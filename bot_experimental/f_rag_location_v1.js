//AI SECTION
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
const dbPath = path.join(__dirname, '../data/db/conversations.db');
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

// ── userdata.db — user settings (location, etc.) ─────────────────────────────
const userdataPath = path.join(__dirname, '../data/db/userdata.db');
const udb = new sqlite3.Database(userdataPath);

udb.serialize(() => {
  udb.run(`CREATE TABLE IF NOT EXISTS user_locations (
    user_id   TEXT PRIMARY KEY,
    city      TEXT NOT NULL,
    state     TEXT NOT NULL,
    nation    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
});
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HISTORY = 30;

// ── Free models ───────────────────────────────────────────────────────────────
const FREE_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];
// ─────────────────────────────────────────────────────────────────────────────

// ── Conversation memory (conversations.db) ────────────────────────────────────
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
      else { console.log(`Cleared ${this.changes} messages for user ${userId}`); resolve(this.changes); }
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

// ── User location (userdata.db) ───────────────────────────────────────────────
function getUserLocation(userId) {
  return new Promise((resolve, reject) => {
    udb.get(`SELECT city, state, nation FROM user_locations WHERE user_id = ?`, [userId], (err, row) => {
      if (err) reject(err);
      else resolve(row || null); // returns { city, state, nation } or null
    });
  });
}

function setUserLocation(userId, city, state, nation) {
  return new Promise((resolve, reject) => {
    udb.run(
      `INSERT OR REPLACE INTO user_locations (user_id, city, state, nation, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [userId, city, state, nation, Date.now()],
      function(err) { if (err) reject(err); else resolve(); }
    );
  });
}

