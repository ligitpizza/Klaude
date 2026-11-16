const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const { storageTarget } = require("./channels.js");
const { usageLine } = require("../commands.js");

const SWEEP_MS = 60_000;
const COMMAND_PREFIX = /^(ai--|--|-)/;

// "<@42>" → "@bob" so stored chat reads naturally.
const cleanContent = (msg) => String(msg.content ?? "").replace(/<@!?(\d+)>/g,
  (_, id) => `@${msg.mentions?.users?.get(id)?.username ?? "user"}`);

// Chat ingestion for channels with ai--index on. Every handler logs instead of
// throwing: storing chat must never get in the way of the bot.
function createIngest({ buffer, store, indexed, now = Date.now }) {
  const save = async (chunks) => {
    for (const chunk of chunks) {
      try { await store.saveChunk(chunk); } catch (err) { console.error("Chat chunk save failed:", err.message); }
    }
  };

  // Storage target for a message, only when its channel's switch is on.
  const indexedTarget = (msg) => {
    if (!msg?.guild) return null;
    const target = storageTarget(msg.channel);
    return target && indexed.isIndexed(msg.guild.id, target.switchId) ? target : null;
  };

  async function onMessage(msg) {
    try {
      if (msg.author?.bot) return;
      if (COMMAND_PREFIX.test(String(msg.content ?? "").trim())) return;
      const target = indexedTarget(msg);
      if (!target) return;
      const closed = buffer.add(
        { ...target, guildId: msg.guild.id },
        { id: msg.id, author: msg.author.username, content: cleanContent(msg), ts: msg.createdTimestamp },
      );
      if (closed) await save([closed]);
    } catch (err) {
      console.error("Chat ingest failed:", err.message);
    }
  }

  async function onUpdate(_oldMsg, newMsg) {
    try {
      if (newMsg?.partial || newMsg?.content == null || newMsg.author?.bot) return; // content unknown
      const target = indexedTarget(newMsg);
      if (!target) return;
      const content = cleanContent(newMsg);
      if (!buffer.edit(target.key, newMsg.id, content)) await store.editMessage(target.switchId, newMsg.id, content);
    } catch (err) {
      console.error("Chat edit failed:", err.message);
    }
  }

  async function onDelete(msg) {
    try {
      const target = indexedTarget(msg);
      if (!target) return;
      if (!buffer.remove(target.key, msg.id)) await store.deleteMessage(target.switchId, msg.id);
    } catch (err) {
      console.error("Chat delete failed:", err.message);
    }
  }

  return {
    onMessage, onUpdate, onDelete,
    sweep: () => save(buffer.sweep(now())),
    flushAll: () => save(buffer.drain()),
    stopChannel: (switchId) => buffer.discardSwitch(switchId),
  };
}

function initChatIngest(client, ingest) {
  client.on("messageCreate", (m) => ingest.onMessage(m));
  client.on("messageUpdate", (o, n) => ingest.onUpdate(o, n));
  client.on("messageDelete", (m) => ingest.onDelete(m));
  setInterval(() => ingest.sweep(), SWEEP_MS).unref();

  // Render sends SIGTERM before a restart: save open chunks first.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down — saving open chat chunks...");
    await ingest.flushAll();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// ── ai--index on | off | status ──────────────────────────────────────────────
const embed = (title, description) => ({
  embeds: [new EmbedBuilder().setColor("#282d2f").setTitle(title).setDescription(description)],
});

async function handleIndexCommand(message, { indexed, store, ingest }) {
  const sub = message.content.trim().split(/\s+/)[1]?.toLowerCase();
  const ch = message.channel;

  if (!message.guild) return message.reply(embed("Chat memory", "Chat memory only works in servers."));
  if (ch?.isThread?.()) {
    return message.reply(embed("Chat memory", "Threads follow their parent channel. Run `ai--index` in the parent channel."));
  }
  const target = storageTarget(ch);
  if (!target) return message.reply(embed("Chat memory", "Chat memory can't be used in this kind of channel."));
  if (!["on", "off", "status"].includes(sub)) return message.reply(embed("Correct Usage:", usageLine("ai--index")));

  const guildId = message.guild.id;
  const isOn = indexed.isIndexed(guildId, target.switchId);

  try {
    if (sub === "status") {
      const n = isOn ? await store.countChunks(target.switchId) : 0;
      return message.reply(embed("Chat memory",
        isOn ? `**On** for <#${ch.id}> — ${n} conversation chunk(s) stored.` : `**Off** for <#${ch.id}>.`));
    }

    if (!ch.permissionsFor(message.member)?.has(PermissionFlagsBits.ManageChannels)) {
      return message.reply(embed("Not allowed", "You need the **Manage Channels** permission in this channel."));
    }

    if (sub === "on") {
      await indexed.set(guildId, target.switchId, true);
      return message.reply(embed("Chat memory on",
        `I'll remember conversations in <#${ch.id}> and its public threads from now on. Only new messages are remembered — nothing older is imported.`));
    }

    // off: stop first so nothing open gets saved after the delete
    ingest.stopChannel(target.switchId);
    await indexed.set(guildId, target.switchId, false);
    const removed = await store.deleteChannel(target.switchId);
    return message.reply(embed("Chat memory off",
      `Stopped remembering <#${ch.id}> and deleted ${removed} stored conversation chunk(s).`));
  } catch (err) {
    console.error("ai--index failed:", err.message);
    return message.reply(embed("Error", "Couldn't update chat memory right now. Try again later."));
  }
}

module.exports = { createIngest, initChatIngest, handleIndexCommand, cleanContent };
