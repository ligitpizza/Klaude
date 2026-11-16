const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeRedis, FakeVector } = require("./helpers/fakes.js");
const { COMMANDS } = require("../data/commands.js");
const {
  commandVectors, syncCommands, guidelineVector, upsertGuideline, removeGuideline, syncGuidelines,
} = require("../data/rag/knowledge_sync.js");

test("commandVectors covers non-hidden commands with usage, desc and note", () => {
  const vecs = commandVectors(COMMANDS);
  const ids = vecs.map(v => v.id);
  assert.ok(ids.includes("-play"));
  assert.ok(!ids.includes("--track"), "hidden commands stay out");
  const play = vecs.find(v => v.id === "-play");
  assert.equal(play.data, "-play <song/url> — Play from YouTube, Spotify, SoundCloud. You must be in a voice channel.");
  assert.equal(play.metadata.group, "music");
  const stop = vecs.find(v => v.id === "-stop");
  assert.equal(stop.data, "-stop — Stop and clear queue.");
});

test("syncCommands upserts once, then skips while the registry is unchanged", async () => {
  const vector = new FakeVector();
  const redis = new FakeRedis();
  assert.equal(await syncCommands({ vector, redis, commands: COMMANDS }), "synced");
  assert.equal(vector.ids("commands").length, commandVectors(COMMANDS).length);
  vector.calls.length = 0;
  assert.equal(await syncCommands({ vector, redis, commands: COMMANDS }), "skipped");
  assert.equal(vector.calls.length, 0);
});

test("syncCommands deletes commands that were removed from the registry", async () => {
  const vector = new FakeVector();
  const redis = new FakeRedis();
  await syncCommands({ vector, redis, commands: COMMANDS });
  const fewer = COMMANDS.filter(c => c.cmd !== "-stop");
  assert.equal(await syncCommands({ vector, redis, commands: fewer }), "synced");
  assert.ok(!vector.ids("commands").includes("-stop"));
  assert.ok(vector.ids("commands").includes("-play"));
});

test("guidelineVector embeds name and content", () => {
  assert.deepEqual(guidelineVector({ id: "a", name: "IP", content: "mc.example.net" }), {
    id: "a", data: "IP: mc.example.net", metadata: { name: "IP", content: "mc.example.net" },
  });
});

test("upsertGuideline and removeGuideline keep the namespace in step", async () => {
  const vector = new FakeVector();
  await upsertGuideline(vector, { id: "a", name: "IP", content: "x" });
  assert.deepEqual(vector.ids("guidelines"), ["a"]);
  await removeGuideline(vector, "a");
  assert.deepEqual(vector.ids("guidelines"), []);
});

test("syncGuidelines only upserts the ones not stored yet", async () => {
  const vector = new FakeVector();
  await upsertGuideline(vector, { id: "a", name: "A", content: "1" });
  vector.calls.length = 0;
  await syncGuidelines({ vector, guidelines: [
    { id: "a", name: "A", content: "1" }, { id: "b", name: "B", content: "2" }, { id: "c", name: "C", content: "3" },
  ] });
  assert.deepEqual(vector.ids("guidelines").sort(), ["a", "b", "c"]);
  const upserts = vector.calls.filter(c => c.method === "upsert");
  assert.equal(upserts.length, 1);
  assert.equal(vector.get("guidelines", "b").data, "B: 2");
});

test("syncGuidelines with no guidelines makes no calls", async () => {
  const vector = new FakeVector();
  await syncGuidelines({ vector, guidelines: [] });
  assert.equal(vector.calls.length, 0);
});

test("togglePinned flips the flag and reports the new state, or null if missing", () => {
  const { togglePinned } = require("../data/rag/knowledge_sync.js");
  const list = [{ id: "a", name: "A", content: "1" }];
  assert.equal(togglePinned(list, "a"), true);
  assert.equal(list[0].pinned, true);
  assert.equal(togglePinned(list, "a"), false);
  assert.equal(list[0].pinned, undefined);
  assert.equal(togglePinned(list, "zzz"), null);
});

test("vector failures reject so callers can log them", async () => {
  const vector = new FakeVector();
  vector.failNext();
  await assert.rejects(syncCommands({ vector, redis: new FakeRedis(), commands: COMMANDS }));
});