function clearUserLocation(userId) {
  return new Promise((resolve, reject) => {
    udb.run(`DELETE FROM user_locations WHERE user_id = ?`, [userId], function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

// Helper — format location object into a readable string
function formatLocation(loc) {
  if (!loc) return null;
  return `${loc.city}, ${loc.state}, ${loc.nation}`;
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

// ── Location trigger keywords ─────────────────────────────────────────────────
const LOCATION_TRIGGERS = [
  // Medical
  'clinic', 'hospital', 'doctor', 'pharmacy', 'sick', 'medicine', 'emergency', 'dentist',
  // Food
  'restaurant', 'food', 'eat', 'cafe', 'coffee', 'makan', 'kedai', 'mamak', 'hawker',
  // Shopping & services
  'shop', 'mall', 'store', 'nearby', 'near me', 'around here', 'where can i',
  // Transport & utilities
  'petrol', 'gas station', 'atm', 'bank', 'parking', 'bus stop', 'lrt', 'grab',
];

function needsLocationSearch(text) {
  const lower = text.toLowerCase();
  return LOCATION_TRIGGERS.some(trigger => lower.includes(trigger));
}
// ─────────────────────────────────────────────────────────────────────────────

// ── DuckDuckGo web search (no API key needed) ─────────────────────────────────
async function webSearch(query) {
  try {
    console.log(`🔍 DDG searching: ${query}`);
    const encoded = encodeURIComponent(query);
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { headers: { 'User-Agent': 'DiscordBot/1.0' } }
    );

    if (!response.ok) {
      console.error('DDG search failed:', response.status);
      return null;
    }

    const data = await response.json();
    const parts = [];

    if (data.Abstract) parts.push(data.Abstract);

    if (data.Results?.length) {
      data.Results.slice(0, 3).forEach(r => {
        if (r.Text) parts.push(`• ${r.Text}`);
      });
    }

    if (data.RelatedTopics?.length) {
      data.RelatedTopics.slice(0, 5).forEach(t => {
        if (t.Text) parts.push(`• ${t.Text}`);
      });
    }

    const result = parts.join('\n').trim();
    console.log(`DDG returned ${result.length} chars`);
    return result || null;

  } catch (err) {
    console.error('DDG search error:', err);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Try each model in order, skip on 429, return null if all fail ─────────────
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

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}, AI + location search`);
});

process.on('SIGINT', () => {
  console.log('Closing database connections...');
  db.close();
  udb.close(() => {
    console.log('Database connections closed.');
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
      console.error('Error clearing memory:', err);
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
      console.error('Error getting stats:', err);
      return await message.reply("❌ Error getting stats. Try again later.");
    }
  }

  // ── ai--setlocation city, state, nation ────────────────────────────────────
  if (msgLower.includes('ai--setlocation')) {
    const raw = message.content.replace(/ai--setlocation/i, '').trim();
    if (!raw) {
      return await message.reply(
        '❌ Please provide your location in this format:\n`ai--setlocation city, state, nation`\nExample: `ai--setlocation Sungai Ara, Penang, Malaysia`'
      );
    }

    const parts = raw.split(',').map(s => s.trim());
    if (parts.length !== 3 || parts.some(p => !p)) {
      return await message.reply(
        '❌ Invalid format. Use:\n`ai--setlocation city, state, nation`\nExample: `ai--setlocation Sungai Ara, Penang, Malaysia`'
      );
    }

    const [city, state, nation] = parts;
    try {
      await setUserLocation(userId, city, state, nation);
      return await message.reply(
        `📍 Location saved!\n🏙️ City: **${city}**\n🗺️ State: **${state}**\n🌏 Nation: **${nation}**`
      );
    } catch (err) {
      console.error('Error saving location:', err);
      return await message.reply("❌ Error saving location. Try again later.");
    }
  }

  // ── ai--mylocation ──────────────────────────────────────────────────────────
  if (msgLower.includes('ai--mylocation')) {
    try {
      const loc = await getUserLocation(userId);
      if (!loc) {
        return await message.reply(
          '📍 No location set.\nUse `ai--setlocation city, state, nation` to set one.\nExample: `ai--setlocation Sungai Ara, Penang, Malaysia`'
        );
      }
      return await message.reply(
        `📍 **Your Location:**\n🏙️ City: **${loc.city}**\n🗺️ State: **${loc.state}**\n🌏 Nation: **${loc.nation}**\n\n` +
        `\`ai--setlocation city, state, nation\` — change it\n` +
        `\`ai--clearlocation\` — remove it`
      );
    } catch (err) {
      return await message.reply("❌ Error fetching location.");
    }
  }

  // ── ai--clearlocation ───────────────────────────────────────────────────────
  if (msgLower.includes('ai--locationclr')) {
    try {
      const count = await clearUserLocation(userId);
      if (count === 0) return await message.reply("📍 No location was set.");
      return await message.reply('📍 Location cleared.');
    } catch (err) {
      return await message.reply("❌ Error clearing location.");
    }
  }

  // ── Only process @mentions from here ───────────────────────────────────────
  if (!message.mentions.has(client.user) && message.guild) return;

  const userInput = message.content.replace(`<@${client.user.id}>`, '').trim();

  try {
    console.log(`Processing message from ${userName} (${userId})`);

    const [conversationHistory, channelContext, userLocation] = await Promise.all([
      getConversationHistory(userId),
      getChannelContext(message.channel),
      getUserLocation(userId)
    ]);

    console.log(`Loaded ${conversationHistory.length} previous messages for ${userName}`);
    const locationStr = formatLocation(userLocation);
    console.log(`User location: ${locationStr || 'not set'}`);

    // If location-related question and user has a location, do a DDG search
    let searchResults = '';
    if (userLocation && needsLocationSearch(userInput)) {
      await message.channel.sendTyping();
      searchResults = await webSearch(`${userInput} near ${locationStr}`) || '';
      if (searchResults) {
        console.log(`Got DDG results (${searchResults.length} chars)`);
      } else {
        console.log('DDG returned no results, falling back to AI knowledge');
      }
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
- If someone asks a technical question, break it down step by step
- Don't pad responses with filler phrases like "Great question!" or "Certainly!"
${locationStr ? `\nThe user is located in ${locationStr}. Factor this in when they ask about nearby places, clinics, food, etc.` : ''}
${searchResults ? `\nReal-time search results for their query — use these to give accurate local suggestions:\n${searchResults}` : ''}
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