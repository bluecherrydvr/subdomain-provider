/**
 *
 * @param redis redis promise client
 * @param key store path to cache key value map
 * @param callback new value generator function if isn't there any value in cache or cache value is expired
 * @param parser callback to parse cached value to original type
 * @param expireTime cache value expire time in seconds
 * @returns {function(*=): Promise<void>}
 */
exports.createRedisCache = function createRedisCache(redis, key, callback = async (value) => value,
                                                     parser = (value) => value, expireTime = 300) {
    const keyCreatedAt = key + ':created';

    const produceAndCache = async (value) => {
        // produce a new value
        const result = await callback(value);

        // store produced value to cache and record time
        await Promise.all([
            redis.hset(key, value, result),
            redis.hset(keyCreatedAt, value, Date.now())
        ]);

        // return produced & cached value
        return result;
    };

    return async (value) => {

        if (!(await redis.hexists(key, value))) {
            return produceAndCache(value);
        }

        const [result, recordTime] = await Promise.all([
            redis.hget(key, value), // get cached value
            redis.hget(keyCreatedAt, value) // get cached value's record time
        ]);

        const now = Date.now()

        // if there is a cached value and record time is not expired return it
        if (((now - recordTime) / 1000) < parseInt(expireTime)) {
            return parser(result);
        }

        return produceAndCache(value);
    };
};