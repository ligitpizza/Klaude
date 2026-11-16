const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeRedis, FakeVector } = require("./helpers/fakes.js");
const { createChatStore } = require("../data/rag/chat_store.js");

function chunk({ key = "100", switchId = key, guildId = "1", channelName = "general", lines }) {
  const messages = lines.map(([id, author, content], i) => ({ id, author, content, ts: 1_000 + i }));
  return { id: `${key}:${messages[0].id}`, key, switchId, guildId, channelName, start: 1_000, end: 1_000 + lines.length - 1, messages };
}

const setup = () => {
  const vector = new FakeVector();
  const redis = new FakeRedis();
  return { vector, redis, store: createChatStore({ vector, redis }) };
};

const minecraft = () => chunk({ lines: [["11", "alice", "should we reset the minecraft map"], ["12", "bob", "yes reset minecraft on saturday"]] });

test("a saved chunk is searchable and counted", async () => {
  const { store, vector } = setup();
  await store.saveChunk(minecraft());
  const stored = vector.get("chat", "100:11");
  assert.equal(stored.data, "[alice]: should we reset the minecraft map\n[bob]: yes reset minecraft on saturday");
  assert.deepEqual(stored.metadata.authors, ["alice", "bob"]);
  assert.equal(stored.metadata.channelId, "100");
  assert.equal(stored.metadata.switchId, "100");
  const hits = await store.search({ query: "minecraft map reset", guildId: "1", switchIds: ["100"], askKey: null });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].channelName, "general");
  assert.equal(hits[0].messages.length, 2);
  assert.equal(await store.countChunks("100"), 1);
});

test("editMessage rewrites the stored line; unknown ids return false", async () => {
  const { store, vector } = setup();
  await store.saveChunk(minecraft());
  assert.equal(await store.editMessage("100", "12", "no, sunday instead"), true);
  assert.match(vector.get("chat", "100:11").data, /\[bob\]: no, sunday instead/);
  assert.equal(vector.get("chat", "100:11").metadata.messages[1].content, "no, sunday instead");
  assert.equal(await store.editMessage("100", "999", "x"), false);
});

test("deleteMessage drops the line, and the vector once the chunk is empty", async () => {
  const { store, vector } = setup();
  await store.saveChunk(minecraft());
  assert.equal(await store.deleteMessage("100", "11"), true);
  assert.doesNotMatch(vector.get("chat", "100:11").data, /alice/);
  assert.equal(await store.deleteMessage("100", "12"), true);
  assert.equal(vector.get("chat", "100:11"), null);
  assert.equal(await store.countChunks("100"), 0);
  assert.equal(await store.deleteMessage("100", "12"), false);
});

test("deleteChannel removes only that channel's chunks and returns the count", async () => {
  const { store, vector } = setup();
  await store.saveChunk(minecraft());
  await store.saveChunk(chunk({ lines: [["13", "carol", "later chat"]] }));
  await store.saveChunk(chunk({ key: "200", lines: [["21", "dan", "other channel"]] }));
  assert.equal(await store.deleteChannel("100"), 2);
  assert.deepEqual(vector.ids("chat"), ["200:21"]);
  assert.equal(await store.countChunks("100"), 0);
});

test("search with nothing allowed makes no vector call", async () => {
  const { store, vector } = setup();
  vector.calls.length = 0;
  assert.deepEqual(await store.search({ query: "x", guildId: "1", switchIds: [], askKey: null }), []);
  assert.equal(vector.calls.length, 0);
});

test("non-numeric ids never reach the filter", async () => {
  const { store, vector } = setup();
  await store.saveChunk(minecraft());
  const q = [];
  const orig = vector.query.bind(vector);
  vector.query = async (ns, args) => { q.push(args.filter); return orig(ns, args); };
  await store.search({ query: "minecraft", guildId: "1", switchIds: ["100", "1' OR '1'='1"], askKey: "x') OR ('a" });
  assert.equal(q[0], "guildId = '1' AND switchId IN ('100')");
});

test("a thread chunk is found through its parent channel", async () => {
  const { store } = setup();
  await store.saveChunk(chunk({ key: "300", switchId: "100", channelName: "general › map-reset", lines: [["31", "eve", "minecraft map reset thread"]] }));
  const hits = await store.search({ query: "minecraft map", guildId: "1", switchIds: ["100"], askKey: null });
  assert.equal(hits[0].channelName, "general › map-reset");
});

test("a restricted channel's chunk is only found when asking in that channel", async () => {
  const { store } = setup();
  await store.saveChunk(chunk({ key: "500", channelName: "mod-chat", lines: [["51", "mod", "minecraft ban list secret"]] }));
  const fromGeneral = await store.search({ query: "minecraft ban", guildId: "1", switchIds: ["100"], askKey: "100" });
  assert.equal(fromGeneral.length, 0);
  const fromMods = await store.search({ query: "minecraft ban", guildId: "1", switchIds: ["100"], askKey: "500" });
  assert.equal(fromMods.length, 1);
});

test("search never crosses guilds", async () => {
  const { store } = setup();
  await store.saveChunk(chunk({ guildId: "2", lines: [["61", "x", "minecraft elsewhere"]] }));
  assert.equal((await store.search({ query: "minecraft", guildId: "1", switchIds: ["100"], askKey: "100" })).length, 0);
});
