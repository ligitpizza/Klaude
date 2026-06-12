require("dotenv").config();
const { EmbedBuilder } = require("discord.js");
const { DisTube }      = require("distube");
const { SpotifyPlugin }    = require("@distube/spotify");
const { SoundCloudPlugin } = require("@distube/soundcloud");
const fetch   = require("node-fetch");
const ffmpeg  = require("ffmpeg-static");

let distube;

// ─── Init ─────────────────────────────────────────────────────────────────────
function initMusic(client) {
  console.log("ffmpeg path:", ffmpeg);

  distube = new DisTube(client, {
    ffmpeg: { path: ffmpeg },
    plugins: [new SpotifyPlugin(), new SoundCloudPlugin()],
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
  "`-volume <0-100>` — Set volume.\n" +
  "`-leave` — Bot quit voice chat.\n" +
  // "`-ask <question>` — Ask the AI assistant.\n" +
  "\n**Supported sources:** YouTube · Spotify · SoundCloud\n";

const MUSIC_COMMANDS = new Set([
  "play", "p", "skip", "s", "stop", "pause", "resume",
  "queue", "q", "volume", "vol", "nowplaying", "np", "ask", "ai", "leave", "l",
]);

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
    if (!args.length)   return message.reply("Please provide a song name or URL!");
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

  // ── -leave ─────────────────────────────────────────────────────────────────
  if (command === "leave" || command === "l") {
    const queue = distube.getQueue(message.guildId);
    if (queue) queue.stop();
    const voiceState = message.guild.members.me?.voice;
    if (!voiceState?.channel) return message.reply("I'm not in a voice channel!");
    await voiceState.disconnect();
    message.react("💔");
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
      embeds: [new EmbedBuilder().setColor("#282d2f").setTitle("Music Queue").setDescription(desc)].setFooter({ text: `Requested by **${userName}**` }),
    });
  }

  // ── -volume / -vol ─────────────────────────────────────────────────────────
  if (command === "volume" || command === "vol") {
    const queue = distube.getQueue(message.guildId);
    if (!queue) return message.reply("  Nothing is playing!");
    if (!args.length) return message.reply(`🔊 Current volume: **${queue.volume}%**`);

    const vol = parseInt(args[0]);
    if (isNaN(vol) || vol < 0 || vol > 100) return message.reply("Volume must be 0–100!");
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
        .setThumbnail(song.thumbnail)]
        .setFooter({ text: `Requested by **${userName}**` }),
    });
  }

    // ── -ask / -ai ─────────────────────────────────────────────────────────────
  //   if (command === "ask" || command === "ai") {
  //     if (!args.length) return message.reply("Ask me something! Example: `-ask good songs for a party`");

  //     const question = args.join(" ");
  //     try {
  //       const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  //         method: "POST",
  //         headers: {
  //           "Content-Type":  "application/json",
  //           "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
  //           "HTTP-Referer":  "https://discord.com",
  //           "X-Title":       "Discord Music Bot",
  //         },
  //         body: JSON.stringify({
  //           model:      "mistralai/devstral-2512:free",
  //           messages:   [
  //             { role: "system", content: "You're a helpful music bot assistant. Give short, casual responses." },
  //             { role: "user",   content: question },
  //           ],
  //           temperature: 0.8,
  //           max_tokens:  500,
  //         }),
  //       });

  //       if (!response.ok) return message.reply("Bot is having issues right now!");

  //       const data   = await response.json();
  //       const answer = data.choices[0].message.content;

  //       return message.channel.send({
  //         embeds: [new EmbedBuilder()
  //           .setColor("#282d2f")
  //           .setTitle("🤖 Bot Assistant")
  //           .addFields(
  //             { name: "Your Question", value: question },
  //             { name: "Answer",        value: answer   },
  //           )
  //           .setFooter({ text: `Asked by ${message.author.username}` })],
  //       });
  //     } catch (err) {
  //       console.error("Bot error:", err);
  //       return message.reply("  Something went wrong with the bot!");
  //     }
  //   }
}

module.exports = { initMusic, handleMusicCommand, MUSIC_COMMANDS, MUSIC_HELP };