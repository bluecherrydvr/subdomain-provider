
require('dotenv').config();

const {
    REDIS_URL,
    DO_API_TOKEN,
    CRYPTLEX_API_CACHE_SECONDS,
    ADMIN_TOKEN,
    SUB_DOMAIN_TTL,
    ROOT_DOMAIN,
    APP_PORT,
    SUBDOMAIN_CHANGE_RATE_LIMIT_COUNT,
    SUBDOMAIN_CHANGE_RATE_LIMIT_RELEASE_SECONDS
} = process.env;

const redis = require('redis');
const express = require('express');
const DigitalOcean = require('do-wrapper').default;
const { wrap } = require('@awaitjs/express');
const {Validator: IpValidator} = require('ip-num/Validator');

const RedisPromise = require('./lib/redis-promise');
const authChecker = require('./lib/auth-checker');
const {isValidLicenseId, getLicenseIdByLicenseKey} = require('./lib/cryptlex-api');
const {createRedisCache} = require('./lib/cache');

const Redlock = require('redlock');

const router = express.Router()

const redisClient = new RedisPromise(redis.createClient(REDIS_URL));
const redlock = new Redlock([redisClient.originalClient]);
const doClient = new DigitalOcean(DO_API_TOKEN);

const logger = require('./logger');

const isValidLicenseIdCache = createRedisCache(redisClient, 'license_id_validation',
    (token) => isValidLicenseId(token), Boolean, CRYPTLEX_API_CACHE_SECONDS);

const getLicenseIdByLicenseKeyCache = createRedisCache(redisClient, 'license_key_id_mapping',
    (licenseKey) => getLicenseIdByLicenseKey(licenseKey), String, CRYPTLEX_API_CACHE_SECONDS);

const clientAuthChecker = authChecker(
    async (token) => await isValidLicenseIdCache(token)
);

const optionalClientAuthChecker = authChecker(
    async (token) => await isValidLicenseIdCache(token),
    true
);

const adminAuthChecker = authChecker(
    async (token) => ADMIN_TOKEN === token
);


function isValidSubdomain(subdomain) {
    return /^[a-z0-9][a-z0-9\-]{2,49}$/i.test(subdomain);
}

async function isSubdomainAvailable(subdomain, authToken) {

    if (!isValidSubdomain(subdomain)) {
        throw new Error('invalid subdomain name');
    }

    if (await redisClient.sismember('banned_subdomains', subdomain)) {
        throw new Error('subdomain is banned, please use different subdomain name');
    }

    const subdomainOwner = await redisClient.hget('client_subdomains', subdomain);

    if (!subdomainOwner || (authToken && authToken === subdomainOwner)) {
        return;
    }

    throw new Error('subdomain has a different owner');
}

async function updateSubdomainRecord(type, authToken, subdomain, address, prefix = '') {

    // allocate subdomain name for a client
    await redisClient.hset('client_subdomains', subdomain, authToken);
    await redisClient.hsetnx('client_subdomains_book_time', subdomain, Date.now());

    // do not create new dns subdomain records on simultaneous api requests for a client
    const resourceName = 'client_subdomain_' + type + '_id';
    // lock expire time is 30 seconds
    const lock = await redlock.lock(resourceName + ':' + authToken, 30000);

    const options = {
        type: type.toUpperCase(),
        name: prefix + subdomain,
        data: address,
        ttl: SUB_DOMAIN_TTL
    };

    const domainRecordId = await redisClient.hget(resourceName, authToken);

    if (domainRecordId) {
        await doClient.domains.updateRecord(ROOT_DOMAIN, domainRecordId, options);
    } else {
        const {domain_record: {id: domainRecordId}} = await doClient.domains.createRecord(ROOT_DOMAIN, options);
        await redisClient.hset(resourceName, authToken, domainRecordId);
    }

    await redisClient.hset('client_subdomain_' + type + '_address', subdomain, address);

    return lock.unlock();
}


