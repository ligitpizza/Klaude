//AI SECTION v3 — Gemini + NewsAPI + OMDB + RAWG + Tavily fallback
require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fetch = require("node-fetch");
const Discord = require("discord.js");
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── conversations.db — chat memory ───────────────────────────────────────────
const dbPath = path.join(__dirname, '../data/conversations.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_timestamp ON conversations(user_id, timestamp)`);
});
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HISTORY = 30;

// ── Gemini models ─────────────────────────────────────────────────────────────
const FREE_MODELS = [
//   "gemini-2.5-flash",
//   "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-live",
  "gemini-embedding-2-preview",
];
// ─────────────────────────────────────────────────────────────────────────────

// ── Conversation memory ───────────────────────────────────────────────────────
function getConversationHistory(userId) {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT role, content FROM conversations
      WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?
    `;
    db.all(query, [userId, MAX_HISTORY], (err, rows) => {
      if (err) { console.error('Database error:', err); reject(err); }
      else { resolve(rows.reverse().map(r => ({ role: r.role, content: r.content }))); }
    });
  });
}

function addToConversationHistory(userId, role, content) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO conversations (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
      [userId, role, content, Date.now()],
      function(err) {
        if (err) { console.error('Database insert error:', err); reject(err); }
        else { resolve(this.lastID); }
      }
    );
  });
}

function clearConversationHistory(userId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM conversations WHERE user_id = ?`, [userId], function(err) {
      if (err) { console.error('Database delete error:', err); reject(err); }
      else { resolve(this.changes); }
    });
  });
}

