// ─── Command registry ─────────────────────────────────────────────────────────
// Single source of truth for every user-facing command. Three things read it:
//   • manual.js       → builds the --help / ai--help embeds
//   • f_rag_quality   → feeds the AI a plain-text command guide (so it can
//                       answer "how do I use -search?" without a web search)
//   • manual.js       → typo replies ("Did you mean `-search`?")
// Add a command here and all three pick it up.
//
// Fields:
//   cmd      the canonical command exactly as typed (with its prefix)
//   usage    how to call it, shown in help and in "Usage:" replies
//   desc     one-line description
//   aliases  other names that run the same command (same prefix)
//   group    help-page section it belongs to
//   hidden   true = valid command, but kept out of help and the AI guide
//   note     extra context for the AI guide only

const GROUPS = {
  ai:        "🤖 AI",
  guide:     "📋 Custom guidelines",
  keyword:   "🛡️ Keyword Control",
  extractor: "🔍 Extractor",
  music:     "🎵 Music",
  photo:     "📸 Photo Tracker",
  general:   "⚙️ General",
};

const COMMANDS = [
  // ── AI ──
  { cmd: "@wes",          usage: "@wes {message}",        desc: "Chat with the AI", group: "ai",
    note: "Mention the bot anywhere in a message. In DMs no mention is needed." },
  { cmd: "ai--help",      usage: "ai--help",              desc: "Show AI-specific help", group: "ai" },
  { cmd: "ai--memoclr",   usage: "ai--memoclr",           desc: "Clear your AI chat memory", group: "ai" },
  { cmd: "ai--memostat",  usage: "ai--memostat",          desc: "View your conversation stats", group: "ai" },

  // ── Custom guidelines (all are subcommands of ai--g) ──
  { cmd: "ai--g",         usage: "ai--g ls",                      desc: "List all guidelines", group: "guide" },
  { cmd: "ai--g -s",      usage: "ai--g -s <id>",                 desc: "View a specific guideline", group: "guide", sub: true },
  { cmd: "ai--g -a",      usage: "ai--g -a <name> - <content>",   desc: "Add a guideline", group: "guide", sub: true },
  { cmd: "ai--g -e",      usage: "ai--g -e <id> - <content>",     desc: "Edit a guideline", group: "guide", sub: true },
  { cmd: "ai--g -r",      usage: "ai--g -r <id>",                 desc: "Remove a guideline", group: "guide", sub: true },

  // ── Keyword control ──
  { cmd: "-ton",          usage: "-ton",                  desc: "Enable keyword control", group: "keyword" },
  { cmd: "-toff",         usage: "-toff",                 desc: "Disable keyword control", group: "keyword" },
  { cmd: "-tstat",        usage: "-tstat",                desc: "Show current status", group: "keyword" },

  // ── Extractor (only --myid is advertised) ──
  { cmd: "--myid",        usage: "--myid",                desc: "Your user ID", group: "extractor" },
  { cmd: "--userid",      usage: "--userid @user",        desc: "Look up a user's ID", group: "extractor", hidden: true },
  { cmd: "--serverids",   usage: "--serverids",           desc: "Server IDs", group: "extractor", hidden: true },
  { cmd: "--userinfo",    usage: "--userinfo [@user]",    desc: "User info", group: "extractor", hidden: true },
  { cmd: "--track",       usage: "--track @user",         desc: "Track a user", group: "extractor", hidden: true },
  { cmd: "--stk",         usage: "--stk @user",           desc: "User summary", group: "extractor", hidden: true },
  { cmd: "--export",      usage: "--export",              desc: "Export server data", group: "extractor", hidden: true },
  { cmd: "--analyze",     usage: "--analyze @user",       desc: "Analyze activity", group: "extractor", hidden: true },
  { cmd: "--webhooks",    usage: "--webhooks",            desc: "List webhooks", group: "extractor", hidden: true },
  { cmd: "--invites",     usage: "--invites",             desc: "List invites", group: "extractor", hidden: true },
  { cmd: "--permissions", usage: "--permissions @user",   desc: "User permissions", group: "extractor", hidden: true },
  { cmd: "--correlation", usage: "--correlation",         desc: "Correlation report", group: "extractor", hidden: true },

  // ── Music ──
  { cmd: "-play",       aliases: ["-p"],  usage: "-play <song/url>",       desc: "Play from YouTube, Spotify, SoundCloud", group: "music",
    note: "You must be in a voice channel." },
  { cmd: "-skip",       aliases: ["-s"],  usage: "-skip",                  desc: "Skip current song", group: "music" },
  { cmd: "-stop",                         usage: "-stop",                  desc: "Stop and clear queue", group: "music" },
  { cmd: "-pause",                        usage: "-pause",                 desc: "Pause playback", group: "music" },
  { cmd: "-resume",                       usage: "-resume",                desc: "Resume playback", group: "music" },
  { cmd: "-queue",      aliases: ["-q"],  usage: "-queue",                 desc: "Show queue", group: "music" },
  { cmd: "-nowplaying", aliases: ["-np"], usage: "-nowplaying",            desc: "Show current song", group: "music" },
  { cmd: "-loop",       aliases: ["-lp"], usage: "-loop [off|song|queue]", desc: "Toggle loop mode", group: "music",
    note: "With no argument it cycles off → song → queue." },
  { cmd: "-volume",     aliases: ["-vol"], usage: "-volume <0-100>",       desc: "Set volume", group: "music",
    note: "With no number it shows the current volume." },
  { cmd: "-leave",      aliases: ["-l"],  usage: "-leave",                 desc: "Disconnect bot from voice", group: "music" },
  { cmd: "-search",     aliases: ["-se"], usage: "-search <query>",        desc: "Search SoundCloud and pick a track", group: "music",
    note: "You must be in a voice channel. Shows a list of results to pick from." },
  { cmd: "-ask rec",    usage: "-ask rec [song]",  desc: "Recommend similar songs", group: "music", sub: true,
    note: "Defaults to the song that's playing." },
  { cmd: "-ask desc",   usage: "-ask desc [song]", desc: "Get info about a song", group: "music", sub: true,
    note: "Defaults to the song that's playing." },
  { cmd: "-ask",        aliases: ["-ai"], usage: "-ask <question>",        desc: "General Q&A with the bot assistant", group: "music" },

  // ── Photo tracker ──
  { cmd: "-mystat",      usage: "-mystat",          desc: "Your photo upload stats", group: "photo" },
  { cmd: "-photostat",   usage: "-photostat @user", desc: "Stats for a specific user", group: "photo" },
  { cmd: "-toposter",    usage: "-toposter",        desc: "Top photo contributors leaderboard", group: "photo" },
  { cmd: "-serverstat",  usage: "-serverstat",      desc: "Server-wide photo stats", group: "photo" },
  { cmd: "-channelstat", usage: "-channelstat [#channel]", desc: "Channel photo stats (defaults to current channel)", group: "photo" },

  // ── General ──
  { cmd: "--help",       usage: "--help",           desc: "Show the command list", group: "general", hidden: true },
  { cmd: "-uptime",      usage: "-uptime",          desc: "How long the bot has been online", group: "general" },
];