async function updateLatestSubdomainBook(type, authToken, subdomain) {

    const prevSubdomain = await redisClient.hget('client_subdomains_last', authToken);

    if (prevSubdomain && prevSubdomain === subdomain) {
        return;
    }

    return redisClient.hset('client_subdomains_last', authToken, subdomain);
}

async function getActualClientConfig(authToken) {
    const subdomain = await redisClient.hget('client_subdomains_last', authToken);

    if (!subdomain) {
        throw new Error('there is no subdomain registered before for this client');
    }

    const records = await Promise.all(['a', 'aaaa'].map(async type => ({
        type,
        value: await redisClient.hget('client_subdomain_' + type + '_address', subdomain)
    })));

    return {
        subdomain,
        records
    };
}

async function getActualValidationData(authToken) {
    const subdomain = await redisClient.hget('client_subdomains_last', authToken);

    if (!subdomain) {
        throw new Error('there is no subdomain registered before for this client');
    }

    const prefix = 'client_subdomain_txt_';

    const result = [];
    const addressLabel = prefix + 'address';
    const idLabel = prefix + 'id';

    try {
        result.push({
            success: true,
            type: 'redis',
            label: addressLabel,
            data: await redisClient.hget(addressLabel, subdomain)
        });
    } catch (err) {
        logger.log('get validation data error (redis)', err);
        result.push({
            success: false,
            type: 'redis',
            label: addressLabel
        });
    }

    let recordId = null;

    try {
        recordId = await redisClient.hget(idLabel, authToken);
        result.push({
            success: true,
            type: 'redis',
            label: idLabel,
            data: recordId
        });
    } catch (err) {
        logger.log('get validation id error (redis)', err);
        result.push({
            success: false,
            type: 'redis',
            label: idLabel
        });
    }

    if (!recordId) {
        return result;
    }

    try {
        result.push({
            success: true,
            type: 'dns',
            data: await doClient.domains.getRecord(ROOT_DOMAIN, recordId)
        });
    } catch (err) {
        logger.log('get validation data error (dns)', err);
        result.push({
            success: false,
            type: 'dns'
        });
    }

    return result;
}

async function destroyActualClientConfig(authToken) {

    const resourceNames = [
        'client_subdomain_a_id',
        'client_subdomain_aaaa_id',
        'actual_config_destroy'
    ];

    // lock expire time is 30 seconds
    const lock = await redlock.lock(resourceNames.map(name => name + ':' + authToken), 30000);

    try {
        const subdomain = await redisClient.hget('client_subdomains_last', authToken);

        if (!subdomain) {
            throw new Error('there is no subdomain registered before for this client');
        }

        for (const target of ['a', 'aaaa']) {
            const recordId = await redisClient.hget('client_subdomain_' + target + '_id', authToken);

            if (recordId) {
                await doClient.domains.deleteRecord(ROOT_DOMAIN, recordId);
                await redisClient.hdel('client_subdomain_' + target + '_id', authToken);
            }

            await redisClient.hdel('client_subdomain_' + target + '_address', subdomain);
        }

        await redisClient.hdel('client_subdomains_last', authToken);
    } finally {
        await lock.unlock();
    }

}

async function subdomainRateLimitCheck(subdomain, authToken) {

    const actualSubdomain = await redisClient.hget('client_subdomains_last', authToken);

    if (actualSubdomain && actualSubdomain === subdomain) {
        return;
    }

    const key = 'client_rate_limit:' + authToken;

    if (!await redisClient.exists(key)) {
        await redisClient.setex(key, SUBDOMAIN_CHANGE_RATE_LIMIT_RELEASE_SECONDS, 0);
    }

    const currentLimit = parseInt(await redisClient.incr(key));

    if (currentLimit > SUBDOMAIN_CHANGE_RATE_LIMIT_COUNT) {
        throw new Error('Subdomain name change rate limit is exceeded');
    }
}

