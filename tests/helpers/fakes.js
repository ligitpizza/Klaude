// In-memory stand-ins for Redis, the vector client and Discord objects.
// Shapes match what the production code calls, nothing more.

class FakeRedis {
  constructor() { this.store = new Map(); this.calls = 0; }
  _tick() { this.calls++; }
  async get(k) { this._tick(); return this.store.has(k) ? this.store.get(k) : null; }
  async set(k, v) { this._tick(); this.store.set(k, v); return "OK"; }
  async del(...keys) { this._tick(); let n = 0; for (const k of keys.flat()) if (this.store.delete(k)) n++; return n; }
  _set(k) { if (!this.store.has(k)) this.store.set(k, new Set()); return this.store.get(k); }
  async sadd(k, ...m) { this._tick(); const s = this._set(k); let n = 0; for (const x of m.flat()) if (!s.has(String(x))) { s.add(String(x)); n++; } return n; }
  async srem(k, ...m) { this._tick(); const s = this._set(k); let n = 0; for (const x of m.flat()) if (s.delete(String(x))) n++; return n; }
  async smembers(k) { this._tick(); return [...(this.store.get(k) || [])]; }
  _hash(k) { if (!this.store.has(k)) this.store.set(k, new Map()); return this.store.get(k); }
  async hset(k, obj) { this._tick(); const h = this._hash(k); let n = 0; for (const [f, v] of Object.entries(obj)) { if (!h.has(f)) n++; h.set(f, v); } return n; }
  async hget(k, f) { this._tick(); return this.store.get(k)?.get(f) ?? null; }
  async hgetall(k) { this._tick(); const h = this.store.get(k); return h && h.size ? Object.fromEntries(h) : null; }
  async hdel(k, ...f) { this._tick(); const h = this.store.get(k); let n = 0; for (const x of f.flat()) if (h?.delete(x)) n++; return n; }
  async hlen(k) { this._tick(); return this.store.get(k)?.size ?? 0; }
}

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);

// Supports the filter shapes the code builds:
//   guildId = 'g' AND (switchId IN ('a','b') OR channelId = 'c')
//   guildId = 'g' AND switchId IN ('a')      guildId = 'g' AND channelId = 'c'
function matchesFilter(meta, filter) {
  if (!filter) return true;
  const eq = [...filter.matchAll(/(\w+) = '([^']*)'/g)].map(m => [m[1], m[2]]);
  const ins = [...filter.matchAll(/(\w+) IN \(([^)]*)\)/g)].map(m => [m[1], [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1])]);
  const guild = eq.find(([k]) => k === "guildId");
  if (guild && meta.guildId !== guild[1]) return false;
  const alts = [...eq.filter(([k]) => k !== "guildId").map(([k, v]) => meta[k] === v),
                ...ins.map(([k, vs]) => vs.includes(meta[k]))];
  return alts.length ? alts.some(Boolean) : true;
}

class FakeVector {
  constructor() { this.ns = new Map(); this.calls = []; this._fail = null; }
  failNext(err = new Error("vector down")) { this._fail = err; }
  failAlways(err = new Error("vector down")) { this._failAlways = err; }
  _check(method, ns) {
    this.calls.push({ method, ns });
    if (this._failAlways) throw this._failAlways;
    if (this._fail) { const e = this._fail; this._fail = null; throw e; }
  }
  _space(ns) { if (!this.ns.has(ns)) this.ns.set(ns, new Map()); return this.ns.get(ns); }
  async upsert(ns, items) { this._check("upsert", ns); const s = this._space(ns); for (const it of items) s.set(String(it.id), { ...it, id: String(it.id) }); }
  async query(ns, { data, topK, filter }) {
    this._check("query", ns);
    const q = words(data);
    return [...this._space(ns).values()]
      .filter(it => matchesFilter(it.metadata || {}, filter))
      .map(it => {
        const w = words(it.data);
        const shared = [...q].filter(x => w.has(x)).length;
        return { id: it.id, score: shared / Math.max(q.size, w.size, 1), metadata: it.metadata };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  async fetch(ns, ids) { this._check("fetch", ns); const s = this._space(ns); return ids.map(id => (s.has(String(id)) ? { id: String(id), metadata: s.get(String(id)).metadata, data: s.get(String(id)).data } : null)); }
  async remove(ns, ids) { if (!ids.length) return; this._check("remove", ns); const s = this._space(ns); for (const id of ids) s.delete(String(id)); }
  // test helpers
  ids(ns) { return [...this._space(ns).keys()]; }
  get(ns, id) { return this._space(ns).get(String(id)) || null; }
}

// ── Discord fakes ────────────────────────────────────────────────────────────
// fakeChannel({ id, name, guildId, type, parent, everyoneCanView = true, viewers })
//   viewers: Set of member ids who can view (default: everyone).
const ChannelTypes = { GuildText: 0, PublicThread: 11, PrivateThread: 12, DM: 1 };
const EVERYONE = "@everyone";

function fakeChannel({ id, name, guildId = "1", type = ChannelTypes.GuildText, parent = null, everyoneCanView = true, viewers = null }) {
  const ch = {
    id, name, guildId, type, parent, parentId: parent?.id ?? null,
    isThread: () => type === ChannelTypes.PublicThread || type === ChannelTypes.PrivateThread,
    permissionsFor(who) {
      const whoId = typeof who === "string" ? who : who?.id;
      // threads inherit their parent's view permission
      const base = parent || ch;
      const canView = whoId === EVERYONE
        ? base._everyoneCanView
        : (base._viewers ? base._viewers.has(whoId) : base._everyoneCanView || false);
      return { has: () => canView };
    },
    _everyoneCanView: everyoneCanView,
    _viewers: viewers,
  };
  return ch;
}
const fakeMember = (id) => ({ id, user: { id } });
function fakeGuild(id, channels) {
  const map = new Map(channels.map(c => [c.id, c]));
  return { id, roles: { everyone: { id: EVERYONE } }, channels: { cache: map } };
}

module.exports = { FakeRedis, FakeVector, fakeChannel, fakeMember, fakeGuild, ChannelTypes };
