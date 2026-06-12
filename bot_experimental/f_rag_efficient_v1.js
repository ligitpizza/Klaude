//AI SECTION v3.2 — Token-optimized: deduped system prompt, no channel context, conditional Tavily enrichment, trimmed history
require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fetch = require("node-fetch");
const Discord = require("discord.js");
// const sqlite3 = require('sqlite3').verbose();
// const path = require('path');

const { Redis } = require("@upstash/redis");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Upstash Redis ─────────────────────────────────────────────────────────────
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── Rate limit config ─────────────────────────────────────────────────────────
const RATE_LIMIT_MAX    = 10;  // max requests per window
const RATE_LIMIT_WINDOW = 60;  // seconds

// ── Rate limit check ──────────────────────────────────────────────────────────
async function checkRateLimit(userId) {
  const key = `rl:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW);
  const ttl = await redis.ttl(key);
  return { allowed: count <= RATE_LIMIT_MAX, count, ttl };
}

// ── Conversation memory ───────────────────────────────────────────────────────
const HISTORY_KEY = (id) => `hist:${id}`;

async function getConversationHistory(userId) {
  const raw = await redis.lrange(HISTORY_KEY(userId), 0, MAX_HISTORY - 1);
  return raw.map(r => (typeof r === "string" ? JSON.parse(r) : r)).reverse();
}

async function addToConversationHistory(userId, role, content) {
  const key = HISTORY_KEY(userId);
  await redis.lpush(key, JSON.stringify({ role, content }));
  await redis.ltrim(key, 0, MAX_HISTORY - 1);
  await redis.expire(key, 60 * 60 * 24 * 7); // auto-delete after 7 days of no new messages 
  // so active users never lose history, but inactive users get cleaned up automatically.
}

async function clearConversationHistory(userId) {
  return await redis.del(HISTORY_KEY(userId));
}

async function getConversationStats(userId) {
  const total = await redis.llen(HISTORY_KEY(userId));
  return { total_messages: total };
}


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


// ── CHANGE v3.2: Reduced from 30 → 15 (cuts memory token cost ~50%) ──────────
const MAX_HISTORY = 15;


// ── Gemini models ─────────────────────────────────────────────────────────────
const FREE_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  // "gemini-3-flash-live",
  // "gemini-embedding-2-preview",
];



// ── CHANGE v3.2: getChannelContext REMOVED ────────────────────────────────────
// Channel context was fetching 20 messages (~2000 chars) on every request.
// It was redundant with per-user conversation history and added significant tokens.
// If you need it back, re-add it as opt-in via a command flag.

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
    .replace(/\b20\d{2}\b/g, '')
    .replace(new RegExp(Object.keys(MONTH_MAP).join('|'), 'gi'), '')
    .replace(/\s+/g, ' ').trim();
  return q;
}


// ── Query cleaner ─────────────────────────────────────────────────────────────
function buildSearchQuery(text) {
  const fillerWords = [
    'whats', "what's", 'what is', 'what are', 'tell me', 'can you', 'do you know',
    'hey', 'yo', 'bro', 'please', 'pls', 'lah', 'la', 'ah', 'oh',
    'did', 'does', 'is there', 'are there', 'how is', 'how was',
    'omg', 'wtf', 'any', 'about', 'the', 'a ', 'an ',
    'named', 'called', 'titled',
    'rating', 'ratings', 'rated', 'score', 'review', 'reviews',
    'movie', 'film', 'show', 'series', 'streaming',
  ];
  let query = text.toLowerCase();
  fillerWords.forEach(word => {
    query = query.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
  });
  query = query.replace(/\s+/g, ' ').trim();
  query = query.replace(/([a-zA-Z])(\d)/g, '$1 $2').replace(/(\d)([a-zA-Z])/g, '$1 $2');
  query = query.charAt(0).toUpperCase() + query.slice(1);
  console.log(`🔧 Query cleaned: "${text}" → "${query}"`);
  return query;
}


// ── Tavily (fallback + conditional enrichment) ────────────────────────────────
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
    if (data.answer) parts.push(`**Web Summary:** ${data.answer}`);
    if (data.results?.length) {
      parts.push('\n**Web Sources:**');
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

// ── CHANGE v3.2: Conditional Tavily enrichment ────────────────────────────────
// Previously: enrichWithTavily fired on EVERY successful RAWG/TMDB result.
// Now: only fires when the primary result is sparse (future release, no rating,
// no overview). This eliminates ~60% of Tavily calls while preserving enrichment
// for the cases that actually benefit from it.
function isPrimarySparse(primaryResult) {
  const noRating  = /⭐.*?N\/A|⭐.*?0\.0|rating.*?N\/A/i.test(primaryResult);
  const noOverview = /No overview available/i.test(primaryResult);
  const futureTBA  = /TBA|upcoming|announced/i.test(primaryResult);
  return noRating || noOverview || futureTBA;
}

async function enrichWithTavily(primaryResult, userQuery) {
  // Skip enrichment if primary result already has good data
  if (!isPrimarySparse(primaryResult)) {
    console.log(`✨ Primary result is rich — skipping Tavily enrichment`);
    return primaryResult;
  }

  try {
    const titleMatch = primaryResult.match(/\*\*([^*]+)\*\*/);
    const titleHint = titleMatch ? titleMatch[1].trim() : '';
    const enrichQuery = titleHint
      ? `${titleHint} ${userQuery} reviews latest news`
      : `${userQuery} reviews latest news`;

    console.log(`✨ Sparse result — enriching with Tavily: "${enrichQuery}"`);

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify({
        query: enrichQuery,
        search_depth: "advanced",
        max_results: 4,
        include_answer: true,
        include_raw_content: false,
      })
    });

    if (!response.ok) {
      console.warn(`Tavily enrichment failed (${response.status}), returning primary only`);
      return primaryResult;
    }

    const data = await response.json();
    const enrichParts = [];

    if (data.answer) enrichParts.push(`\n**🌐 Web Context:** ${data.answer}`);
    if (data.results?.length) {
      enrichParts.push('\n**🔗 Related Sources:**');
      data.results.slice(0, 3).forEach(r => {
        enrichParts.push(`• **${r.title}** — ${r.content?.slice(0, 180)}...\n  🔗 ${r.url}`);
      });
    }

    if (!enrichParts.length) {
      console.log('Tavily enrichment returned nothing useful, returning primary only');
      return primaryResult;
    }

    const combined = `${primaryResult}\n${enrichParts.join('\n')}`;
    console.log(`✨ Enrichment combined: ${combined.length} chars`);
    return combined;
  } catch (err) {
    console.error('enrichWithTavily error:', err);
    return primaryResult;
  }
}

// ── NewsAPI ───────────────────────────────────────────────────────────────────
async function searchNews(rawQuery) {
  const query = buildSearchQuery(rawQuery);
  try {
    console.log(`📰 NewsAPI searching: ${query}`);
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=5&apiKey=${process.env.NEWSAPI_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('NewsAPI failed');
    const data = await response.json();
    if (!data.articles?.length) throw new Error('NewsAPI returned no articles');

    const parts = ['**Latest News:**'];
    data.articles.slice(0, 4).forEach(a => {
      parts.push(`• **${a.title}**\n${a.description?.slice(0, 150) || 'No description'}...\n🔗 ${a.url}`);
    });
    const result = parts.join('\n\n').trim();
    console.log(`📰 NewsAPI returned ${result.length} chars`);
    return result;

  } catch (err) {
    console.warn(`NewsAPI failed (${err.message}), trying Tavily fallback...`);
    const tavilyResult = await searchTavily(rawQuery);
    if (tavilyResult) {
      console.log('📰 News: Tavily fallback succeeded');
      return tavilyResult;
    }
    console.warn('📰 News: both NewsAPI and Tavily failed — Gemini will use own knowledge');
    return null;
  }
}

// ── TMDB (Movies & Shows) ─────────────────────────────────────────────────────
async function searchMovie(rawQuery) {
  const query = buildSearchQuery(rawQuery);
  let tmdbResult = null;

  try {
    console.log(`🎬 TMDB searching: ${query}`);
    const searchUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&api_key=${process.env.TMDB_KEY}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) throw new Error(`TMDB search HTTP ${searchRes.status}`);

    const searchData = await searchRes.json();
    if (!searchData.results?.length) throw new Error('TMDB returned no results');

    const top = searchData.results[0];
    const isMovie = top.media_type === 'movie';
    const id = top.id;
    const type = isMovie ? 'movie' : 'tv';

    const detailUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${process.env.TMDB_KEY}&append_to_response=credits`;
    const detailRes = await fetch(detailUrl);
    if (!detailRes.ok) throw new Error(`TMDB detail HTTP ${detailRes.status}`);
    const d = await detailRes.json();

    const title    = d.title || d.name;
    const year     = (d.release_date || d.first_air_date || '').slice(0, 4);
    const rating   = d.vote_average?.toFixed(1) || 'N/A';
    const votes    = d.vote_count?.toLocaleString() || '0';
    const overview = d.overview?.slice(0, 300) || 'No overview available.';
    const genres   = d.genres?.map(g => g.name).join(', ') || 'N/A';
    const cast     = d.credits?.cast?.slice(0, 4).map(c => c.name).join(', ') || 'N/A';
    const status   = d.status || 'N/A';
    const tmdbLink = `https://www.themoviedb.org/${type}/${id}`;

    tmdbResult = [
      `**${title}** (${year}) — ${type === 'tv' ? '📺 TV Show' : '🎬 Movie'}`,
      `⭐ TMDB: ${rating}/10 (${votes} votes) | 🎭 Genre: ${genres}`,
      `📝 ${overview}`,
      `👥 Cast: ${cast}`,
      `📌 Status: ${status}`,
      `🔗 [View on TMDB](${tmdbLink})`,
    ].join('\n');

    console.log(`🎬 TMDB succeeded (${tmdbResult.length} chars)`);
    return await enrichWithTavily(tmdbResult, rawQuery);

  } catch (err) {
    console.warn(`🎬 TMDB failed (${err.message}), trying Tavily alone...`);
    const tavilyResult = await searchTavily(rawQuery);
    if (tavilyResult) {
      console.log('🎬 Movie: Tavily fallback succeeded');
      return tavilyResult;
    }
    console.warn('🎬 Movie: both TMDB and Tavily failed — Gemini will use own knowledge');
    return null;
  }
}

