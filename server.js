// server.js — Hybrid Router (English->Groq, Taglish->Gemini, Groq fallback)
// OpenAI intentionally OFF for now (can be added later as fallback)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 4000;

// ---------- ENV Clean-up ----------
const cleanKey = (v) => (v ? String(v).trim().replace(/^bearer\s+/i, "") : "");
const GROQ_API_KEY = cleanKey(process.env.GROQ_API_KEY);
const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY);

// ---------- AI Clients ----------
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// In-memory usage tracker (resets on restart; ok for testing)
const usageTracker = {};

// ---------- Helpers ----------
function normalizeTone(tone) {
  const t = String(tone || "").toLowerCase();
  if (["friendly", "professional", "apology", "cheerful"].includes(t)) return t;
  return "friendly";
}
function normalizeRating(rating) {
  const r = Number(rating);
  if (Number.isFinite(r) && r >= 1 && r <= 5) return r;
  return 5;
}
function normalizeLanguage(language, reviewText) {
  // language can be "english", "taglish", "auto"
  const l = String(language || "auto").toLowerCase().trim();
  if (l === "english" || l === "taglish" || l === "auto") return l;

  // fallback: detect if language param is missing/unknown
  return detectLanguage(reviewText);
}
function detectLanguage(text) {
  const t = String(text || "").toLowerCase();
  const tagalogMarkers = [
    "po", "opo", "salamat", "sana", "mabilis", "ang", "ng", "naman", "daw", "kasi",
    "okay", "ok", "paki", "magkano", "meron", "wala", "pa", "na", "din", "rin"
  ];
  const hits = tagalogMarkers.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(t)).length;
  return hits >= 2 ? "taglish" : "english";
}

function buildRules({ rating, tone, language }) {
  // Strict rules to prevent hallucination/placeholder issues
  return `
You are ReplyPilot, a seller assistant for Shopee/Lazada/FB Marketplace.

Write a short reply to a ${rating}-star review. Tone: ${tone}.
Language: ${language}.

STRICT RULES:
- 1–3 sentences only.
- NEVER use placeholders like "[...]", "(...)", "{...}" or angle brackets.
- NEVER guess price, stock, shipping, COD, location, variants, or delivery time.
- If the review asks about price/stock/shipping/COD/location/variants and info is missing: ask ONE short clarifying question instead.
- Be polite and human. Use "po/opo" naturally if Taglish.
`.trim();
}

// ---------- AI Functions ----------
async function generateWithGemini({ reviewText, rating, tone }) {
  if (!genAI) throw new Error("Gemini API Key Missing");

  // Gemini model name can change; "gemini-2.0-flash" is what you set
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    systemInstruction: buildRules({ rating, tone, language: "taglish" }),
  });

  const result = await model.generateContent(String(reviewText));
  const text = result?.response?.text?.() || "";
  return String(text).trim();
}

async function generateWithGroq({ reviewText, rating, tone, language }) {
  if (!groq) throw new Error("Groq API Key Missing");

  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const system = buildRules({ rating, tone, language });

  const completion = await groq.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 220,
    messages: [
      { role: "system", content: system },
      { role: "user", content: String(reviewText) },
    ],
  });

  return completion?.choices?.[0]?.message?.content?.trim() || "";
}

// ---------- Status Route ----------
app.get("/status", (req, res) => {
  res.json({
    status: "ok",
    groqConfigured: !!groq,
    geminiConfigured: !!genAI,
    groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    port: String(PORT),
  });
});

// ---------- Main API Route ----------
app.post("/api/generate-reply", async (req, res) => {
  try {
    const {
      reviewText,
      rating,
      tone,
      language = "auto",     // "english" | "taglish" | "auto"
      platform = "shopee",   // optional
      userId = "user_v18_launch",
    } = req.body || {};

    const text = String(reviewText || "").trim();
    if (!text) return res.status(400).json({ error: "BAD_REQUEST", details: "reviewText is required" });

    const safeTone = normalizeTone(tone);
    const safeRating = normalizeRating(rating);
    const lang = normalizeLanguage(language, text);

    // usage limit (testing)
    if (!usageTracker[userId]) usageTracker[userId] = 0;
    if (usageTracker[userId] >= 100) return res.status(403).json({ error: "LIMIT_REACHED" });

    let reply = "";
    let engine = "";

    // Routing:
    // - Taglish -> Gemini primary, Groq fallback
    // - English -> Groq primary (no need to hit Gemini)
    if (lang === "taglish") {
      try {
        reply = await generateWithGemini({ reviewText: text, rating: safeRating, tone: safeTone });
        engine = "gemini-primary";
      } catch (gemErr) {
        console.log("Gemini failed, switching to Groq fallback:", gemErr?.message || gemErr);
        reply = await generateWithGroq({ reviewText: text, rating: safeRating, tone: safeTone, language: "taglish" });
        engine = "groq-fallback";
      }
    } else {
      // english
      reply = await generateWithGroq({ reviewText: text, rating: safeRating, tone: safeTone, language: "english" });
      engine = "groq-primary";
    }

    usageTracker[userId]++;

    // final safety: ensure reply is not empty
    if (!reply) {
      return res.status(500).json({ error: "AI_ERROR", details: "Empty reply from engine", engine });
    }

    res.json({
      reply,
      engine,
      language: lang,
      platform,
      usageCount: usageTracker[userId],
    });
  } catch (err) {
    res.status(500).json({ error: "SERVER_ERROR", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 ReplyPilot Backend LIVE (Hybrid Router)
- Local: http://localhost:${PORT}
- English -> Groq
- Taglish -> Gemini (fallback Groq)
`);
});
