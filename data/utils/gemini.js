const fetch = require("node-fetch");
const { withTimeout } = require("./timeout.js");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_TIMEOUT_MS = 15000;
const COOLDOWN_MS = 60000;

// Free-tier *text* models, tried in this order. Lighter models (usually higher
// free limits) come before heavier ones. Live / TTS / audio / embedding models
// don't work on the chat endpoint and must not go here.
// Override without a code change: GEMINI_MODELS=model-a,model-b
const DEFAULT_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.8-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-flash-lite",
];

function parseModelList(envValue) {
  const list = String(envValue ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_MODELS];
}

// Tries each model in order, falling back to the next on a rate limit, error,
// or empty response. A model that returned 429 or an error is skipped for
// 60 s (or its Retry-After), so a dead model doesn't add a 15 s timeout to
// every message. If every model is cooling down, all are tried anyway.
function createGemini({ fetchImpl, models, now = Date.now, timeoutMs = GEMINI_TIMEOUT_MS }) {
  const cooldownUntil = new Map();

  const coolDown = (model, ms = COOLDOWN_MS) => cooldownUntil.set(model, now() + ms);

  async function askGeminiWithModel(messages, { temperature = 0.7, maxTokens = 1500 } = {}) {
    const available = models.filter(m => (cooldownUntil.get(m) ?? 0) <= now());
    const order = available.length ? available : models;

    for (const model of order) {
      let response;
      try {
        response = await withTimeout(fetchImpl(GEMINI_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.GOOGLE_API_KEY}`,
          },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        }), timeoutMs, `Gemini (${model})`);
      } catch (err) {
        console.error(`Gemini request failed for ${model}:`, err.message);
        coolDown(model);
        continue;
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        coolDown(model, retryAfter > 0 ? retryAfter * 1000 : COOLDOWN_MS);
        console.log(`Model ${model} rate limited, trying next...`);
        continue;
      }
      if (!response.ok) {
        console.error(`Model ${model} error ${response.status}:`, await response.text());
        coolDown(model);
        continue;
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) return { text, model };
      console.log(`Model ${model} returned empty, trying next...`);
    }
    return null;
  }

  async function askGemini(messages, opts) {
    const result = await askGeminiWithModel(messages, opts);
    return result ? result.text : null;
  }

  return { askGemini, askGeminiWithModel };
}

const defaultGemini = createGemini({ fetchImpl: fetch, models: parseModelList(process.env.GEMINI_MODELS) });

module.exports = {
  askGemini: defaultGemini.askGemini,
  askGeminiWithModel: defaultGemini.askGeminiWithModel,
  createGemini,
  DEFAULT_MODELS,
  parseModelList,
};