async function applySubdomainRecord(type, authToken, subdomain, data, prefix = '') {
    const lock = await redlock.lock('subdomain_record_attempt:' + subdomain, 50000);

    try {
        await subdomainRateLimitCheck(subdomain, authToken);
        await isSubdomainAvailable(subdomain, authToken)
        await updateSubdomainRecord(type, authToken, subdomain, data, prefix);
        await updateLatestSubdomainBook(type, authToken, subdomain);
    } finally {
        await lock.unlock();
    }
}

async function cleanValidationData(authToken) {

    const recordId = await redisClient.hget('client_subdomain_txt_id', authToken);

    if (!recordId) {
        throw new Error('validation data is not exists');
    }

    await doClient.domains.deleteRecord(ROOT_DOMAIN, recordId);
    await redisClient.hdel('client_subdomain_txt_id', authToken);
}

async function getClientsSubdomains() {

    const clientSubdomains = await redisClient.hgetall('client_subdomains');
    const clientSubdomainsMap = new Map();

    for (const [subdomain, clientId] of Object.entries(clientSubdomains)) {

        if (clientSubdomainsMap.has(clientId)) {
            clientSubdomainsMap.get(clientId).push(subdomain);
        } else {
            clientSubdomainsMap.set(clientId, [subdomain]);
        }
    }

    return clientSubdomainsMap;
}

async function getOrphanSubdomains() {

    const clientSubdomains = await getClientsSubdomains();

    const orphanSubdomains = new Map();

    for (const [clientId, subdomains] of clientSubdomains) {
        const subdomain = await redisClient.hget('client_subdomains_last', clientId);

        if (!subdomain) {
            orphanSubdomains.set(clientId, subdomains);
        } else {
            const targetSubdomains = subdomains.filter(target => target.toLowerCase() !== subdomain.toLowerCase());
            if(targetSubdomains.length > 0) {
                orphanSubdomains.set(clientId, targetSubdomains);
            }
        }
    }

    return orphanSubdomains;
}

async function isSubdomainExpired(subdomain, expireTime) {
    if (!expireTime) {
        return true;
    }

    const targetTime = await redisClient.hget('client_subdomains_book_time', subdomain);

    if (!targetTime) {
        return true;
    }

    return parseInt(targetTime) < parseInt(expireTime);
}

const app = express();

app.use(express.json())
app.use('/subdomain-provider', router);

router.post('/check-subdomain-availability', optionalClientAuthChecker, wrap(async (req, res) => {

    const {authToken} = res.locals;
    const {subdomain} = req.body;

    if (!subdomain) {
        res.json({success: false, message: 'subdomain is not provided'});
        return;
    }

    try {
        await isSubdomainAvailable(subdomain, authToken);
        res.json({success: true, available: true});
    } catch (err) {
        res.json({success: false, message: err.message});
    }

}));

router.get('/actual-configuration', clientAuthChecker, wrap(async(req, res) => {

    const {authToken} = res.locals;

    try {
        const config = await getActualClientConfig(authToken);
        res.json(config);
    } catch (err) {
        res.json({
            subdomain: '',
            records: [
                {type: 'a', value: ''},
                {type: 'aaaa', value: ''}
            ]
        });
    }

}));

router.delete('/actual-configuration', clientAuthChecker, wrap(async (req, res) => {

    const {authToken} = res.locals;

    try {
        await destroyActualClientConfig(authToken)
        res.json({success: true});
    } catch (err) {
        res.json({success: false, message: err.message});
    }

}));

router.purge('/orphan-name-list', adminAuthChecker, wrap(async(req, res) => {

    const {expireTime} = req.body;

    const orphanSubdomains = await getOrphanSubdomains();

    for (const [clientId, subdomains] of orphanSubdomains) {
        for (const subdomain of subdomains) {
            if (await isSubdomainExpired(subdomain, expireTime)) {
                await redisClient.hdel('client_subdomains', subdomain);
                await redisClient.hdel('client_subdomains_book_time', subdomain);
            }
        }
    }

    res.json({success: true});
}));

router.get('/orphan-name-list', adminAuthChecker, wrap(async (req, res) => {
    res.json(Object.fromEntries(await getOrphanSubdomains()));
}))

