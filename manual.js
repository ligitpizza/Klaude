require("dotenv").config();
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");

function initManual(client) {

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

// ─── Help Pages ───────────────────────────────────────────────────────────────
// One embed per module — --help pages through these with ◀ / ▶ buttons
// instead of cramming everything into one wall-of-text embed.
function buildHelpPages() {
  const pages = [
    {
      title: "🤖 AI",
      lines: [
        "`@wes {msg}` Chat with the AI",
        "`ai--help` Show AI-specific help",
      ],
    },
    {
      title: "🎵 Music",
      lines: [
        "`-play <song/url>` Play from YouTube, Spotify, SoundCloud",
        "`-skip` Skip current song",
        "`-stop` Stop and clear queue",
        "`-pause` Pause playback",
        "`-resume` Resume playback",
        "`-queue` Show queue",
        "`-nowplaying` Show current song",
        "`-loop [off|song|queue]` Toggle loop mode",
        "`-volume <0-100>` Set volume",
        "`-leave` Disconnect bot from voice",
        "`-search <query>` Search SoundCloud and pick a track",
        "`-ask rec [song]` Recommend similar songs",
        "`-ask desc [song]` Get info about a song",
        "`-ask <question>` General Q&A with the bot assistant",
      ],
    },
    {
      title: "📸 Photo Tracker",
      lines: [
        "`-mystat` Your photo upload stats",
        "`-photostat @user` Stats for a specific user",
        "`-toposter` Top photo contributors leaderboard",
        "`-serverstat` Server-wide photo stats",
        "`-channelstat` Current channel photo stats",
      ],
    },
    {
      title: "🛡️ Keyword Control",
      lines: [
        "`-ton` Enable keyword control",
        "`-toff` Disable keyword control",
        "`-tstat` Show current status",
      ],
    },
    {
      title: "🔍 Extractor",
      lines: [
        "`--myid` Your user ID",
      ],
    },
    {
      title: "⚙️ General",
      lines: [
        "`-uptime` How long the bot has been online",
      ],
    },
  ];

  return pages.map((page, i) =>
    new EmbedBuilder()
      .setColor("#282d2f")
      .setTitle(`Command List — ${page.title}`)
      .setDescription(page.lines.join("\n"))
      .setFooter({ text: `Bot by ${getCreatorTag()} • Page ${i + 1}/${pages.length} • Use --helpai for AI-specific commands` })
  );
}

function buildHelpNavRow(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("help-prev").setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId("help-next").setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1),
  );
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
      { name: "​", value: "​", inline: false },
      {
        name: "📋 Custom guidelines",
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
    const pages = buildHelpPages();
    let page = 0;

    let sentMessage;
    try {
      sentMessage = await message.reply({ embeds: [pages[page]], components: [buildHelpNavRow(page, pages.length)] });
    } catch (err) {
      console.error("Help send error:", err);
      return;
    }

    const collector = sentMessage.createMessageComponentCollector({ time: 120_000 });

    collector.on("collect", async (interaction) => {
      if (interaction.user.id !== message.author.id) {
        interaction.reply({ content: "This isn't your help menu!", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      if (interaction.customId === "help-prev") page = Math.max(0, page - 1);
      if (interaction.customId === "help-next") page = Math.min(pages.length - 1, page + 1);

      try {
        await interaction.update({ embeds: [pages[page]], components: [buildHelpNavRow(page, pages.length)] });
      } catch (err) {
        console.error("Help navigation error:", err);
      }
    });

    collector.on("end", () => {
      sentMessage.edit({ components: [] }).catch(() => {});
    });

    return;
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

}

module.exports = { initManual };
