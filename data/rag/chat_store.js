const { chunkText, MAX_CONTENT } = require("./chunker.js");

const CHAT_NS = "chat";
const MAP_KEY = (key) => `rag:map:${key}`;
// Discord ids are digit-only snowflakes; anything else never goes into a filter.
const isId = (s) => /^\d+$/.test(String(s));

function toVector(chunk) {
  return {
    id: chunk.id,
    data: chunkText(chunk),
    metadata: {
      guildId: chunk.guildId,
      channelId: chunk.key,
      switchId: chunk.switchId,
      channelName: chunk.channelName,
      start: chunk.start,
      end: chunk.end,
      authors: [...new Set(chunk.messages.map(m => m.author))],
      messages: chunk.messages,
    },
  };
}

// Rebuilds a Chunk from stored metadata so it can be edited and re-saved.
const fromMetadata = (id, md) => ({
  id, key: md.channelId, switchId: md.switchId, guildId: md.guildId,
  channelName: md.channelName, start: md.start, end: md.end, messages: md.messages || [],
});

function createChatStore({ vector, redis }) {
  async function saveChunk(chunk) {
    await vector.upsert(CHAT_NS, [toVector(chunk)]);
    await redis.hset(MAP_KEY(chunk.key), Object.fromEntries(chunk.messages.map(m => [m.id, chunk.id])));
  }

  // Loads the stored chunk holding this message, or null.
  async function load(key, messageId) {
    const chunkId = await redis.hget(MAP_KEY(key), messageId);
    if (!chunkId) return null;
    const [hit] = await vector.fetch(CHAT_NS, [chunkId]);
    return hit ? fromMetadata(chunkId, hit.metadata) : null;
  }

  async function editMessage(key, messageId, content) {
    const chunk = await load(key, messageId);
    const m = chunk?.messages.find(x => x.id === messageId);
    if (!m) return false;
    m.content = String(content).slice(0, MAX_CONTENT);
    await vector.upsert(CHAT_NS, [toVector(chunk)]);
    return true;
  }

  async function deleteMessage(key, messageId) {
    const chunk = await load(key, messageId);
    if (!chunk) return false;
    chunk.messages = chunk.messages.filter(x => x.id !== messageId);
    if (chunk.messages.length) await vector.upsert(CHAT_NS, [toVector(chunk)]);
    else await vector.remove(CHAT_NS, [chunk.id]);
    await redis.hdel(MAP_KEY(key), messageId);
    return true;
  }

  async function chunkIds(key) {
    const map = await redis.hgetall(MAP_KEY(key));
    return [...new Set(Object.values(map || {}))];
  }

  async function deleteChannel(key) {
    const ids = await chunkIds(key);
    await vector.remove(CHAT_NS, ids);
    await redis.del(MAP_KEY(key));
    return ids.length;
  }

  const countChunks = async (key) => (await chunkIds(key)).length;

  // switchIds: public indexed channels (their threads included, via switchId).
  // askKey: the channel/thread being asked in, if it's indexed.
  async function search({ query, guildId, switchIds = [], askKey = null, topK = 5 }) {
    if (!isId(guildId)) return [];
    const ids = switchIds.filter(isId);
    const ask = askKey && isId(askKey) ? askKey : null;
    const parts = [];
    if (ids.length) parts.push(`switchId IN (${ids.map(i => `'${i}'`).join(", ")})`);
    if (ask) parts.push(`channelId = '${ask}'`);
    if (!parts.length) return [];

    const scope = parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
    const hits = await vector.query(CHAT_NS, { data: query, topK, filter: `guildId = '${guildId}' AND ${scope}` });
    return hits.map(h => ({
      score: h.score,
      channelName: h.metadata.channelName,
      start: h.metadata.start,
      end: h.metadata.end,
      messages: h.metadata.messages,
    }));
  }

  return { saveChunk, editMessage, deleteMessage, deleteChannel, countChunks, search };
}

module.exports = { createChatStore, CHAT_NS };
