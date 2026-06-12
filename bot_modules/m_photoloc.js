require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const redis = require("../data/db/redis_client.js");
const path = require("path");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Key helpers ───────────────────────────────────────────────────────────────
const PHOTO_USER_KEY  = (userId, serverId)   => `photo:user:${serverId}:${userId}`;
const PHOTO_SERVER_KEY = (serverId)           => `photo:server:${serverId}`;
const PHOTO_CHANNEL_KEY = (serverId, chanId)  => `photo:channel:${serverId}:${chanId}`;
const PHOTO_LEADERBOARD_KEY = (serverId)      => `photo:lb:${serverId}`;

// ── Image detection ───────────────────────────────────────────────────────────
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
const hasImages = msg => msg.attachments.some(a => IMAGE_EXTS.some(e => a.name?.toLowerCase().endsWith(e)));
const getImages = msg => msg.attachments.filter(a => IMAGE_EXTS.some(e => a.name?.toLowerCase().endsWith(e)));

// ── Track uploads ─────────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!hasImages(message)) return;

  const images = getImages(message);
  const count  = images.size;
  const now    = new Date().toISOString();
  const userId = message.author.id;
  const serverId = message.guild.id;
  const chanId = message.channel.id;

  // Per-user stats
  const userKey = PHOTO_USER_KEY(userId, serverId);
  const userRaw = await redis.get(userKey);
  const userData = userRaw ? (typeof userRaw === "string" ? JSON.parse(userRaw) : userRaw) : {
    userId, username: message.author.username, serverId, total: 0, lastUpload: null
  };
  userData.total += count;
  userData.lastUpload = now;
  userData.username = message.author.username;
  await redis.set(userKey, JSON.stringify(userData));

  // Leaderboard (sorted set: score = total photos)
  await redis.zadd(PHOTO_LEADERBOARD_KEY(serverId), { score: userData.total, member: userId });

  // Server-wide stats
  const srvKey = PHOTO_SERVER_KEY(serverId);
  const srvRaw = await redis.get(srvKey);
  const srvData = srvRaw ? (typeof srvRaw === "string" ? JSON.parse(srvRaw) : srvRaw) : {
    total: 0, uniqueUsers: [], channelsUsed: []
  };
  srvData.total += count;
  if (!srvData.uniqueUsers.includes(userId)) srvData.uniqueUsers.push(userId);
  if (!srvData.channelsUsed.includes(chanId)) srvData.channelsUsed.push(chanId);
  await redis.set(srvKey, JSON.stringify(srvData));

  // Channel stats
  const chKey = PHOTO_CHANNEL_KEY(serverId, chanId);
  const chRaw = await redis.get(chKey);
  const chData = chRaw ? (typeof chRaw === "string" ? JSON.parse(chRaw) : chRaw) : { total: 0, uniqueUsers: [] };
  chData.total += count;
  if (!chData.uniqueUsers.includes(userId)) chData.uniqueUsers.push(userId);
  await redis.set(chKey, JSON.stringify(chData));

  console.log(`📸 ${message.author.username} uploaded ${count} image(s) in #${message.channel.name}`);
});

// ── Commands ──────────────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const cmd = message.content.trim().toLowerCase();

  try {
    if (cmd === "-mystat") {
      const raw = await redis.get(PHOTO_USER_KEY(message.author.id, message.guild.id));
      if (!raw) return message.reply("You haven't uploaded any photos yet!");
      const d = typeof raw === "string" ? JSON.parse(raw) : raw;
      return message.reply({ embeds: [
        new EmbedBuilder()
          .setTitle("Your Photo Statistics")
          .setColor("#282d2f")
          .addFields(
            { name: "Total Photos", value: `${d.total}`, inline: true },
            { name: "Last Upload",  value: new Date(d.lastUpload).toLocaleDateString(), inline: true }
          )
          .setFooter({ text: `Stats for ${message.author.username}` })
      ]});
    }

    if (cmd.startsWith("-photostat")) {
      const target = message.mentions.users.first();
      if (!target) return message.reply("Please mention a user! Usage: `-photostat @user`");
      const raw = await redis.get(PHOTO_USER_KEY(target.id, message.guild.id));
      if (!raw) return message.reply(`${target.username} hasn't uploaded any photos yet!`);
      const d = typeof raw === "string" ? JSON.parse(raw) : raw;
      return message.reply({ embeds: [
        new EmbedBuilder()
          .setTitle(`Photo Statistics for ${target.username}`)
          .setColor("#282d2f")
          .setThumbnail(target.displayAvatarURL())
          .addFields(
            { name: "Total Photos", value: `${d.total}`, inline: true },
            { name: "Last Upload",  value: new Date(d.lastUpload).toLocaleDateString(), inline: true }
          )
          .setFooter({ text: `Requested by ${message.author.username}` })
      ]});
    }

    if (cmd === "-toposter") {
      const lbKey = PHOTO_LEADERBOARD_KEY(message.guild.id);
      // zrange with rev + limit top 10
      const top = await redis.zrange(lbKey, 0, 9, { rev: true, withScores: true });
      if (!top?.length) return message.reply("No photo stats yet!");

      // top = [member, score, member, score, ...]
      const lines = [];
      for (let i = 0; i < top.length; i += 2) {
        const memberId = top[i];
        const score    = top[i + 1];
        const raw = await redis.get(PHOTO_USER_KEY(memberId, message.guild.id));
        const name = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw).username : memberId;
        lines.push(`${lines.length + 1}. **${name}** — ${score} photos`);
      }

      return message.reply({ embeds: [
        new EmbedBuilder()
          .setTitle("Top Photo Contributors")
          .setDescription(lines.join("\n"))
          .setColor("#282d2f")
          .setFooter({ text: `Requested by ${message.author.username}` })
      ]});
    }

    if (cmd === "-serverstat") {
      const raw = await redis.get(PHOTO_SERVER_KEY(message.guild.id));
      if (!raw) return message.reply("No photo stats for this server yet!");
      const d = typeof raw === "string" ? JSON.parse(raw) : raw;
      return message.reply({ embeds: [
        new EmbedBuilder()
          .setTitle(`Server Photo Statistics — ${message.guild.name}`)
          .setColor("#282d2f")
          .addFields(
            { name: "Total Photos",   value: `${d.total}`,                  inline: true },
            { name: "Active Users",   value: `${d.uniqueUsers.length}`,     inline: true },
            { name: "Channels Used",  value: `${d.channelsUsed.length}`,    inline: true }
          )
          .setFooter({ text: `Requested by ${message.author.username}` })
      ]});
    }

    if (cmd.startsWith("-channelstat")) {
      const channel = message.mentions.channels.first() || message.channel;
      const raw = await redis.get(PHOTO_CHANNEL_KEY(message.guild.id, channel.id));
      if (!raw) return message.reply("No photo stats for this channel yet!");
      const d = typeof raw === "string" ? JSON.parse(raw) : raw;
      return message.reply({ embeds: [
        new EmbedBuilder()
          .setTitle(`Channel Photo Statistics — #${channel.name}`)
          .setColor("#282d2f")
          .addFields(
            { name: "Total Photos",  value: `${d.total}`,               inline: true },
            { name: "Contributors",  value: `${d.uniqueUsers.length}`,  inline: true }
          )
          .setFooter({ text: `Requested by ${message.author.username}` })
      ]});
    }

  } catch (err) {
    console.error("Command error:", err);
    message.reply("An error occurred while processing your command.");
  }
});

client.once("ready", () => console.log(`✅Logged in as ${client.user.tag}, Photos Up`));
client.login(process.env.DISCORD_BOT_TOKEN_1);