# SoundCloud Interactive Search — Design

## Problem

`-play <query>` always plays/queues the first match DisTube finds. There's no
way to see other candidates or pick a specific one — if the auto-picked
result is wrong, the user has no recourse but to `-skip` and retype.

## Goal

A new `-search <query>` command that shows the top SoundCloud results in an
interactive dropdown, letting the user pick which track actually gets queued.
`-play` is unchanged.

## Non-goals

- No changes to `-play`'s existing behavior.
- No Spotify/YouTube search (those plugins are currently removed from the
  bot — see prior debugging session).
- No persistence of past searches; each `-search` is a standalone, ephemeral
  interaction.

## Command

`-search <query>` / `-se <query>`, added to `MUSIC_COMMANDS` in
`bot_modules/m_music.js`. Same voice-channel guard as `-play`
(`if (!voiceChannel) return message.reply(...)`).

## Flow

1. Call the existing `SoundCloudPlugin` instance's
   `.search(query, "track", 10)` (a reference to the plugin instance is kept
   alongside `distube` in `initMusic`, rather than re-instantiating a second
   SoundCloud client). This reuses the same client-ID/session `-play` already
   establishes.
2. No results → reply `"No SoundCloud results for **{query}**."` and stop.
3. Build:
   - An embed listing the up-to-10 results (title, uploader, duration).
   - A `StringSelectMenuBuilder` with one option per result. `label` is the
     track title truncated to fit Discord's 100-character option-label
     limit; `value` is the result's index in the array (not the URL, to stay
     under Discord's 100-char value limit).
4. Send the embed + select menu as one message.
5. Attach `message.createMessageComponentCollector({ filter, time: 30_000 })`
   directly to that message (local collector, not the global
   `interactionCreate` handler — see rationale below).
   - `filter`: `interaction => interaction.user.id === message.author.id`.
     A click from anyone else gets `interaction.reply({ content: "This
     isn't your search!", flags: MessageFlags.Ephemeral })` and does **not**
     stop the collector (other users' misclicks shouldn't end the search for
     the original requester).
6. On a valid selection:
   - Resolve the picked `SoundCloudSong` from the stored results array by
     index.
   - Call `distube.play(voiceChannel, song.url, { member, textChannel,
     message })` — the same call `-play` already makes, so queueing / "Added
     to Queue" / "Now Playing" behavior is identical.
   - Edit the original message: disable the select menu, replace its content
     with a confirmation ("Selected: **{song.name}**").
   - Stop the collector.
7. On collector `end` with no selection made (timeout): edit the message to
   disable the select menu and show "Search expired — run `-search` again."

## Why a local collector, not the global interaction router

`launch.js` has an unused `client.on("interactionCreate", ...)` stub. A
global router (matching on a `customId` prefix like `search:<userId>`) would
only pay off if multiple interactive features shared routing/state later.
For a single "one message, one outcome" interaction, a collector scoped
directly to the sent message is the standard discord.js pattern — no shared
state, no risk of concurrent searches colliding, no customId bookkeeping.

## Error handling

- SoundCloud API errors during `.search()` (client-ID scrape hiccup, rate
  limit) are caught and reported the same way `-play` already handles
  playback errors: `catch (err) { message.reply(err.message ...) }`.
- Errors during the post-selection `distube.play()` call are handled
  identically to `-play`'s existing try/catch.

## Testing (manual — no test framework in this repo)

- Valid query with multiple results → picks correctly, queues correctly.
- Zero-result query → clean error message, no crash.
- Let the picker time out unpicked → menu disables, message updates,
  no dangling collector.
- A second user clicks the menu → ephemeral "not your search" reply, first
  user can still pick afterward.
- Compare resulting queue/now-playing embeds against what `-play` produces
  for the same track, to confirm the shared `distube.play()` path behaves
  identically.
