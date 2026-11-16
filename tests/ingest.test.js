const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");
const { FakeRedis, FakeVector, ChannelTypes } = require("./helpers/fakes.js");
const { ChunkBuffer } = require("../data/rag/chunker.js");
const { createChatStore } = require("../data/rag/chat_store.js");
const { createIndexedChannels } = require("../data/rag/channels.js");
const { createIngest, handleIndexCommand } = require("../data/rag/ingest.js");

const MIN = 60_000;

// Channel whose permissionsFor() answers per flag: view always, manage per member.
function channel({ id = "100", name = "general", type = ChannelTypes.GuildText, parent = null, managers = new Set(["mod"]) } = {}) {
  return {
    id, name, type, parent, parentId: parent?.id ?? null,
    isThread: () => type === ChannelTypes.PublicThread || type === ChannelTypes.PrivateThread,
    permissionsFor: (who) => ({
      has: (flag) => (flag === PermissionFlagsBits.ManageChannels ? managers.has(who?.id) : true),
    }),
  };
}

function message({ id = "11", content = "hello there", ts = 0, authorId = "u1", username = "alice", bot = false, ch = channel(), mentions = {} } = {}) {
  const replies = [];
  return {
    id, content, createdTimestamp: ts,
    author: { id: authorId, username, bot },
    member: { id: authorId },
    guild: { id: "1" },
    channel: ch, channelId: ch.id,
    mentions: { users: new Map(Object.entries(mentions)) },
    reply: async (r) => { replies.push(r); return r; },
    replies,
  };
}

async function setup({ indexedIds = ["100"] } = {}) {
  const vector = new FakeVector();
  const redis = new FakeRedis();
  const store = createChatStore({ vector, redis });
  const indexed = createIndexedChannels({ redis });
  for (const id of indexedIds) await indexed.set("1", id, true);
  let now = 0;
  const ingest = createIngest({ buffer: new ChunkBuffer(), store, indexed, now: () => now });
  return { vector, redis, store, indexed, ingest, setNow: (t) => { now = t; } };
}

const text = (reply) => {
  const e = reply.embeds?.[0];
  const j = e?.toJSON ? e.toJSON() : e;
  return `${j?.title ?? ""} ${j?.description ?? ""}`;
};

test("messages in an indexed channel are buffered and saved when the chunk closes", async () => {
  const { ingest, vector } = await setup();
  await ingest.onMessage(message({ id: "11", ts: 0 }));
  await ingest.onMessage(message({ id: "12", ts: MIN }));
  assert.deepEqual(vector.ids("chat"), []);
  await ingest.onMessage(message({ id: "13", ts: 20 * MIN }));
  assert.deepEqual(vector.ids("chat"), ["100:11"]);
});

test("skips bots, DMs, unindexed channels, private threads and bot commands", async () => {
  const { ingest, vector } = await setup();
  const priv = channel({ id: "301", type: ChannelTypes.PrivateThread, parent: channel() });
  const skipped = [
    message({ bot: true }),
    { ...message(), guild: null },
    message({ ch: channel({ id: "999", name: "off" }) }),
    message({ ch: priv }),
    message({ content: "-play lofi" }),
    message({ content: "--help" }),
    message({ content: "ai--memostat" }),
  ];
  for (const m of skipped) await ingest.onMessage(m);
  await ingest.flushAll();
  assert.deepEqual(vector.ids("chat"), []);
});

test("public threads are stored under the parent's switch", async () => {
  const { ingest, vector } = await setup();
  const thread = channel({ id: "300", name: "map-reset", type: ChannelTypes.PublicThread, parent: channel() });
  await ingest.onMessage(message({ id: "31", ch: thread }));
  await ingest.flushAll();
  const stored = vector.get("chat", "300:31");
  assert.equal(stored.metadata.switchId, "100");
  assert.equal(stored.metadata.channelName, "general › map-reset");
});

test("user mentions are stored as @username", async () => {
  const { ingest, vector } = await setup();
  await ingest.onMessage(message({ content: "ask <@42> or <@!43>", mentions: { 42: { username: "bob" } } }));
  await ingest.flushAll();
  assert.match(vector.get("chat", "100:11").data, /ask @bob or @user/);
});

test("sweep saves chunks idle for over 10 minutes", async () => {
  const { ingest, vector, setNow } = await setup();
  await ingest.onMessage(message({ ts: 0 }));
  setNow(5 * MIN); await ingest.sweep();
  assert.deepEqual(vector.ids("chat"), []);
  setNow(11 * MIN); await ingest.sweep();
  assert.deepEqual(vector.ids("chat"), ["100:11"]);
});

