const test = require("node:test");
const assert = require("node:assert/strict");
const { createGemini, DEFAULT_MODELS, parseModelList } = require("../data/utils/gemini.js");

// Fake fetch: `script[model]` is a list of responses used in order (the last
// one repeats). A response is { status, content, retryAfter } or "throw".
function fakeFetch(script) {
  const calls = [];
  const used = {};
  const fetchImpl = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    calls.push(model);
    const list = script[model] || [{ status: 500 }];
    const i = Math.min(used[model] || 0, list.length - 1);
    used[model] = (used[model] || 0) + 1;
    const r = list[i];
    if (r === "throw") throw new Error("network down");
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (h) => (h.toLowerCase() === "retry-after" && r.retryAfter != null ? String(r.retryAfter) : null) },
      json: async () => ({ choices: [{ message: { content: r.content ?? "" } }] }),
      text: async () => "error body",
    };
  };
  return { fetchImpl, calls };
}

const ok = (content) => ({ status: 200, content });
const msgs = [{ role: "user", content: "hello" }];

test("DEFAULT_MODELS is the free text-model chain in order", () => {
  assert.deepEqual(DEFAULT_MODELS, [
    "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash",
    "gemini-3.8-flash", "gemini-3-flash-preview", "gemini-2.5-flash-lite",
  ]);
});

test("parseModelList falls back to defaults and trims entries", () => {
  assert.deepEqual(parseModelList(undefined), DEFAULT_MODELS);
  assert.deepEqual(parseModelList("  "), DEFAULT_MODELS);
  assert.deepEqual(parseModelList(" a, ,b "), ["a", "b"]);
});

test("first model answering returns its text and name", async () => {
  const { fetchImpl } = fakeFetch({ m1: [ok("hi")] });
  const g = createGemini({ fetchImpl, models: ["m1", "m2"], now: () => 0 });
  assert.deepEqual(await g.askGeminiWithModel(msgs), { text: "hi", model: "m1" });
});

test("a 429 falls through to the next model", async () => {
  const { fetchImpl } = fakeFetch({ m1: [{ status: 429 }], m2: [ok("from m2")] });
  const g = createGemini({ fetchImpl, models: ["m1", "m2"], now: () => 0 });
  assert.deepEqual(await g.askGeminiWithModel(msgs), { text: "from m2", model: "m2" });
});

test("a rate-limited model is skipped for 60s, then tried again", async () => {
  let t = 0;
  const { fetchImpl, calls } = fakeFetch({ m1: [{ status: 429 }, ok("m1 back")], m2: [ok("m2")] });
  const g = createGemini({ fetchImpl, models: ["m1", "m2"], now: () => t });
  await g.askGeminiWithModel(msgs);          // m1 429 → m2
  t = 30_000;
  calls.length = 0;
  await g.askGeminiWithModel(msgs);
  assert.deepEqual(calls, ["m2"]);
  t = 61_000;
  calls.length = 0;
  const r = await g.askGeminiWithModel(msgs);
  assert.deepEqual(calls, ["m1"]);
  assert.equal(r.model, "m1");
});

test("Retry-After sets the cooldown length", async () => {
  let t = 0;
  const { fetchImpl, calls } = fakeFetch({ m1: [{ status: 429, retryAfter: 5 }, ok("back")], m2: [ok("m2")] });
  const g = createGemini({ fetchImpl, models: ["m1", "m2"], now: () => t });
  await g.askGeminiWithModel(msgs);
  t = 4_000; calls.length = 0;
  await g.askGeminiWithModel(msgs);
  assert.deepEqual(calls, ["m2"]);
  t = 5_001; calls.length = 0;
  await g.askGeminiWithModel(msgs);
  assert.deepEqual(calls, ["m1"]);
});

test("network errors and 500s fall through and cool the model down", async () => {
  for (const bad of ["throw", { status: 500 }]) {
    let t = 0;
    const { fetchImpl, calls } = fakeFetch({ m1: [bad], m2: [ok("m2")] });
    const g = createGemini({ fetchImpl, models: ["m1", "m2"], now: () => t });
    assert.equal((await g.askGeminiWithModel(msgs)).model, "m2");
    t = 1_000; calls.length = 0;
    await g.askGeminiWithModel(msgs);
    assert.deepEqual(calls, ["m2"], `cooldown after ${JSON.stringify(bad)}`);
  }
});

test("an empty answer falls through but does not cool the model down", async () => {
  let t = 0;
  const { fetchImpl, calls } = fakeFetch({ m1: [ok("")], m2: [ok("m2")] });
  const g = createGemini({ fetchImpl, models: ["m1", "m2"], now: () => t });
  assert.equal((await g.askGeminiWithModel(msgs)).model, "m2");
  t = 1_000; calls.length = 0;
  await g.askGeminiWithModel(msgs);
  assert.deepEqual(calls, ["m1", "m2"]);
});

test("when every model is cooling down, all are still tried in order", async () => {
  let t = 0;
  const { fetchImpl, calls } = fakeFetch({ m1: [{ status: 429 }], m2: [{ status: 429 }], m3: [{ status: 429 }] });
  const g = createGemini({ fetchImpl, models: ["m1", "m2", "m3"], now: () => t });
  await g.askGeminiWithModel(msgs);
  t = 1_000; calls.length = 0;
  assert.equal(await g.askGeminiWithModel(msgs), null);
  assert.deepEqual(calls, ["m1", "m2", "m3"]);
});

test("askGemini returns just the text, or null when everything fails", async () => {
  const good = createGemini({ fetchImpl: fakeFetch({ m1: [ok("text")] }).fetchImpl, models: ["m1"], now: () => 0 });
  assert.equal(await good.askGemini(msgs), "text");
  const bad = createGemini({ fetchImpl: fakeFetch({ m1: [{ status: 500 }] }).fetchImpl, models: ["m1"], now: () => 0 });
  assert.equal(await bad.askGemini(msgs), null);
});
