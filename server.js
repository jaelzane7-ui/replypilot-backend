// server.js — Hybrid Router + Fallback (Production, hardened)

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const Groq = require("groq-sdk");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 4000;

// ---------- Helpers ----------
function cleanKey(v) {
  if (!v) return "";
  let s = String(v).trim();
  // If someone pasted "Bearer sk-..." into Render, fix it:
  if (s.toLowerCase().startsWith("bearer ")) s = s.slice(7).trim();
  return s;
}

function cleanEnv(v, fallback = "") {
  return (v ? String(v).trim() : fallback);
}

// ---------- ENV (cleaned) ----------
const GROQ_API_KEY = cleanKey(process.env.GROQ_API_KEY);
const OPENAI_API_KEY = cleanKey(process.env.OPENAI_API_KEY);

const GROQ_MODEL = cleanEnv(process.env.GROQ_MODEL, "llama-3.1-70b-versatile");

// IMPORTANT: default to gpt-4.1-mini (matches your local env & usually enabled)
const OPENAI_TAGLISH_MODEL = cleanEnv(process.env.OPENAI_TAGLISH_MODEL, "gpt-4o-mini");
const OPENAI_FALLBACK_MODEL = cleanEnv(process.env.OPENAI_FALLBACK_MODEL, "gpt-4o-mini");

// ---------- Clients ----------
const groq = new Groq({ apiKey: GROQ_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Utilities ----------
function looksLikeBadTaglish(text = "") {
  const englishWords =
    (text.match(/\b(the|and|is|are|with|for|this|that)\b/gi) || []).length;
  const filipinoWords =
    (text.match(/\b(po|opo|salamat|sige|pwede|na|pa)\b/gi) || []).length;

  return englishWords > 6 && filipinoWords < 2;
}

// ---------- OpenAI Taglish Generator ----------
async function generateTaglishWithOpenAI(reviewText) {
  const completion = await openai.chat.completions.create({
    model: OPENAI_TAGLISH_MODEL,
    temperature: 0.4,
    max_tokens: 220,
    messages: [
      {
        role: "system",
        content: `
You are ReplyPilot, a helpful seller assistant for Philippine online marketplaces such as Shopee, Lazada, and Facebook Marketplace.

Write short, friendly, natural Taglish replies that sound human and polite.

STRICT RULES:
- 1–3 sentences only.
- NEVER use placeholders like "[insert price]", "(price here)", or brackets of any kind.
- NEVER guess prices, stock status, delivery options, or availability.
- If the customer asks for price, stock, variant, size, location, shipping, or COD AND the information is not provided, ask ONE short clarifying question instead.
- Use natural Taglish (mix English and Filipino naturally).
- Use polite markers like "po" and "opo" when appropriate.
- Avoid deep or formal Filipino words.
- Do NOT sound robotic or translated.
- No emojis.
- No hashtags.
- Do not mention AI, policies, or internal steps.

Output ONLY the seller reply text.
        `.trim(),
      },
      {
        role: "user",
        content: `
Customer message:
"${reviewText}"

Write the best seller reply.
        `.trim(),
      },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || "";
}

// ---------- Groq English Generator ----------
async function generateEnglishWithGroq(reviewText) {
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    temperature: 0.4,
    max_tokens: 220,
    messages: [
      {
        role: "system",
        content: `
You are ReplyPilot, an AI assistant that writes clear, friendly, professional English replies for online sellers.
Keep replies short (2–4 sentences), polite, and helpful.
        `.trim(),
      },
      {
        role: "user",
        content: `
Customer review:
"${reviewText}"

Write a seller reply.
        `.trim(),
      },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || "";
}

// ---------- OpenAI Fallback Cleaner ----------
async function cleanWithOpenAI(rawText) {
  const completion = await openai.chat.completions.create({
    model: OPENAI_FALLBACK_MODEL,
    temperature: 0.3,
    max_tokens: 220,
    messages: [
      {
        role: "system",
        content: `
You are a language refiner.
Clean and fix the reply below so it becomes natural Taglish suitable for a Filipino online seller.
Do not add new information.
Output ONLY the cleaned reply text.
        `.trim(),
      },
      { role: "user", content: rawText },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || rawText;
}

// ---------- API ----------
app.post("/api/generate-reply", async (req, res) => {
  try {
    const { reviewText, language } = req.body;

    if (!reviewText) {
      return res.status(400).json({ error: "Missing reviewText" });
    }

    const lang = (language || "").toLowerCase().trim();

    // Router: Taglish/Filipino/Tagalog => OpenAI direct
    if (lang === "taglish" || lang === "filipino" || lang === "tagalog") {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({ error: "OpenAI key not configured on server." });
      }
      const reply = await generateTaglishWithOpenAI(reviewText);
      return res.json({ reply, engine: "openai-direct" });
    }

    // English path => Groq
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "Groq key not configured on server." });
    }

    let reply = await generateEnglishWithGroq(reviewText);

    // Fallback cleanup if output looks wrong
    if (looksLikeBadTaglish(reply) && OPENAI_API_KEY) {
      const cleaned = await cleanWithOpenAI(reply);
      return res.json({ reply: cleaned, engine: "groq+openai-fallback" });
    }

    return res.json({ reply, engine: "groq" });
  } catch (err) {
    // Helpful server-side log (no secrets)
    console.error("Generate error:", {
      message: err?.message,
      name: err?.name,
      status: err?.status,
      code: err?.code,
      type: err?.type,
    });
    res.status(500).json({ error: "Failed to generate reply" });
  }
});

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    port: PORT,
    groqConfigured: !!GROQ_API_KEY,
    openaiConfigured: !!OPENAI_API_KEY,
    groqModel: GROQ_MODEL,
    openaiTaglishModel: OPENAI_TAGLISH_MODEL,
    openaiFallbackModel: OPENAI_FALLBACK_MODEL,
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`ReplyPilot backend running on port ${PORT}`);
});
