require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const fs = require("fs-extra");
const moment = require("moment");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildInvites,
  ],
});

// ─── Data Paths (centralized) ─────────────────────────────────────────────────
const PATHS = {
  logs:     "./logs",
  data:     "./data/exports",
  messages: "./data/messages",
  webhooks: "./data/webhooks",
  tracking: "./data/tracking",
};

Object.values(PATHS).forEach(p => fs.ensureDirSync(p));

// ─── Logging ──────────────────────────────────────────────────────────────────
function logAccess(type, userId, targetData, severity = "INFO") {
  const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
  const entry = `[${timestamp}] [${severity}] ${type} | User: ${userId} | Target: ${JSON.stringify(targetData)}\n`;
  fs.appendFileSync(`${PATHS.logs}/access.log`, entry);
  if (severity === "HIGH" || severity === "CRITICAL") {
    fs.appendFileSync(`${PATHS.logs}/critical.log`, entry);
  }
}

function exportData(data, filename) {
  fs.writeJsonSync(`${PATHS.data}/${filename}`, data, { spaces: 2 });
}

// ─── In-memory message store ──────────────────────────────────────────────────
const messageDatabase = {};

client.once("ready", c => {
  console.log(`✅Logged in as ${c.user.tag}, Extractor module active`);
  // console.log("Extractor module active | Logging: ON | Export: ON");
});

