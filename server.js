// server.js — ReplyPilot Beta Backend
// Hybrid Router: English -> Groq, Taglish -> Gemini, fallback -> Groq, last fallback -> template

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 4000;

// ---------- APP SETTINGS ----------
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- ENV CLEAN-UP ----------
const cleanKey = (v) => (v ? String(v).trim().replace(/^bearer\s+/i, "") : "");
const GROQ_API_KEY = cleanKey(process.env.GROQ_API_KEY);
const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY);

// ---------- AI CLIENTS ----------
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ---------- BETA CONFIG ----------
const DAILY_LIMIT = 15;

const ALLOWED_BETA_TESTERS = new Set([
  "tester_01",
  "tester_02",
  "tester_03",
  "tester_04",
  "tester_05",
  "tester_06",
  "tester_07",
  "tester_08",
  "tester_09",
  "tester_10",
  "tester_11",
  "tester_12",
  "tester_13",
  "tester_14",
  "tester_15",
  "tester_16",
  "tester_17",
  "tester_18",
  "tester_19",
  "tester_20",
]);

// ---------- SAFE RESPONSE HELPERS ----------
function ok(res, payload) {
  return res.status(200).json({ ok: true, ...payload });
}

function softFail(res, payload) {
  return res.status(200).json({ ok: false, ...payload });
}

// ---------- CIRCUIT BREAKER ----------
const breaker = {
  gemini: { downUntil: 0, fails: 0 },
  groq: { downUntil: 0, fails: 0 },
};

function isDown(name) {
  return Date.now() < (breaker[name]?.downUntil || 0);
}

function markOk(name) {
  breaker[name].fails = 0;
  breaker[name].downUntil = 0;
}

function markFail(name, cooldownMs) {
  breaker[name].fails = (breaker[name].fails || 0) + 1;
  breaker[name].downUntil = Date.now() + cooldownMs;
}

function isQuotaLikeError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  const code = err?.status || err?.code || err?.response?.status;

  return (
    code === 429 ||
    code === 403 ||
    msg.includes("quota") ||
    msg.includes("rate") ||
    msg.includes("too many") ||
    msg.includes("exceeded") ||
    msg.includes("billing")
  );
}

async function safeCall(providerName, fn) {
  if (isDown(providerName)) {
    const e = new Error(`${providerName} temporarily disabled by circuit breaker`);
    e._breaker = true;
    throw e;
  }

  try {
    const result = await fn();
    markOk(providerName);
    return result;
  } catch (err) {
    const quotaLike = isQuotaLikeError(err);
    markFail(providerName, quotaLike ? 30 * 60 * 1000 : 15 * 60 * 1000);
    throw err;
  }
}

// ---------- IN-MEMORY USAGE TRACKER ----------
let usageTracker = {};
let usageTrackerDate = getTodayKey();

function getTodayKey() {
  const now = new Date();
  const phTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Manila" }));

  return `${phTime.getFullYear()}-${String(phTime.getMonth() + 1).padStart(2, "0")}-${String(
    phTime.getDate()
  ).padStart(2, "0")}`;
}
function resetUsageIfNewDay() {
  const today = getTodayKey();
  if (usageTrackerDate !== today) {
    usageTracker = {};
    usageTrackerDate = today;
    console.log(`Usage tracker reset for new day: ${today}`);
  }
}

function normalizeUserId(userId) {
  return String(userId || "").trim().toLowerCase();
}

function getUsageInfo(userId) {
  const used = usageTracker[userId] || 0;
  const remaining = Math.max(0, DAILY_LIMIT - used);
  return {
    used,
    limit: DAILY_LIMIT,
    remaining,
    date: usageTrackerDate,
  };
}

// ---------- HELPERS ----------
function cleanText(v) {
  return (v ?? "").toString().trim();
}

function cleanProductName(v) {
  const s = cleanText(v);
  if (!s) return "";
  return s.replace(/\s+/g, " ").slice(0, 60);
}

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

function detectLanguage(text) {
  const t = String(text || "").toLowerCase();
  const tagalogMarkers = [
    "po", "opo", "salamat", "sana", "mabilis", "ang", "ng", "naman", "daw", "kasi",
    "okay", "ok", "paki", "magkano", "meron", "wala", "pa", "na", "din", "rin"
  ];
  const hits = tagalogMarkers.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(t)).length;
  return hits >= 2 ? "taglish" : "english";
}

function normalizeLanguage(language, reviewText) {
  const l = String(language || "auto").toLowerCase().trim();
  if (l === "english" || l === "taglish") return l;
  return detectLanguage(reviewText);
}