test("edits: open chunk in memory, stored chunk in the store, partials ignored", async () => {
  const { ingest, vector } = await setup();
  await ingest.onMessage(message({ id: "11", content: "first" }));
  await ingest.onUpdate(null, message({ id: "11", content: "first edited" }));
  await ingest.flushAll();
  assert.match(vector.get("chat", "100:11").data, /first edited/);

  await ingest.onUpdate(null, message({ id: "11", content: "edited again" }));
  assert.match(vector.get("chat", "100:11").data, /edited again/);

  const partial = { id: "11", partial: true, content: null, author: null, channel: channel(), channelId: "100", guild: { id: "1" } };
  await assert.doesNotReject(ingest.onUpdate(null, partial));
  assert.match(vector.get("chat", "100:11").data, /edited again/);
});

test("deletes after a restart arrive as partials and still remove the line", async () => {
  const { ingest, vector } = await setup();
  await ingest.onMessage(message({ id: "11", content: "keep" }));
  await ingest.onMessage(message({ id: "12", content: "remove me" }));
  await ingest.flushAll();
  await ingest.onDelete({ id: "12", partial: true, content: null, author: null, channel: channel(), channelId: "100", guild: { id: "1" } });
  assert.doesNotMatch(vector.get("chat", "100:11").data, /remove me/);
});

test("a delete with no resolvable channel is ignored without throwing", async () => {
  const { ingest } = await setup();
  await assert.doesNotReject(ingest.onDelete({ id: "12", partial: true, channel: null, channelId: "100", guild: null }));
});

test("stopChannel drops unsaved chunks so they're never saved later", async () => {
  const { ingest, vector } = await setup();
  await ingest.onMessage(message({ id: "11" }));
  const thread = channel({ id: "300", name: "t", type: ChannelTypes.PublicThread, parent: channel() });
  await ingest.onMessage(message({ id: "31", ch: thread }));
  ingest.stopChannel("100");
  await ingest.flushAll();
  assert.deepEqual(vector.ids("chat"), []);
});

test("a failing save is logged, not thrown", async (t) => {
  const { ingest, vector } = await setup();
  const err = t.mock.method(console, "error", () => {});
  vector.failAlways();
  await ingest.onMessage(message({ id: "11" }));
  await assert.doesNotReject(ingest.flushAll());
  assert.ok(err.mock.callCount() >= 1);
});

// ── ai--index ────────────────────────────────────────────────────────────────
test("ai--index on needs Manage Channels", async () => {
  const deps = await setup({ indexedIds: [] });
  const m = message({ content: "ai--index on", authorId: "nobody" });
  await handleIndexCommand(m, deps);
  assert.match(text(m.replies[0]), /Manage Channels/);
  assert.equal(deps.indexed.isIndexed("1", "100"), false);
});

test("ai--index on turns memory on and says only new messages count", async () => {
  const deps = await setup({ indexedIds: [] });
  const m = message({ content: "ai--index on", authorId: "mod" });
  await handleIndexCommand(m, deps);
  assert.equal(deps.indexed.isIndexed("1", "100"), true);
  assert.match(text(m.replies[0]), /new messages/i);
});

test("ai--index off stops, deletes everything stored and reports the count", async () => {
  const deps = await setup();
  await deps.ingest.onMessage(message({ id: "11" }));
  await deps.ingest.flushAll();
  await deps.ingest.onMessage(message({ id: "12", ts: 30 * MIN }));
  const m = message({ content: "ai--index off", authorId: "mod" });
  await handleIndexCommand(m, deps);
  assert.equal(deps.indexed.isIndexed("1", "100"), false);
  await deps.ingest.flushAll();
  assert.deepEqual(deps.vector.ids("chat"), []);
  assert.match(text(m.replies[0]), /\b1\b/);
});

test("ai--index status works for anyone and shows the chunk count", async () => {
  const deps = await setup();
  await deps.ingest.onMessage(message({ id: "11" }));
  await deps.ingest.flushAll();
  const m = message({ content: "ai--index status", authorId: "nobody" });
  await handleIndexCommand(m, deps);
  assert.match(text(m.replies[0]), /on/i);
  assert.match(text(m.replies[0]), /\b1\b/);
});

test("ai--index inside a thread points to the parent channel", async () => {
  const deps = await setup();
  const thread = channel({ id: "300", name: "t", type: ChannelTypes.PublicThread, parent: channel() });
  const m = message({ content: "ai--index on", authorId: "mod", ch: thread });
  await handleIndexCommand(m, deps);
  assert.match(text(m.replies[0]), /parent channel/i);
});

test("bare ai--index shows the usage line", async () => {
  const deps = await setup();
  const m = message({ content: "ai--index", authorId: "mod" });
  await handleIndexCommand(m, deps);
  assert.match(text(m.replies[0]), /ai--index on\|off\|status/);
});
