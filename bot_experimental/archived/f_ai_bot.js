//AI SECTION
require("dotenv").config();
// const { Intents } = require("discord.js");
const { Client, GatewayIntentBits } = require("discord.js");
const fetch = require("node-fetch");
const Discord = require("discord.js");
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// const client = new Discord.Client({
//   intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.MESSAGE_CONTENT]
// });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Initialize SQLite database
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

const MAX_HISTORY = 30;


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

// ── Read recent channel messages for context ──────────────────────────────────
async function getChannelContext(channel, limit = 30) {
  try {
    const messages = await channel.messages.fetch({ limit });
    const context = [...messages.values()]
      .reverse()                                      // oldest first
      .filter(m => !m.author.bot && m.content.length > 5) // skip bots & tiny msgs
      .map(m => `[${m.author.username}]: ${m.content}`)
      .join('\n');

    // Cap at 2000 chars to avoid bloating the prompt
    return context.length > 2000 ? context.slice(-2000) : context;
  } catch (err) {
    console.error('Failed to fetch channel context:', err);
    return '';
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// ── Free models to rotate through when rate limited ──────────────────────────
const FREE_MODELS = [
    "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-embedding-2-preview",
  // "nvidia/nemotron-3-nano-30b-a3b:free",
  //   // "meta-llama/llama-3.3-70b-instruct:free",
  // "mistralai/mistral-7b-instruct:free",
  // "google/gemma-3-27b-it:free",
  // "deepseek/deepseek-r1-0528-qwen3-8b:free",
];
// ─────────────────────────────────────────────────────────────────────────────

// ── Try each model in order, skip on 429, return null if all fail ─────────────
async function fetchFromAny(messages) {
  for (const model of FREE_MODELS) {
    console.log(`Trying model: ${model}`);
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GOOGLE_API_KEY}`,
        "HTTP-Referer": "https://your-site.com",
        "X-Title": "Discord Bot"
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

  return null; // all models failed
}
// ─────────────────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`✅Logged in as ${client.user.tag}, AI with SQLite memory`);
});

process.on('SIGINT', () => {
  console.log('Closing database connection...');
  db.close((err) => {
    if (err) console.error('Error closing database:', err);
    else console.log('Database connection closed.');
    process.exit(0);
  });
});

// command ai--clearmemo to clear memory
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content.length < 3) return;

  const userId   = message.author.id;
  const userName = message.author.username;

  if (message.content.toLowerCase().includes('ai--clearmemo')) {
    try {
      const count = await clearConversationHistory(userId);
      return await message.reply(`🧠 Memory cleared! Deleted ${count} messages. Starting fresh.`);
    } catch (err) {
      console.error('Error clearing memory:', err);
      return await message.reply("❌ Error clearing memory. Try again later.");
    }
  }

  if (message.content.toLowerCase().includes('ai--memostat')) {
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

  if (!message.mentions.has(client.user) && message.guild) return;

  const userInput = message.content.replace(`<@${client.user.id}>`, '').trim();

  try {
    console.log(`Processing message from ${userName} (${userId})`);

    const conversationHistory = await getConversationHistory(userId);
    console.log(`Loaded ${conversationHistory.length} previous messages for ${userName}`);

    // Fetch what people have been talking about in this channel
    const channelContext = await getChannelContext(message.channel);
    console.log(`Fetched channel context (${channelContext.length} chars)`);

    const messages = [
      {
        role: "system",
        content: 
`
You are a helpful, witty, and conversational Discord bot. Respond to ${userName} naturally and clearly.

Guidelines:
- Be concise but thorough — don't over-explain, but don't leave things half-answered
- Match the tone of the conversation (casual if they're casual, serious if they're serious)
- If you don't know something, say so honestly instead of guessing
- Use plain language, avoid unnecessary jargon
- If someone asks a technical question, break it down step by step
- Remember context from the conversation history and channel to give relevant replies
- Don't pad responses with filler phrases like "Great question!" or "Certainly!"

Here is what people have been talking about in this channel recently:
${channelContext || '(no recent messages)'}

`
// `
// You are a racist and have dark humour Discord bot. Respond to ${userName} in a casual,
//  Racial slur and curse word is allowed.4Chan user type reply. Keep responses concise and natural. 
//  You can remember our previous conversations from our chat history. witty and funny.
// `

      },
      ...conversationHistory,
      { role: "user", content: userInput }
    ];

    const reply = await fetchFromAny(messages);

    if (!reply) {
      console.error("All models rate limited or failed");
      return await message.reply("⏳ All free AI models are rate limited right now. Try again in a minute.");
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