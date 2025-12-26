// server.js — Hybrid Router + Fallback (Production)

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const Groq = require("groq-sdk");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 4000;

// ---- Clients ----
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---- Middleware ----
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- Utilities ----
function looksLikeBadTaglish(text = "") {
  const englishWords = (text.match(/\b(the|and|is|are|with|for|this|that)\b/gi) || []).length;
  const filipinoWords = (text.match(/\b(po|opo|salamat|sige|pwede|na|pa)\b/gi) || []).length;

  // Red flag: heavy English + almost no Filipino markers
  return englishWords > 6 && filipinoWords < 2;
}

// ---- OpenAI Taglish Generator ----
async function generateTaglishWithOpenAI(reviewText) {
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_TAGLISH_MODEL,
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

  return completion.choices[0].message.content.trim();
}

// ---- Groq English Generator ----
async function generateEnglishWithGroq(reviewText) {
  const completion = await groq.chat.completions.create({
    model: "llama-3.1-70b-versatile",
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

  return completion.choices[0].message.content.trim();
}

// ---- OpenAI Fallback Cleaner ----
async function cleanWithOpenAI(rawText) {
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_FALLBACK_MODEL,
    temperature: 0.3,
    max_tokens: 220,
    messages: [
      {
        role: "system",
        content: `
You are a language refiner.
Clean and fix the reply below so it becomes natural Taglish suitable for a Filipino online seller.
Do not add new information.
        `.trim(),
      },
      {
        role: "user",
        content: rawText,
      },
    ],
  });

  return completion.choices[0].message.content.trim();
}

// ---- API ----
app.post("/api/generate-reply", async (req, res) => {
  try {
    const { reviewText, language } = req.body;

    if (!reviewText) {
      return res.status(400).json({ error: "Missing reviewText" });
    }

    // ---- ROUTER ----
    if (language === "taglish" || language === "filipino" || language === "tagalog") {
      const reply = await generateTaglishWithOpenAI(reviewText);
      return res.json({ reply, engine: "openai-direct" });
    }

    // ---- ENGLISH PATH ----
    let reply = await generateEnglishWithGroq(reviewText);

    // ---- FALLBACK CHECK ----
    if (looksLikeBadTaglish(reply)) {
      const cleaned = await cleanWithOpenAI(reply);
      return res.json({ reply: cleaned, engine: "groq+openai-fallback" });
    }

    return res.json({ reply, engine: "groq" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate reply" });
  }
});

// ---- Health ----
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    groq: !!process.env.GROQ_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
  });
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`ReplyPilot backend running on port ${PORT}`);
});
