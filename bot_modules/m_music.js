require("dotenv").config();
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require("discord.js");
const { DisTube, RepeatMode } = require("distube");
const { SoundCloudPlugin } = require("@distube/soundcloud");
const fetch   = require("node-fetch");
const { withTimeout } = require("../data/utils/timeout.js");
const { askGemini, askGeminiWithModel } = require("../data/utils/gemini.js");
const { usageLine } = require("../data/commands.js");
// ffmpeg-static's bundled binary segfaults on Render when reading SoundCloud's
// HLS (.m3u8) streams, so we use @ffmpeg-installer/ffmpeg's binary instead.
// FFMPEG_PATH still overrides both, e.g. to point at a system-installed ffmpeg.
const ffmpeg  = process.env.FFMPEG_PATH || require("@ffmpeg-installer/ffmpeg").path;

let distube;
let soundcloudPlugin;

// soundcloud.ts scrapes a public client_id from soundcloud.com once and caches
// it forever. When SoundCloud rotates/revokes that id (or rejects the one
// served to a datacenter IP like Render's) every API call returns 401 and the
// library never recovers until the process restarts. Re-scrape and retry once.
function enableClientIdRefresh(api) {
  const original = api.fetchRequest;
  api.fetchRequest = async (url, method, params) => {
    try {
      return await original(url, method, params);
    } catch (err) {
      if (api.oauthToken || !/Status code (401|403)/.test(err.message)) throw err;
      console.warn(`SoundCloud ${err.message}; refreshing client ID and retrying`);
      await api.getClientId(true);
      return original(url, method, params);
    }
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initMusic(client) {
  console.log("ffmpeg path:", ffmpeg);

  // Optional: pin your own SoundCloud client id / OAuth token (see README) if
  // the auto-scraped one keeps getting rejected on the host.
  soundcloudPlugin = new SoundCloudPlugin({
    ...(process.env.SOUNDCLOUD_CLIENT_ID && { clientId: process.env.SOUNDCLOUD_CLIENT_ID }),
    ...(process.env.SOUNDCLOUD_OAUTH_TOKEN && { oauthToken: process.env.SOUNDCLOUD_OAUTH_TOKEN }),
  });
  enableClientIdRefresh(soundcloudPlugin.soundcloud.api);

  distube = new DisTube(client, {
    ffmpeg: { path: ffmpeg },
    plugins: [soundcloudPlugin],
  });

  distube.on("playSong", (queue, song) => {
    // console.log(
    //   "playSong fired | guild:", queue.voice?.guild?.name,
    //   "| guildId:", queue.voice?.guild?.id,
    //   "| textChannel:", queue.textChannel?.name,
    //   "| textChannel guild:", queue.textChannel?.guild?.name,
    // ); // debug log

    queue.textChannel?.send({
      embeds: [new EmbedBuilder()
        .setColor("#282d2f")
        .setTitle("Now Playing")
        .setDescription(`**[${song.name}](${song.url})**`)
        .addFields(
          { name: "Duration",     value: `${song.formattedDuration}`,                    inline: true },
          { name: "Source",       value: song.source?.toUpperCase() ?? "UNKNOWN",   inline: true },
          { name: "Requested by", value: song.user?.username ?? "Unknown",          inline: true },
        )
        .setThumbnail(song.thumbnail)
        .setFooter({ text: `${queue.songs.length} song(s) remaining in queue` })],
    });
  });

  distube.on("addSong", (queue, song) => {
    queue.textChannel?.send({
      embeds: [new EmbedBuilder()
        .setColor("#282d2f")
        .setTitle("Added to Queue")
        .setDescription(`**[${song.name}](${song.url})**`)
        .addFields(
          { name: "Duration", value: `${song.formattedDuration}`,               inline: true },
          { name: "Position", value: `#${queue.songs.length}`,                  inline: true },
          { name: "Source",   value: song.source?.toUpperCase() ?? "UNKNOWN",   inline: true },
        )
        .setThumbnail(song.thumbnail)],
    });
  });

  distube.on("addList", (queue, playlist) => {
    queue.textChannel?.send(
      `Added **${playlist.name}** playlist — **${playlist.songs.length}** songs to the queue!`
    );
  });

  distube.on("error", (error, queue, song) => {
    console.error("DisTube error:", error);
    queue?.textChannel?.send(
      song ? `  Error playing **${song.name}**: ${error.message}`
           : `  An error occurred: ${error.message}`
    );
  });

  distube.on("finish",     queue => queue.textChannel?.send("Queue finished! Add more songs with `-play`."));
  distube.on("disconnect", queue => queue.textChannel?.send("Disconnected from voice channel."));
  distube.on("empty",      queue => queue.textChannel?.send("Voice channel is empty. Leaving..."));

  distube.on("debug",       message => console.log("[DisTube debug]", message));
  distube.on("ffmpegDebug", message => console.log("[FFmpeg debug]", message));

  return distube;
}

// ─── Help text (defined here, exported for launch.js) ─────────────────────────
const MUSIC_HELP =
  "\n\n**# Music Commands** [Requires being in a voice channel]\n" +
  "`-play <song/url>` — Play from YouTube, Spotify, or SoundCloud.\n" +
  "`-skip` — Skip current song.\n" +
  "`-stop` — Stop and clear queue.\n" +
  "`-pause` — Pause current song.\n" +
  "`-resume` — Resume paused song.\n" +
  "`-queue` — Show current queue.\n" +
  "`-nowplaying` — Show current song info.\n" +
  "`-loop [off|song|queue]` — Toggle loop mode, or jump straight to one.\n" +
  "`-volume <0-100>` — Set volume.\n" +
  "`-leave` — Bot quit voice chat.\n" +
  "`-search <query>` — Search SoundCloud and pick a track from a list.\n" +
  "`-ask rec [song]` — Recommend similar songs (defaults to what's playing).\n" +
  "`-ask desc [song]` — Get info about a song (defaults to what's playing).\n" +
  "`-ask <question>` — General Q&A with the bot assistant.\n" +
  "\n**Supported sources:** YouTube · Spotify · SoundCloud\n";

const MUSIC_COMMANDS = new Set([
  "play", "p", "skip", "s", "stop", "pause", "resume",
  "queue", "q", "volume", "vol", "nowplaying", "np", "ask", "ai", "leave", "l",
  "search", "se", "loop", "lp",
]);

// ─── Bot assistant (-ask / -ai) helpers ────────────────────────────────────────
// Resolves a user-typed song name to a real, playable track via SoundCloud
// search, so "-ask rec <song>"/"-ask desc <song>" work on any track, not
// just whatever's currently playing.
async function resolveSeedSong(query) {
  try {
    const results = await withTimeout(soundcloudPlugin.search(query, "track", 1), 15000, "SoundCloud seed search");
    return results?.[0] || null;
  } catch (err) {
    console.error(`Seed song search failed for "${query}":`, err.message);
    return null;
  }
}

async function fetchSongBackground(query) {
  try {
    const response = await withTimeout(fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query, search_depth: "basic", max_results: 3,
        include_answer: true, include_raw_content: false,
      }),
    }), 15000, "Tavily song lookup");
    if (!response.ok) return { text: null, url: null };
    const data = await response.json();
    const text = data.answer || (data.results?.length ? data.results.map(r => r.content).join("\n").slice(0, 1500) : null);
    const url = data.results?.[0]?.url || null;
    return { text, url };
  } catch (err) {
    console.error("Song background lookup error:", err);
    return { text: null, url: null };
  }
}

