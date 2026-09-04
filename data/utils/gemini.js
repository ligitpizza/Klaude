const fetch = require("node-fetch");
const { withTimeout } = require("./timeout.js");

const GEMINI_TIMEOUT_MS = 15000;
const FREE_MODELS = ["gemini-3.1-flash-lite", "gemini-3-flash-live"];

// Tries each model in FREE_MODELS in order, falling back to the next on a
// rate limit, error, or empty response. Shared by every module that needs
// a Gemini chat completion, so the fallback chain lives in one place.
async function askGemini(messages, { temperature = 0.7, maxTokens = 1500 } = {}) {
  for (const model of FREE_MODELS) {
    let response;
    try {
      response = await withTimeout(fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GOOGLE_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      }), GEMINI_TIMEOUT_MS, `Gemini (${model})`);
    } catch (err) {
      console.error(`Gemini request failed for ${model}:`, err.message);
      continue;
    }

    if (response.status === 429) { console.log(`Model ${model} rate limited, trying next...`); continue; }
    if (!response.ok) { const errText = await response.text(); console.error(`Model ${model} error ${response.status}:`, errText); continue; }

    const data = await response.json();
    if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
    console.log(`Model ${model} returned empty, trying next...`);
  }
  return null;
}

module.exports = { askGemini };