client.on("messageCreate", async msg => {

  const userName = msg.author.username;
  // Passive collection
  if (!messageDatabase[msg.channel.id]) messageDatabase[msg.channel.id] = [];
  messageDatabase[msg.channel.id].push({
    messageId:   msg.id,
    author:      { id: msg.author.id, username: msg.author.username, bot: msg.author.bot },
    content:     msg.content,
    timestamp:   msg.createdAt.toISOString(),
    attachments: msg.attachments.map(a => a.url),
    embeds:      msg.embeds.length,
  });
  if (messageDatabase[msg.channel.id].length > 1000) {
    messageDatabase[msg.channel.id].shift();
  }

  if (msg.author.bot) return;

  // ── --myid ──────────────────────────────────────────────────────────────────
  if (msg.content === "--myid") {
    logAccess("SELF_ID_CHECK", msg.author.id, { username: msg.author.username });
    return msg.reply(`Your Discord User ID is: \`${msg.author.id}\``);
  }

  // ── --userid @user ──────────────────────────────────────────────────────────
  if (msg.content.startsWith("--userid")) {
    const user = msg.mentions.users.first();
    if (!user) return msg.reply("Please mention a user! Usage: `--userid @username`");
    logAccess("USER_ID_LOOKUP", msg.author.id, { targetUser: user.username, targetId: user.id });
    return msg.reply(`User ID of **${user.username}**: \`${user.id}\``);
  }

  // ── --serverids ─────────────────────────────────────────────────────────────
  if (msg.content === "--serverids") {
    try {
      const members = await msg.guild.members.fetch();
      const memberList = [];
      let userList = "**Server Member IDs:**\n\n";

      members.forEach(member => {
        userList += `${member.user.username}: \`${member.user.id}\`\n`;
        memberList.push({ username: member.user.username, id: member.user.id, isBot: member.user.bot });
      });

      const filename = `server_${msg.guild.id}_members.json`;
      exportData(memberList, filename);
      logAccess("MASS_ID_EXTRACTION", msg.author.id, { serverName: msg.guild.name, count: members.size }, "HIGH");

      const chunks = userList.match(/[\s\S]{1,1900}/g);
      for (const chunk of chunks) await msg.channel.send(chunk);
      // return msg.channel.send(`Exported to: \`${PATHS.data}/${filename}\``);
    } catch (err) {
      console.error(err);
      return msg.reply("Error fetching members.");
    }
  }

  // ── --userinfo [@user] ──────────────────────────────────────────────────────
  if (msg.content.startsWith("--userinfo")) {
    const user   = msg.mentions.users.first() || msg.author;
    const member = msg.guild.members.cache.get(user.id);

    const userData = {
      username:      user.username,
      id:            user.id,
      discriminator: user.discriminator,
      createdAt:     user.createdAt.toISOString(),
      bot:           user.bot,
      avatarURL:     user.displayAvatarURL({ dynamic: true, size: 512 }),
    };

    if (member) {
      userData.joinedAt   = member.joinedAt.toISOString();
      userData.roles      = member.roles.cache.map(r => ({ name: r.name, id: r.id }));
      userData.nickname   = member.nickname;
      userData.presence   = member.presence?.status || "offline";
      userData.activities = member.presence?.activities.map(a => ({
        name: a.name, type: a.type, details: a.details,
      })) || [];
    }

    logAccess("DETAILED_USER_INFO", msg.author.id, { targetUser: user.username, targetId: user.id }, "MEDIUM");
    exportData(userData, `user_${user.id}_data.json`);

    // ✅ Fixed: using .addFields() (array) — required in discord.js v14
    const embed = new EmbedBuilder()
      .setColor("#282d2f")
      .setTitle("User Information")
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: "Username",       value: user.username,                          inline: true },
        { name: "User ID",        value: `\`${user.id}\``,                       inline: true },
        { name: "Discriminator",  value: user.discriminator || "N/A",            inline: true },
        { name: "Account Created",value: user.createdAt.toDateString(),          inline: true },
        { name: "Bot Account",    value: user.bot ? "Yes" : "No",               inline: true },
      )
      .setFooter({ text: "Extractor function - requested by " + msg.author.username });

    if (member) {
      embed.addFields(
        { name: "Joined Server", value: member.joinedAt.toDateString(),                              inline: true },
        { name: "Nickname",      value: member.nickname || "None",                                   inline: true },
        { name: "Status",        value: member.presence?.status || "offline",                       inline: true },
        { name: "Roles",         value: member.roles.cache.map(r => r.name).join(", ") || "None",  inline: false },
      );
      if (member.presence?.activities.length > 0) {
        embed.addFields({
          name:  "Current Activities",
          value: member.presence.activities.map(a => `${a.name} (${a.type})`).join("\n"),
          inline: false,
        });
      }
    }

    msg.channel.send({ embeds: [embed] });
    // return msg.channel.send(`Exported to: \`${PATHS.data}/user_${user.id}_data.json\``);
  }

  // ── --track @user ───────────────────────────────────────────────────────────
  if (msg.content.startsWith("--track")) {
    const user = msg.mentions.users.first();
    if (!user) return msg.reply("Please mention a user! Usage: `--track @username`");

    const member = msg.guild.members.cache.get(user.id);
    if (!member) return msg.reply("User not found in this server.");

    const trackingData = {
      userId:      user.id,
      username:    user.username,
      timestamp:   moment().format(),
      status:      member.presence?.status || "offline",
      activities:  member.presence?.activities || [],
      roles:       member.roles.cache.map(r => r.name),
      joinedServer:member.joinedAt.toISOString(),
      accountAge:  moment().diff(user.createdAt, "days"),
    };

    logAccess("USER_TRACKING", msg.author.id, { targetUser: user.username }, "MEDIUM");

    const trackFile = `${PATHS.tracking}/tracking_${user.id}.json`;
    const existing  = fs.existsSync(trackFile) ? fs.readJsonSync(trackFile) : [];
    existing.push(trackingData);
    fs.writeJsonSync(trackFile, existing, { spaces: 2 });

    return msg.reply(`Tracking recorded for **${user.username}**. Total records: ${existing.length}`);
  }

  // ── --stk @user ───────────────────────────────────────────────────────────
  if (msg.content.startsWith("--stk")) {
    const user = msg.mentions.users.first();
    if (!user) return msg.reply("Please mention a user! Usage: `--stalk @username`");

    const member = msg.guild.members.cache.get(user.id);

    // ✅ Fixed: using .addFields() (array) — required in discord.js v14
    const embed = new EmbedBuilder()
      .setColor("#282d2f")
      .setTitle("Advanced Profile Analysis")
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: "Target User", value: `${user.username}#${user.discriminator}`, inline: false },
        { name: "User ID",     value: `\`${user.id}\``,                         inline: true  },
        { name: "Account Age", value: `${moment().diff(user.createdAt, "days")} days`, inline: true },
      );

    if (member) {
      embed.addFields(
        { name: "Server Join Date", value: member.joinedAt.toDateString(),                         inline: true  },
        { name: "Days in Server",   value: `${moment().diff(member.joinedAt, "days")} days`,       inline: true  },
        { name: "Total Roles",      value: `${member.roles.cache.size}`,                           inline: true  },
        { name: "Highest Role",     value: member.roles.highest.name,                              inline: true  },
        { name: "Permissions",      value: `${member.permissions.toArray().slice(0, 5).join(", ")}` + `...`, inline: false },
      );
    }

    embed.addFields({
      name:  "Avatar URL",
      value: user.displayAvatarURL({ dynamic: true, size: 512 }),
      inline: false,
    });
    // embed.setFooter({ text: "This is a privacy violation demonstration" });

    logAccess("STALKER_PROFILE", msg.author.id, { targetUser: user.username }, "HIGH");
    return msg.channel.send({ embeds: [embed] });
  }

  // ── --export ────────────────────────────────────────────────────────────────
  if (msg.content === "--export") {
    try {
      msg.reply("Exporting all server data...");

      const members  = await msg.guild.members.fetch();
      const channels = msg.guild.channels.cache;
      const roles    = msg.guild.roles.cache;

      const serverData = {
        exportDate: moment().format(),
        server: {
          id:          msg.guild.id,
          name:        msg.guild.name,
          memberCount: msg.guild.memberCount,
          createdAt:   msg.guild.createdAt.toISOString(),
          ownerId:     msg.guild.ownerId,
        },
        members: members.map(m => ({
          id:            m.user.id,
          username:      m.user.username,
          discriminator: m.user.discriminator,
          isBot:         m.user.bot,
          joinedAt:      m.joinedAt.toISOString(),
          roles:         m.roles.cache.map(r => r.name),
          status:        m.presence?.status || "offline",
        })),
        channels: channels.map(c => ({ id: c.id, name: c.name, type: c.type })),
        roles:    roles.map(r => ({
          id:          r.id,
          name:        r.name,
          color:       r.hexColor,
          position:    r.position,
          permissions: r.permissions.toArray(),
        })),
      };

      const filename = `FULL_SERVER_EXPORT_${msg.guild.id}.json`;
      exportData(serverData, filename);
      logAccess("FULL_SERVER_EXPORT", msg.author.id, { serverName: msg.guild.name }, "CRITICAL");

      return msg.channel.send(
        `Export complete!\n \`${PATHS.data}/${filename}\`\n` +
        `Members: ${members.size} | Channels: ${channels.size} | Roles: ${roles.size}`
      );
    } catch (err) {
      console.error(err);
      return msg.reply("Error exporting server data.");
    }
  }

  // ── --analyze @user ─────────────────────────────────────────────────────────
  if (msg.content.startsWith("--analyze")) {
    const user = msg.mentions.users.first();
    if (!user) return msg.reply("Please mention a user! Usage: `--analyze @username`");

    let totalMessages = 0;
    const channelActivity = {};
    const messagesByHour  = {};

    Object.keys(messageDatabase).forEach(channelId => {
      messageDatabase[channelId].forEach(m => {
        if (m.author.id !== user.id) return;
        totalMessages++;
        const ch = msg.guild.channels.cache.get(channelId);
        if (ch) channelActivity[ch.name] = (channelActivity[ch.name] || 0) + 1;
        const hr = moment(m.timestamp).hour();
        messagesByHour[hr] = (messagesByHour[hr] || 0) + 1;
      });
    });

    const mostActiveHours = Object.entries(messagesByHour)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([h, c]) => `${h}:00 (${c} msgs)`).join(", ") || "N/A";

    const topChannels = Object.entries(channelActivity)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([ch, c]) => `${ch}: ${c}`).join("\n") || "No data";

    const embed = new EmbedBuilder()
      .setColor('#282d2f')
      .setTitle("Message Pattern Analysis")
      .setDescription(`Analysis for **${user.username}**`)
      .addFields(
        { name: "Total Messages",  value: `${totalMessages}`,                        inline: true  },
        { name: "Channels Tracked",value: `${Object.keys(channelActivity).length}`,  inline: true  },
        { name: "Most Active Hours",value: mostActiveHours,                          inline: false },
        { name: "Top Channels",    value: topChannels,                               inline: false },
      )
      .setFooter({ text: "Based on messages since bot started" });

    logAccess("MESSAGE_ANALYSIS", msg.author.id, { targetUser: user.username, msgCount: totalMessages }, "HIGH");
    return msg.channel.send({ embeds: [embed] });
  }

  // ── --webhooks ──────────────────────────────────────────────────────────────
  if (msg.content === "--webhooks") {
    try {
      const webhooks = await msg.guild.fetchWebhooks();
      if (webhooks.size === 0) return msg.reply("No webhooks found.");

      const webhookData = webhooks.map(wh => ({
        id:        wh.id,
        name:      wh.name,
        channelId: wh.channelId,
        token:     wh.token ? "[REDACTED]" : "No token",
        url:       wh.url,
        owner:     wh.owner?.username || "Unknown",
      }));

      const filename = `webhooks/webhooks_${msg.guild.id}.json`;
      exportData(webhookData, filename);

      const embed = new EmbedBuilder()
        .setColor('#282d2f')
        .setTitle("Server Webhooks Detected")
        .setDescription(`Found ${webhooks.size} webhook(s)`)
        .addFields({ name: "Security Risk", value: "Webhooks can be abused for impersonation and spam", inline: false });

      webhooks.forEach(wh => {
        const ch = msg.guild.channels.cache.get(wh.channelId);
        embed.addFields({
          name:  `${wh.name} (ID: ${wh.id})`,
          value: `Channel: ${ch?.name || "Unknown"}\nOwner: ${wh.owner?.username || "Unknown"}`,
          inline: false,
        });
      });

      logAccess("WEBHOOK_ENUMERATION", msg.author.id, { count: webhooks.size }, "CRITICAL");
      msg.channel.send({ embeds: [embed] });
      return msg.channel.send(`Exported to: \`${PATHS.data}/${filename}\``);
    } catch (err) {
      console.error(err);
      return msg.reply("Error fetching webhooks. Missing permissions?");
    }
  }

  // ── --invites ───────────────────────────────────────────────────────────────
  if (msg.content === "--invites") {
    try {
      const invites = await msg.guild.invites.fetch();
      if (invites.size === 0) return msg.reply("No active invites found.");

      const inviteData = invites.map(inv => ({
        code:      inv.code,
        inviter:   inv.inviter?.username || "Unknown",
        uses:      inv.uses,
        maxUses:   inv.maxUses,
        channel:   inv.channel?.name,
        expiresAt: inv.expiresAt?.toISOString() || "Never",
        createdAt: inv.createdAt.toISOString(),
      }));

      exportData(inviteData, `invites_${msg.guild.id}.json`);

      const embed = new EmbedBuilder()
        .setColor('#282d2f')
        .setTitle("Server Invite Analysis")
        .setDescription(`Found ${invites.size} active invite(s)`);

      invites.forEach(inv => {
        embed.addFields({
          name:  `Code: ${inv.code}`,
          value: `Inviter: ${inv.inviter?.username || "Unknown"}\nUses: ${inv.uses}/${inv.maxUses || "∞"}\nChannel: ${inv.channel?.name}`,
          inline: true,
        });
      });

      logAccess("INVITE_ENUMERATION", msg.author.id, { count: invites.size }, "HIGH");
      return msg.channel.send({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      return msg.reply("Error fetching invites. Missing permissions?");
    }
  }

  // ── --permissions @user ─────────────────────────────────────────────────────
  if (msg.content.startsWith("--permissions")) {
    const user = msg.mentions.users.first();
    if (!user) return msg.reply("Please mention a user! Usage: `--permissions @username`");

    const member = msg.guild.members.cache.get(user.id);
    if (!member) return msg.reply("User not found in this server.");

    const permissions   = member.permissions.toArray();
    const dangerousPerms = permissions.filter(p =>
      ["Administrator", "ManageGuild", "ManageChannels", "ManageRoles",
       "KickMembers", "BanMembers", "ManageWebhooks"].includes(p)
    );

    const embed = new EmbedBuilder()
      .setColor(dangerousPerms.length > 0 ? '#282d2f' : '#282d2f')
      .setTitle("Permission Analysis")
      .setDescription(`Analyzing **${user.username}**`)
      .addFields(
        { name: "Total Permissions",    value: `${permissions.length}`,    inline: true },
        { name: "Dangerous Permissions",value: `${dangerousPerms.length}`, inline: true },
        { name: "Is Administrator",     value: member.permissions.has("Administrator") ? "YES" : "No", inline: true },
        { name: "All Permissions",      value: `${permissions.join(", ")}` || "None", inline: false },
      )
      .setFooter({ text: "Extractor function - requested by " + msg.author.username });

    if (dangerousPerms.length > 0) {
      embed.addFields({ name: "Dangerous Perms", value: `${dangerousPerms.join(", ")}`, inline: false });
    }

    logAccess("PERMISSION_ANALYSIS", msg.author.id, { targetUser: user.username, dangerousPerms: dangerousPerms.length }, "MEDIUM");
    return msg.channel.send({ embeds: [embed] });
  }

  // ── --correlation ───────────────────────────────────────────────────────────
  if (msg.content === "--correlation") {
    try {
      msg.reply("Analyzing collected data...");

      const members  = await msg.guild.members.fetch();
      const analysis = {
        totalMembers:        members.size,
        bots:                members.filter(m => m.user.bot).size,
        humans:              members.filter(m => !m.user.bot).size,
        onlineUsers:         members.filter(m => m.presence?.status === "online").size,
        roles:               msg.guild.roles.cache.size,
        channels:            msg.guild.channels.cache.size,
        trackingFiles:       fs.readdirSync(PATHS.tracking).length,
        channelsMonitored:   Object.keys(messageDatabase).length,
        totalMessagesTracked:Object.values(messageDatabase).reduce((s, m) => s + m.length, 0),
      };

      const embed = new EmbedBuilder()
        .setColor('#282d2f')
        .setTitle("Data Correlation Analysis")
        .addFields(
          { name: "Server Stats",          value: `Members: ${analysis.totalMembers}\nBots: ${analysis.bots}\nHumans: ${analysis.humans}\nOnline: ${analysis.onlineUsers}`, inline: true  },
          { name: "Infrastructure",        value: `Roles: ${analysis.roles}\nChannels: ${analysis.channels}`,                                                               inline: true  },
          { name: "Collected Intelligence",value: `Tracking Files: ${analysis.trackingFiles}\nChannels Monitored: ${analysis.channelsMonitored}\nMessages Logged: ${analysis.totalMessagesTracked}`, inline: false },
        )
        .setFooter({ text: "Data correlation capabilities demonstration" });

      exportData(analysis, `correlation_${Date.now()}.json`);
      logAccess("DATA_CORRELATION", msg.author.id, analysis, "CRITICAL");

      return msg.channel.send({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      return msg.reply("Error performing correlation analysis.");
    }
  }

  // ── --logs ──────────────────────────────────────────────────────────────────
// if (msg.content === "--logs") {
//   try {
//     const logs = fs.readFileSync(`${PATHS.logs}/access.log`, "utf8");
//     const recent = logs.split("\n").slice(-20).join("\n") || "No logs yet";
//     const chunks = recent.match(/[\s\S]{1,1900}/g);
//     for (const chunk of chunks) await msg.channel.send(`\`\`\`\n${chunk}\n\`\`\``);
//   } catch {
//     return msg.reply("No logs found yet.");
//   }
// }

  // ── --criticallogs ──────────────────────────────────────────────────────────
// if (msg.content === "--criticallogs") {
//   try {
//     const logFile = `${PATHS.logs}/critical.log`;
//     if (!fs.existsSync(logFile)) return msg.reply("No critical events logged yet.");
//     const logs = fs.readFileSync(logFile, "utf8");
//     const recent = logs.split("\n").slice(-15).join("\n");
//     const chunks = recent.match(/[\s\S]{1,1900}/g);
//     for (const chunk of chunks) await msg.channel.send(`\`\`\`\n${chunk}\n\`\`\``);
//   } catch {
//     return msg.reply("Error reading critical logs.");
//   }
// }
});

client.login(process.env.DISCORD_BOT_TOKEN_1);