function getConversationStats(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as total_messages, MIN(timestamp) as first_message, MAX(timestamp) as last_message
       FROM conversations WHERE user_id = ?`,
      [userId],
      (err, row) => { if (err) reject(err); else resolve(row); }
    );
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Channel context ───────────────────────────────────────────────────────────
async function getChannelContext(channel, limit = 20) {
  try {
    const messages = await channel.messages.fetch({ limit });
    const context = [...messages.values()]
      .reverse()
      .filter(m => !m.author.bot && m.content.length > 5)
      .map(m => `[${m.author.username}]: ${m.content}`)
      .join('\n');
    return context.length > 2000 ? context.slice(-2000) : context;
  } catch (err) {
    console.error('Failed to fetch channel context:', err);
    return '';
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Extract year and month from a query string ────────────────────────────────
const MONTH_MAP = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function extractDateInfo(text) {
  const lower = text.toLowerCase();
  const yearMatch = lower.match(/\b(20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : null;

  let month = null;
  for (const [name, num] of Object.entries(MONTH_MAP)) {
    if (lower.includes(name)) { month = num; break; }
  }

  return { year, month };
}

function stripDateFromQuery(text) {
  let q = text
    .replace(/\b20\d{2}\b/g, '')                         // strip 4-digit years
    .replace(new RegExp(Object.keys(MONTH_MAP).join('|'), 'gi'), '') // strip month names
    .replace(/\s+/g, ' ').trim();
  return q;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Query cleaner (strip filler words) ───────────────────────────────────────
function buildSearchQuery(text) {
  const fillerWords = [
    // conversational filler
    'whats', "what's", 'what is', 'what are', 'tell me', 'can you', 'do you know',
    'hey', 'yo', 'bro', 'please', 'pls', 'lah', 'la', 'ah', 'oh',
    'did', 'does', 'is there', 'are there', 'how is', 'how was',
    'omg', 'wtf', 'any', 'about', 'the', 'a ', 'an ',
    'named', 'called', 'titled',
    //
    'rating', 'ratings', 'rated', 'score', 'review', 'reviews',
    'movie', 'film', 'show', 'series', 'streaming',
  ];
  let query = text.toLowerCase();
  fillerWords.forEach(word => {
    query = query.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
  });
  query = query.replace(/\s+/g, ' ').trim();
  // Fix cases like "kombat2" → "kombat 2"
  query = query.replace(/([a-zA-Z])(\d)/g, '$1 $2').replace(/(\d)([a-zA-Z])/g, '$1 $2');
  query = query.charAt(0).toUpperCase() + query.slice(1);
  console.log(`🔧 Query cleaned: "${text}" → "${query}"`);
  return query;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── NewsAPI ───────────────────────────────────────────────────────────────────
async function searchNews(rawQuery) {
  const query = buildSearchQuery(rawQuery);
  try {
    console.log(`📰 NewsAPI searching: ${query}`);
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=5&apiKey=${process.env.NEWSAPI_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error('NewsAPI failed:', response.status);
      return null;
    }
    const data = await response.json();
    if (!data.articles?.length) return null;

    const parts = ['**Latest News:**'];
    data.articles.slice(0, 4).forEach(a => {
      parts.push(`• **${a.title}**\n${a.description?.slice(0, 150) || 'No description'}...\n🔗 ${a.url}`);
    });
    const result = parts.join('\n\n').trim();
    console.log(`NewsAPI returned ${result.length} chars`);
    return result;
  } catch (err) {
    console.error('NewsAPI error:', err);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── TMDB (Movies & Shows) ─────────────────────────────────────────────────────
async function searchMovie(rawQuery) {
  const query = buildSearchQuery(rawQuery);
  try {
    console.log(`🎬 TMDB searching: ${query}`);

    // Search for movie/show
    const searchUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&api_key=${process.env.TMDB_KEY}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) {
      console.error('TMDB search failed:', searchRes.status);
      return null;
    }
    const searchData = await searchRes.json();
    console.log(`🎬 TMDB raw results:`, JSON.stringify(searchData).slice(0, 500));
    if (!searchData.results?.length) return null;

    // Grab top result
    const top = searchData.results[0];
    const isMovie = top.media_type === 'movie';
    const id = top.id;
    const type = isMovie ? 'movie' : 'tv';

    // Fetch full details
    const detailUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${process.env.TMDB_KEY}&append_to_response=credits`;
    const detailRes = await fetch(detailUrl);
    if (!detailRes.ok) return null;
    const d = await detailRes.json();

    const title    = d.title || d.name;
    const year     = (d.release_date || d.first_air_date || '').slice(0, 4);
    const rating   = d.vote_average?.toFixed(1) || 'N/A';
    const votes    = d.vote_count?.toLocaleString() || '0';
    const overview = d.overview?.slice(0, 300) || 'No overview available.';
    const genres   = d.genres?.map(g => g.name).join(', ') || 'N/A';
    const cast     = d.credits?.cast?.slice(0, 4).map(c => c.name).join(', ') || 'N/A';
    const status   = d.status || 'N/A';
    // const poster   = top.poster_path ? `https://image.tmdb.org/t/p/w500${top.poster_path}` : null;
    const tmdbLink = `https://www.themoviedb.org/${type}/${id}`;

    const result = [
    //   poster,
      `**${title}** (${year}) — ${type === 'tv' ? '📺 TV Show' : '🎬 Movie'}`,
      `⭐ TMDB: ${rating}/10 (${votes} votes) | 🎭 Genre: ${genres}`,
      `📝 ${overview}`,
      `👥 Cast: ${cast}`,
      `📌 Status: ${status}`,
      `🔗 [View on TMDB](${tmdbLink})`,
    ].filter(Boolean).join('\n');

    console.log(`TMDB returned ${result.length} chars`);
    return result;
  } catch (err) {
    console.error('TMDB error:', err);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── RAWG: Publisher search ────────────────────────────────────────────────────
async function searchGameByPublisher(rawQuery, hint) {
  const { year } = extractDateInfo(rawQuery);
  const publisherQuery = buildSearchQuery(hint);
  console.log(`🎮 RAWG publisher search: "${publisherQuery}" year=${year}`);

  try {
    // Step 1: resolve publisher ID
    const pubRes = await fetch(
      `https://api.rawg.io/api/publishers?search=${encodeURIComponent(publisherQuery)}&key=${process.env.RAWG_KEY}`
    );
    if (!pubRes.ok) return null;
    const pubData = await pubRes.json();
    if (!pubData.results?.length) return null;

    const { id: publisherId, name: publisherName } = pubData.results[0];
    console.log(`🎮 Resolved publisher: ${publisherName} (id=${publisherId})`);

    // Step 2: fetch their games
    const params = new URLSearchParams({
      publishers: publisherId,
      page_size: '8',
      ordering: '-released',
      key: process.env.RAWG_KEY,
    });
    if (year) params.set('dates', `${year}-01-01,${year}-12-31`);

    const gamesRes = await fetch(`https://api.rawg.io/api/games?${params}`);
    if (!gamesRes.ok) return null;
    const gamesData = await gamesRes.json();
    if (!gamesData.results?.length) return null;

    const label = `**Games by ${publisherName}${year ? ` in ${year}` : ''}:**`;
    const parts = [label];
    gamesData.results.slice(0, 5).forEach(g => {
      const platforms = g.platforms?.map(p => p.platform.name).slice(0, 3).join(', ') || 'N/A';
      const link = g.slug ? `🔗 [RAWG](https://rawg.io/games/${g.slug})` : '';
      parts.push(`• **${g.name}** — ⭐ ${g.rating}/5 | 📅 ${g.released || 'TBA'} | 🎮 ${platforms} ${link}`.trim());
    });
    return parts.join('\n').trim();
  } catch (err) {
    console.error('RAWG publisher search error:', err);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── RAWG: Similar/series games ────────────────────────────────────────────────
async function searchSimilarGames(gameName) {
  const query = buildSearchQuery(gameName);
  console.log(`🎮 RAWG similar games for: "${query}"`);

  try {
    // Step 1: find the game's slug
    const searchRes = await fetch(
      `https://api.rawg.io/api/games?search=${encodeURIComponent(query)}&page_size=1&key=${process.env.RAWG_KEY}`
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    if (!searchData.results?.length) return null;

    const { slug, name } = searchData.results[0];
    console.log(`🎮 Found base game: ${name} (slug=${slug})`);

    // Step 2: fetch same-series games
    const seriesRes = await fetch(
      `https://api.rawg.io/api/games/${slug}/game-series?page_size=6&key=${process.env.RAWG_KEY}`
    );
    if (!seriesRes.ok) return null;
    const seriesData = await seriesRes.json();

    if (!seriesData.results?.length) {
      return `No game series found for **${name}** on RAWG. It may be a standalone title or too new to have series data.`;
    }

    const parts = [`**Games in the same series as ${name}:**`];
    seriesData.results.slice(0, 5).forEach(g => {
      const platforms = g.platforms?.map(p => p.platform.name).slice(0, 3).join(', ') || 'N/A';
      const link = g.slug ? `🔗 [RAWG](https://rawg.io/games/${g.slug})` : '';
      parts.push(`• **${g.name}** — ⭐ ${g.rating}/5 | 📅 ${g.released || 'TBA'} | 🎮 ${platforms} ${link}`.trim());
    });
    return parts.join('\n').trim();
  } catch (err) {
    console.error('RAWG similar games error:', err);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── RAWG (Games) ──────────────────────────────────────────────────────────────
async function searchGame(rawQuery) {
  const lower = rawQuery.toLowerCase();

  // ── Publisher query ────────────────────────────────────────────────────────
  const publisherMatch = lower.match(
    /publisher\s+(?:of\s+)?(.+)|(?:published|made|developed)\s+by\s+(.+)|(.+)\s+publisher/i
  );
  if (publisherMatch) {
    const hint = (publisherMatch[1] || publisherMatch[2] || publisherMatch[3] || '').trim();
    return await searchGameByPublisher(rawQuery, hint);
  }

  // ── Similar/related query ──────────────────────────────────────────────────
  const similarMatch = lower.match(/(?:related to|similar to|games like|like)\s+(.+)/i);
  if (similarMatch) {
    const gameName = similarMatch[1].trim();
    return await searchSimilarGames(gameName);
  }

  // ── Default: title / date search ──────────────────────────────────────────
  const { year, month } = extractDateInfo(rawQuery);

  // Strip date words before cleaning so filler-word pass doesn't mangle them
  const stripped = year ? stripDateFromQuery(rawQuery) : rawQuery;
  const titleQuery = buildSearchQuery(stripped);

  // Generic release-list keywords — if only these remain, don't send as search term
  const releaseKeywords = ['game release', 'game releases', 'release', 'releases', 'games'];
  const isReleaseListQuery = !titleQuery ||
    releaseKeywords.some(k => titleQuery.toLowerCase().trim() === k);

  // Build RAWG date range
  let dateRange = null;
  if (year && month) {
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    dateRange = `${year}-${month}-01,${year}-${month}-${lastDay}`;
  } else if (year) {
    dateRange = `${year}-01-01,${year}-12-31`;
  }

  // Build URL params
  const params = new URLSearchParams({ page_size: '8', key: process.env.RAWG_KEY });
  if (!isReleaseListQuery) params.set('search', titleQuery);
  if (dateRange) {
    params.set('dates', dateRange);
    params.set('ordering', '-released');
  }

  const url = `https://api.rawg.io/api/games?${params.toString()}`;
  console.log(`🎮 RAWG URL: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error('RAWG failed:', response.status);
      return null;
    }
    const data = await response.json();
    if (!data.results?.length) return null;

    const label = dateRange
      ? `**Games${isReleaseListQuery ? ' releasing' : ''} in ${month ? `${Object.keys(MONTH_MAP).find(k => MONTH_MAP[k] === month)?.replace(/^\w/, c => c.toUpperCase())} ` : ''}${year || ''}:**`
      : `**Games Found:**`;

    const parts = [label];
    data.results.slice(0, 5).forEach(g => {
      const platforms = g.platforms?.map(p => p.platform.name).slice(0, 3).join(', ') || 'N/A';
      const link = g.slug ? `🔗 [RAWG](https://rawg.io/games/${g.slug})` : '';
      parts.push(`• **${g.name}** — ⭐ ${g.rating}/5 | 📅 ${g.released || 'TBA'} | 🎮 ${platforms} ${link}`.trim());
    });

    const result = parts.join('\n').trim();
    console.log(`RAWG returned ${result.length} chars`);
    return result;
  } catch (err) {
    console.error('RAWG error:', err);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Tavily (catch-all fallback) ───────────────────────────────────────────────
async function searchTavily(rawQuery) {
  const query = buildSearchQuery(rawQuery);
  try {
    console.log(`🔍 Tavily searching: ${query}`);
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
      })
    });
    if (!response.ok) {
      console.error('Tavily failed:', response.status);
      return null;
    }
    const data = await response.json();
    const parts = [];
    if (data.answer) parts.push(`**Summary:** ${data.answer}`);
    if (data.results?.length) {
      parts.push('\n**Sources:**');
      data.results.slice(0, 3).forEach(r => {
        parts.push(`• **${r.title}** — ${r.content?.slice(0, 200)}...\n🔗 ${r.url}`);
      });
    }
    const result = parts.join('\n').trim();
    console.log(`Tavily returned ${result.length} chars`);
    return result || null;
  } catch (err) {
    console.error('Tavily error:', err);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Try each Gemini model, skip on 429 ───────────────────────────────────────
async function fetchFromAny(messages) {
  for (const model of FREE_MODELS) {
    console.log(`Trying model: ${model}`);
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GOOGLE_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 1500
      })
    });

    if (response.status === 429) {
      console.log(`Model ${model} is rate limited, trying next...`);
      continue;
    }
    if (!response.ok) {
      const errText = await response.text();
      console.error(`Model ${model} error ${response.status}:`, errText);
      continue;
    }
    const data = await response.json();
    if (data.choices?.[0]?.message?.content) {
      console.log(`Got response from model: ${model}`);
      return data.choices[0].message.content.trim();
    }
    console.log(`Model ${model} returned empty, trying next...`);
  }
  return null;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── AI intent classifier ──────────────────────────────────────────────────────
async function classifyIntent(userInput) {
  const messages = [
    {
      role: "system",
      content: `You are an intent classifier. Classify the user's message into exactly one of these categories:
- "movie" — asking about a movie, TV show, film, series, cast, rating, streaming
- "game" — asking about a video game, release date, DLC, patch, console, publisher, developer, games similar to or related to another game
- "news" — asking about current events, latest news, breaking news, updates
- "search" — asking about weather, sports scores, crypto, stocks, prices, general web search
- "none" — general conversation, questions AI can answer from knowledge

Reply with ONLY the category word, nothing else.`
    },
    { role: "user", content: userInput }
  ];

  const result = await fetchFromAny(messages);
  const category = result?.toLowerCase().trim();
  console.log(`🤖 AI classified intent: "${category}"`);

  const valid = ['movie', 'game', 'news', 'search', 'none'];
  return valid.includes(category) ? category : null;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Route to correct API based on AI classification ───────────────────────────
async function fetchSearchResults(userInput) {
  const category = await classifyIntent(userInput);
  console.log(`🗂️ Classified category: ${category || 'none — using AI knowledge'}`);

  switch (category) {
    case 'news':   return await searchNews(userInput);
    case 'movie':  return await searchMovie(userInput);
    case 'game':   return await searchGame(userInput);
    case 'search': return await searchTavily(userInput);
    default:       return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`✅Logged in as ${client.user.tag}, AI + NewsAPI + TMDB + RAWG + Tavily -v3.0`);
});

process.on('SIGINT', () => {
  console.log('Closing database connection...');
  db.close((err) => {
    if (err) console.error('Error closing database:', err);
    else console.log('Database connection closed.');
    process.exit(0);
  });
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content.length < 3) return;

  const userId   = message.author.id;
  const userName = message.author.username;
  const msgLower = message.content.toLowerCase();

  // ── ai--clearmemo ───────────────────────────────────────────────────────────
  if (msgLower.includes('ai--clearmemo')) {
    try {
      const count = await clearConversationHistory(userId);
      return await message.reply(`🧠 Memory cleared! Deleted ${count} messages. Starting fresh.`);
    } catch (err) {
      return await message.reply("❌ Error clearing memory. Try again later.");
    }
  }

  // ── ai--memostat ────────────────────────────────────────────────────────────
  if (msgLower.includes('ai--memostat')) {
    try {
      const stats     = await getConversationStats(userId);
      const firstDate = stats.first_message ? new Date(stats.first_message).toLocaleDateString() : 'Never';
      const lastDate  = stats.last_message  ? new Date(stats.last_message).toLocaleDateString()  : 'Never';
      return await message.reply(`📊 **Your Stats:**\nTotal messages: ${stats.total_messages}\nFirst chat: ${firstDate}\nLast chat: ${lastDate}`);
    } catch (err) {
      return await message.reply("❌ Error getting stats. Try again later.");
    }
  }

  // ── Only process @mentions from here ───────────────────────────────────────
  if (!message.mentions.has(client.user) && message.guild) return;

  const userInput = message.content
    .replace(/<@[!&]?\d+>/g, '')
    .trim();

  try {
    console.log(`Processing message from ${userName} (${userId})`);

    const [conversationHistory, channelContext] = await Promise.all([
      getConversationHistory(userId),
      getChannelContext(message.channel),
    ]);

    console.log(`Loaded ${conversationHistory.length} previous messages for ${userName}`);

    // Route to correct API
    await message.channel.sendTyping();
    const searchResults = await fetchSearchResults(userInput);

    if (searchResults) {
      console.log(`Search results injected (${searchResults.length} chars)`);
    } else {
      console.log('No search results — AI answering from own knowledge');
    }

    const messages = [
      {
        role: "system",
        content: `You are a helpful, witty, and conversational Discord bot. Respond to ${userName} naturally and clearly.

Guidelines:
- Be concise but thorough — don't over-explain, but don't leave things half-answered
- Match the tone of the conversation (casual if they're casual, serious if they're serious)
- If you don't know something, say so honestly instead of guessing
- Use plain language, avoid unnecessary jargon
- If someone asks a question regarding a movie, show, or game, provide key details (like release date, rating, genre) and link to a source for more info
- If someone asks a technical question, break it down step by step
- Don't pad responses with filler phrases like "Great question!" or "Certainly!"
- When real-time data is provided above, treat it as ground truth — never contradict or ignore it
- NEVER say you don't have information when real-time data has been provided above — use it to answer the question. If the data is incomplete, say "Based on the information I have..." and answer as best you can using that data.
${searchResults
  ? `\nIMPORTANT: You MUST base your answer ONLY on the following real-time data. Do NOT use your training knowledge for this topic. Do NOT say you don't have information — the data below IS your information:\n\n${searchResults}\n\nPresent this data clearly to the user. 
  Do NOT REMOVE any URLs or links:\n\n${searchResults}`
  : '\nNo real-time data was retrieved. Answer from your own training knowledge and be transparent if something may be outdated.'}
${channelContext ? `\nRecent channel conversation for context:\n${channelContext}` : ''}`
      },
      ...conversationHistory,
      { role: "user", content: userInput }
    ];

    const reply = await fetchFromAny(messages);

    if (!reply) {
      console.error("All models rate limited or failed");
      return await message.reply("⏳ All AI models are rate limited right now. Try again in a minute.");
    }

    try {
      await addToConversationHistory(userId, "user", userInput);
      await addToConversationHistory(userId, "assistant", reply);
      console.log(`Saved conversation for ${userName}`);
      console.log(`------------------------------------------------------------`);
    } catch (dbError) {
      console.error('Error saving to database:', dbError);
    }

    if (reply.length > 2000) {
      const chunks = [];
      for (let i = 0; i < reply.length; i += 2000) chunks.push(reply.substring(i, i + 2000));
      await message.reply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
    } else {
      await message.reply(reply);
    }

  } catch (error) {
    console.error("Error calling AI:", error.message);
    await message.reply("Something went wrong with the AI 🤖⚠️");
  }
});

client.login(process.env.DISCORD_BOT_TOKEN_1);
// client.login(process.env.DISCORD_BOT_TOKEN_2);