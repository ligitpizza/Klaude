require("dotenv").config();
const { Redis } = require("@upstash/redis");
const { withTimeout } = require("../utils/timeout.js");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// The Upstash REST client has no built-in request timeout, so a stalled
// TLS/network connection (observed intermittently on Render) leaves callers
// awaiting forever. Wrap every command with a bounded timeout so a stall
// fails fast into the caller's existing error handling instead of hanging.
const REDIS_TIMEOUT_MS = 8000;

const redisWithTimeout = new Proxy(redis, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return function (...args) {
      const result = value.apply(target, args);
      return result instanceof Promise
        ? withTimeout(result, REDIS_TIMEOUT_MS, `redis.${String(prop)}`)
        : result;
    };
  },
});

module.exports = redisWithTimeout;