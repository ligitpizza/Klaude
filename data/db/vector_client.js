require("dotenv").config();
const { withTimeout } = require("../utils/timeout.js");

// Same bound as the Redis client: the Upstash REST SDK has no request timeout
// of its own, and a stalled connection must fail fast into the caller's
// fallback instead of hanging a reply.
const VECTOR_TIMEOUT_MS = 8000;

const isRateLimit = (err) =>
  err?.status === 429 || /rate limit|request limit|too many requests/i.test(err?.message || "");

// The only code that touches @upstash/vector. Everything else uses this shape:
//   upsert(ns, items) · query(ns, {data, topK, filter}) · fetch(ns, ids) · remove(ns, ids)
// Returns null when the env vars aren't set, so callers fall back to the
// non-vector behaviour.
function createVectorClient({ url, token, IndexClass, timeoutMs = VECTOR_TIMEOUT_MS } = {}) {
  if (!url || !token) return null;
  const Index = IndexClass || require("@upstash/vector").Index;
  const index = new Index({ url, token });

  const call = async (label, fn) => {
    try {
      return await withTimeout(fn(), timeoutMs, `vector.${label}`);
    } catch (err) {
      if (isRateLimit(err)) console.warn("Upstash Vector rate limit hit");
      throw err;
    }
  };

  return {
    upsert: (ns, items) => call("upsert", () => index.namespace(ns).upsert(items)),
    query: (ns, { data, topK, filter }) => call("query", () =>
      index.namespace(ns).query({ data, topK, ...(filter ? { filter } : {}), includeMetadata: true })),
    fetch: (ns, ids) => call("fetch", () => index.namespace(ns).fetch(ids, { includeMetadata: true })),
    remove: async (ns, ids) => {
      if (!ids.length) return;
      await call("remove", () => index.namespace(ns).delete(ids));
    },
    // Deletes every vector whose metadata matches, e.g. "switchId = '123'".
    removeByFilter: (ns, filter) => call("removeByFilter", () => index.namespace(ns).delete({ filter })),
  };
}

const vector = createVectorClient({
  url: process.env.UPSTASH_VECTOR_REST_URL,
  token: process.env.UPSTASH_VECTOR_REST_TOKEN,
});

module.exports = { createVectorClient, vector };
