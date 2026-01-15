// server.js — Hybrid Router (English->Groq, Taglish->Gemini, Groq fallback)
// OpenAI intentionally OFF for now (can be added later as fallback cleaner)

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
  const t = String(tone || "").toLowerCase().trim();
  if (["friendly", "professional", "apology", "cheerful"].includes(t)) return t;
  return "friendly";
}

function normalizeRating(rating) {
  const r = Number(rating);
  if (Number.isFinite(r) && r >= 1 && r <= 5) return r;
  return 5;
}

function normalizeLanguage(language, reviewText) {
  const l = String(language || "auto").toLowerCase().trim();
  if (l === "english" || l === "taglish") return l;
  if (l === "auto") return detectLanguage(reviewText);
  return detectLanguage(reviewText);
}


function detectLanguage(text) {
  const t = String(text || "").toLowerCase();
  const tagalogMarkers = [
    "po",
    "opo",
    "salamat",
    "sana",
    "mabilis",
    "ang",
    "ng",
    "naman",
    "daw",
    "kasi",
    "okay",
    "ok",
    "paki",
    "magkano",
    "meron",
    "wala",
    "pa",
    "na",
    "din",
    "rin",
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

// ---------- Reply cleanup + product helpers ----------
function cleanText(v) {
  return (v ?? "").toString().trim();
}

function cleanProductName(v) {
  const s = cleanText(v);
  if (!s) return "";
  return s.replace(/\s+/g, " ").slice(0, 60);
}

function fixCommonTypos(s) {
  if (!s) return s;
  return s
    .replace(/\brecieve\b/gi, "receive")
    .replace(/\brecieved\b/gi, "received")
    .replace(/\bthnaks\b/gi, "thanks");
}

function deCorporate(s) {
  if (!s) return s;
  return s
    .replace(/appreciate your business\.?/gi, "Salamat po sa order ninyo!")
    .replace(/we appreciate your business\.?/gi, "Salamat po sa order ninyo!")
    .replace(/we hope to serve you again soon\.?/gi, "Sana po makabalik kayo ulit!")
    .replace(/hope to serve you again soon\.?/gi, "Sana po makabalik kayo ulit!");
}

function ensurePoliteTaglish(s, lang) {
  if (!s) return s;
  let out = s.trim();
  if (lang === "taglish" && !/\bpo\b/i.test(out)) {
    if (/^salamat/i.test(out)) out = out.replace(/^Salamat/i, "Salamat po");
    else out = out + " Salamat po!";
  }
  return out;
}

function keepShort(s) {
  if (!s) return s;
  // Soft trim to ~3 sentences max
  const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, 3).join(" ").trim();
}

function polishReply(reply, lang) {
  let out = cleanText(reply);
  out = fixCommonTypos(out);
  out = deCorporate(out);
  out = ensurePoliteTaglish(out, lang);
  out = keepShort(out);
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function buildUserPrompt({ reviewText, productName, rating, tone, language, platform }) {
  const productLine = productName ? `Product: "${productName}"\n` : "";
  return `
Platform: ${platform || "shopee"}
Tone: ${tone}
Rating: ${rating} star(s)
Language: ${language}
${productLine}Customer review:
"${reviewText}"

Write a SHORT seller reply that sounds like a real Shopee/Lazada seller in the Philippines.
Rules:
- 1–3 sentences only.
- Natural Taglish (not corporate English).
- Polite (use "po/opo" naturally if Taglish).
- If product is provided, you MAY mention it once naturally (no extra specs).
- NEVER add fake details (price, stock, freebies, warranty, delivery date, COD, location, variants).
- If the message asks for missing info (price/stock/size/location/shipping/COD), ask ONE short clarifying question instead.
`.trim();
}

// ---------- AI Functions ----------
async function generateWithGemini({ reviewText, rating, tone, productName, platform }) {
  if (!genAI) throw new Error("Gemini API Key Missing");

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    systemInstruction: buildRules({ rating, tone, language: "taglish" }),
  });

  const prompt = buildUserPrompt({
    reviewText,
    productName,
    rating,
    tone,
    language: "taglish",
    platform,
  });

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  return String(text).trim();
}

async function generateWithGroq({ reviewText, rating, tone, language, productName, platform }) {
  if (!groq) throw new Error("Groq API Key Missing");

  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const system = buildRules({ rating, tone, language });

  const userPrompt = buildUserPrompt({
    reviewText,
    productName,
    rating,
    tone,
    language,
    platform,
  });

  const completion = await groq.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 220,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
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
      productName, // ✅ optional
      rating,
      tone,
      language = "auto", // "english" | "taglish" | "auto"
      userId = "user_v18_launch",
    } = req.body || {};

    // accept either "platform" or legacy "marketplace" from frontend
    const platform = req.body?.platform || req.body?.marketplace || "shopee";

    const text = cleanText(reviewText);
    if (!text) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        details: "reviewText is required",
      });
    }

    const safeTone = normalizeTone(tone);
    const safeRating = normalizeRating(rating);
    const lang = normalizeLanguage(language, text);
    const safeProductName = cleanProductName(productName);

    // usage limit (testing)
    if (!usageTracker[userId]) usageTracker[userId] = 0;
    if (usageTracker[userId] >= 100) return res.status(403).json({ error: "LIMIT_REACHED" });

    let reply = "";
    let engine = "";

    // Routing:
    // - Taglish -> Gemini primary, Groq fallback
    // - English -> Groq primary
    if (lang === "taglish") {
      try {
        reply = await generateWithGemini({
          reviewText: text,
          rating: safeRating,
          tone: safeTone,
          productName: safeProductName,
          platform,
        });
        engine = "gemini-primary";
      } catch (gemErr) {
        console.log("Gemini failed, switching to Groq fallback:", gemErr?.message || gemErr);
        reply = await generateWithGroq({
          reviewText: text,
          rating: safeRating,
          tone: safeTone,
          language: "taglish",
          productName: safeProductName,
          platform,
        });
        engine = "groq-fallback";
      }
    } else {
      reply = await generateWithGroq({
        reviewText: text,
        rating: safeRating,
        tone: safeTone,
        language: "english",
        productName: safeProductName,
        platform,
      });
      engine = "groq-primary";
    }

    usageTracker[userId]++;

    // final safety: ensure reply is not empty
    if (!reply) {
      return res.status(500).json({
        error: "AI_ERROR",
        details: "Empty reply from engine",
        engine,
      });
    }

    const finalReply = polishReply(reply, lang);

    res.json({
      reply: finalReply,
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