async function handleNowPlayingInfo(message, song) {
  const artist = song.uploader?.name || song.user?.username || "Unknown";
  const { text: background, url: infoUrl } = await fetchSongBackground(`${song.name} ${artist} song about`);

  const messages = [
    {
      role: "system",
      content: "You are a music bot writing a short, engaging 2-3 sentence description of a track, like a mini "
        + "Wikipedia blurb. Be concise and factual; if you don't recognize it and no background info is given, "
        + "say so briefly instead of making things up.",
    },
    {
      role: "user",
      content: background
        ? `Track: "${song.name}" by ${artist}. Background info:\n${background}`
        : `Track: "${song.name}" by ${artist}. No background info was found — answer from your own knowledge if you recognize it, otherwise say you don't have info on this one.`,
    },
  ];
  const info = await askGeminiWithModel(messages, { maxTokens: 300 });
  const blurb = info?.text;

  // Prefer the real source we found the background info from; fall back to
  // a YouTube search for the artist so there's always somewhere to click.
  const artistLink = infoUrl || `https://www.youtube.com/results?search_query=${encodeURIComponent(artist)}`;

  return message.channel.send({
    embeds: [new EmbedBuilder()
      .setColor("#282d2f")
      .setTitle(`About: ${song.name}`)
      .setURL(song.url)
      .setDescription(blurb || "Couldn't find any info on this track.")
      .addFields(
        { name: "Uploader/Artist", value: artist,                inline: true },
        { name: "Duration",        value: song.formattedDuration, inline: true },
        { name: "🔗 More about the artist", value: `[Open link](${artistLink})`, inline: false },
      )
      .setThumbnail(song.thumbnail)
      .setFooter(info ? { text: `answered by ${info.model}` } : null)],
  });
}

