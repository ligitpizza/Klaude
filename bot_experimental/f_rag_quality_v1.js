//AI SECTION v3 — Gemini + NewsAPI + OMDB + RAWG + Tavily fallback
require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const fetch = require("node-fetch");
const { LOADIPHLPAPI } = require("node:dns");
const redis = require("../data/db/redis_client.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let LOG_COUNTER = 0;

// ── Rate limit config ─────────────────────────────────────────────────────────
const RATE_LIMIT_MAX    = 8;  // max requests per window
const RATE_LIMIT_WINDOW = 60;  // seconds


// ── Rate limit check ──────────────────────────────────────────────────────────
async function checkRateLimit(userId) {
  const key = `rl:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW);
  const ttl = await redis.ttl(key);
  return { allowed: count <= RATE_LIMIT_MAX, count, ttl };
}

const MAX_HISTORY = 20;

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
    .replace(/\b20\d{2}\b/g, '')
    .replace(new RegExp(Object.keys(MONTH_MAP).join('|'), 'gi'), '')
    .replace(/\s+/g, ' ').trim();
  return q;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Query cleaner (hybrid: regex pre-pass → AI if still messy) ────────────────
const FILLER_WORDS = [
  'whats', "what's", 'what is', 'what are', 'tell me', 'can you', 'do you know',
  'hey', 'yo', 'bro', 'please', 'pls', 'lah', 'la', 'ah', 'oh',
  'did', 'does', 'is there', 'are there', 'how is', 'how was',
  'omg', 'wtf', 'any', 'about', 'the', 'a ', 'an ',
  'named', 'called', 'titled',
];

function regexClean(text) {
  let q = text.toLowerCase();
  FILLER_WORDS.forEach(w => { q = q.replace(new RegExp(`\\b${w}\\b`, 'gi'), ''); });
  q = q.replace(/\s+/g, ' ').trim();
  q = q.replace(/([a-zA-Z])(\d)/g, '$1 $2').replace(/(\d)([a-zA-Z])/g, '$1 $2');
  return q.charAt(0).toUpperCase() + q.slice(1);
}

function isMessy(text) {
  const wordCount = text.trim().split(/\s+/).length;
  const hasSlang = /\b(lah|la|bro|yo|omg|wtf|pls|nak|tak|ke|kan|wei|weh|sia|leh)\b/i.test(text);
  const hasFiller = /\b(can you|tell me|do you know|what is|what are|is there)\b/i.test(text);
  return wordCount > 6 || hasSlang || hasFiller;
}

async function buildSearchQuery(rawQuery) {
  // Step 1: fast regex pre-pass
  const preClean = regexClean(rawQuery);

  // Step 2: if still messy, let AI refine it
  if (isMessy(rawQuery)) {
    console.log(`🔧 Query messy, sending to AI cleaner: "${preClean}"`);
    const messages = [
      {
        role: "system",
        content: `You are a search query optimizer. Extract only the essential search terms.
        Remove filler words, casual/slang language (including Malay slang like "lah", "bro", "wei"), and conversational phrases.
        Return ONLY the cleaned query — no explanation, no punctuation, no quotes. 2–6 words max.`
      },
      { role: "user", content: rawQuery }
    ];
    const aiResult = await fetchFromAny(messages);
    const cleaned = aiResult?.trim() || preClean;
    console.log(`🤖 AI-cleaned: "${rawQuery}" → "${cleaned}"`);
    return cleaned;
  }

  console.log(`🔧 Regex-cleaned: "${rawQuery}" → "${preClean}"`);
  return preClean;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Tavily ────────────────────────────────────────────────────────────────────
async function searchTavily(rawQuery) {
  const query = await buildSearchQuery(rawQuery);
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
// ─────────────────────────────────────────────────────────────────────────────

// ── Tavily enrichment ─────────────────────────────────────────────────────────
async function enrichWithTavily(primaryResult, userQuery) {
  try {
    const titleMatch = primaryResult.match(/\*\*([^*]+)\*\*/);
    const titleHint = titleMatch ? titleMatch[1].trim() : '';
    const enrichQuery = titleHint
      ? `${titleHint} ${userQuery} reviews latest news`
      : `${userQuery} reviews latest news`;

    console.log(`✨ Enriching with Tavily: "${enrichQuery}"`);

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

    if (!enrichParts.length) return primaryResult;

    const combined = `${primaryResult}\n${enrichParts.join('\n')}`;
    console.log(`✨ Enrichment combined: ${combined.length} chars`);
    return combined;
  } catch (err) {
    console.error('enrichWithTavily error:', err);
    return primaryResult;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── NewsAPI ───────────────────────────────────────────────────────────────────
async function searchNews(rawQuery) {
  const query = await buildSearchQuery(rawQuery);
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
    if (tavilyResult) return tavilyResult;
    console.warn('📰 News: both NewsAPI and Tavily failed');
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── MalaysiaNewsAPI ───────────────────────────────────────────────────────────────────
async function searchMalaysiaNews(rawQuery) {
  const query = await buildSearchQuery(rawQuery);
  try {
    console.log(`🇲🇾 Malaysia news searching: ${query}`);
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${process.env.NEWSAPI_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('NewsAPI failed');
    const data = await response.json();

    // filter to Malaysian sources only
    const myDomains = ['thestar.com.my', 'malaymail.com', 'bernama.com', 'fmt.com.my', 
                       'nst.com.my', 'malaysiakini.com', 'themalaysianinsight.com', 'sinchew.com.my'];
    
    const filtered = data.articles?.filter(a =>
      myDomains.some(d => a.url?.includes(d))
    );

    // fall back to general results if no MY sources matched
    const articles = filtered?.length ? filtered : data.articles;
    if (!articles?.length) throw new Error('No results');

    const parts = ['**🇲🇾 Malaysia News:**'];
    articles.slice(0, 4).forEach(a => {
      parts.push(`• **${a.title}**\n${a.description?.slice(0, 150) || ''}...\n🔗 ${a.url}`);
    });
    return parts.join('\n\n').trim();

  } catch (err) {
    console.warn(`Malaysia news failed (${err.message}), Tavily fallback...`);
    return await searchTavily(`Malaysia news ${rawQuery}`);
  }
}

// ── TMDB ──────────────────────────────────────────────────────────────────────
async function searchMovie(rawQuery) {
  const query = await buildSearchQuery(rawQuery);
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

    const tmdbResult = [
      `**${title}** (${year}) — ${type === 'tv' ? '📺 TV Show' : '🎬 Movie'}`,
      `⭐ TMDB: ${rating}/10 (${votes} votes) | 🎭 Genre: ${genres}`,
      `📝 ${overview}`,
      `👥 Cast: ${cast}`,
      `📌 Status: ${status}`,
      `🔗 [View on TMDB](${tmdbLink})`,
    ].join('\n');

    console.log(`🎬 TMDB succeeded, enriching...`);
    return await enrichWithTavily(tmdbResult, rawQuery);

  } catch (err) {
    console.warn(`🎬 TMDB failed (${err.message}), trying Tavily...`);
    const tavilyResult = await searchTavily(rawQuery);
    if (tavilyResult) return tavilyResult;
    console.warn('🎬 Movie: both TMDB and Tavily failed');
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── RAWG ──────────────────────────────────────────────────────────────────────
async function searchGame(rawQuery) {
  const { year, month } = extractDateInfo(rawQuery);
  const stripped = year ? stripDateFromQuery(rawQuery) : rawQuery;
  const titleQuery = await buildSearchQuery(stripped);

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
      const link = g.slug ? `https://rawg.io/games/${g.slug}` : '';
      const linkText = link ? ` | 🔗 [View on RAWG](${link})` : '';
      parts.push(`• **${g.name}** — ⭐ Rating: ${g.rating}/5 | 📅 ${g.released || 'TBA'} | 🎮 ${platforms}${linkText}`); // fix to avoid ai return text url.
    });

    const rawgResult = parts.join('\n').trim();
    console.log(`🎮 RAWG succeeded, enriching...`);
    return await enrichWithTavily(rawgResult, rawQuery);

  } catch (err) {
    console.warn(`🎮 RAWG failed (${err.message}), trying Tavily...`);
    const tavilyResult = await searchTavily(rawQuery);
    if (tavilyResult) return tavilyResult;
    console.warn('🎮 Game: both RAWG and Tavily failed');
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────


async function searchGameByPublisher(rawQuery, hint = '') {
  const query = await buildSearchQuery(hint || rawQuery);
  try {
    console.log(`🎮 RAWG publisher search: ${query}`);
    const params = new URLSearchParams({ search: query, page_size: '6', key: process.env.RAWG_KEY });
    const url = `https://api.rawg.io/api/games?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.results?.length) return null;

    const parts = [`**Games by ${query}:**`];
    data.results.slice(0, 5).forEach(g => {
      const platforms = g.platforms?.map(p => p.platform.name).slice(0, 3).join(', ') || 'N/A';
      const link = g.slug ? `https://rawg.io/games/${g.slug}` : '';
      const linkText = link ? ` | 🔗 [View on RAWG](${link})` : '';
      parts.push(`• **${g.name}** — ⭐ ${g.rating}/5 | 📅 ${g.released || 'TBA'} | 🎮 ${platforms}${linkText}`); // fix to avoid ai return text url.
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
      const link = g.slug ? `https://rawg.io/games/${g.slug}` : '';
      const linkText = link ? ` | 🔗 [View on RAWG](${link})` : '';
      parts.push(`• **${g.name}** — ⭐ ${g.rating}/5 | 📅 ${g.released || 'TBA'} | 🎮 ${platforms}${linkText}`); // fix to avoid ai return text url.
    });
    return parts.join('\n').trim();
  } catch (err) {
    console.error('RAWG similar games error:', err);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Gemini ────────────────────────────────────────────────────────────────────
const FREE_MODELS = [
  // "gemini-2.5-flash-lite",
  // "gemini-2.5-flash",
  // "gemini-3.1-flash",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-live",
];

async function fetchFromAny(messages) {
  for (const model of FREE_MODELS) {
    console.log(`Trying model: ${model}`);
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GOOGLE_API_KEY}`
      },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 1500 })
    });

    if (response.status === 429) { console.log(`Model ${model} rate limited, trying next...`); continue; }
    if (!response.ok) { const errText = await response.text(); console.error(`Model ${model} error ${response.status}:`, errText); continue; }
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
const gamenews = 'asking about gaming news, game announcements, upcoming releases buzz, gaming industry updates.'
const technews = 'asking about tech news, startups, programming, AI developments, silicon valley.'
const generalnews = 'asking about general current events, politics, sports, latest news, breaking news and updates.'

// ── Intent classifier ─────────────────────────────────────────────────────────
async function classifyIntent(userInput) {
  const messages = [
    {
      role: "system",
      content: `You are an intent classifier. Classify the user's message into exactly one of these categories:
- "movie" — asking about a movie, TV show, film, series, cast, rating, streaming
- "game" — asking about a video game, release date, DLC, patch, console, game publisher, games by a developer/studio, games similar to another game, game series
- "news" — '${generalnews + `Can be ` + technews + `And` + gamenews}
- "mynews" — asking about Malaysia news, local Malaysian current events, Malaysian politics, economy, weather
- "none" — general conversation, questions AI can answer from knowledge, weather, sports scores, crypto, stocks, prices, or anything else

Reply with ONLY the category word, nothing else.`
    },
    { role: "user", content: userInput }
  ];

  const result = await fetchFromAny(messages);
  const category = result?.toLowerCase().trim();
  console.log(`🤖 Intent: "${category}"`);
  // FIX 1: valid array now includes gamenews and technews
  const valid = ['movie', 'game', 'news', 'mynews', 'none'];     //'gamenews', 'technews'
  return valid.includes(category) ? category : null;
}
// ─────────────────────────────────────────────────────────────────────────────

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
      // FIX 2: await was missing on buildSearchQuery
      const gameName = await buildSearchQuery(similarMatch[1].trim());
      const similarResult = await searchSimilarGames(gameName);
      if (similarResult) return await enrichWithTavily(similarResult, userInput);
    }

    return await searchGame(userInput);
  }

  switch (category) {
    case 'news':      return await searchNews(userInput);
    case 'mynews': return await searchMalaysiaNews(userInput);
    case 'movie':     return await searchMovie(userInput);
    // case 'gamenews':  return await searchGameNews(userInput);
    // case 'technews':  return await searchHackerNews(userInput);
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
// tavily serve as fall back for "none" category if it contains time-sensitive signals, otherwise return null to let AI answer from knowledge
// none-category message can hits Tavily, with pure conversational stuff like "how are you". That's wasteful.
// to make it more targeted, we add a signal check before calling Tavily.
// ─────────────────────────────────────────────────────────────────────────────

// ── [1] GUIDELINES HELPERS — add after clearConversationHistory() ─────────────
 
const GUIDELINES_KEY = 'bot:guidelines';
 
async function getGuidelines() {
  try {
    const raw = await redis.get(GUIDELINES_KEY);
    if (!raw) return [];
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
}
 
async function saveGuidelines(guidelines) {
  await redis.set(GUIDELINES_KEY, JSON.stringify(guidelines));
}
 
async function addGuideline(name, content) {
  const guidelines = await getGuidelines();
  const id = Date.now().toString(36); // short unique id
  guidelines.push({ id, name: name.trim(), content: content.trim() });
  await saveGuidelines(guidelines);
  return id;
}
 
async function editGuideline(id, content) {
  const guidelines = await getGuidelines();
  const idx = guidelines.findIndex(g => g.id === id);
  if (idx === -1) return false;
  guidelines[idx].content = content.trim();
  await saveGuidelines(guidelines);
  return true;
}
 
async function removeGuideline(id) {
  const guidelines = await getGuidelines();
  const filtered = guidelines.filter(g => g.id !== id);
  if (filtered.length === filtered.length && guidelines.length === filtered.length) return false; // nothing removed
  await saveGuidelines(filtered);
  return filtered.length < guidelines.length;
}
 
async function buildGuidelinesBlock() {
  const guidelines = await getGuidelines();
  if (!guidelines.length) return '';
  return guidelines.map(g => `- [${g.name}] ${g.content}`).join('\n');
}
 
// ─────────────────────────────────────────────────────────────────────────────




client.once("ready", () => {
  try {
    console.log(`✅Logged in as ${client.user.tag}, v3.1 (Redis + rate limit)`);
  } catch (err) {
    console.error('Error fetching creator user:', err);
  }
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  process.exit(0);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content.length < 3) return;

  const userId   = message.author.id;
  const userName = message.author.username;
  const msgLower = message.content.toLowerCase();

  //ai commands
  // ai--memoclr
  if (msgLower.includes('ai--memoclr')) {
    try {
      await clearConversationHistory(userId);
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f")
          .setTitle("🧹 Memory Cleared")
          .setDescription("Your conversation history has been wiped. Starting fresh!")
          .setFooter({ text: `Requested by ${userName}` })],
      });
    } catch {
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f")
          .setTitle("Error")
          .setDescription("Failed to clear memory. Try again later.")
        ],  
      });
    }
  }
 
  // ai--memostat
  if (msgLower.includes('ai--memostat')) {
    try {
      const stats = await getConversationStats(userId);
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f")
          .setTitle("Your Stats")
          .addFields({ name: "Messages Stored", value: `${stats.total_messages}`, inline: true })
          .setFooter({ text: `Stats for ${userName}` })
        ],
      });
    } catch {
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f")
          .setTitle("Error")
          .setDescription("Failed to fetch stats. Try again later.")],
      });
    }
  }
 
  // ai--guide — CRUD for dynamic guidelines
  if (msgLower.startsWith('ai--g')) {
    // Optional: restrict to specific user IDs
    // const ALLOWED = ['YOUR_DISCORD_USER_ID'];
    // if (!ALLOWED.includes(userId)) return await message.reply('Not authorized.');
 
    const args = message.content.slice('ai--g'.length).trim();
    const [subcommand, ...rest] = args.split(/\s+/);
    const sub = subcommand?.toLowerCase();
 
    // LIST
    if (sub === 'ls') {
      const guidelines = await getGuidelines();
      if (!guidelines.length) return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f")
          .setTitle("Guidelines")
          .setDescription("No guidelines stored yet.")],
      });
      const lines = guidelines.map(g => `\`${g.id}\` **${g.name}** — ${g.content.slice(0, 80)}${g.content.length > 80 ? '...' : ''}`);
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f")
          .setTitle(`Guidelines - **${guidelines.length}** Total`)
          .setDescription(lines.join('\n'))
          .setFooter({ text: `Requested by ${userName}` })
        ],  
      });
    }
 
    // SHOW
    if (sub === '-s') {
      const id = rest[0];
      if (!id) return await message.reply({
        embeds: [new EmbedBuilder().setColor("#282d2f").setTitle("Correct Usage:").setDescription("Usage: `ai--g -s <id>`")],
      });
      const guidelines = await getGuidelines();
      const g = guidelines.find(g => g.id === id);
      if (!g) return await message.reply({
        embeds: [new EmbedBuilder().setColor("#282d2f").setTitle("Invalid Commands:").setDescription(`No guideline found with id \`${id}\`.`)],
      });
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f")
          .setTitle(`📄 ${g.name}`)
          .setDescription(g.content)
          .setFooter({ text: `ID: ${g.id}` })
          .setFooter({ text: `Requested by ${userName}` })
        ],
      });
    }
 
    // ADD  — format: ai--guide add <name> - <content>
    if (sub === '-a') {
      const full = rest.join(' ');
      const pipeIdx = full.indexOf('-');
      if (pipeIdx === -1) return await message.reply({
        embeds: [new EmbedBuilder().setColor("#282d2f").setTitle("Correct Usage:").setDescription("`ai--g -a <name> - <content>`")],
      });
      const name    = full.slice(0, pipeIdx).trim();
      const content = full.slice(pipeIdx + 1).trim();
      if (!name || !content) return await message.reply({
        embeds: [new EmbedBuilder().setColor("#282d2f").setTitle("Invalid Commands:").setDescription("Both name and content are required.")],
      });
      const id = await addGuideline(name, content);
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f") 
          .setTitle("Guideline Added")
          .addFields(
            { name: "ID",   value: `\`${id}\``, inline: true },
            { name: "Name", value: name, inline: true },
            { name: "Content",   value: content, inline: true },
          )
          .setFooter({ text: `Added by ${userName}` })
        ],
      });
    }
 
    // EDIT  — format: ai--guide edit <id> - <new content>
    if (sub === '-e') {
      const full = rest.join(' ');
      const pipeIdx = full.indexOf('-');
      if (pipeIdx === -1) return await message.reply({
        embeds: [new EmbedBuilder().setColor("#282d2f").setTitle("Correct Usage:").setDescription("`ai--g -e <id> - <new content>`")],
      });
      const id      = full.slice(0, pipeIdx).trim();
      const content = full.slice(pipeIdx + 1).trim();
      if (!id || !content) return await message.reply({
        embeds: [new EmbedBuilder().setColor("#282d2f").setTitle("Invalid Commands:").setDescription("Both id and new content are required.")],
      });
      const ok = await editGuideline(id, content);
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor(ok ? "#282d2f" : "#282d2f")
          .setTitle("Guideline Updated")
          .setDescription(ok ? `Guideline \`${id}\` updated.` : `No guideline found with id \`${id}\`.`)
          .setFooter({ text: `Updated by ${userName}` })
        ],
      });
    }
 
    // REMOVE
    if (sub === '-r') {
      const id = rest[0];
      if (!id) return await message.reply({
        embeds: [new EmbedBuilder().setColor("#282d2f").setTitle("Correct Usage:").setDescription("`ai--g -r <id>`")],
      });
      const ok = await removeGuideline(id);
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor(ok ? "#282d2f" : "#282d2f")
          .setTitle("Guideline Removed")
          .setDescription(ok ? `Guideline \`${id}\` removed.` : `No guideline found with id \`${id}\`.`)
          .setFooter({ text: `Removed by ${userName}` })
        ],
      });
    }
 
    // HELP fallback
    return await message.reply({
      embeds: [new EmbedBuilder()
        .setColor("#282d2f")
        // .setTitle("📋ai--g Commands")
        .addFields(
          {
            name: "📋 Guidelines",
            value: [
              "`ai--g ls` List all guidelines",
              "`ai--g -s <id>` View a specific guideline",
              "`ai--g -a <name> - <content>` Add a guideline",
              "`ai--g -e <id> - <content>` Edit a guideline",
              "`ai--g -r <id>` Remove a guideline",
            ].join("\n"),
            inline: false,
          },
        )],
    });
  }
 
