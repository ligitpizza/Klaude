const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeRedis, fakeChannel, fakeMember, fakeGuild, ChannelTypes } = require("./helpers/fakes.js");
const { createIndexedChannels, storageTarget, allowedSources } = require("../data/rag/channels.js");

// #general: public. #mod-chat: only "mod" can view. #art: public, but "bob"
// is blocked by a role override. #off: public, not indexed.
function server() {
  const general = fakeChannel({ id: "100", name: "general" });
  const modChat = fakeChannel({ id: "500", name: "mod-chat", everyoneCanView: false, viewers: new Set(["mod"]) });
  const art = fakeChannel({ id: "600", name: "art", viewers: new Set(["mod", "alice"]) });
  const off = fakeChannel({ id: "700", name: "off" });
  const guild = fakeGuild("1", [general, modChat, art, off]);
  return { general, modChat, art, off, guild };
}

async function indexedFor(ids) {
  const indexed = createIndexedChannels({ redis: new FakeRedis() });
  for (const id of ids) await indexed.set("1", id, true);
  return indexed;
}

test("asking in #general: public channels only, never #mod-chat — even for a mod", async () => {
  const { general, guild } = server();
  const indexed = await indexedFor(["100", "500", "600"]);
  const r = allowedSources({ guild, askChannel: general, member: fakeMember("mod"), indexed });
  assert.deepEqual(r.switchIds.sort(), ["100", "600"]);
  assert.equal(r.askKey, "100");
});

test("asking in #mod-chat: its own memory plus public channels", async () => {
  const { modChat, guild } = server();
  const indexed = await indexedFor(["100", "500"]);
  const r = allowedSources({ guild, askChannel: modChat, member: fakeMember("mod"), indexed });
  assert.deepEqual(r.switchIds, ["100"]);
  assert.equal(r.askKey, "500");
});

test("a public channel the asker can't view is left out", async () => {
  const { general, guild } = server();
  const indexed = await indexedFor(["100", "600"]);
  const r = allowedSources({ guild, askChannel: general, member: fakeMember("bob"), indexed });
  assert.deepEqual(r.switchIds, ["100"]);
});

test("asking in a channel that isn't indexed gives no askKey; unindexed channels never appear", async () => {
  const { off, guild } = server();
  const indexed = await indexedFor(["100"]);
  const r = allowedSources({ guild, askChannel: off, member: fakeMember("alice"), indexed });
  assert.equal(r.askKey, null);
  assert.deepEqual(r.switchIds, ["100"]);
});

test("storageTarget: text channel, public thread, private thread, DM", () => {
  const { general } = server();
  assert.deepEqual(storageTarget(general), { key: "100", switchId: "100", channelName: "general" });
  const thread = fakeChannel({ id: "300", name: "map-reset", type: ChannelTypes.PublicThread, parent: general });
  assert.deepEqual(storageTarget(thread), { key: "300", switchId: "100", channelName: "general › map-reset" });
  const priv = fakeChannel({ id: "301", name: "secret", type: ChannelTypes.PrivateThread, parent: general });
  assert.equal(storageTarget(priv), null);
  assert.equal(storageTarget(fakeChannel({ id: "9", name: "dm", type: ChannelTypes.DM })), null);
  assert.equal(storageTarget(null), null);
});

test("asking in a public thread of an indexed channel searches that thread as askKey", async () => {
  const { general, guild } = server();
  const indexed = await indexedFor(["100"]);
  const thread = fakeChannel({ id: "300", name: "map-reset", type: ChannelTypes.PublicThread, parent: general });
  const r = allowedSources({ guild, askChannel: thread, member: fakeMember("alice"), indexed });
  assert.equal(r.askKey, "300");
  assert.deepEqual(r.switchIds, ["100"]);
});

test("asking in a private thread gives no askKey", async () => {
  const { modChat, guild } = server();
  const indexed = await indexedFor(["500"]);
  const priv = fakeChannel({ id: "501", name: "x", type: ChannelTypes.PrivateThread, parent: modChat });
  assert.equal(allowedSources({ guild, askChannel: priv, member: fakeMember("mod"), indexed }).askKey, null);
});

test("indexed channels update immediately and survive a reload from Redis", async () => {
  const redis = new FakeRedis();
  const a = createIndexedChannels({ redis });
  await a.set("1", "100", true);
  await a.set("1", "200", true);
  await a.set("1", "200", false);
  assert.equal(a.isIndexed("1", "100"), true);
  assert.equal(a.isIndexed("1", "200"), false);
  assert.deepEqual(a.list("1"), ["100"]);

  const b = createIndexedChannels({ redis });
  assert.equal(b.isIndexed("1", "100"), false, "nothing until load()");
  await b.load(["1", "2"]);
  assert.equal(b.isIndexed("1", "100"), true);
  assert.deepEqual(b.list("2"), []);
});

test("isIndexed costs no Redis calls", async () => {
  const redis = new FakeRedis();
  const a = createIndexedChannels({ redis });
  await a.set("1", "100", true);
  const before = redis.calls;
  for (let i = 0; i < 50; i++) a.isIndexed("1", "100");
  assert.equal(redis.calls, before);
});
