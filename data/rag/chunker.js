// Groups a channel's messages into conversation chunks — one searchable
// document per back-and-forth, which answers "what did we decide" far better
// than single lines, and costs ~1/10th of the vector budget.
//
// A chunk closes when the next message comes more than 10 minutes later, when
// it reaches 15 messages, or when sweep() finds it idle for 10 minutes.
// Pure and in-memory: saving closed chunks is the caller's job.

const GAP_MS = 600_000;
const MAX_MESSAGES = 15;
// Caps one message so a full chunk stays far under Upstash's 48 KB metadata limit.
const MAX_CONTENT = 1000;

const cap = (s) => String(s).slice(0, MAX_CONTENT);

class ChunkBuffer {
  constructor() { this.open = new Map(); }

  // Returns the chunk this message closed (previous one, or this one when it
  // fills up), or null.
  add({ key, switchId, guildId, channelName }, { id, author, content, ts }) {
    if (!String(content ?? "").trim()) return null;

    let closed = null;
    const current = this.open.get(key);
    if (current && ts - current.end > GAP_MS) {
      closed = current;
      this.open.delete(key);
    }

    let chunk = this.open.get(key);
    if (!chunk) {
      chunk = { id: `${key}:${id}`, key, switchId, guildId, channelName, start: ts, end: ts, messages: [] };
      this.open.set(key, chunk);
    }
    chunk.messages.push({ id, author, content: cap(content), ts });
    chunk.end = ts;
    chunk.channelName = channelName; // follows renames

    if (chunk.messages.length >= MAX_MESSAGES) {
      this.open.delete(key);
      return chunk; // a gap-closed chunk can't coexist: it would have been the open one
    }
    return closed;
  }

  edit(key, messageId, content) {
    const m = this.open.get(key)?.messages.find(x => x.id === messageId);
    if (!m) return false;
    m.content = cap(content);
    return true;
  }

  remove(key, messageId) {
    const chunk = this.open.get(key);
    const i = chunk ? chunk.messages.findIndex(x => x.id === messageId) : -1;
    if (i === -1) return false;
    chunk.messages.splice(i, 1);
    if (!chunk.messages.length) this.open.delete(key);
    return true;
  }

  discard(key) { this.open.delete(key); }

  sweep(now) {
    const closed = [];
    for (const [key, chunk] of this.open) {
      if (now - chunk.end > GAP_MS) { closed.push(chunk); this.open.delete(key); }
    }
    return closed;
  }

  drain() {
    const all = [...this.open.values()];
    this.open.clear();
    return all;
  }
}

const chunkText = (chunk) => chunk.messages.map(m => `[${m.author}]: ${m.content}`).join("\n");

module.exports = { ChunkBuffer, chunkText, GAP_MS, MAX_MESSAGES, MAX_CONTENT };
