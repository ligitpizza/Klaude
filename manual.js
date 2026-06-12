require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});


let creator;
client.once("ready", async () => {
  try {
    creator = await client.users.fetch("1396841908436733973"); //693111194319323197 old
    console.log(`✅Logged in as ${client.user.tag}, Manual up`);
  } catch (err) {
    console.error("Failed to fetch owner:", err);
  }
});

const getCreatorTag = () => creator ? creator.tag : "the owner";


const botMsg = () =>
  `\n\n**(I am a bot, and this action was performed automatically. Please contact ${getCreatorTag()} the moderators of this sub if you have any questions or concerns.)**`;

// ─── Help Embed Builder ───────────────────────────────────────────────────────
function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor("#282d2f")
    .setTitle("Command List")
    .addFields(
      // ── AI (full width) ──────────────────────────────────────────────────────
      {
        name: "🤖 AI",
        value: [
          "`@wes {msg}` Chat with the AI",
          "`ai--help` Show AI-specific help",
        ].join("\n"),
        inline: false,
      },
      { name: "\u200b", value: "\u200b", inline: false },
      {
        name: "🎵 Music",
        value: [
          "`-play <song/url>` Play from YouTube, Spotify, SoundCloud",
          "`-skip` Skip current song",
          "`-stop` Stop and clear queue",
          "`-pause` Pause playback",
          "`-resume` Resume playback",
          "`-queue` Show queue",
          "`-nowplaying` Show current song",
          "`-volume <0-100>` Set volume",
          "`-leave` Disconnect bot from voice",
        ].join("\n"),
        inline: true,
      },
      {
        // name: "\u200b", // invisible header — right column
        name: "🛡️ Keyword Control",
        value: [
          "`-ton` Enable keyword control",
          "`-toff` Disable keyword control",
          "`-tstat` Show current status",
        ].join("\n"),
        inline: true,
      },
      // ── spacer row so next section starts on a new line ──────────────────────
      { name: "\u200b", value: "\u200b", inline: false },
      {
        name: "🔍 Extractor",
        value: [
          "`--myid` Your user ID",
          "`--userid @user` Get a user's ID",
          // "`--serverids` List all member IDs",
          "`--userinfo @user` Detailed user info",
          // "`--track @user` Log tracking snapshot", 
          "`--stk @user` Advanced profile view",
          // "`--export` Full server data export",
          "`--analyze @user` Message pattern analysis",
          "`--webhooks` List server webhooks",
          "`--invites` List active invites",  
          // "`--permissions @user` Permission analysis",
          // "`--correlation` Data correlation report",
          // "`--logs` Recent access logs",
          // "`--criticallogs` Critical events only",
        ].join("\n"),
        inline: true,
      },
      {
        name: "📸 Photo Tracker",
        value: [
          "`-mystat` Your photo upload stats",
          "`-photostat @user` Stats for a specific user",
          "`-toposter` Top photo contributors leaderboard",
          "`-serverstat` Server-wide photo stats",
          "`-channelstat` Current channel photo stats",
        ].join("\n"),
        inline: true,
      },
      // ── spacer ───────────────────────────────────────────────────────────────
      // { name: "\u200b", value: "\u200b", inline: false },
      // {
      //   name: "🔍 Extractor",
      //   value: [
      //     "`--myid` Your user ID",
      //     "`--userid @user` Get a user's ID",
      //     "`--serverids` List all member IDs",
      //     "`--userinfo @user` Detailed user info",
      //     "`--track @user` Log tracking snapshot",
      //     "`--stalk @user` Advanced profile view",
      //     "`--export` Full server data export",
      //     "`--analyze @user` Message pattern analysis",
      //     "`--webhooks` List server webhooks",
      //     "`--invites` List active invites",
      //     "`--permissions @user` Permission analysis",
      //     "`--correlation` Data correlation report",
      //     "`--logs` Recent access logs",
      //     "`--criticallogs` Critical events only",
      //   ].join("\n"),
      //   inline: true,
      // },
      // {
      //   name: "\u200b",
      //   value: [
      //     "`--analyze @user` Message pattern analysis",
      //     // "`--webhooks` List server webhooks",
      //     // "`--invites` List active invites",
      //     // "`--permissions @user` Permission analysis",
      //     // "`--correlation` Data correlation report",
      //     // "`--logs` Recent access logs",
      //     // "`--criticallogs` Critical events only",
      //   ].join("\n"),
      //   inline: true,
      // },
      // ── spacer ───────────────────────────────────────────────────────────────
      { name: "\u200b", value: "\u200b", inline: false },
      // ── General (full width) ─────────────────────────────────────────────────
      {
        name: "⚙️ General",
        value: "`-uptime` How long the bot has been online",
        inline: false,
      },
    )
    // .setDescription("\u00a0".repeat(150))
    .setFooter({ text: `Bot by ${getCreatorTag()} • Use --helpai for AI-specific commands` });
}

function buildHelpAIEmbed() {
  return new EmbedBuilder()
    .setColor("#282d2f")
    .setTitle("AI Commands")
    .addFields(
      {
        name: "💬 Chat",
        value: [
          "`@wes {message}` Chat directly with the AI",
          "`ai--memoclr` Clear your AI chat memory",
          "`ai--memostat` View your conversation stats",
        ].join("\n"),
        inline: true,
      },
      {
        name: "📍 Location (disabled)",
        value: [
          "`ai--setlocation` Save your location (e.g. Penang, Malaysia)",
          "`ai--mylocation` Check your saved location",
          "`ai--locationclr` Remove your saved location",
        ].join("\n"),
        inline: true,
      },
      // ── spacer ───────────────────────────────────────────────────────────────
      { name: "\u200b", value: "\u200b", inline: false },
      {
        name: "📋 Guidelines (Admin)",
        value: [
          "`ai--g ls` List all guidelines",
          "`ai--g -s <id>` View a specific guideline",
          "`ai--g -a <name> - <content>` Add a guideline",
          "`ai--g -e <id> - <content>` Edit a guideline",
          "`ai--g -r <id>` Remove a guideline",
        ].join("\n"),
        inline: false,
      },
    )
    .setFooter({ text: "AI model may have outdated info past early 2025" });
}


// ─── Message Handler ──────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const lower = message.content.toLowerCase();

  if (lower === "--help") {
    return message.reply({ embeds: [buildHelpEmbed()] });
  }

  if (lower === "ai--help") {
    return message.reply({ embeds: [buildHelpAIEmbed()] });
  }

  if (lower === "!help" || lower === "/help") {
    return message.reply(`Use **--help** to list available commands!${botMsg()}`);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
});

client.login(process.env.DISCORD_BOT_TOKEN_1);