// ─────────────────────────────────────────────────────────────────────────────
 

  // ── Only process @mentions ──────────────────────────────────────────────────
  if (!message.mentions.has(client.user) && message.guild) return;

  // ── Rate limit ──────────────────────────────────────────────────────────────
  try {
    const { allowed, count, ttl } = await checkRateLimit(userId);
    if (!allowed) {
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f")
          .setTitle("⏳ Rate Limited")
          .setDescription(`You've sent **${count}** messages this minute. Try again in **${ttl}s**.`)],
      });
    }
  } catch (err) {
    console.error('Rate limit check failed:', err);
  }

  // Handle user input by stripping bot mentions and trimming whitespace
  const userInput = message.content
    .replace(/<@[!&]?\d+>/g, '')
    .trim();

  try {
    LOG_COUNTER++; // FIX 4: increment moved here — tracks actual messages processed
    console.log(`Processing message from ${userName} (${userId})`);

    const [conversationHistory, channelContext, guidelinesBlock] = await Promise.all([
      getConversationHistory(userId),
      getChannelContext(message.channel),
      buildGuidelinesBlock(),
    ]);


    console.log(`Loaded ${conversationHistory.length} previous messages for ${userName}`);

    await message.channel.sendTyping();
    const searchResults = await fetchSearchResults(userInput);

    if (searchResults) {
      console.log(`Search results injected (${searchResults.length} chars)`);
    } else {
      console.log('No search results — AI answering from own knowledge');
    }

    const uncertaintyNote = !searchResults
      ? '\n- NOTE: No real-time data was retrieved. If this involves recent events, flag to the user that your answer may be outdated.' : '';

    const systemContent = `You are a helpful, witty, and conversational Discord bot. Respond to ${userName} naturally and clearly. 
        Guidelines:
        - When a user asks "Are you a RAG AI?" or implies you are a Retrieval-Augmented Generation bot. Behavior: Downplay your complexity using the exact phrase requested by the creator 'Yes, I am a RAG-like-typeshi AI.', then explain RAG concepts simply and how you are trained.
        - When a user asks "who created you?" or "who made you?" or similar, respond with "I was created by DebianPizza, a talented developer who **kinda** vibe coded everything" and then briefly explain your purpose and capabilities in a humble way.
      
        
        ${guidelinesBlock ? `\nGuidelines:\n${guidelinesBlock}` : ''}
        - Match the tone of the conversation
        - If you don't know something, say so honestly
        - Use plain language, avoid unnecessary jargon
        - Don't pad responses with filler phrases like "Great question!" or "Certainly!"
        - When real-time data is provided, treat it as ground truth
        - NEVER say you don't have information when real-time data has been provided — use it${uncertaintyNote}
        - NEVER reformat, shorten, or remove URLs. Always preserve markdown hyperlinks exactly as given in the real-time data. If a link is [text](url), keep it as [text](url).
        ${searchResults
          ? `\nIMPORTANT: Base your answer ONLY on the following real-time data. Do NOT remove any URLs or links:\n\n${searchResults}`
          : '\nNo real-time data retrieved. Answer from your own training knowledge and be transparent if something may be outdated.'}
        ${channelContext ? `\nRecent channel conversation:\n${channelContext}` : ''}`


    const messages = [
      {
        role: "system",
        content: systemContent,
      },
      ...conversationHistory,
      { 
        role: "user", 
        content: userInput 
      }
    ];

    const reply = await fetchFromAny(messages);

    if (!reply) {
      console.error("All models rate limited or failed");
      return await message.reply({
        embeds: [new EmbedBuilder()
          .setColor("#282d2f")
          .setTitle("⏳ AI Unavailable")
          .setDescription("All AI models are rate limited right now. Try again in a minute.")],
      });
    }

    try {
      await addToConversationHistory(userId, "user", userInput);
      await addToConversationHistory(userId, "assistant", reply);
      console.log(`Saved conversation for ${userName}`);
      console.log(`------------------------------------------------------------ {Log: ${LOG_COUNTER}}`);
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
    console.error("Error:", error.message);
    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor("#282d2f")
        .setTitle("Error")
        .setDescription("Something went wrong with the AI.")],
    });
  }
});

client.login(process.env.DISCORD_BOT_TOKEN_1);