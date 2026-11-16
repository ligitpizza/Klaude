const test = require("node:test");
const assert = require("node:assert/strict");
const { historyEntry, visibleHistory } = require("../data/rag/history.js");
const { isPublicChannel } = require("../data/rag/channels.js");
const { fakeChannel, fakeGuild, ChannelTypes } = require("./helpers/fakes.js");

test("history entries remember where they were said and whether it was public", () => {
  assert.deepEqual(historyEntry("assistant", "hi", { channelId: "500", pub: false }),
    { role: "assistant", content: "hi", channelId: "500", pub: false });
});

test("C1: an answer given in a restricted channel is not replayed in another channel", () => {
  const entries = [
    historyEntry("user", "what did we decide about banning X?", { channelId: "500", pub: false }),
    historyEntry("assistant", "Mods agreed to ban X on Friday.", { channelId: "500", pub: false }),
    historyEntry("user", "hello", { channelId: "100", pub: true }),
  ];
  const inGeneral = visibleHistory(entries, "100");
  assert.deepEqual(inGeneral.map(e => e.content), ["hello"]);
  const inMods = visibleHistory(entries, "500");
  assert.equal(inMods.length, 3);
});

test("visibleHistory returns plain {role, content} for the model", () => {
  const out = visibleHistory([historyEntry("user", "hi", { channelId: "100", pub: true })], "200");
  assert.deepEqual(out, [{ role: "user", content: "hi" }]);
});

test("entries saved before this change (no channel info) are still shown", () => {
  assert.deepEqual(visibleHistory([{ role: "user", content: "old" }], "100"), [{ role: "user", content: "old" }]);
});

test("isPublicChannel: @everyone can view; threads follow parent; private threads and restricted channels aren't", () => {
  const general = fakeChannel({ id: "100", name: "general" });
  const mods = fakeChannel({ id: "500", name: "mod-chat", everyoneCanView: false, viewers: new Set(["mod"]) });
  const guild = fakeGuild("1", [general, mods]);
  assert.equal(isPublicChannel(general, guild), true);
  assert.equal(isPublicChannel(mods, guild), false);
  assert.equal(isPublicChannel(fakeChannel({ id: "300", name: "t", type: ChannelTypes.PublicThread, parent: general }), guild), true);
  assert.equal(isPublicChannel(fakeChannel({ id: "301", name: "p", type: ChannelTypes.PrivateThread, parent: general }), guild), false);
  assert.equal(isPublicChannel(general, null), false);
});