async function handleRecommend(message, song, voiceChannel) {
  const artist = song.uploader?.name || song.user?.username || "Unknown";

  const messages = [
    {
      role: "system",
      content: "You recommend real, existing songs similar in genre/style to a given track. Reply with ONLY a "
        + "list of 5 \"Song Title - Artist\" lines, nothing else, no numbering, no extra text.",
    },
    { role: "user", content: `Recommend songs similar to "${song.name}" by ${artist}.` },
  ];
  const raw = await askGemini(messages, { maxTokens: 200 });
  const suggestions = (raw || "")
    .split("\n")
    .map(line => line.replace(/^[-•\d.]+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 5);

  if (!suggestions.length) return message.reply("Couldn't come up with any recommendations right now.");

  const found = [];
  for (const suggestion of suggestions) {
    try {
      const results = await withTimeout(soundcloudPlugin.search(suggestion, "track", 1), 15000, "SoundCloud recommend search");
      if (results?.length) found.push(results[0]);
    } catch (err) {
      console.error(`Recommend search failed for "${suggestion}":`, err.message);
    }
  }

  if (!found.length) return message.reply("Couldn't find playable versions of any recommendations right now.");

  const truncate = (str, max) => (str.length > max ? `${str.slice(0, max - 1)}…` : str);

  const menu = new StringSelectMenuBuilder()
    .setCustomId("soundcloud-search")
    .setPlaceholder("Pick a track to queue")
    .addOptions(found.map((s, i) => ({
      label:       truncate(s.name, 100),
      description: truncate(`${s.uploader?.name ?? "Unknown"} • ${s.formattedDuration}`, 100),
      value:       String(i),
    })));

  const embed = new EmbedBuilder()
    .setColor("#282d2f")
    .setTitle(`Recommended — similar to "${song.name}"`)
    .setDescription(found.map((s, i) => `**${i + 1}.** ${s.name} — *${s.formattedDuration}*`).join("\n"))
    .setFooter({ text: "Pick a track from the dropdown below — expires in 30s" });

  let sentMessage;
  try {
    sentMessage = await message.channel.send({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  } catch (err) {
    console.error("Recommend send error:", err);
    return message.reply("Could not display recommendations — please try again.").catch(() => {});
  }

  const collector = sentMessage.createMessageComponentCollector({ time: 30_000 });

  collector.on("collect", async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      interaction.reply({ content: "This isn't your recommendation list!", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    const picked = found[Number(interaction.values[0])];
    collector.stop("picked");

    try {
      await interaction.update({ embeds: [embed], components: [], content: `Selected: **${picked.name}**` });
    } catch (err) {
      console.error("Recommend update error:", err);
    }

    try {
      await distube.play(voiceChannel, picked.url, {
        member: message.member, textChannel: message.channel, message,
      });
    } catch (err) {
      console.error("Recommend play error:", err);
      message.channel.send(`  ${err.message || "Could not play that song."}`).catch(() => {});
    }
  });

  collector.on("end", (_collected, reason) => {
    if (reason === "picked") return;
    sentMessage.edit({
      embeds: [embed],
      components: [],
      content: "Recommendations expired — run `-ask recommend ...` again.",
    }).catch(() => {});
  });
}

async function handleGeneralAsk(message, question, currentSong) {
  const context = currentSong
    ? `Currently playing: "${currentSong.name}" by ${currentSong.uploader?.name || currentSong.user?.username || "Unknown"}.`
    : "Nothing is currently playing.";

  const messages = [
    { role: "system", content: `You're a helpful music bot assistant. Give short, casual responses. ${context}` },
    { role: "user",   content: question },
  ];
  const result = await askGeminiWithModel(messages, { temperature: 0.8, maxTokens: 500 });
  if (!result) return message.reply("Bot is having issues right now!");
  const answer = result.text;

  return message.channel.send({
    embeds: [new EmbedBuilder()
      .setColor("#282d2f")
      .setTitle("🤖 Bot Assistant")
      .addFields(
        { name: "Your Question", value: question },
        { name: "Answer",        value: answer   },
      )
      .setFooter({ text: `Asked by ${message.author.username} • answered by ${result.model}` })],
  });
}

// ─── Command Handler ──────────────────────────────────────────────────────────
async function handleMusicCommand(command, args, message) {
  // Guard: must be used inside a server
  if (!message.guild) {
    return message.reply("Music commands can only be used in a server!");
  }

  const voiceChannel = message.member?.voice?.channel;

  // ── -play / -p ────────────────────────────────────────────────────────────
  if (command === "play" || command === "p") {
    if (!voiceChannel)  return message.reply("You need to be in a voice channel!");
    if (!args.length)   return message.reply(`Please provide a song name or URL!\n${usageLine("-play")}`);
    try {
      await distube.play(voiceChannel, args.join(" "), {
        member: message.member, textChannel: message.channel, message,
      });
    } catch (err) {
      console.error("Play error:", err);
      message.reply(`  ${err.message || "Could not play that song."}`);
    }
    return;
  }

  // ── -search / -se ─────────────────────────────────────────────────────────
  if (command === "search" || command === "se") {
    if (!voiceChannel)  return message.reply("You need to be in a voice channel!");
    if (!args.length)   return message.reply(`Please provide a search query!\n${usageLine("-search")}`);

    const query = args.join(" ");
    let results;
    try {
      results = await withTimeout(soundcloudPlugin.search(query, "track", 10), 15000, "SoundCloud search");
    } catch (err) {
      console.error("Search error:", err);
      return message.reply(`  ${err.message || "Could not search SoundCloud."}`);
    }

    if (!results.length) {
      return message.reply(`No SoundCloud results for **${query}**.`);
    }

    const truncate = (str, max) => (str.length > max ? `${str.slice(0, max - 1)}…` : str);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("soundcloud-search")
      .setPlaceholder("Pick a track to queue")
      .addOptions(results.map((song, i) => ({
        label:       truncate(song.name, 100),
        description: truncate(`${song.uploader?.name ?? "Unknown"} • ${song.formattedDuration}`, 100),
        value:       String(i),
      })));

    const embed = new EmbedBuilder()
      .setColor("#282d2f")
      .setTitle(`SoundCloud results for "${query}"`)
      .setDescription(
        results.map((song, i) => `**${i + 1}.** ${song.name} — *${song.formattedDuration}*`).join("\n")
      )
      .setFooter({ text: "Pick a track from the dropdown below — expires in 30s" });

    let sentMessage;
    try {
      sentMessage = await message.channel.send({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    } catch (err) {
      console.error("Search send error:", err);
      return message.reply("Could not display search results — please try again.").catch(() => {});
    }

    const collector = sentMessage.createMessageComponentCollector({ time: 30_000 });

    collector.on("collect", async (interaction) => {
      if (interaction.user.id !== message.author.id) {
        interaction.reply({ content: "This isn't your search!", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      const picked = results[Number(interaction.values[0])];
      collector.stop("picked");

      try {
        await interaction.update({
          embeds: [embed],
          components: [],
          content: `Selected: **${picked.name}**`,
        });
      } catch (err) {
        console.error("Search update error:", err);
      }

      try {
        await distube.play(voiceChannel, picked.url, {
          member: message.member, textChannel: message.channel, message,
        });
      } catch (err) {
        console.error("Search play error:", err);
        message.channel.send(`  ${err.message || "Could not play that song."}`).catch(() => {});
      }
    });

    collector.on("end", (_collected, reason) => {
      if (reason === "picked") return;
      sentMessage.edit({
        embeds: [embed],
        components: [],
        content: "Search expired — run `-search` again.",
      }).catch(() => {});
    });

    return;
  }

  // ── -leave ─────────────────────────────────────────────────────────────────
  if (command === "leave" || command === "l") {
    const queue = distube.getQueue(message.guildId);
    if (queue) queue.stop();
    const voiceState = message.guild.members.me?.voice;
    if (!voiceState?.channel) return message.reply("I'm not in a voice channel!");
    try {
      await voiceState.disconnect();
      message.react("💔");
    } catch (err) {
      console.error("Leave error:", err);
      message.reply("I couldn't leave the voice channel — I might be missing the **Move Members** permission.");
    }
    return;
  }

  // ── -skip / -s ────────────────────────────────────────────────────────────
  if (command === "skip" || command === "s") {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply("Nothing is playing!");
    try { await queue.skip(); message.react("⏭️"); }
    catch { message.reply("No more songs in queue."); }
    return;
  }

  // ── -stop ──────────────────────────────────────────────────────────────────
  if (command === "stop") {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply("Nothing is playing!");
    queue.stop();
    message.react("⏹️");
    return;
  }

  // ── -pause ─────────────────────────────────────────────────────────────────
  if (command === "pause") {
    const queue = distube.getQueue(message.guildId);
    if (!queue || !queue.playing) return message.reply("Nothing is playing!");
    queue.pause();
    message.react("⏸️");
    return;
  }

  // ── -resume ────────────────────────────────────────────────────────────────
  if (command === "resume") {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply("Nothing to resume!");
    queue.resume();
    message.react("▶️");
    return;
  }

  // ── -loop / -lp ────────────────────────────────────────────────────────────
  if (command === "loop" || command === "lp") {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply("Nothing is playing!");

    const modeMap = {
      off: RepeatMode.DISABLED, disable: RepeatMode.DISABLED, disabled: RepeatMode.DISABLED,
      song: RepeatMode.SONG, track: RepeatMode.SONG,
      queue: RepeatMode.QUEUE, all: RepeatMode.QUEUE,
    };
    const arg = args[0]?.toLowerCase();

    const mode = arg in modeMap ? queue.setRepeatMode(modeMap[arg]) : queue.setRepeatMode();

    const labels = {
      [RepeatMode.DISABLED]: "Off",
      [RepeatMode.SONG]:     "🔂 Looping current song",
      [RepeatMode.QUEUE]:    "🔁 Looping whole queue",
    };
    return message.reply(`Loop mode: **${labels[mode]}**`);
  }

  // ── -queue / -q ────────────────────────────────────────────────────────────
  if (command === "queue" || command === "q") {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply("Queue is empty!");

    const current = queue.songs[0];
    let desc = `**Now Playing:**\n${current.name} — *${current.formattedDuration}*\n\n`;

    if (queue.songs.length > 1) {
      desc += "**Up Next:**\n";
      queue.songs.slice(1, 11).forEach((song, i) => {
        desc += `${i + 1}. ${song.name} — *${song.formattedDuration}*\n`;
      });
      if (queue.songs.length > 11) desc += `\n*...and ${queue.songs.length - 11} more*`;
    }

    return message.channel.send({
      embeds: [new EmbedBuilder()
        .setColor("#282d2f")
        .setTitle("Music Queue")
        .setDescription(desc)
        .setFooter({ text: `Requested by ${message.author.username}` })],
    });
  }

  // ── -volume / -vol ─────────────────────────────────────────────────────────
  if (command === "volume" || command === "vol") {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply("  Nothing is playing!");
    if (!args.length) return message.reply(`🔊 Current volume: **${queue.volume}%**`);

    const vol = parseInt(args[0]);
    if (isNaN(vol) || vol < 0 || vol > 100) return message.reply(`Volume must be 0–100!\n${usageLine("-volume")}`);
    queue.setVolume(vol);
    return message.reply(`🔊 Volume set to **${vol}%**`);
  }

  // ── -nowplaying / -np ──────────────────────────────────────────────────────
  if (command === "nowplaying" || command === "np") {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply(" Nothing is playing!");

    const song = queue.songs[0];
    return message.channel.send({
      embeds: [new EmbedBuilder()
        .setColor("#282d2f")
        .setTitle("Now Playing")
        .setDescription(`**[${song.name}](${song.url})**`)
        .addFields(
          { name: "Duration",     value: song.formattedDuration,                    inline: true },
          { name: "Source",       value: song.source?.toUpperCase() ?? "UNKNOWN",   inline: true },
          { name: "Requested by", value: song.user?.username ?? "Unknown",          inline: true },
          { name: "Volume",       value: `${queue.volume}%`,                        inline: true },
        )
        .setThumbnail(song.thumbnail)],
    });
  }

  // ── -ask / -ai ─────────────────────────────────────────────────────────────
  if (command === "ask" || command === "ai") {
    if (!args.length) return message.reply("Try `-ask rec [song]`, `-ask desc [song]`, or `-ask <question>`");
    if (!process.env.GOOGLE_API_KEY) return message.reply("The bot assistant isn't configured on this server.");

    const sub = args[0].toLowerCase();
    const queue = distube.getQueue(message.guildId);
    const currentSong = queue?.songs?.[0];

    try {
      if (sub === "rec" || sub === "recommend") {
        const songQuery = args.slice(1).join(" ").trim();
        const seed = songQuery ? await resolveSeedSong(songQuery) : currentSong;
        if (!seed) {
          return message.reply(songQuery
            ? `Couldn't find "${songQuery}" to base recommendations on.`
            : "Nothing is playing right now — play something first, or use `-ask rec <song>`.");
        }
        if (!voiceChannel) return message.reply("You need to be in a voice channel to queue a recommendation!");
        return await handleRecommend(message, seed, voiceChannel);
      }

      if (sub === "desc" || sub === "description") {
        const songQuery = args.slice(1).join(" ").trim();
        const seed = songQuery ? await resolveSeedSong(songQuery) : currentSong;
        if (!seed) {
          return message.reply(songQuery
            ? `Couldn't find "${songQuery}".`
            : "Nothing is playing right now — play something first, or use `-ask desc <song>`.");
        }
        return await handleNowPlayingInfo(message, seed);
      }

      return await handleGeneralAsk(message, args.join(" "), currentSong);
    } catch (err) {
      console.error("Ask error:", err);
      return message.reply("  Something went wrong with the bot assistant!");
    }
  }
}

module.exports = { initMusic, handleMusicCommand, MUSIC_COMMANDS, MUSIC_HELP };