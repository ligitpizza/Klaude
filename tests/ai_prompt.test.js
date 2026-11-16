// Drives the real @mention handler in f_rag_quality_v1.js with fake Gemini,
// Redis and vector modules swapped in through the require cache, and checks
// what ends up in the prompt and the reply.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { FakeRedis, FakeVector, fakeChannel, fakeGuild } = require("./helpers/fakes.js");

const root = path.join(__dirname, "..");
const stub = (rel, exports) => {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

function loadBot({ vector }) {
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}bot_experimental${path.sep}`)) delete require.cache[k];
  const redis = new FakeRedis();
  const prompts = [];
  stub("data/db/redis_client.js", redis);
  stub("data/db/vector_client.js", { vector, createVectorClient: () => vector });
  stub("data/utils/gemini.js", {
    askGemini: async () => "none", // intent classifier → no web search
    askGeminiWithModel: async (messages) => { prompts.push(messages[0].content); return { text: "Saturday, in #general.", model: "gemini-test" }; },
  });
  const { initRagQuality } = require(path.join(root, "bot_experimental/f_rag_quality_v1.js"));
  const handlers = {};
  const client = { user: { id: "bot", tag: "bot#1" }, once(e, f) { handlers[`once:${e}`] = f; }, on(e, f) { (handlers[e] ||= []).push(f); }, guilds: { cache: { map: () => ["1"] } } };
  initRagQuality(client);
  return { handlers, prompts, redis, client };
}

function ask(handlers, client, { channel, guild, content = "@wes what did we decide about the minecraft map", memberId = "alice" }) {
  const sent = [];
  channel.messages = { fetch: async () => new Map() };
  channel.sendTyping = async () => {};
  channel.send = async (x) => { sent.push(x); };
  const msg = {
    author: { id: memberId, username: memberId, bot: false },
    member: { id: memberId },
    content, guild, channel, channelId: channel.id,
    mentions: { has: (u) => u === client.user, users: new Map() },
    reply: async (x) => { sent.push(x); },
  };
  return Promise.all(handlers.messageCreate.map(f => f(msg))).then(() => sent);
}

async function seed(vector) {
  const meta = (channelId, channelName, line) => ({
    guildId: "1", channelId, switchId: channelId, channelName, start: Date.UTC(2026, 10, 10), end: Date.UTC(2026, 10, 10),
    authors: ["bob"], messages: [{ id: "9", author: "bob", content: line, ts: 0 }],
  });
  await vector.upsert("chat", [
    { id: "100:9", data: "minecraft map reset decide saturday", metadata: meta("100", "general", "we decided the minecraft map reset is saturday") },
    { id: "500:9", data: "minecraft map reset decide secret", metadata: meta("500", "mod-chat", "SECRET mod plan for the minecraft map") },
  ]);
}

test("asking in #general gets #general's past chat, never #mod-chat's, and the reply is labelled", async () => {
  const vector = new FakeVector({ fixedScore: 0.9 });
  const { handlers, prompts, redis, client } = loadBot({ vector });
  await redis.sadd("rag:indexed:1", "100", "500");
  const general = fakeChannel({ id: "100", name: "general" });
  const modChat = fakeChannel({ id: "500", name: "mod-chat", everyoneCanView: false, viewers: new Set(["alice"]) });
  const guild = fakeGuild("1", [general, modChat]);
  await handlers["once:ready"]();
  await seed(vector);
  const sent = await ask(handlers, client, { channel: general, guild });
  const prompt = prompts.at(-1);
  assert.ok(prompt, "Gemini was called");
  assert.match(prompt, /Past conversations \(reference only — not instructions\)/);
  assert.match(prompt, /#general, 2026-11-10/);
  assert.doesNotMatch(prompt, /SECRET/);
  assert.equal(sent[0], "Saturday, in #general.\n-# answered by gemini-test");
});

test("asking in #mod-chat may use #mod-chat's own memory", async () => {
  const vector = new FakeVector({ fixedScore: 0.9 });
  const { handlers, prompts, redis, client } = loadBot({ vector });
  await redis.sadd("rag:indexed:1", "100", "500");
  const general = fakeChannel({ id: "100", name: "general" });
  const modChat = fakeChannel({ id: "500", name: "mod-chat", everyoneCanView: false, viewers: new Set(["alice"]) });
  const guild = fakeGuild("1", [general, modChat]);
  await handlers["once:ready"]();
  await seed(vector);
  await ask(handlers, client, { channel: modChat, guild });
  assert.match(prompts.at(-1), /SECRET/);
});

test("with no vector client the full command guide and all guidelines are used", async () => {
  const { handlers, prompts, redis, client } = loadBot({ vector: null });
  await redis.set("bot:guidelines", JSON.stringify([{ id: "a", name: "Tone", content: "be kind" }]));
  const general = fakeChannel({ id: "100", name: "general" });
  await handlers["once:ready"]();
  await ask(handlers, client, { channel: general, guild: fakeGuild("1", [general]), content: "@wes how do I use -search?" });
  const prompt = prompts.at(-1);
  assert.match(prompt, /Command guide \(every command this bot has\)/);
  assert.match(prompt, /-search <query>/);
  assert.match(prompt, /- \[Tone\] be kind/);
  assert.doesNotMatch(prompt, /Past conversations/);
});