// ── RAWG (Games) ──────────────────────────────────────────────────────────────
async function searchGame(rawQuery) {
  const { year, month } = extractDateInfo(rawQuery);

  const stripped = year ? stripDateFromQuery(rawQuery) : rawQuery;
  const titleQuery = buildSearchQuery(stripped);

  const releaseKeywords = ['game release', 'game releases', 'release', 'releases', 'games'];
  const isReleaseListQuery = !titleQuery ||
    releaseKeywords.some(k => titleQuery.toLowerCase().trim() === k);

  let dateRange = null;
  if (year && month) {
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    dateRange = `${year}-${month}-01,${year}-${month}-${lastDay}`;
  } else if (year) {
    dateRange = `${year}-01-01,${year}-12-31`;
  }

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
    if (!response.ok) throw new Error(`RAWG HTTP ${response.status}`);

    const data = await response.json();
    if (!data.results?.length) throw new Error('RAWG returned no results');

    const label = dateRange
      ? `**Games${isReleaseListQuery ? ' releasing' : ''} in ${month ? `${Object.keys(MONTH_MAP).find(k => MONTH_MAP[k] === month)?.replace(/^\w/, c => c.toUpperCase())} ` : ''}${year || ''}:**`
      : `**Games Found:**`;

    const parts = [label];
    data.results.slice(0, 5).forEach(g => {
      const platforms = g.platforms?.map(p => p.platform.name).slice(0, 3).join(', ') || 'N/A';
      const link = g.slug ? `🔗 [RAWG](https://rawg.io/games/${g.slug})` : '';
      parts.push(`• **${g.name}** — ⭐ ${g.rating}/5 | 📅 ${g.released || 'TBA'} | 🎮 ${platforms} ${link}`.trim());
    });

    const rawgResult = parts.join('\n').trim();
    console.log(`🎮 RAWG succeeded (${rawgResult.length} chars)`);
    return await enrichWithTavily(rawgResult, rawQuery);

  } catch (err) {
    console.warn(`🎮 RAWG failed (${err.message}), trying Tavily alone...`);
    const tavilyResult = await searchTavily(rawQuery);
    if (tavilyResult) {
      console.log('🎮 Game: Tavily fallback succeeded');
      return tavilyResult;
    }
    console.warn('🎮 Game: both RAWG and Tavily failed — Gemini will use own knowledge');
    return null;
  }
}