// ─── Lookups ──────────────────────────────────────────────────────────────────
// Only top-level commands (not "ai--g -s" or "-ask rec") are typed as the
// first word of a message, so only those take part in typo matching.
const TOP_LEVEL = COMMANDS.filter(c => !c.sub && !c.cmd.startsWith("@"));

const byName = new Map();
for (const c of TOP_LEVEL) {
  byName.set(c.cmd, c);
  for (const a of c.aliases || []) byName.set(a, c);
}

function getCommand(name) {
  return byName.get(String(name).toLowerCase()) || null;
}

// "Usage: `-play <song/url>`" — for missing-argument replies.
function usageLine(name) {
  const c = getCommand(name);
  return c ? `Usage: \`${c.usage}\`` : "";
}

function groupLines(groupKey) {
  return COMMANDS
    .filter(c => c.group === groupKey && !c.hidden)
    .map(c => `\`${c.usage}\` ${c.desc}`);
}

// ─── Typo matching ────────────────────────────────────────────────────────────
// Optimal string alignment distance: Levenshtein plus adjacent swaps, so
// "-sreach" → "-search" counts as 1 edit, not 2.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

const PREFIX_RE = /^(ai--|--|-)/;
const stripPrefix = s => s.replace(PREFIX_RE, "");

// These handlers match with startsWith(), so e.g. "-photostats" or
// "ai--guide" already run the real command. Never "correct" those.
const STARTS_WITH_HANDLED = [
  "ai--g", "-photostat", "-channelstat",
  "--userid", "--userinfo", "--track", "--stk", "--analyze", "--permissions",
];

