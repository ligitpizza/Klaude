const crypto = require("node:crypto");

const COMMANDS_NS = "commands";
const GUIDELINES_NS = "guidelines";
const COMMANDS_HASH_KEY = "rag:commands:hash";

// ── Commands ──────────────────────────────────────────────────────────────────
function commandVectors(commands) {
  return commands
    .filter(c => !c.hidden)
    .map(c => ({
      id: c.cmd,
      data: `${c.usage} — ${c.desc}.${c.note ? ` ${c.note}` : ""}`,
      metadata: { cmd: c.cmd, usage: c.usage, desc: c.desc, note: c.note || "", group: c.group },
    }));
}

// Re-upserts only when the registry changed since the last sync, so a Render
// restart doesn't spend ~45 vector updates for nothing.
async function syncCommands({ vector, redis, commands }) {
  const vecs = commandVectors(commands);
  const hash = crypto.createHash("sha1").update(JSON.stringify(vecs)).digest("hex");

  const raw = await redis.get(COMMANDS_HASH_KEY);
  const prev = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
  if (prev?.hash === hash) return "skipped";

  await vector.upsert(COMMANDS_NS, vecs);
  const ids = vecs.map(v => v.id);
  const gone = (prev?.ids || []).filter(id => !ids.includes(id));
  await vector.remove(COMMANDS_NS, gone);
  await redis.set(COMMANDS_HASH_KEY, JSON.stringify({ hash, ids }));
  return "synced";
}

// ── Guidelines ────────────────────────────────────────────────────────────────
const guidelineVector = (g) => ({
  id: g.id,
  data: `${g.name}: ${g.content}`,
  metadata: { name: g.name, content: g.content },
});

const upsertGuideline = (vector, g) => vector.upsert(GUIDELINES_NS, [guidelineVector(g)]);
const removeGuideline = (vector, id) => vector.remove(GUIDELINES_NS, [id]);

// One-off catch-up for guidelines that existed before vector storage.
async function syncGuidelines({ vector, guidelines }) {
  if (!guidelines.length) return;
  const existing = await vector.fetch(GUIDELINES_NS, guidelines.map(g => g.id));
  const missing = guidelines.filter((_, i) => !existing[i]);
  if (missing.length) await vector.upsert(GUIDELINES_NS, missing.map(guidelineVector));
}

// Pinned guidelines always go into the prompt, whatever the search finds.
// Mutates the list; returns the new pinned state, or null if the id is unknown.
function togglePinned(guidelines, id) {
  const g = guidelines.find(x => x.id === id);
  if (!g) return null;
  if (g.pinned) delete g.pinned;
  else g.pinned = true;
  return Boolean(g.pinned);
}

module.exports = {
  COMMANDS_NS, GUIDELINES_NS,
  commandVectors, syncCommands, guidelineVector, upsertGuideline, removeGuideline, syncGuidelines,
  togglePinned,
};
