const test = require("node:test");
const assert = require("node:assert/strict");
const { findClosestCommands } = require("../data/commands.js");

const suggest = (text) => {
  const r = findClosestCommands(text);
  return r === null ? null : r.suggestions.map(c => c.cmd);
};

test("typos still get the closest command", () => {
  assert.deepEqual(suggest("-serch lofi"), ["-search"]);
  assert.deepEqual(suggest("ai--memoclear"), ["ai--memoclr"]);
});

test("a cut-off ai-- command suggests what it starts", () => {
  assert.deepEqual(suggest("ai--in"), ["ai--index"]);
  assert.deepEqual(suggest("ai--i"), ["ai--index"]);
  assert.deepEqual(suggest("ai--memo"), ["ai--memoclr", "ai--memostat"]);
  assert.deepEqual(suggest("ai--he"), ["ai--help"]);
});

test("a cut-off -- command suggests what it starts", () => {
  assert.deepEqual(suggest("--he"), ["--help"]);
  assert.deepEqual(suggest("--my"), ["--myid"]);
});

test("a bare ai-- points to ai--help", () => {
  assert.deepEqual(suggest("ai--"), ["ai--help"]);
});

test("short plain-dash words in chat stay quiet", () => {
  assert.deepEqual(suggest("-in"), []);
  assert.deepEqual(suggest("-ok"), []);
});

test("valid commands are never corrected", () => {
  assert.equal(suggest("ai--index on"), null);
  assert.equal(suggest("-p song"), null);
});

test("ai--help lists the chat memory and pin commands", async () => {
  const { initManual } = require("../manual.js");
  const handlers = {};
  initManual({ once() {}, on(e, f) { handlers[e] = f; }, users: { fetch: async () => ({ tag: "owner" }) } });
  let reply;
  await handlers.messageCreate({ author: { bot: false, id: "1" }, content: "ai--help", reply: async (r) => { reply = r; } });
  const text = JSON.stringify(reply.embeds[0].toJSON());
  assert.match(text, /ai--index on\|off\|status/);
  assert.match(text, /ai--g -p <id>/);
});