// Looks at the first word of a message. Returns:
//   null                      → not command-shaped, or already a valid command
//   { input, suggestions: [] } → command-shaped but nothing close (stay quiet)
//   { input, suggestions: [cmd, …] } → closest real command(s)
// The prefix is ignored when comparing, so "--play" suggests "-play".
function findClosestCommands(text) {
  const first = String(text).trim().split(/\s+/)[0].toLowerCase();
  if (!/^(ai--|--|-)[a-z]+$/.test(first)) return null;
  if (byName.has(first)) return null;
  if (STARTS_WITH_HANDLED.some(p => first.startsWith(p))) return null;

  const bare = stripPrefix(first);
  // Too short to guess from: "-x" is 1 edit from -p, -s, -q and -l.
  if (bare.length < 3) return { input: first, suggestions: [] };

  // 1 typo for short words, 2 for longer ones ("-hello" must not become "--help").
  const maxDist = bare.length <= 5 ? 1 : 2;
  let best = Infinity;
  let matches = [];
  for (const c of TOP_LEVEL) {
    if (c.hidden && c.group === "extractor") continue; // don't advertise hidden tools
    for (const name of [c.cmd, ...(c.aliases || [])]) {
      const nameBare = stripPrefix(name);
      if (nameBare.length < 3) continue; // skip short aliases as targets
      const dist = editDistance(bare, nameBare);
      if (dist > maxDist || dist > best) continue;
      if (dist < best) { best = dist; matches = []; }
      if (!matches.includes(c)) matches.push(c);
    }
  }
  // "--hepl" ties --help and ai--help; prefer the one with the prefix they typed.
  const inputPrefix = first.match(PREFIX_RE)[0];
  const samePrefix = matches.filter(c => c.cmd.match(PREFIX_RE)?.[0] === inputPrefix);
  if (samePrefix.length) matches = samePrefix;
  return { input: first, suggestions: matches.slice(0, 3) };
}

// ─── AI command guide ─────────────────────────────────────────────────────────
// Plain text for the system prompt. Hidden commands are left out.
function buildCommandGuide() {
  const out = [];
  for (const [key, title] of Object.entries(GROUPS)) {
    const cmds = COMMANDS.filter(c => c.group === key && !c.hidden);
    if (!cmds.length) continue;
    out.push(title.replace(/^\S+\s/, "")); // drop the emoji
    for (const c of cmds) {
      const alias = c.aliases?.length ? ` (alias: ${c.aliases.join(", ")})` : "";
      const note = c.note ? ` ${c.note}` : "";
      out.push(`- ${c.usage}${alias}: ${c.desc}.${note}`);
    }
  }
  return out.join("\n");
}

// True when a message is about the bot's own commands, so the AI module can
// skip the web search and answer from the guide instead.
function mentionsCommands(text) {
  const t = String(text).toLowerCase();
  if (/\b(commands?|how (do|can|to) (i )?use (you|this bot|the bot))\b/.test(t)) return true;
  // Lookbehind skips hyphenated words like "self-play" or "well-known".
  const tokens = t.match(/(?<![a-z0-9-])(?:ai--|--|-)[a-z]+/g) || [];
  return tokens.some(tok => byName.has(tok) || (findClosestCommands(tok)?.suggestions.length ?? 0) > 0);
}

module.exports = {
  GROUPS,
  COMMANDS,
  getCommand,
  usageLine,
  groupLines,
  findClosestCommands,
  buildCommandGuide,
  mentionsCommands,
  editDistance,
};
