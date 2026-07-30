# SoundCloud Interactive Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `-search <query>` Discord command that shows up to 10 SoundCloud results in a dropdown, letting the user pick which track gets queued, instead of `-play` always auto-picking the first match.

**Architecture:** All changes live in `bot_modules/m_music.js`. The `SoundCloudPlugin` instance already created in `initMusic` is kept in a module-level variable so `-search` can call its `.search()` method directly. The picker is a `StringSelectMenuBuilder` attached to a `createMessageComponentCollector` scoped to the sent message (not the global `interactionCreate` handler in `launch.js`) — see the design spec for why. Selecting a result calls the same `distube.play(voiceChannel, url, {...})` path `-play` already uses, so queueing/now-playing behavior is identical.

**Tech Stack:** discord.js v14 (`StringSelectMenuBuilder`, `ActionRowBuilder`, `MessageFlags` — all already available, no new dependency), `@distube/soundcloud`'s existing `SoundCloudPlugin.search()` method.

**Spec:** `docs/superpowers/specs/2026-07-30-soundcloud-search-ui-design.md`

## Global Constraints

- Show exactly 10 results (spec: "10 results").
- Picker expires after 30 seconds (spec: "30 seconds").
- Only the user who ran `-search` can select an option; other users get an ephemeral "This isn't your search!" reply and the picker stays active for the original requester (spec: "Only the person who ran -search").
- Use a local `createMessageComponentCollector` on the sent message, not the global `interactionCreate` stub in `launch.js` (spec: "local collector, not global router").
- `-play` must not change at all.
- No automated test framework exists in this repo (`package.json`'s `test` script is a stub). All verification in this plan is manual, live-Discord testing — matching how every other music command in this file has been verified so far.

---

### Task 1: Persistent SoundCloudPlugin reference + component imports

**Files:**
- Modify: `bot_modules/m_music.js:2` (discord.js import)
- Modify: `bot_modules/m_music.js:11` (module-level `let distube;`)
- Modify: `bot_modules/m_music.js:17-20` (plugin instantiation inside `initMusic`)

**Interfaces:**
- Produces: module-level `soundcloudPlugin` variable (type: `SoundCloudPlugin` instance from `@distube/soundcloud`), set once inside `initMusic` and readable by `handleMusicCommand` in the same module. Task 3 calls `soundcloudPlugin.search(query, "track", 10)` on it.

- [ ] **Step 1: Add the new discord.js imports**

In `bot_modules/m_music.js`, replace line 2:

```js
const { EmbedBuilder } = require("discord.js");
```

with:

```js
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require("discord.js");
```

- [ ] **Step 2: Add the module-level `soundcloudPlugin` variable**

Replace line 11:

```js
let distube;
```

with:

```js
let distube;
let soundcloudPlugin;
```

- [ ] **Step 3: Capture the plugin instance instead of inlining it**

Replace lines 17-20:

```js
  distube = new DisTube(client, {
    ffmpeg: { path: ffmpeg },
    plugins: [new SoundCloudPlugin()],
  });
```

with:

```js
  soundcloudPlugin = new SoundCloudPlugin();

  distube = new DisTube(client, {
    ffmpeg: { path: ffmpeg },
    plugins: [soundcloudPlugin],
  });
```

- [ ] **Step 4: Verify the module still loads cleanly**

Run: `node -e "require('./bot_modules/m_music.js'); console.log('OK')"`

Expected: prints `OK` with no errors. This only checks for syntax/reference errors — `initMusic` isn't called by requiring the module, so no live Discord/SoundCloud connection happens here.

- [ ] **Step 5: Commit**

```bash
git add bot_modules/m_music.js
git commit -m "Keep a reference to the SoundCloudPlugin instance for search"
```

---

### Task 2: Register the `-search` / `-se` command and help text

**Files:**
- Modify: `bot_modules/m_music.js:85-97` (`MUSIC_HELP`)
- Modify: `bot_modules/m_music.js:99-102` (`MUSIC_COMMANDS`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `MUSIC_COMMANDS` now includes `"search"` and `"se"`, so `launch.js`'s existing `if (MUSIC_COMMANDS.has(command)) await handleMusicCommand(...)` dispatch (in `launch.js`, unchanged) will route `-search`/`-se` into `handleMusicCommand` once Task 3 adds the handler branch. Until Task 3 lands, these commands fall through `handleMusicCommand` with no matching `if` block and silently no-op (matches how every other unhandled command in this file already behaves — no `else` branch exists).

- [ ] **Step 1: Add the help text line**

In `bot_modules/m_music.js`, replace:

```js
  "`-leave` — Bot quit voice chat.\n" +
  // "`-ask <question>` — Ask the AI assistant.\n" +
```

with:

```js
  "`-leave` — Bot quit voice chat.\n" +
  "`-search <query>` — Search SoundCloud and pick a track from a list.\n" +
  // "`-ask <question>` — Ask the AI assistant.\n" +
```

- [ ] **Step 2: Add the command names**

Replace:

```js
const MUSIC_COMMANDS = new Set([
  "play", "p", "skip", "s", "stop", "pause", "resume",
  "queue", "q", "volume", "vol", "nowplaying", "np", "ask", "ai", "leave", "l",
]);
```

with:

```js
const MUSIC_COMMANDS = new Set([
  "play", "p", "skip", "s", "stop", "pause", "resume",
  "queue", "q", "volume", "vol", "nowplaying", "np", "ask", "ai", "leave", "l",
  "search", "se",
]);
```

- [ ] **Step 3: Verify**

Run: `node -e "const {MUSIC_COMMANDS} = require('./bot_modules/m_music.js'); console.log(MUSIC_COMMANDS.has('search'), MUSIC_COMMANDS.has('se'))"`

Expected: `true true`

- [ ] **Step 4: Commit**

```bash
git add bot_modules/m_music.js
git commit -m "Register -search/-se command and help text"
```

---

### Task 3: Implement the `-search` command handler

**Files:**
- Modify: `bot_modules/m_music.js` — insert a new command block between the end of the `-play` block (line 126, `return;\n  }`) and the start of the `-leave` block (line 128, `// ── -leave`).

**Interfaces:**
- Consumes:
  - `soundcloudPlugin` (module-level, from Task 1) — calls `.search(query, "track", 10)`, which returns `Promise<SoundCloudSong[]>` (each with `.name: string`, `.url: string`, `.formattedDuration: string`, `.uploader: {name, url}`) or throws a `DisTubeError` with a `.message` string.
  - `distube` (module-level, existing) — calls `.play(voiceChannel, url, { member, textChannel, message })`, exactly as the existing `-play` handler does.
  - `ActionRowBuilder`, `StringSelectMenuBuilder`, `MessageFlags`, `EmbedBuilder` (from Task 1's import change).
- Produces: nothing consumed elsewhere — this is a leaf command handler.

- [ ] **Step 1: Write the `-search` handler block**

Insert this new block right after the `-play` block's closing `return;\n  }` (line 126) and before the `// ── -leave` comment (line 128):

```js
  // ── -search / -se ─────────────────────────────────────────────────────────
  if (command === "search" || command === "se") {
    if (!voiceChannel)  return message.reply("You need to be in a voice channel!");
    if (!args.length)   return message.reply("Please provide a search query!");

    const query = args.join(" ");
    let results;
    try {
      results = await soundcloudPlugin.search(query, "track", 10);
    } catch (err) {
      console.error("Search error:", err);
      return message.reply(`  ${err.message || "Could not search SoundCloud."}`);
    }

    if (!results.length) {
      return message.reply(`No SoundCloud results for **${query}**.`);
    }

    const truncate = (str, max) => (str.length > max ? `${str.slice(0, max - 1)}…` : str);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("soundcloud-search")
      .setPlaceholder("Pick a track to queue")
      .addOptions(results.map((song, i) => ({
        label:       truncate(song.name, 100),
        description: truncate(`${song.uploader?.name ?? "Unknown"} • ${song.formattedDuration}`, 100),
        value:       String(i),
      })));

    const embed = new EmbedBuilder()
      .setColor("#282d2f")
      .setTitle(`SoundCloud results for "${query}"`)
      .setDescription(
        results.map((song, i) => `**${i + 1}.** ${song.name} — *${song.formattedDuration}*`).join("\n")
      )
      .setFooter({ text: "Pick a track from the dropdown below — expires in 30s" });

    const sentMessage = await message.channel.send({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(menu)],
    });

    const collector = sentMessage.createMessageComponentCollector({ time: 30_000 });

    collector.on("collect", async (interaction) => {
      if (interaction.user.id !== message.author.id) {
        return interaction.reply({ content: "This isn't your search!", flags: MessageFlags.Ephemeral });
      }

      const picked = results[Number(interaction.values[0])];
      collector.stop("picked");

      await interaction.update({
        embeds: [embed],
        components: [],
        content: `Selected: **${picked.name}**`,
      });

      try {
        await distube.play(voiceChannel, picked.url, {
          member: message.member, textChannel: message.channel, message,
        });
      } catch (err) {
        console.error("Search play error:", err);
        message.channel.send(`  ${err.message || "Could not play that song."}`);
      }
    });

    collector.on("end", (_collected, reason) => {
      if (reason === "picked") return;
      sentMessage.edit({
        embeds: [embed],
        components: [],
        content: "Search expired — run `-search` again.",
      }).catch(() => {});
    });

    return;
  }

```

- [ ] **Step 2: Verify the module still loads cleanly**

Run: `node -e "require('./bot_modules/m_music.js'); console.log('OK')"`

Expected: prints `OK` with no errors.

- [ ] **Step 3: Manual smoke test — happy path**

Start the bot locally (`node launch.js`), join a voice channel in your test server, then in a text channel run:

```
-search geoxor virtual
```

Expected: an embed titled `SoundCloud results for "geoxor virtual"` listing up to 10 numbered results, with a dropdown below it saying "Pick a track to queue". Click one of the options.

Expected after clicking: the message updates to `Selected: **<track name>**` with the dropdown gone, and immediately after, the normal "Added to Queue" or "Now Playing" embed appears (same as `-play` would produce for that track).

- [ ] **Step 4: Manual smoke test — no results**

Run:

```
-search asdkjfhlaskdjfh29384zzz
```

Expected: bot replies `No SoundCloud results for **asdkjfhlaskdjfh29384zzz**.` — no crash, no dangling dropdown.

- [ ] **Step 5: Manual smoke test — timeout**

Run `-search` with any query that returns results, but don't click anything. Wait 31 seconds.

Expected: the message edits itself to `Search expired — run \`-search\` again.` with the dropdown removed.

- [ ] **Step 6: Manual smoke test — wrong user**

Run `-search` from one Discord account, then click the dropdown from a *different* account.

Expected: the second account gets an ephemeral reply `This isn't your search!`, and the original requester can still click and have it work normally afterward.

- [ ] **Step 7: Commit**

```bash
git add bot_modules/m_music.js
git commit -m "Add -search command with interactive SoundCloud result picker"
```
