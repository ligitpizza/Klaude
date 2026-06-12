require("dotenv").config();
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
const { initMusic, handleMusicCommand, MUSIC_COMMANDS, MUSIC_HELP } = require("./bot_modules/m_music.js");
const distube = initMusic(client);

//modules
require("./bot_modules/m_moderator.js");
require("./bot_modules/m_extractor.js");
// require("./bot_modules/m_insomnia.js");
require('./bot_modules/m_music.js');
require('./bot_modules/m_photoloc.js');

//experimental
// require('./bot_experimental/f_rag_location_v1.js');
// require('./bot_experimental/f_rag_efficient_v1.js');
require('./bot_experimental/f_rag_quality_v1.js');

//additional
// require('./additional/a_insomnia_1.js');
// require('./additional/a_insomnia_2.js');
// require('./additional/a_insomnia_3.js');
require('./manual.js');


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

client.login(process.env.DISCORD_BOT_TOKEN_1);