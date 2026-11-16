# Vector RAG + Gemini Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AI bot a working multi-model Gemini fallback with an "answered by" label, then real retrieval: commands, `ai--g` guidelines (with pinning) and opt-in channel chat stored in Upstash Vector and fetched per question.

**Architecture:** Pure logic (model selection, chunking, permission rule, command-group expansion, prompt formatting) lives in small modules under `data/` with dependencies injected, so it's tested with in-memory fakes. A thin adapter (`data/db/vector_client.js`) is the only code that touches `@upstash/vector`. `f_rag_quality_v1.js` wires it together and falls back to today's behaviour whenever the vector side is missing or failing.

**Tech Stack:** Node 22 (CommonJS), discord.js v14, `@upstash/redis` (existing), `@upstash/vector` (new), built-in `node:test` + `node:assert/strict` for tests.

**Spec:** `docs/superpowers/specs/2026-11-16-vector-rag-design.md` — read it before starting any task.

## Global Constraints

- CommonJS `require`/`module.exports`, matching the repo. No TypeScript, no ESM.
- Only new runtime dependency: `@upstash/vector`. No test-framework dependency — use `node:test`.
- Every outbound call is bounded with `withTimeout` from `data/utils/timeout.js` (vector calls: **8000 ms**, same as Redis).
- Env vars: `UPSTASH_VECTOR_REST_URL`, `UPSTASH_VECTOR_REST_TOKEN`, optional `GEMINI_MODELS` (comma-separated).
- Embed colour `#282d2f` for all new embeds.
- Default model order: `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.8-flash`, `gemini-3-flash-preview`, `gemini-2.5-flash-lite`.
- Model cooldown after a 429 or error: **60 000 ms**, or `Retry-After` seconds × 1000 when present.
- Label line exactly: `-# answered by <model>`.
- Chunking: close after a gap > **600 000 ms** (10 min), at **15** messages, or when idle 10 min; sweep every **60 000 ms**.
- Per-message content stored is capped at **1000** characters (keeps a 15-message chunk well under Upstash's 48 KB metadata limit).
- Retrieval: `topK` **5** per namespace; minimum score constant `MIN_SCORE = 0.75` (tunable, one constant).
- Namespaces: `commands`, `guidelines`, `chat`. Chunk id `<channelId>:<firstMessageId>`.
- Redis keys: `rag:indexed:<guildId>` (set), `rag:map:<channelId>` (hash messageId → chunkId), `rag:commands:hash` (string). Guidelines stay in `bot:guidelines`, gaining an optional `pinned: true`.
- `ai--index on|off` needs Manage Channels in that channel; `status` is open to everyone.
- Never crash or block a reply because of the vector side: log and fall back.
- Commit messages have **no** `Co-Authored-By` or "Generated with" lines (owner's rule).

## Review Focus

1. **Edit/delete after a restart** — `messageUpdate`/`messageDelete` arrive as partials (`partial: true`, `content: null`, no `author`). Expect: handled by ids only, no throw. Test in Task 8.
2. **Label pushes a reply over 2000 characters** — a 1995-char answer plus the label must split cleanly, label on the last piece, every piece ≤ 2000. Test in Task 2.
3. **Vector call throws or times out mid-question** — the reply still goes out with the full command guide and all guidelines. Test in Task 9.
4. **`ai--index off` while a chunk is still open in memory** — the open chunk is discarded, never flushed into the deleted channel later. Test in Task 8.
5. **Very long or empty messages** — Nitro 4000-char messages are capped; attachment-only (empty) messages are skipped; a full chunk's metadata JSON stays < 48 KB. Test in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `data/utils/gemini.js` (modify) | Model list, cooldown, `askGemini` / `askGeminiWithModel`, `createGemini` factory for tests |
| `data/utils/discord_text.js` (new) | `splitWithLabel()` — split text into ≤ 2000-char pieces, label on the last |
| `data/db/vector_client.js` (new) | Adapter over `@upstash/vector` with timeouts; `null` when env vars are missing |
| `data/rag/knowledge_sync.js` (new) | Sync commands (hash-gated) and guidelines into the vector index |
| `data/rag/chunker.js` (new) | `ChunkBuffer` — pure in-memory chunking, edit/remove/sweep/drain |
| `data/rag/chat_store.js` (new) | Persist chunks, apply edits/deletes, delete a channel, count, search |
| `data/rag/channels.js` (new) | Indexed-channel set (memory + Redis), storage target for a channel/thread, the `allowedSources` rule |
| `data/rag/ingest.js` (new) | Wires client events, sweep timer and shutdown flush to the buffer and store |
| `data/rag/retrieve.js` (new) | `retrieveContext()`, `expandCommandGroups()`, prompt block formatting |
| `bot_experimental/f_rag_quality_v1.js` (modify) | `ai--index`, `ai--g -p`, guideline sync hooks, retrieval in the prompt, label |
| `bot_modules/m_music.js` (modify) | Label in `-ask` embed footers |
| `data/commands.js` (modify) | `ai--index` and `ai--g -p` entries |
| `launch.js` (modify) | `Partials.Message`, `Partials.Channel` on the shared client |
| `tests/helpers/fakes.js` (new) | `FakeRedis`, `FakeVector`, fake Discord channel/member/guild builders |
| `tests/*.test.js` (new) | One test file per module above |
| `README.md`, `package.json` (modify) | Env vars, setup, privacy note; `"test": "node --test"`, `@upstash/vector` |

---

### Task 1: Gemini model fallback with cooldown

**Files:**
- Modify: `data/utils/gemini.js`
- Modify: `package.json` (`"test": "node --test"`)
- Create: `tests/gemini.test.js`
- Also commit: `docs/superpowers/specs/2026-11-16-vector-rag-design.md`, this plan

**Interfaces:**
- Produces:
  - `DEFAULT_MODELS: string[]` (the six ids in Global Constraints, in order)
  - `parseModelList(envValue?: string): string[]` — comma-split, trimmed, empties dropped; falls back to `DEFAULT_MODELS` when empty/undefined
  - `createGemini({ fetchImpl, models, now = Date.now, timeoutMs = 15000 }) -> { askGemini, askGeminiWithModel }`
  - `askGeminiWithModel(messages, { temperature = 0.7, maxTokens = 1500 } = {}): Promise<{ text: string, model: string } | null>`
  - `askGemini(messages, opts): Promise<string | null>` — same as above, returning `.text`
  - Module exports a default instance built from `node-fetch` and `parseModelList(process.env.GEMINI_MODELS)`, plus `createGemini`, `DEFAULT_MODELS`, `parseModelList`.

- [ ] **Step 1: Write the failing tests** in `tests/gemini.test.js`, using a fake `fetchImpl` that returns `{ status, ok, headers: { get }, json(), text() }` per model and a controllable `now`:
  - `parseModelList(undefined)` deep-equals `DEFAULT_MODELS`; `parseModelList(" a, ,b ")` deep-equals `["a","b"]`.
  - first model returns content `"hi"` → `{ text: "hi", model: "m1" }`.
  - `m1` → 429, `m2` → content → `{ model: "m2" }`.
  - after `m1` 429 at t=0, a second call at t=30 000 does **not** call `m1` (assert fake call log); at t=61 000 it does again.
  - `m1` 429 with `Retry-After: 5` → skipped at t=4 000, tried at t=5 001.
  - `m1` network throw / 500 / empty content → falls through to `m2`, and `m1` is cooling down (non-content empty response does not cool down — only 429, non-ok status and throws do).
  - every model cooling down → all are still tried in order (call log length = models.length).
  - all fail → `null`; `askGemini` returns the string or `null`.
- [ ] **Step 2: Run** `node --test tests/gemini.test.js` — Expected: FAIL (`createGemini is not a function`).
- [ ] **Step 3: Implement** in `data/utils/gemini.js`. Cooldown is a `Map<model, untilMs>`; order of attempts = models not cooling down (in list order), or the full list if none are available. Keep the existing endpoint, headers, body and `withTimeout` wrapping.
- [ ] **Step 4: Run** `node --test tests/gemini.test.js` — Expected: PASS. Also `node --check bot_modules/m_music.js bot_experimental/f_rag_quality_v1.js` — no output.
- [ ] **Step 5: Commit**
```bash
git add data/utils/gemini.js tests/gemini.test.js package.json docs/superpowers
git commit -m "feat(ai): free Gemini model fallback chain with cooldown"
```

---

### Task 2: "answered by" label

**Files:**
- Create: `data/utils/discord_text.js`, `tests/discord_text.test.js`
- Modify: `bot_experimental/f_rag_quality_v1.js` (main reply call at ~line 950 and the split/send block after it)
- Modify: `bot_modules/m_music.js` (`handleNowPlayingInfo` ~195, `handleGeneralAsk` ~322)

**Interfaces:**
- Consumes: `askGeminiWithModel` (Task 1)
- Produces: `splitWithLabel(text: string, label?: string, max = 2000): string[]`; `modelLabel(model: string): string` → `"-# answered by <model>"`

- [ ] **Step 1: Write the failing tests:**
  - `modelLabel("gemini-3.5-flash-lite") === "-# answered by gemini-3.5-flash-lite"`.
  - short text → one piece equal to `text + "\n" + label`.
  - 1995-char text + label → 2 pieces, every piece `length <= 2000`, last piece ends with the label, `pieces.join` minus the label and joining newline equals the original text.
  - 4500-char text → 3 pieces, all ≤ 2000, label only on the last.
  - no label → behaves like a plain 2000-char split.
- [ ] **Step 2: Run** `node --test tests/discord_text.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `splitWithLabel`, then wire it in:
  - `f_rag_quality_v1.js`: the **final reply** call uses `askGeminiWithModel`; store `reply.text` in history; send `splitWithLabel(reply.text, modelLabel(reply.model))` — first piece via `message.reply`, the rest via `message.channel.send`. The intent classifier and search-query cleanup keep using `askGemini` (no label).
  - `m_music.js`: `handleNowPlayingInfo` and `handleGeneralAsk` use `askGeminiWithModel`; append `• answered by <model>` to the existing embed footer text (e.g. `Asked by alice • answered by gemini-3.1-flash-lite`). `handleRecommend` stays on `askGemini` (its output is parsed, not shown).
- [ ] **Step 4: Run** `node --test` — Expected: all PASS; `node --check` on both modified files — no output.
- [ ] **Step 5: Commit** `feat(ai): show which Gemini model answered`

---

### Task 3: Vector client adapter and test fakes

**Files:**
- Create: `data/db/vector_client.js`, `tests/helpers/fakes.js`, `tests/vector_client.test.js`
- Modify: `package.json` (`npm install @upstash/vector`)

**Interfaces:**
- Produces (adapter — the only shape the rest of the code uses):
  - `createVectorClient({ url, token, IndexClass, timeoutMs = 8000 }) -> VectorClient | null` (`null` when `url` or `token` is missing)
  - `VectorClient.upsert(ns: string, items: {id, data, metadata}[]): Promise<void>`
  - `VectorClient.query(ns, { data: string, topK: number, filter?: string }): Promise<{id, score, metadata}[]>` (always `includeMetadata: true`)
  - `VectorClient.fetch(ns, ids: string[]): Promise<({id, metadata} | null)[]>`
  - `VectorClient.remove(ns, ids: string[]): Promise<void>` (no-op for an empty list)
  - Module export `vector`: the default instance from env, or `null`.
- Produces (fakes, for every later task):
  - `FakeRedis` — in-memory `get/set/del/sadd/srem/smembers/hset/hget/hgetall/hdel/hlen`, async, same return shapes as `@upstash/redis`.
  - `FakeVector` — implements the `VectorClient` shape; `query` scores by shared lowercase words (`shared / max(words)`), applies `filter` for the two forms used (`guildId = 'x' AND channelId IN ('a','b')`), returns `topK` sorted by score; `failNext(err)` makes the next call reject; `calls` records method + ns.
  - `fakeChannel({ id, name, guildId, type, parent, everyoneCanView, viewers: Set<userId> })`, `fakeMember(id)`, `fakeGuild(id, channels)` — objects with `permissionsFor(memberOrRole).has(flag)` enough for Task 7.

- [ ] **Step 1: Write the failing tests:** `createVectorClient({})` → `null`; with a stub `IndexClass` recording calls, `upsert("chat", [...])` calls the SDK's `upsert(items, { namespace: "chat" })`; `query` passes `{ data, topK, filter, includeMetadata: true }` with `{ namespace }`; `remove("chat", [])` makes no SDK call; a stub that never resolves rejects with a timeout after `timeoutMs` (use `timeoutMs: 20`).
- [ ] **Step 2: Run** `node --test tests/vector_client.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the adapter (log `console.warn("Upstash Vector rate limit hit")` when an SDK error's message or status indicates a rate limit, then rethrow) over `@upstash/vector`'s `Index` (`upsert(items, { namespace })`, `query(payload, { namespace })`, `fetch(ids, { namespace, includeMetadata: true })`, `delete(ids, { namespace })` — check these against the SDK docs/types at install time and adjust inside the adapter only). Write `tests/helpers/fakes.js`.
- [ ] **Step 4: Run** `node --test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(rag): Upstash Vector adapter and test fakes`

---

### Task 4: Commands and guidelines in the index, with pinning

**Files:**
- Create: `data/rag/knowledge_sync.js`, `tests/knowledge_sync.test.js`
- Modify: `data/commands.js` (add `{ cmd: "ai--g -p", usage: "ai--g -p <id>", desc: "Pin/unpin a guideline so it always applies", group: "guide", sub: true }`)
- Modify: `bot_experimental/f_rag_quality_v1.js` (guideline helpers ~583–630 and the `ai--g` handler ~704–841)

**Interfaces:**
- Consumes: `VectorClient` (Task 3), `COMMANDS` from `data/commands.js`
- Produces:
  - `commandVectors(commands): {id, data, metadata}[]` — non-hidden entries; `id = cmd`, `data = "<usage> — <desc>. <note>"` (note omitted when absent), `metadata = { cmd, usage, desc, note, group }`
  - `syncCommands({ vector, redis, commands }): Promise<"skipped" | "synced">` — sha1 of `JSON.stringify(commandVectors(...))` vs `rag:commands:hash`; on change: upsert all, remove ids that were in the old set but not the new (store the id list alongside the hash as JSON `{hash, ids}`), save
  - `guidelineVector(g): {id, data: "<name>: <content>", metadata: {name, content}}`
  - `upsertGuideline(vector, g)`, `removeGuideline(vector, id)`, `syncGuidelines({ vector, guidelines })` (fetch existing ids; upsert the missing ones)
  - In `f_rag_quality_v1.js`: `togglePin(id): Promise<boolean | null>` (new pinned state, or `null` if not found)

- [ ] **Step 1: Write the failing tests** (FakeVector + FakeRedis): first `syncCommands` → `"synced"` and the `commands` namespace has one vector per non-hidden entry (`--track` absent, `-play` present); second call → `"skipped"` with zero vector calls; removing an entry from the list → re-sync deletes its id; `guidelineVector({id:"a",name:"IP",content:"mc.example.net"}).data === "IP: mc.example.net"`; `syncGuidelines` with 3 guidelines where 1 already exists upserts exactly 2; any vector failure rejects (callers catch).
- [ ] **Step 2: Run** `node --test tests/knowledge_sync.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `knowledge_sync.js`. Then in `f_rag_quality_v1.js`: after each successful `addGuideline`/`editGuideline`/`removeGuideline`, call the matching vector function when `vector` is non-null, inside `try/catch` that only logs. Add `ai--g -p <id>` (usage reply when id missing, "not found" reply, otherwise "📌 Pinned"/"Unpinned"), `📌 ` prefix in `ai--g ls` for pinned entries, and the new line in the `ai--g` help fallback. On client `ready`: `syncCommands` and `syncGuidelines`, each in `try/catch` that logs.
- [ ] **Step 4: Run** `node --test` — PASS; `node --check bot_experimental/f_rag_quality_v1.js`.
- [ ] **Step 5: Commit** `feat(rag): commands and guidelines in vector index, ai--g -p pinning`

---

### Task 5: Chunk buffer

**Files:**
- Create: `data/rag/chunker.js`, `tests/chunker.test.js`

**Interfaces:**
- Produces:
  - Constants `GAP_MS = 600000`, `MAX_MESSAGES = 15`, `MAX_CONTENT = 1000`
  - `class ChunkBuffer` with:
    - `add(target: {key, switchId, guildId, channelName}, msg: {id, author, content, ts}): Chunk | null` — returns the **closed** chunk if this message closed the previous one (gap) or filled this one (15th message); skips (returns `null`, stores nothing) when `content.trim()` is empty; truncates content to `MAX_CONTENT`
    - `edit(key, messageId, content): boolean`, `remove(key, messageId): boolean` (true if found in the open chunk)
    - `discard(key): void`
    - `sweep(now: number): Chunk[]` — closes chunks whose last message is older than `GAP_MS`
    - `drain(): Chunk[]` — closes everything
  - `Chunk = { id: "<key>:<firstMessageId>", key, switchId, guildId, channelName, start, end, messages: [{id, author, content, ts}] }` — `key` is where the messages were posted (channel or thread id); `switchId` is the channel whose `ai--index` switch covers it (the parent, for a thread)
  - `chunkText(chunk): string` — lines `"[author]: content"` joined by `\n`

- [ ] **Step 1: Write the failing tests:** 3 messages 1 min apart → nothing closed, `drain()` returns 1 chunk with 3 messages and `id === "c1:m1"`; a message 11 min after the last → returns the previous chunk; 15th message → returns a 15-message chunk and the 16th starts a new one; `sweep(last + 600001)` closes, `sweep(last + 599999)` doesn't; `edit`/`remove` change the open chunk and return `true`, unknown id → `false`; removing the only message then `drain()` → no chunk; empty content skipped; a 4000-char message stored as 1000 chars; 15 × 4000-char messages → `Buffer.byteLength(JSON.stringify(chunk)) < 48000`; `discard("c1")` → `drain()` returns nothing for `c1`; two channels buffer independently.
- [ ] **Step 2: Run** `node --test tests/chunker.test.js` — FAIL.
- [ ] **Step 3: Implement** `ChunkBuffer` (a `Map<key, Chunk>`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(rag): conversation chunk buffer`

---

### Task 6: Chat store

**Files:**
- Create: `data/rag/chat_store.js`, `tests/chat_store.test.js`

**Interfaces:**
- Consumes: `VectorClient`, `chunkText`, `Chunk` (Task 5), a Redis client
- Produces `createChatStore({ vector, redis }) ->`:
  - `saveChunk(chunk): Promise<void>` — upsert into `chat` with `data = chunkText(chunk)`, `metadata = { guildId, channelId: chunk.key, switchId: chunk.switchId, channelName, start, end, authors: [...unique], messages }`; then one `hset("rag:map:<key>", { [msgId]: chunk.id, ... })`
  - `editMessage(key, messageId, content): Promise<boolean>` — `hget` → `fetch` → replace content (capped at 1000) → re-upsert; `false` if not mapped
  - `deleteMessage(key, messageId): Promise<boolean>` — as above but drop the line; empty chunk → `remove` the vector; `hdel` the mapping
  - `deleteChannel(key): Promise<number>` — `hgetall` → unique chunk ids → `remove` → `del` the hash; returns chunks removed
  - `countChunks(key): Promise<number>` — unique values in the hash
  - `search({ query, guildId, switchIds, askKey, topK = 5 }): Promise<ChatHit[]>` — `switchIds` are public indexed channels (their threads included), `askKey` is the ask channel's own key or `null`. Empty `switchIds` and no `askKey` → `[]` with no vector call. Filter: `guildId = '<g>' AND (switchId IN ('<a>', ...) OR channelId = '<askKey>')`, dropping whichever half is empty. Ids are Discord snowflakes — drop any id not matching `/^\d+$/` before building the filter.
  - `ChatHit = { score, channelName, start, end, messages }`

- [ ] **Step 1: Write the failing tests:** save then search finds it (FakeVector) and `countChunks` = 1; `editMessage` changes the stored line, unknown id → `false`; `deleteMessage` of 1 of 2 lines keeps the vector, of the last line removes it; `deleteChannel` removes all chunks for that key only (another channel's chunk survives) and returns the count; `search` with `switchIds: []`, `askKey: null` makes no call; a non-numeric id is dropped from the filter; a thread chunk (`key` = thread id, `switchId` = parent) is found via its parent in `switchIds`; a restricted channel's chunk is found only via `askKey`, never via another channel's search.
- [ ] **Step 2: Run** `node --test tests/chat_store.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(rag): chat chunk store with edit/delete`

---

### Task 7: Indexed channels and the permission rule

**Files:**
- Create: `data/rag/channels.js`, `tests/channels.test.js`

**Interfaces:**
- Consumes: Redis client; discord.js `PermissionFlagsBits.ViewChannel`, `ChannelType`
- Produces:
  - `createIndexedChannels({ redis }) -> { load(guildIds): Promise<void>, isIndexed(guildId, channelId): boolean, set(guildId, channelId, on: boolean): Promise<void>, list(guildId): string[] }` — memory `Map<guildId, Set>`, Redis set `rag:indexed:<guildId>` written only by `set`
  - `storageTarget(channel): { key, switchId, channelName } | null` — normal text channel → `{ key: id, switchId: id, channelName: name }`; public thread / forum post → `{ key: thread.id, switchId: parent.id, channelName: "<parent> › <thread>" }`; **private thread → `null`**; DMs / non-text → `null`
  - `allowedSources({ guild, askChannel, member, indexed }): { switchIds: string[], askKey: string | null }` — feeds Task 6's `search`. `switchIds` = indexed channels in this guild where `permissionsFor(guild.roles.everyone).has(ViewChannel)` **and** `permissionsFor(member).has(ViewChannel)`. `askKey` = `storageTarget(askChannel).key` when that target's `switchId` is indexed, else `null` (and `null` for a private thread).

- [ ] **Step 1: Write the failing tests** with the fake builders:
  - asked in public `#general` (indexed) → `switchIds` contains `#general`; `#mod-chat` (indexed, @everyone can't view) is **not** in it even though the asker is a mod who can view it; `askKey` = `#general`'s id.
  - asked in `#mod-chat` → `askKey` = `#mod-chat`'s id, `switchIds` = the public indexed channels.
  - asked in a non-indexed channel → `askKey` is `null`.
  - public indexed channel the asker can't view (role override) → not allowed.
  - non-indexed channel → never allowed.
  - `storageTarget(privateThread) === null`; public thread → `switchId` = parent id, `channelName` = `"general › map-reset"`.
  - `isIndexed` reflects `set(...)` immediately and survives a new instance after `load()` from the same FakeRedis.
- [ ] **Step 2: Run** `node --test tests/channels.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test` — PASS.
- [ ] **Step 5: Commit** `feat(rag): indexed channels and reply-audience permission rule`

---

### Task 8: Ingestion wiring and `ai--index`

**Files:**
- Create: `data/rag/ingest.js`, `tests/ingest.test.js`
- Modify: `launch.js` (client options: `partials: [Partials.Message, Partials.Channel]`)
- Modify: `bot_experimental/f_rag_quality_v1.js` (`ai--index` handler before the @mention gate; remove the existing `process.on('SIGINT')` handler — ingest owns shutdown)
- Modify: `data/commands.js` (`{ cmd: "ai--index", usage: "ai--index on|off|status", desc: "Turn chat memory on/off for this channel, or check it", group: "ai", note: "on/off need Manage Channels. Only new messages are remembered." }`)

**Interfaces:**
- Consumes: `ChunkBuffer` (5), `createChatStore` (6), `createIndexedChannels`, `storageTarget` (7)
- Produces:
  - `createIngest({ buffer, store, indexed, now = Date.now }) -> { onMessage(msg), onUpdate(oldMsg, newMsg), onDelete(msg), sweep(), flushAll(), stopChannel(key) }` — all async, never throw (log instead)
  - `initChatIngest(client, deps)` — registers `messageCreate`/`messageUpdate`/`messageDelete`, `setInterval(sweep, 60000)`, and `SIGTERM`/`SIGINT` → `await flushAll()` then `process.exit(0)`
  - `handleIndexCommand(message, { indexed, store, ingest }): Promise<void>` (lives in `ingest.js`, called from `f_rag_quality_v1.js` when `msgLower.startsWith("ai--index")`)

- [ ] **Step 1: Write the failing tests** (fakes + plain objects as messages):
  - `onMessage` skips: bot authors, DMs (`guild` null), non-indexed channels, private threads, messages starting with `-`, `--` or `ai--`; stores `@username` in place of `<@id>` mentions.
  - closed chunks from `add` and `sweep()` reach `store.saveChunk`.
  - `onUpdate(old, partialNew)` where `newMsg.partial === true` and content is unknown → no throw, no store call; with content → edits the open chunk if present, else `store.editMessage`.
  - `onDelete({ id, channelId, partial: true, content: null, author: null })` → no throw; removes from the open chunk or calls `store.deleteMessage(channelKey, id)` (channel key from `channelId`; for a thread it's the thread id, which equals `channelId`).
  - `stopChannel(key)` discards the open chunk: after it, `flushAll()` saves nothing for that key.
  - `handleIndexCommand`: `on` without Manage Channels → refusal reply, no state change; `on` with it → indexed + confirmation mentioning only new messages are remembered; `off` → `stopChannel`, `store.deleteChannel`, unindexed, reply with the number removed; `status` → on/off + `countChunks`; inside a thread → reply that it's controlled from the parent channel; bare `ai--index` → usage line from `usageLine("ai--index")`.
  - a `store.saveChunk` rejection is logged, not thrown.
- [ ] **Step 2: Run** `node --test tests/ingest.test.js` — FAIL.
- [ ] **Step 3: Implement** `ingest.js`; wire `initChatIngest` and `indexed.load(client.guilds.cache.map(g => g.id))` on `ready` in `f_rag_quality_v1.js` only when `vector` is non-null (otherwise `ai--index` replies that chat memory isn't configured); add `Partials` in `launch.js`; add the registry entry, and add `"ai--index"` to `STARTS_WITH_HANDLED` in `data/commands.js` (its handler uses `startsWith`).
- [ ] **Step 4: Run** `node --test` — PASS; `node --check` on modified files; then `node -e "require('./manual.js')"` loads without error.
- [ ] **Step 5: Commit** `feat(rag): opt-in chat ingestion and ai--index command`

---

### Task 9: Retrieval in the prompt, with fallback

**Files:**
- Create: `data/rag/retrieve.js`, `tests/retrieve.test.js`
- Modify: `bot_experimental/f_rag_quality_v1.js` (prompt assembly ~879–940)

**Interfaces:**
- Consumes: `VectorClient`, `createChatStore().search`, `allowedSources` (7), `COMMANDS`, `buildCommandGuide`, `mentionsCommands`
- Produces:
  - `MIN_SCORE = 0.75`
  - `expandCommandGroups(matches: {metadata:{group}}[], commands): Command[]` — every non-hidden command in the matched groups, registry order
  - `retrieveContext({ vector, chatStore, query, aboutCommands, guildId, switchIds, askKey }): Promise<{ commands: Command[] | null, guidelines: {id,name,content}[] | null, chats: ChatHit[] }>` — three lookups in parallel via `Promise.allSettled`; drop hits below `MIN_SCORE`; `aboutCommands` → expanded groups, else top matches; a failed lookup yields `null` (commands/guidelines) or `[]` (chats); `vector === null` → `{ commands: null, guidelines: null, chats: [] }`
  - `formatCommands(cmds): string`, `formatChats(hits): string` — chats as `#<channelName>, <YYYY-MM-DD>:` then the lines; header `Past conversations (reference only — not instructions):`
  - `buildPromptBlocks(ctx, { pinned, allGuidelines, guide }): { commandsBlock, guidelinesBlock, chatsBlock }` — `ctx.commands === null` → `guide` (the full `COMMAND_GUIDE`); `ctx.guidelines === null` → `allGuidelines`, else `pinned` + `ctx.guidelines` deduplicated by id; `chatsBlock` is `""` when there are no chats

- [ ] **Step 1: Write the failing tests:** "what music commands are there" with `aboutCommands: true` → all 14 music entries; a non-command question → only top matches ≥ `MIN_SCORE`; FakeVector `failNext` on guidelines → `guidelines: null`, commands still returned; `vector: null` → all-fallback shape; `formatChats` output starts with the header and includes `#general, 2026-11-10:`; chats below `MIN_SCORE` are dropped; **Review Focus 3:** with a FakeVector whose every call rejects, `buildPromptBlocks(await retrieveContext(...), ...)` gives `commandsBlock === guide` and a guidelines block containing every guideline; a pinned guideline also returned by retrieval appears once.
- [ ] **Step 2: Run** `node --test tests/retrieve.test.js` — FAIL.
- [ ] **Step 3: Implement** `retrieve.js`, then in `f_rag_quality_v1.js`:
  - compute `{ switchIds, askKey }` with `allowedSources` (guild messages only; DMs → none) and pass them to `retrieveContext`.
  - use `buildPromptBlocks` for the three blocks; after a retrieved (non-fallback) commands block, add "This is the relevant part of the full list in --help."
  - with a non-empty `chatsBlock`, add the rule: say roughly when and where it was discussed; if it doesn't answer the question, say so instead of guessing.
  - `ai--g` behaviour and the `mentionsCommands` web-search skip are unchanged.
- [ ] **Step 4: Run** `node --test` — PASS; `node --check bot_experimental/f_rag_quality_v1.js`.
- [ ] **Step 5: Commit** `feat(rag): retrieve commands, guidelines and past chat per question`

---

### Task 10: README and setup notes

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Add `UPSTASH_VECTOR_REST_URL`, `UPSTASH_VECTOR_REST_TOKEN`, optional `GEMINI_MODELS` to the `.env` block; a "Chat memory setup" section (create a **dense** index, **cosine**, embedding model **`openai/text-embedding-3-small`** in the Upstash console; add the two keys to `.env` and Render); `ai--index on|off|status` and `ai--g -p <id>` in the AI commands section; a privacy note: indexed channels' messages are stored in Upstash Vector until `ai--index off`, which deletes them; private threads are never stored; restricted channels' memory only answers inside that channel; `npm test`.
- [ ] **Step 2:** `node --test` — all PASS.
- [ ] **Step 3: Commit** `docs: chat memory setup, new commands and privacy note`