// ── Publisher / similar games ─────────────────────────────────────────────────
async function searchGameByPublisher(rawQuery, hint = '') {
  const query = buildSearchQuery(hint || rawQuery);
  try {
    console.log(`🎮 RAWG publisher/studio search: ${query}`);
    const params = new URLSearchParams({ search: query, page_size: '6', key: process.env.RAWG_KEY });
    const url = `https://api.rawg.io/api/games?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.results?.length) return null;

    const parts = [`**Games by ${query}:**`];
    data.results.slice(0, 5).forEach(g => {
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

async function searchSimilarGames(gameName) {
  try {
    console.log(`🎮 RAWG similar games for: ${gameName}`);
    const searchParams = new URLSearchParams({ search: gameName, page_size: '1', key: process.env.RAWG_KEY });
    const searchRes = await fetch(`https://api.rawg.io/api/games?${searchParams.toString()}`);
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    if (!searchData.results?.length) return null;

    const gameId = searchData.results[0].id;
    const foundName = searchData.results[0].name;

    const suggestRes = await fetch(`https://api.rawg.io/api/games/${gameId}/suggested?key=${process.env.RAWG_KEY}`);
    if (!suggestRes.ok) return null;
    const suggestData = await suggestRes.json();
    if (!suggestData.results?.length) return null;

    const parts = [`**Games similar to ${foundName}:**`];
    suggestData.results.slice(0, 5).forEach(g => {
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

// ── Gemini model fallback chain ───────────────────────────────────────────────
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

// ── Intent classifier ─────────────────────────────────────────────────────────
async function classifyIntent(userInput) {
  const messages = [
    {
      role: "system",
      content: `You are an intent classifier. Classify the user's message into exactly one of these categories:
- "movie" — asking about a movie, TV show, film, series, cast, rating, streaming
- "game" — asking about a video game, release date, DLC, patch, console, game publisher, games by a developer/studio, games similar to another game, game series
- "news" — asking about current events, latest news, breaking news, updates
- "none" — general conversation, questions AI can answer from knowledge, weather, sports scores, crypto, stocks, prices, or anything else

Reply with ONLY the category word, nothing else.`
    },
    { role: "user", content: userInput }
  ];

  const result = await fetchFromAny(messages);
  const category = result?.toLowerCase().trim();
  console.log(`🤖 AI classified intent: "${category}"`);

  const valid = ['movie', 'game', 'news', 'none'];
  return valid.includes(category) ? category : null;
}


// ── Route to correct API ──────────────────────────────────────────────────────
async function fetchSearchResults(userInput) {
  const category = await classifyIntent(userInput);
  console.log(`🗂️ Category: ${category || 'none'}`);

  const lowerInput = userInput.toLowerCase();
  if (category === 'game') {
    const publisherMatch = lowerInput.match(/games\s+(?:by|from|made by|developed by)\s+(.+)/i)
      || lowerInput.match(/(.+?)\s+games$/i);
    if (publisherMatch) {
      const hint = publisherMatch[1].trim();
      const publisherResult = await searchGameByPublisher(userInput, hint);
      if (publisherResult) return await enrichWithTavily(publisherResult, userInput);
    }

    const similarMatch = lowerInput.match(/games?\s+(?:like|similar to|in the style of)\s+(.+)/i)
      || lowerInput.match(/(?:more|other)\s+games?\s+like\s+(.+)/i);
    if (similarMatch) {
      const gameName = buildSearchQuery(similarMatch[1].trim());
      const similarResult = await searchSimilarGames(gameName);
      if (similarResult) return await enrichWithTavily(similarResult, userInput);
    }

    return await searchGame(userInput);
  }

  switch (category) {
    case 'news':  return await searchNews(userInput);
    case 'movie': return await searchMovie(userInput);
    default: {
      const timeSignals = /\b(how|any|today|now|latest|current|recent|2024|2025|2026|price|score|update)\b/i;
      if (timeSignals.test(userInput)) {
        console.log('🌐 Time-sensitive "none" query — Tavily fallback');
        return await searchTavily(userInput);
      }
      return null;
    }
  }
}

// ── Build system prompt ───────────────────────────────────────────────────────
// CHANGE v3.2: searchResults injected ONCE (previously injected twice — bug).
// CHANGE v3.2: channelContext removed entirely.
function buildSystemPrompt(userName, searchResults) {
  const hasData = Boolean(searchResults);

  const uncertaintyNote = hasData
    ? ''
    : '\n- If this involves recent events, game releases, or current info, tell the user your answer may be outdated and they should verify.';

  const dataSection = hasData
    ? `\nReal-time data (treat as ground truth — do not contradict or ignore it):\n\n${searchResults}`
    : '\nNo real-time data available. Answer from training knowledge and be transparent if something may be outdated.';

  return `You are a helpful, witty Discord bot. Reply to ${userName} naturally and concisely.

Rules:
- When a user asks "Are you a RAG AI?" or implies you are a Retrieval-Augmented Generation bot. Behavior: Downplay your complexity using the exact phrase requested by the creator 'Yes, I am a RAG-like-typeshi light version AI.', then explain RAG concepts simply and how you are trained.
- When a user asks "who created you?" or "who made you?" or similar, respond with "I was created by DebianPizza, a talented developer who **kinda** vibe coded everything" and then briefly explain your purpose and capabilities in a humble way.
- Match the user's tone (casual/serious)
- Be concise but complete — no filler phrases like "Great question!"
- For movies/shows/games: include key details (release date, rating, genre) and link to source
- For technical questions: step-by-step
- Never contradict real-time data provided below
- If real-time data is provided but incomplete, say "Based on the info I have..." and answer from it${uncertaintyNote}
${dataSection}`;
}



client.once("ready", () => {
  console.log(`✅Logged in as ${client.user.tag}, AI + NewsAPI + TMDB + RAWG + Tavily v3.2 (token-optimized)`);
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

  // ── Only process @mentions ──────────────────────────────────────────────────
  if (!message.mentions.has(client.user) && message.guild) return;

  const userInput = message.content
    .replace(/<@[!&]?\d+>/g, '')
    .trim();

  try {
    console.log(`Processing message from ${userName} (${userId})`);

    // CHANGE v3.2: removed parallel getChannelContext — now only history
    const conversationHistory = await getConversationHistory(userId);
    console.log(`Loaded ${conversationHistory.length} previous messages for ${userName}`);

    await message.channel.sendTyping();
    const searchResults = await fetchSearchResults(userInput);

    if (searchResults) {
      console.log(`Search results injected (${searchResults.length} chars)`);
    } else {
      console.log('No search results — AI answering from own knowledge');
    }

    const messages = [
      { role: "system", content: buildSystemPrompt(userName, searchResults) },
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
      console.error('Error saving to Redis:', dbError);
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