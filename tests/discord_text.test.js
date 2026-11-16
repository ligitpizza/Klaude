const test = require("node:test");
const assert = require("node:assert/strict");
const { splitWithLabel, modelLabel } = require("../data/utils/discord_text.js");

test("modelLabel is Discord small text naming the model", () => {
  assert.equal(modelLabel("gemini-3.5-flash-lite"), "-# answered by gemini-3.5-flash-lite");
});

test("short text gets the label on a new line, in one piece", () => {
  assert.deepEqual(splitWithLabel("hello", "-# answered by m"), ["hello\n-# answered by m"]);
});

test("label that would push a reply past 2000 chars moves to a final piece", () => {
  const text = "a".repeat(1995);
  const label = modelLabel("gemini-3.1-flash-lite");
  const pieces = splitWithLabel(text, label);
  assert.equal(pieces.length, 2);
  for (const p of pieces) assert.ok(p.length <= 2000, `piece of ${p.length}`);
  assert.ok(pieces.at(-1).endsWith(label));
  const joined = pieces.join("");
  assert.equal(joined.slice(0, -(label.length + 1)), text);
});

test("long text splits into ≤2000-char pieces with the label only on the last", () => {
  const text = "b".repeat(4500);
  const label = modelLabel("m");
  const pieces = splitWithLabel(text, label);
  assert.equal(pieces.length, 3);
  for (const p of pieces) assert.ok(p.length <= 2000);
  assert.equal(pieces.filter(p => p.includes(label)).length, 1);
  assert.ok(pieces[2].endsWith(label));
});

test("without a label it is a plain 2000-char split", () => {
  const pieces = splitWithLabel("c".repeat(4001));
  assert.deepEqual(pieces.map(p => p.length), [2000, 2000, 1]);
});