function fixCommonTypos(s) {
  if (!s) return s;
  return s
    .replace(/\brecieve\b/gi, "receive")
    .replace(/\brecieved\b/gi, "received")
    .replace(/\bthnaks\b/gi, "thanks");
}

function deCorporate(s, lang) {
  if (!s) return s;

  if (lang === "taglish") {
    return s
      .replace(/appreciate your business\.?/gi, "Salamat po sa order ninyo!")
      .replace(/we appreciate your business\.?/gi, "Salamat po sa order ninyo!")
      .replace(/we hope to serve you again soon\.?/gi, "Sana po makabalik kayo ulit!")
      .replace(/hope to serve you again soon\.?/gi, "Sana po makabalik kayo ulit!");
  }

  return s
    .replace(/we appreciate your business\.?/gi, "Thank you for your order!")
    .replace(/hope to serve you again soon\.?/gi, "We hope to serve you again again!");
}

function ensurePoliteTaglish(s, lang) {
  if (!s) return s;
  let out = s.trim();

  if (lang === "taglish" && !/\bpo\b|\bopo\b/i.test(out)) {
    if (/^salamat/i.test(out)) out = out.replace(/^salamat/i, "Salamat po");
    else out = `${out} Salamat po!`;
  }

  return out;
}

function keepShort(s) {
  if (!s) return s;
  const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, 3).join(" ").trim();
}

function polishReply(reply, lang) {
  let out = cleanText(reply);
  out = fixCommonTypos(out);
  out = deCorporate(out, lang);
  out = ensurePoliteTaglish(out, lang);
  out = keepShort(out);
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function buildSystemPrompt({ language, tone }) {
  const toneLine =
    tone === "professional"
      ? "Sound professional but still warm."
      : tone === "apology"
      ? "Sound apologetic, calm, and helpful."
      : tone === "cheerful"
      ? "Sound cheerful, upbeat, and friendly."
      : "Sound friendly, natural, and human.";

  const langLine =
    language === "taglish"
      ? "Write in natural Filipino seller Taglish used in the Philippines."
      : "Write in natural, simple English used by online sellers.";

  return `
You are ReplyPilot, an AI assistant for Shopee and Lazada sellers in the Philippines.
${toneLine}
${langLine}

Rules:
- Reply in 1 to 3 short sentences only.
- Sound human, warm, and realistic.
- Never sound overly corporate or robotic.
- Never invent details such as price, stock, warranty, shipping dates, COD, freebies, or location.
- If the customer is asking for missing info like stock, size, color, shipping, or availability, ask one short clarifying question instead of inventing an answer.
- If the review is positive, thank the customer naturally.
- If neutral, acknowledge and invite feedback.
- If negative, apologize briefly and invite them to message for help.
`.trim();
}

function buildUserPrompt({ reviewText, productName, rating, tone, language, platform }) {
  const productLine = productName ? `Product: ${productName}\n` : "";

  return `
Platform: ${platform || "shopee"}
Tone: ${tone}
Rating: ${rating} star(s)
Language: ${language}
${productLine}Customer review:
"${reviewText}"

Write a short seller reply.
`.trim();
}

function templateReply({ rating = 5, language = "english", productName = "" }) {
  const p = productName ? ` (${productName})` : "";
  const r = Number(rating) || 5;

  if (language === "taglish") {
    if (r >= 4) return `Salamat po sa feedback ninyo${p}! Masaya po kami na natuwa kayo. Sana po makabalik kayo ulit!`;
    if (r === 3) return `Salamat po sa feedback${p}. Puwede po ba namin malaman kung ano pa ang puwede naming i-improve?`;
    return `Pasensya na po sa abala${p}. Paki-message po kami para maayos namin agad at matulungan kayo.`;
  }

  if (r >= 4) return `Thank you so much for your feedback${p}! We truly appreciate your support.`;
  if (r === 3) return `Thanks for the feedback${p}. Could you share what we can improve to serve you better?`;
  return `We’re sorry about your experience${p}. Please message us so we can help and make this right.`;
}

// ---------- AI FUNCTIONS ----------
async function generateWithGemini({ reviewText, productName, rating, tone, language, platform }) {
  if (!genAI) throw new Error("Gemini API Key Missing");

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    systemInstruction: buildSystemPrompt({ rating, tone, language }),
  });

  const prompt = buildUserPrompt({
    reviewText,
    productName,
    rating,
    tone,
    language,
    platform,
  });

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  return String(text).trim();
}

