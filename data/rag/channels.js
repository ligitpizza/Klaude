const { ChannelType, PermissionFlagsBits } = require("discord.js");

const INDEXED_KEY = (guildId) => `rag:indexed:${guildId}`;

// Which channels have chat memory turned on. Kept in memory so the check on
// every message is free; Redis is only written by ai--index on/off and read
// once at startup.
function createIndexedChannels({ redis }) {
  const byGuild = new Map();
  const setFor = (g) => { if (!byGuild.has(g)) byGuild.set(g, new Set()); return byGuild.get(g); };

  return {
    async load(guildIds) {
      for (const g of guildIds) {
        const ids = await redis.smembers(INDEXED_KEY(g));
        byGuild.set(g, new Set((ids || []).map(String)));
      }
    },
    isIndexed: (guildId, channelId) => byGuild.get(guildId)?.has(channelId) ?? false,
    async set(guildId, channelId, on) {
      if (on) await redis.sadd(INDEXED_KEY(guildId), channelId);
      else await redis.srem(INDEXED_KEY(guildId), channelId);
      if (on) setFor(guildId).add(channelId);
      else setFor(guildId).delete(channelId);
    },
    list: (guildId) => [...(byGuild.get(guildId) || [])],
  };
}

const TEXT_CHANNELS = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice]);
const PUBLIC_THREADS = new Set([ChannelType.PublicThread, ChannelType.AnnouncementThread]);

// Where a channel's messages are stored (key) and whose ai--index switch
// covers them (switchId). Public threads and forum posts follow their parent's
// switch. Private threads are never stored: their member lists can't be
// checked through the parent's permissions.
function storageTarget(channel) {
  if (!channel) return null;
  if (TEXT_CHANNELS.has(channel.type)) {
    return { key: channel.id, switchId: channel.id, channelName: channel.name };
  }
  if (PUBLIC_THREADS.has(channel.type) && channel.parent) {
    return { key: channel.id, switchId: channel.parent.id, channelName: `${channel.parent.name} › ${channel.name}` };
  }
  return null;
}

const canView = (channel, who) => Boolean(channel.permissionsFor(who)?.has(PermissionFlagsBits.ViewChannel));

// True when @everyone can read the channel (threads: their parent; private
// threads never count as public).
function isPublicChannel(channel, guild) {
  if (!channel || !guild) return false;
  if (channel.type === ChannelType.PrivateThread) return false;
  const base = PUBLIC_THREADS.has(channel.type) && channel.parent ? channel.parent : channel;
  return canView(base, guild.roles.everyone);
}

// The reply is read by everyone in the ask channel, not just the asker. So:
//   - the ask channel's own memory is fine (same audience), and
//   - other channels only when @everyone can view them (and the asker can).
// A restricted channel's memory therefore only answers inside that channel.
function allowedSources({ guild, askChannel, member, indexed }) {
  const switchIds = indexed.list(guild.id).filter(id => {
    const ch = guild.channels.cache.get(id);
    return ch && canView(ch, guild.roles.everyone) && canView(ch, member);
  });
  const target = storageTarget(askChannel);
  const askKey = target && indexed.isIndexed(guild.id, target.switchId) ? target.key : null;
  return { switchIds, askKey };
}

module.exports = { createIndexedChannels, storageTarget, allowedSources, isPublicChannel };
