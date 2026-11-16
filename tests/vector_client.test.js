const test = require("node:test");
const assert = require("node:assert/strict");
const { createVectorClient } = require("../data/db/vector_client.js");

// Stub of @upstash/vector's Index: records calls made through index.namespace(ns).
function stubIndexClass({ hang = false, throwErr = null } = {}) {
  const calls = [];
  class StubIndex {
    constructor(cfg) { this.cfg = cfg; }
    namespace(ns) {
      const rec = (method) => async (...args) => {
        calls.push({ ns, method, args });
        if (throwErr) throw throwErr;
        if (hang) return new Promise(() => {});
        if (method === "query") return [{ id: "a", score: 0.9, metadata: { x: 1 } }];
        if (method === "fetch") return [{ id: "a", metadata: { x: 1 } }, null];
        return "Success";
      };
      return { upsert: rec("upsert"), query: rec("query"), fetch: rec("fetch"), delete: rec("delete") };
    }
  }
  return { StubIndex, calls };
}

test("returns null when url or token is missing", () => {
  assert.equal(createVectorClient({}), null);
  assert.equal(createVectorClient({ url: "u" }), null);
  assert.equal(createVectorClient({ token: "t" }), null);
});

test("upsert goes to the namespace with the items as given", async () => {
  const { StubIndex, calls } = stubIndexClass();
  const v = createVectorClient({ url: "u", token: "t", IndexClass: StubIndex });
  const items = [{ id: "c1", data: "hello", metadata: { a: 1 } }];
  await v.upsert("chat", items);
  assert.deepEqual(calls, [{ ns: "chat", method: "upsert", args: [items] }]);
});

test("query always asks for metadata and passes the filter", async () => {
  const { StubIndex, calls } = stubIndexClass();
  const v = createVectorClient({ url: "u", token: "t", IndexClass: StubIndex });
  const res = await v.query("chat", { data: "minecraft", topK: 5, filter: "guildId = '1'" });
  assert.deepEqual(calls[0].args, [{ data: "minecraft", topK: 5, filter: "guildId = '1'", includeMetadata: true }]);
  assert.deepEqual(res, [{ id: "a", score: 0.9, metadata: { x: 1 } }]);
});

test("query without a filter doesn't send one", async () => {
  const { StubIndex, calls } = stubIndexClass();
  const v = createVectorClient({ url: "u", token: "t", IndexClass: StubIndex });
  await v.query("commands", { data: "play", topK: 3 });
  assert.deepEqual(calls[0].args, [{ data: "play", topK: 3, includeMetadata: true }]);
});

test("fetch includes metadata and keeps nulls for missing ids", async () => {
  const { StubIndex, calls } = stubIndexClass();
  const v = createVectorClient({ url: "u", token: "t", IndexClass: StubIndex });
  const res = await v.fetch("chat", ["a", "b"]);
  assert.deepEqual(calls[0].args, [["a", "b"], { includeMetadata: true }]);
  assert.deepEqual(res, [{ id: "a", metadata: { x: 1 } }, null]);
});

test("remove of an empty list makes no call; otherwise deletes by ids", async () => {
  const { StubIndex, calls } = stubIndexClass();
  const v = createVectorClient({ url: "u", token: "t", IndexClass: StubIndex });
  await v.remove("chat", []);
  assert.equal(calls.length, 0);
  await v.remove("chat", ["a"]);
  assert.deepEqual(calls[0], { ns: "chat", method: "delete", args: [["a"]] });
});

test("removeByFilter deletes by metadata filter in the namespace", async () => {
  const { StubIndex, calls } = stubIndexClass();
  const v = createVectorClient({ url: "u", token: "t", IndexClass: StubIndex });
  await v.removeByFilter("chat", "switchId = '100'");
  assert.deepEqual(calls[0], { ns: "chat", method: "delete", args: [{ filter: "switchId = '100'" }] });
});

test("a call that never resolves times out", async () => {
  const { StubIndex } = stubIndexClass({ hang: true });
  const v = createVectorClient({ url: "u", token: "t", IndexClass: StubIndex, timeoutMs: 20 });
  await assert.rejects(v.query("chat", { data: "x", topK: 1 }), /Timed out/);
});

test("a rate-limit error is warned about and rethrown", async (t) => {
  const err = Object.assign(new Error("Exceeded daily request limit"), { status: 429 });
  const { StubIndex } = stubIndexClass({ throwErr: err });
  const v = createVectorClient({ url: "u", token: "t", IndexClass: StubIndex });
  const warn = t.mock.method(console, "warn", () => {});
  await assert.rejects(v.upsert("chat", [{ id: "x", data: "y" }]), /limit/);
  assert.equal(warn.mock.callCount(), 1);
});
