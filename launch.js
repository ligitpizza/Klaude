require("dotenv").config();

const { withTimeout } = require("./data/utils/timeout.js");

// Log the source of any unhandled rejection instead of letting Node crash
// with no context (this is what happened with the recent SSL handshake
// failure — we need to know *which* outbound connection failed). Still
// exits after logging — attaching a listener suppresses Node's default
// crash behavior, and continuing to run after an unhandled rejection would
// leave the bot in an unpredictable half-initialized state instead of
// letting Render restart it cleanly.
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});

const { EmbedBuilder } = require('discord.js');
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

app.get("/", (req, res) => res.send("wes is running!"));

const { Client, GatewayIntentBits } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const PREFIX = "-"; // ← moved up so it's defined before use

// ─── Modules ──────────────────────────────────────────────────────────────────
// All modules below share this single client/token — each one used to spin up
// its own Client and log in with the same DISCORD_BOT_TOKEN_1, which meant up
// to 6 simultaneous gateway connections on one token fighting over Discord's
// IDENTIFY rate limit at boot. Whichever client lost that race never reached
// "ready" and silently never received any events (e.g. the AI module ignoring
// every @mention). Everything that only needs this client's existing intents
// now attaches its listeners directly to it instead of logging in separately.
const { initMusic, handleMusicCommand, MUSIC_COMMANDS, MUSIC_HELP } = require("./bot_modules/m_music.js");
const distube = initMusic(client);

const { initModerator } = require("./bot_modules/m_moderator.js");
const { initPhotoloc }  = require("./bot_modules/m_photoloc.js");
const { initManual }    = require("./manual.js");
const { initRagQuality } = require("./bot_experimental/f_rag_quality_v1.js");

initModerator(client);
initPhotoloc(client);
initManual(client);
initRagQuality(client);

// m_extractor.js still runs as its own client — it needs privileged intents
// (GuildMembers/GuildPresences) that may not be enabled for this application
// in the Discord Developer Portal, so merging it into the shared client risks
// taking the whole bot down if those aren't toggled on. Keeping it isolated
// means only the extractor module is at risk, not everything else.
require("./bot_modules/m_extractor.js");
// require("./bot_modules/m_insomnia.js");

//additional
// require('./additional/a_insomnia_1.js');
// require('./additional/a_insomnia_2.js');
// require('./additional/a_insomnia_3.js');


client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Guard: music commands only work in servers
  if (!message.guild) return;

  if (!message.content.startsWith(PREFIX)) return;

  const args    = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (MUSIC_COMMANDS.has(command)) {
    await handleMusicCommand(command, args, message);
  }
});

client.on('messageCreate', message => {
  if (message.author.bot) return;

  if (message.content.toLowerCase() === '-uptime') {
    const uptime = process.uptime() * 1000;

    const days    = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours   = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((uptime % (1000 * 60)) / 1000);

    let uptimeString = '';
    if (days > 0)    uptimeString += `${days}d `;
    if (hours > 0)   uptimeString += `${hours}h `;
    if (minutes > 0) uptimeString += `${minutes}m `;
    uptimeString += `${seconds}s`;

    const embed = new EmbedBuilder()
      .setColor('#282d2f')
      .setTitle('Bot Uptime')
      .setDescription(`been online for: **${uptimeString}**`)
      .setTimestamp()
      .setFooter({ text: 'Bot Status' });

    message.reply({ embeds: [embed] });
  }
});


client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
});

client.on("error", (err) => console.error("Client error:", err));

// client.login() can stall indefinitely (rather than reject) if the gateway
// handshake stalls on a bad connection, which withRetry alone can't recover
// from since it only retries on a caught rejection. Bound each attempt with
// a timeout and force a clean retry (destroying the client's half-open
// connection state first) instead of leaving the bot stuck offline forever.
const LOGIN_TIMEOUT_MS = 20000;
const MAX_LOGIN_ATTEMPTS = 5;

async function loginWithTimeout() {
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    try {
      await withTimeout(client.login(process.env.DISCORD_BOT_TOKEN_1), LOGIN_TIMEOUT_MS, "Discord login");
      return;
    } catch (err) {
      console.error(`Login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS} failed:`, err.message);
      if (attempt === MAX_LOGIN_ATTEMPTS) throw err;
      try { await client.destroy(); } catch {}
    }
  }
}

// If every in-process attempt fails, don't give up silently and stay
// offline forever — exit so Render restarts the container and the retry
// loop starts fresh (Render backs off and keeps retrying a crashing
// container, which is what actually recovers this once the underlying
// network issue clears, however long that takes).
loginWithTimeout().catch(err => {
  console.error("Main login failed after all retries:", err);
  process.exit(1);
});