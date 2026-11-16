require("dotenv").config();
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");
const { GROUPS, COMMANDS, groupLines, findClosestCommands } = require("./data/commands.js");

// Help lines for specific commands, in the order given.
const linesFor = cmds => cmds
  .map(name => COMMANDS.find(c => c.cmd === name))
  .filter(Boolean)
  .map(c => `\`${c.usage}\` ${c.desc}`);

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
// instead of cramming everything into one wall-of-text embed. Small/niche
// modules (Keyword Control, Extractor) ride along on the AI page instead of
// getting their own, and General (-uptime) is pinned to the bottom of every
// page rather than being its own page.
function buildHelpPages() {
  const pages = [
    {
      title: GROUPS.ai,
      sections: [
        { name: GROUPS.ai,        lines: linesFor(["@wes", "ai--help"]) },
        { name: GROUPS.keyword,   lines: groupLines("keyword") },
        { name: GROUPS.extractor, lines: groupLines("extractor") },
      ],
    },
    { title: GROUPS.music, sections: [{ name: GROUPS.music, lines: groupLines("music") }] },
    { title: GROUPS.photo, sections: [{ name: GROUPS.photo, lines: groupLines("photo") }] },
  ];

  const generalSection = { name: GROUPS.general, lines: groupLines("general") };

  return pages.map((page, i) => {
    const embed = new EmbedBuilder()
      .setColor("#282d2f")
      .setTitle(`Command List — ${page.title}`)
      .setFooter({ text: `Bot by ${getCreatorTag()} • Page ${i + 1}/${pages.length} • Use ai--help for AI-specific commands` });

    for (const section of [...page.sections, generalSection]) {
      embed.addFields({ name: section.name, value: section.lines.join("\n"), inline: false });
    }

    return embed;
  });
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
        value: linesFor(["@wes", "ai--memoclr", "ai--memostat"]).join("\n"),
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
        name: GROUPS.guide,
        value: groupLines("guide").join("\n"),
        inline: false,
      },
      {
        name: "🧠 Chat memory",
        value: [
          ...linesFor(["ai--index"]),
          "*on/off need Manage Channels • only new messages are remembered • off deletes what was stored*",
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

  // ── Typo'd commands ─────────────────────────────────────────────────────────
  // "-serch" → "Did you mean `-search`?" with the usage line. No AI call:
  // the command registry doubles as the list of valid commands. Stays quiet
  // when nothing is close, so stray "-something" chatter isn't answered.
  const typo = findClosestCommands(message.content);
  if (typo?.suggestions.length) {
    const options = typo.suggestions.map(c => `\`${c.cmd}\``).join(" or ");
    const usages  = typo.suggestions.map(c => `\`${c.usage}\` ${c.desc}`).join("\n");
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor("#282d2f")
        .setTitle("Unknown command")
        .setDescription(`\`${typo.input}\` isn't a command. Did you mean ${options}?\n\n${usages}`)
        .setFooter({ text: "Use --help to see every command" })],
    }).catch(err => console.error("Typo reply error:", err));
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
});

}

module.exports = { initManual };