async function generateWithGroq({ reviewText, productName, rating, tone, language, platform }) {
  if (!groq) throw new Error("Groq API Key Missing");

  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const system = buildSystemPrompt({ rating, tone, language });
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

// ---------- STATUS ROUTE ----------
app.get("/status", (req, res) => {
  return res.json({
    status: "ok",
    groqConfigured: !!groq,
    geminiConfigured: !!genAI,
    groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    port: String(PORT),
    usageDate: usageTrackerDate,
    breakers: {
      groq: breaker.groq,
      gemini: breaker.gemini,
    },
  });
});

// ---------- MAIN API ROUTE ----------
app.post("/api/generate-reply", async (req, res) => {
  try {
    resetUsageIfNewDay();

    const {
      reviewText,
      productName,
      rating,
      tone,
      language = "auto",
      platform = req.body?.platform || req.body?.marketplace || "shopee",
      userId,
    } = req.body || {};

    const text = cleanText(reviewText);
    if (!text) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        details: "reviewText is required",
      });
    }

    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        details: "userId is required",
      });
    }

    if (!ALLOWED_BETA_TESTERS.has(normalizedUserId)) {
      return res.status(403).json({
        error: "BETA_ACCESS_DENIED",
        details: "This tester account is not authorized for beta access.",
      });
    }

    const safeTone = normalizeTone(tone);
    const safeRating = normalizeRating(rating);
    const lang = normalizeLanguage(language, text);
    const safeProductName = cleanProductName(productName);

    const currentUsage = usageTracker[normalizedUserId] || 0;
    if (currentUsage >= DAILY_LIMIT) {
      return softFail(res, {
        message: "Beta limit reached for today. Please try again tomorrow.",
        error: "LIMIT_REACHED",
        usage: getUsageInfo(normalizedUserId),
      });
    }

    let reply = "";
    let engine = "";
    let fallbackUsed = false;

    if (lang === "taglish") {
      try {
        reply = await safeCall("gemini", async () => {
          return await generateWithGemini({
            reviewText: text,
            productName: safeProductName,
            rating: safeRating,
            tone: safeTone,
            language: "taglish",
            platform,
          });
        });
        engine = "gemini-primary";
      } catch (gemErr) {
        console.log("Gemini failed, switching to Groq fallback:", gemErr?.message || gemErr);

        try {
          reply = await safeCall("groq", async () => {
            return await generateWithGroq({
              reviewText: text,
              productName: safeProductName,
              rating: safeRating,
              tone: safeTone,
              language: "taglish",
              platform,
            });
          });
          engine = "groq-fallback";
          fallbackUsed = true;
        } catch (groqErr) {
          console.log("Groq fallback also failed, using template:", groqErr?.message || groqErr);
          reply = templateReply({
            rating: safeRating,
            language: "taglish",
            productName: safeProductName,
          });
          engine = "template";
          fallbackUsed = true;
        }
      }
    } else {
      try {
        reply = await safeCall("groq", async () => {
          return await generateWithGroq({
            reviewText: text,
            productName: safeProductName,
            rating: safeRating,
            tone: safeTone,
            language: "english",
            platform,
          });
        });
        engine = "groq-primary";
      } catch (groqErr) {
        console.log("Groq failed, using template:", groqErr?.message || groqErr);
        reply = templateReply({
          rating: safeRating,
          language: "english",
          productName: safeProductName,
        });
        engine = "template";
        fallbackUsed = true;
      }
    }

    if (!reply) {
      reply = templateReply({
        rating: safeRating,
        language: lang,
        productName: safeProductName,
      });
      engine = "template";
      fallbackUsed = true;
    }

    const finalReply = polishReply(reply, lang);

    usageTracker[normalizedUserId] = (usageTracker[normalizedUserId] || 0) + 1;
    const usage = getUsageInfo(normalizedUserId);

    console.log({
      testerId: normalizedUserId,
      engine,
      fallbackUsed,
      language: lang,
      platform,
      used: usage.used,
      remaining: usage.remaining,
    });

    return ok(res, {
      reply: finalReply,
      engine,
      fallbackUsed,
      language: lang,
      platform,
      usage,
    });
  } catch (err) {
    console.error("SERVER ERROR:", err?.message || err);

    return softFail(res, {
      message: "Beta capacity reached. Please try again later.",
      error: "SERVER_ERROR",
    });
  }
});

app.listen(PORT, () => {
  console.log(`
🚀 ReplyPilot Backend LIVE (Beta)
Local: http://localhost:${PORT}
English -> Groq
Taglish -> Gemini (fallback Groq)
Daily limit per tester: ${DAILY_LIMIT}
Allowed beta testers: ${ALLOWED_BETA_TESTERS.size}
  `);
});