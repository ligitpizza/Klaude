const test = require("node:test");
const assert = require("node:assert/strict");
const { ChunkBuffer, chunkText, GAP_MS, MAX_MESSAGES, MAX_CONTENT } = require("../data/rag/chunker.js");

const MIN = 60_000;
const target = (key = "c1") => ({ key, switchId: key, guildId: "g1", channelName: "general" });
const msg = (id, ts, content = `message ${id}`, author = "alice") => ({ id, author, content, ts });

test("constants match the design", () => {
  assert.equal(GAP_MS, 600_000);
  assert.equal(MAX_MESSAGES, 15);
  assert.equal(MAX_CONTENT, 1000);
});

test("messages close together stay in one open chunk", () => {
  const b = new ChunkBuffer();
  for (let i = 1; i <= 3; i++) assert.equal(b.add(target(), msg(`m${i}`, i * MIN)), null);
  const [chunk] = b.drain();
  assert.equal(chunk.id, "c1:m1");
  assert.equal(chunk.messages.length, 3);
  assert.equal(chunk.switchId, "c1");
  assert.equal(chunk.guildId, "g1");
  assert.equal(chunk.start, MIN);
  assert.equal(chunk.end, 3 * MIN);
});

test("a gap over 10 minutes closes the previous chunk", () => {
  const b = new ChunkBuffer();
  b.add(target(), msg("m1", 0));
  b.add(target(), msg("m2", MIN));
  const closed = b.add(target(), msg("m3", MIN + 11 * MIN));
  assert.deepEqual(closed.messages.map(m => m.id), ["m1", "m2"]);
  assert.deepEqual(b.drain()[0].messages.map(m => m.id), ["m3"]);
});

test("the 15th message closes a full chunk and the 16th starts a new one", () => {
  const b = new ChunkBuffer();
  let closed = null;
  for (let i = 1; i <= 15; i++) closed = b.add(target(), msg(`m${i}`, i * 1000));
  assert.equal(closed.messages.length, 15);
  assert.equal(b.add(target(), msg("m16", 16_000)), null);
  assert.equal(b.drain()[0].id, "c1:m16");
});

test("sweep closes chunks idle for more than 10 minutes only", () => {
  const b = new ChunkBuffer();
  b.add(target(), msg("m1", 0));
  assert.deepEqual(b.sweep(GAP_MS - 1), []);
  assert.equal(b.sweep(GAP_MS + 1).length, 1);
  assert.deepEqual(b.drain(), []);
});

test("edit and remove change the open chunk", () => {
  const b = new ChunkBuffer();
  b.add(target(), msg("m1", 0, "old"));
  b.add(target(), msg("m2", 1));
  assert.equal(b.edit("c1", "m1", "new"), true);
  assert.equal(b.edit("c1", "nope", "x"), false);
  assert.equal(b.remove("c1", "m2"), true);
  assert.equal(b.remove("c1", "nope"), false);
  const [chunk] = b.drain();
  assert.deepEqual(chunk.messages.map(m => [m.id, m.content]), [["m1", "new"]]);
});

test("removing the only message leaves nothing to save", () => {
  const b = new ChunkBuffer();
  b.add(target(), msg("m1", 0));
  b.remove("c1", "m1");
  assert.deepEqual(b.drain(), []);
});

test("empty (attachment-only) messages are skipped", () => {
  const b = new ChunkBuffer();
  assert.equal(b.add(target(), msg("m1", 0, "   ")), null);
  assert.deepEqual(b.drain(), []);
});

test("long messages are capped and a full chunk stays under 48 KB", () => {
  const b = new ChunkBuffer();
  let closed = null;
  for (let i = 1; i <= 15; i++) closed = b.add(target(), msg(`m${i}`, i, "é".repeat(4000)));
  assert.equal(closed.messages[0].content.length, MAX_CONTENT);
  assert.ok(Buffer.byteLength(JSON.stringify(closed)) < 48_000);
});

test("edits are capped too", () => {
  const b = new ChunkBuffer();
  b.add(target(), msg("m1", 0));
  b.edit("c1", "m1", "x".repeat(5000));
  assert.equal(b.drain()[0].messages[0].content.length, MAX_CONTENT);
});

test("discard drops a channel's open chunk", () => {
  const b = new ChunkBuffer();
  b.add(target("c1"), msg("m1", 0));
  b.add(target("c2"), msg("m2", 0));
  b.discard("c1");
  assert.deepEqual(b.drain().map(c => c.key), ["c2"]);
});

test("discardSwitch drops the channel's and its threads' open chunks only", () => {
  const b = new ChunkBuffer();
  b.add({ key: "c1", switchId: "c1", guildId: "g1", channelName: "general" }, msg("m1", 0));
  b.add({ key: "t1", switchId: "c1", guildId: "g1", channelName: "general › t" }, msg("m2", 0));
  b.add({ key: "c2", switchId: "c2", guildId: "g1", channelName: "other" }, msg("m3", 0));
  b.discardSwitch("c1");
  assert.deepEqual(b.drain().map(c => c.key), ["c2"]);
});

test("channels buffer independently", () => {
  const b = new ChunkBuffer();
  b.add(target("c1"), msg("a1", 0));
  b.add(target("c2"), msg("b1", 0));
  assert.equal(b.add(target("c1"), msg("a2", 20 * MIN)).id, "c1:a1");
  assert.deepEqual(b.drain().map(c => c.id).sort(), ["c1:a2", "c2:b1"]);
});

test("chunkText renders one line per message", () => {
  const b = new ChunkBuffer();
  b.add(target(), msg("m1", 0, "reset the map?", "alice"));
  b.add(target(), msg("m2", 1, "yes, saturday", "bob"));
  assert.equal(chunkText(b.drain()[0]), "[alice]: reset the map?\n[bob]: yes, saturday");
});