router.get('/banned-subdomain-list', wrap(async (req, res) => {

    try {
        res.json({success: true, list: await redisClient.smembers('banned_subdomains')});
    } catch (err) {
        res.json({success: false, message: err.message});
    }

}));

router.get('/manifest', wrap(async (req, res) => {

    res.json({
        success: true,
        root_domain: ROOT_DOMAIN,
        sub_domain_ttl: SUB_DOMAIN_TTL
    });

}));

router.post('/get-license-id', wrap(async(req, res) => {

    const {licenseKey} = req.body;

    if (!licenseKey) {
        res.json({success: false, message: 'license key is not provided'});
        return;
    }

    try {
        const licenseId = await getLicenseIdByLicenseKeyCache(licenseKey);
        res.json({success: true, licenseId});
    } catch (err) {
        logger.error('get license id endpoint', err);
        res.json({success: false, message: 'an error occured during license key checking'});
    }

}));

router.post('/ban-subdomain', adminAuthChecker, wrap(async(req, res) => {

    const {subdomain} = req.body;

    if (!subdomain) {
        res.json({success: false, message: 'subdomain is not provided'});
        return;
    }


    if (!isValidSubdomain(subdomain)) {
        res.json({success: false, message: 'invalid subdomain'});
        return;
    }

    await redisClient.sadd('banned_subdomains', subdomain);

    res.json({success: true});

}));

router.post('/assign-ip-address', clientAuthChecker, wrap( async (req, res) => {

    const {authToken} = res.locals;
    const {ip_address, subdomain, type = 4} = req.body;

    if (!ip_address) {
        res.json({success: false, message: 'ip address is not provided'});
        return;
    }

    if (!subdomain) {
        res.json({success: false, message: 'subdomain is not provided'});
        return;
    }

    if (type === 4) {
        const [isValidIpAddress, validationMessage] = IpValidator.isValidIPv4String(ip_address);
        if (!isValidIpAddress) {
            res.json({success: false, message: 'invalid ipv4 address. ' + validationMessage});
            return;
        }

        try {
            await applySubdomainRecord('a', authToken, subdomain, ip_address);

        } catch (err) {
            res.json({success: false, message: err.message});
            return;
        }

        res.json({success: true});
        return;
    }

    if (type === 6) {
        const [isValidIpAddress, validationMessage] = IpValidator.isValidIPv6String(ip_address);
        if (!isValidIpAddress) {
            res.json({success: false, message: 'invalid ipv6 address. ' + validationMessage});
            return;
        }

        try {
            await applySubdomainRecord('aaaa', authToken, subdomain, ip_address);
        } catch (err) {
            res.json({success: false, message: err.message});
            return;
        }

        res.json({success: true});
        return;
    }

    res.json({success: false, message: 'valid ip types are 4 or 6', foo: res.locals.authToken});
}));

router.post('/assign-validation-data', clientAuthChecker, wrap(async (req, res) => {

    const {authToken} = res.locals;
    const {subdomain, data} = req.body;

    if (!subdomain) {
        res.json({success: false, message: 'subdomain is not provided'});
        return;
    }

    if (!data) {
        res.json({success: false, message: 'data is not provided'});
        return;
    }

    try {
        await applySubdomainRecord('txt', authToken, subdomain, data, '_acme-challenge.');
    } catch (err) {
        res.json({success: false, message: err.message});
        return;
    }

    res.json({success: true});

}));

router.delete('/clean-validation-data', clientAuthChecker, wrap(async (req, res) => {

    const {authToken} = res.locals;

    try {
        await cleanValidationData(authToken);
    } catch (err) {
        res.json({success: false, message: err.message});
        return;
    }

    res.json({success: true});

}));

router.get('/get-validation-data', clientAuthChecker, wrap(async (req, res) => {

    const {authToken} = res.locals;

    try {
        res.json(await getActualValidationData(authToken));
    } catch (err) {
        res.json({success: false, message: err.message});
    }

}));

app.listen(APP_PORT, () => {
    console.log(`app listening at http://localhost:${APP_PORT}`);
});