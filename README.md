# Klaude (Rag-like Discord Bot)

A multi-module Discord bot built with Discord.js v14, featuring AI chat with RAG-typeshi-like, music playback, photo tracking, keyword triggers, and server utilities.

Containerized with **Docker** and hosted on **Render** (cloud). Active AI module uses **Upstash Redis** for conversation memory.

---

## Features

| Module | Description |
|--------|-------------|
| **AI Bot (RAG-like)** | Conversational AI with per-user memory, real-time data via TMDB, RAWG, NewsAPI, and Tavily |
| **Music** | Play audio from Spotify, and SoundCloud in voice channels |
| **Photoloc** | Automatically tracks and stats image uploads per user/channel |
| **Moderator** | Responds to keywords with copypasta messages (toggleable per server) |
| **Extractor** | Server/user info utilities and data export commands |
| **Insomnia** | Periodic pings to keep the bot alive on free hosting |

---

## Prerequisites

- [Node.js](https://nodejs.org/) v22 LTS
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An [OpenRouter](https://openrouter.ai/) API key (for music module AI) <-- Optional
- A [Google AI](https://ai.google.dev/) API key (for RAG AI modules) <-- Better
- An [Upstash Redis](https://upstash.com/) account (used by `f_rag_quality_v1` for AI memory/rate limiting, and by `m_photoloc` for photo stats)
- API keys for [TMDB](https://www.themoviedb.org/), [RAWG](https://rawg.io/apidocs), [NewsAPI](https://newsapi.org/), [Tavily](https://tavily.com/) (for RAG-like features)

---

## Installation

```bash
git clone https://github.com/laeffy7403/discord-bot-vscode-ver.git
cd discord-bot-vscode-ver
npm install
```

Create a `.env` file in the root directory:

```env
# Discord
DISCORD_BOT_TOKEN_1=your_main_bot_token (You need only discord bot token)
DISCORD_BOT_TOKEN_2=your_alt_bot_token_2 (Optional) 
DISCORD_BOT_TOKEN_3=your_alt_bot_token_3 (Optional)
DISCORD_BOT_TOKEN_4=your_alt_bot_token_4 (Optional)

# AI
OPENROUTER_API_KEY=your_openrouter_key (Optional)
GOOGLE_API_KEY=your_google_gemini_key (Better)
# Optional: Gemini models to try, in order (default: a chain of free text models)
# GEMINI_MODELS=gemini-3.1-flash-lite,gemini-3.5-flash-lite

# RAG Data APIs
TMDB_KEY=your_tmdb_key
RAWG_KEY=your_rawg_key
NEWSAPI_KEY=your_newsapi_key
TAVILY_API_KEY=your_tavily_key

# Optional: SoundCloud. Normally auto-detected and auto-refreshed on 401; set
# these only if the host keeps getting "Status code 401" from SoundCloud.
# SOUNDCLOUD_CLIENT_ID=your_client_id
# SOUNDCLOUD_OAUTH_TOKEN=your_oauth_token

# Cloud DB (f_rag_quality_v1 AI memory + m_photoloc stats)
UPSTASH_REDIS_REST_URL=your_upstash_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_token

# Optional: chat memory + retrieval (Upstash Vector). Without these the bot
# still works: full command guide and all guidelines in every prompt.
UPSTASH_VECTOR_REST_URL=your_upstash_vector_url
UPSTASH_VECTOR_REST_TOKEN=your_upstash_vector_token
```

### Chat memory setup (Upstash Vector)

1. In the [Upstash console](https://console.upstash.com/), create a **Vector** index: type **Dense**, metric **Cosine**, embedding model **`openai/text-embedding-3-small`** (Upstash creates the embeddings, so no extra API key is needed).
2. Copy its REST URL and token into `.env` (and into Render's environment) as `UPSTASH_VECTOR_REST_URL` / `UPSTASH_VECTOR_REST_TOKEN`.
3. Restart the bot. It stores the command list and your `ai--g` guidelines in the index on startup.
4. In each channel you want remembered, someone with **Manage Channels** runs `ai--index on`.

Free tier: 10,000 queries + updates a day. Each question uses up to 3 queries; each stored conversation chunk (up to 15 messages) uses 1 update.

Start the bot:

```bash
node launch.js
```

---

## Commands

### AI Commands
| Command | Description |
|---------|-------------|
| `@bot <message>` | Chat with the AI (has per-user memory) |
| `ai--memoclr` | Clear your AI conversation history |
| `ai--memostat` | View your conversation statistics |
| `ai--g ls\|-s\|-a\|-e\|-r` | Manage server-defined AI guidelines |
| `ai--g -p <id>` | Pin/unpin a guideline so it always applies (unpinned ones are only used when relevant) |
| `ai--index on\|off\|status` | Turn chat memory on/off for this channel, or check it (on/off need Manage Channels) |
| `ai--help` | AI-specific command help |

### Music Commands
*(Must be in a voice channel)*

| Command | Description |
|---------|-------------|
| `-play <song/url>` | Play from YouTube, Spotify, or SoundCloud |
| `-skip` | Skip the current song |
| `-stop` | Stop and clear the queue |
| `-pause` | Pause playback |
| `-resume` | Resume playback |
| `-queue` | Show the current queue |
| `-nowplaying` | Show info about the current song |
| `-loop [off\|song\|queue]` | Toggle loop mode |
| `-volume <0-100>` | Set playback volume |
| `-leave` | Disconnect the bot from voice |
| `-search <query>` | Search SoundCloud and pick a track |
| `-ask rec [song]` | Recommend similar songs (defaults to what's playing) |
| `-ask desc [song]` | Get info about a song (defaults to what's playing) |
| `-ask <question>` | General Q&A with the bot assistant (needs `GOOGLE_API_KEY`) |

### Photo Tracker Commands (Note: bot have to stay online 24/7)
| Command | Description |
|---------|-------------|
| `-mystat` | Your photo upload stats |
| `-photostat @user` | Stats for a specific user |
| `-toposter` | Leaderboard of top photo contributors |
| `-serverstat` | Overall server photo statistics |
| `-channelstat` | Photo stats for the current channel |

### Keyword Control Commands 
| Command | Description |
|---------|-------------|
| `-ton` | Enable keyword trigger responses |
| `-toff` | Disable keyword trigger responses |
| `-tstat` | Check current keyword toggle status |

### General
| Command | Description |
|---------|-------------|
| `--help` | Paginated command list (◀ / ▶ buttons, one page per module) |
| `-uptime` | Show how long the bot has been online |

---

## Project Structure

```
├── launch.js                      # Entry point — loads all modules on the shared client
├── debug.js                       # Standalone API connection tester
├── manual.js                      # Help command (paginated --help) and misc utilities
├── package.json
├── .env                           # Secret tokens (not committed)
├── bot_modules/
│   ├── m_moderator.js             # Keyword trigger responses (copypastas)
│   ├── m_extractor.js             # Server/user info and data export (runs its own Client)
│   ├── m_music.js                 # Music playback (YT/Spotify/SoundCloud) + -ask bot assistant
│   ├── m_photoloc.js              # Image upload tracking (Upstash Redis)
│   └── m_insomnia.js              # Keep-alive pinger (currently disabled)
├── bot_experimental/
│   └── f_rag_quality_v1.js        # Active AI module — Gemini + Upstash Redis memory/rate limiting
├── additional_modules/
│   ├── a_insomnia_1.js            # Alt bot keep-alive (token 2, currently disabled)
│   ├── a_insomnia_2.js            # Alt bot keep-alive (token 3, currently disabled)
│   └── a_insomnia_3.js            # Alt bot keep-alive (token 4, currently disabled)
└── data/
    ├── db/
    │   └── redis_client.js        # Upstash Redis client, wrapped with a per-call timeout
    └── utils/
        ├── timeout.js             # withTimeout() — races a promise against a deadline
        ├── retry.js               # withRetry() — retries a promise-returning fn on rejection
        └── gemini.js              # askGemini() — shared Gemini model-fallback chain
```

---

## Active Modules (launch.js)

Currently loaded in `launch.js`:

```
✅ m_moderator.js          (shared client)
✅ m_photoloc.js           (shared client)
✅ manual.js               (shared client)
✅ f_rag_quality_v1.js     (shared client) ← active AI module
✅ m_music.js              (shared client)
✅ m_extractor.js          (own Client — needs GuildMembers/GuildPresences intents)
❌ m_insomnia.js           (commented out)
❌ a_insomnia_*.js         (commented out)
```

---

## RAG Typeshi System Flow — `f_rag_quality_v1`

This module is the **quality-focused** RAG variant using **Upstash Redis** for cloud-based conversation memory and per-user rate limiting. It is only better on retriving game, news and film info rather other category like sport, weather, crypto money-shi CUZ i feel like it. Which boring fuck like to see sport and weather forecast when ur phone already has the built-in feature but still work like ass. As for crypto? i am not a crypto dude.

```
User @mentions bot
        │
        ▼
  Strip mention → extract userInput
        │
        ▼
  Rate Limit Check (Upstash Redis)
  rl:{userId} — max 10 req / 60s
        │
    Blocked? → reply with cooldown message
        │
        ▼
  Load Conversation History
  Upstash Redis: hist:{userId}
  (last 20 messages, TTL: 7 days)
        │
        ▼
  Fetch Channel Context
  Last 20 messages from Discord channel
        │
        ▼
  Intent Classification (Gemini)
  ┌─────────────────────────────┐
  │  movie / game / news / none │
  └─────────────────────────────┘
        │
   ┌────┴────┬──────────┬──────┐
   ▼         ▼          ▼      ▼
 movie      game       news   none
   │         │          │      │
 TMDB      RAWG      NewsAPI Tavily
   │         │          │      │
   └────┬────┴──────────┘      │
        ▼                      │
  Tavily Enrichment            │
  (always enriches in v1)      │
        │                      │
        └──────────┬───────────┘
                   ▼
         Build System Prompt
         (inject search results
          + channel context)
                   │
                   ▼
         Gemini Model Chain
         gemini-3.1-flash-lite →
         gemini-3-flash-live
         (fallback on 429)
                   │
                   ▼
         Save to Redis History
         hist:{userId} (lpush)
                   │
                   ▼
         Reply to Discord
         (chunked if > 2000 chars)
```

---

## Database Summary

Everything persistent is stored in Upstash Redis — nothing local, so state survives Render redeploys.

| Key(s) | Module | Status |
|---|---|---|
| `hist:{userId}` | `f_rag_quality_v1` | ✅ Active |
| `rl:{userId}` | `f_rag_quality_v1` | ✅ Active |
| `bot:guidelines` | `f_rag_quality_v1` (`ai--g`, with optional `pinned`) | ✅ Active |
| `rag:indexed:{guildId}` | chat memory — channels with `ai--index on` | ✅ Active |
| `rag:map:{channelId}` | chat memory — message id → stored chunk (for edits/deletes) | ✅ Active |
| `rag:commands:hash` | chat memory — skips re-uploading unchanged commands | ✅ Active |

Upstash **Vector** (optional) holds three namespaces: `commands`, `guidelines` and `chat` (conversation chunks from channels with `ai--index on`).

### Chat memory and privacy

- Nothing is stored until someone with Manage Channels runs `ai--index on` in a channel. Only messages sent after that are remembered; older messages are never imported.
- Stored messages stay in Upstash Vector until `ai--index off`, which deletes everything stored for that channel and its threads. Edits and deletes in Discord are applied to what was stored.
- Public threads and forum posts follow their parent channel. **Private threads are never stored.**
- A reply can only quote past chat that everyone reading the reply could already see: memory from channels **@everyone** can view can come up anywhere, but memory from a restricted channel (e.g. `#mod-chat`) only comes up when someone asks in that same channel.
- Past chat is given to the AI as reference only, never as instructions.
| `photo:user:*`, `photo:server:*`, `photo:channel:*`, `photo:lb:*` | `m_photoloc` | ✅ Active |

---

## Deployment

This bot runs in a **Docker container** and is hosted on **Render** (cloud service).

- Base image: `node:26-slim`
- Container installs `ffmpeg`, `python3`, `make`, `g++` for audio processing and native module builds (see [Dockerfile](Dockerfile))
- Entry point: `node launch.js` (via `CMD` in the Dockerfile)
- Port: `3001` (VS Code/Render version)
- Keep-alive: Express server on `/` responds with `"wes is running!"`

To build and run the container locally:

```bash
docker build -t rag-like-discord-bot .
docker run --env-file .env -p 3001:3001 rag-like-discord-bot
```

> The Replit version uses port `3000`. Do not mix the two. (not working anymore)

> **Region note:** deploy to Render's **Oregon (US)** region. Singapore's shared outbound IP range was found to be rate-limited/blocked by Discord's gateway — the bot logged into Discord fine locally but its `client.login()` timed out consistently for 12+ hours from Singapore, with plain HTTPS to `discord.com` working normally the whole time. Switching region fixed it immediately.

---

## Reliability

A few fixes worth knowing about if something looks slow or crashes unexpectedly:

- **Redis/fetch timeouts** (Upstash calls, Tavily/NewsAPI/TMDB/RAWG/Gemini): if any of these stalls (network hiccup, slow API), the bot now fails fast (8–15s) and shows an error instead of hanging that command indefinitely.
- **try/catch gaps fixed** (photo tracker, `ai--g` guidelines): a failed Redis call in those paths now just logs an error instead of crashing and taking the whole bot offline.
- **Login retry-with-backoff**: if Discord login fails on boot, it retries a few times with backoff instead of hanging forever, and exits cleanly (so Render restarts it) if all attempts fail.

---

## Tests

```bash
npm test
```

Uses Node's built-in test runner with in-memory fakes for Redis, Upstash Vector, Gemini and Discord, so no keys or network are needed.

---

## Planned Changes

- [ ] Merge `m_extractor.js` onto the shared client once its privileged intents are confirmed enabled, to drop the second login/gateway connection
- [ ] Replace each module's own raw `messageCreate` listener with a shared command registry, so adding a new module doesn't mean re-writing prefix parsing

---

## Notes

- All persistent state (AI memory, rate limits, guidelines, photo stats) lives in Upstash Redis, so it survives Render redeploys — there's no local SQLite storage in the active codebase.
- Earlier experimental AI variants (`f_rag_efficient_v1`, `f_rag_location_v1`, and the archived `f_ai_bot*` files) were never loaded by `launch.js` and have been removed; `f_rag_quality_v1` is the only AI module.

---

## License

ISC
