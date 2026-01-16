require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Quick health endpoints (boot-safe)
app.get("/", (req, res) => res.send("ReplyPilot backend running"));
app.get("/status", (req, res) =>
  res.json({
    status: "ok",
    port: String(PORT),
    groqKey: !!process.env.GROQ_API_KEY,
    geminiKey: !!process.env.GEMINI_API_KEY,
  })
);

app.get("/__whoami", (req, res) => {
  res.json({
    ok: true,
    file: "backend/server.js",
    stamp: "boot-safe-20260116",
  });
});

// --- AI deps (safe require) ---
let Groq, GoogleGenerativeAI;
try { Groq = require("groq-sdk"); } catch {}
try { ({ GoogleGenerativeAI } = require("@google/generative-ai")); } catch {}

const cleanKey = (v) => (v ? String(v).trim().replace(/^bearer\s+/i, "") : "");
const GROQ_API_KEY = cleanKey(process.env.GROQ_API_KEY);
const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY);

const groq = Groq && GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const genAI = GoogleGenerativeAI && GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// --- helpers ---
const clean = (v) => (v ?? "").toString().trim();

function detectLanguage(text) {
  const t = String(text || "").toLowerCase();
  const markers = ["salamat","po","opo","mabilis","sana","ang","ng","kasi","meron","wala"];
  const hits = markers.filter(w => new RegExp(`\\b${w}\\b`, "i").test(t)).length;
  return hits >= 2 ? "taglish" : "english";
}

function normalizeLanguage(language, text) {
  const l = String(language || "auto").toLowerCase().trim();
  if (l === "english" || l === "taglish") return l;
  return detectLanguage(text);
}

function buildRules({ rating, tone, language }) {
  return `
You are ReplyPilot, a Shopee/Lazada seller assistant.
Reply to a ${rating}-star review.
Tone: ${tone}
Language: ${language}

Rules:
- 1–3 sentences only
- No prices, stock, shipping, COD, location
- Be polite, natural, Taglish if Filipino
`.trim();
}

function buildPrompt({ reviewText, productName, platform }) {
  return `
Platform: ${platform || "shopee"}
${productName ? `Product: ${productName}` : ""}

Customer review:
"${reviewText}"

Write a natural seller reply.
`.trim();
}

function polish(text, lang) {
  let s = clean(text)
    .replace(/\brecieve\b/gi,"receive")
    .replace(/\brecieved\b/gi,"received")
    .replace(/we appreciate your business\.?/gi,"Salamat po sa order ninyo!")
    .replace(/hope to serve you again soon\.?/gi,"Sana po makabalik kayo ulit!");
  if (lang === "taglish" && !/\bpo\b/i.test(s)) s += " Salamat po!";
  return s.trim();
}

// --- AI calls ---
async function groqReply(p) {
  if (!groq) throw new Error("GROQ_NOT_CONFIGURED");
  const c = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    temperature: 0.4,
    max_tokens: 220,
    messages: [
      { role: "system", content: buildRules(p) },
      { role: "user", content: buildPrompt(p) },
    ],
  });
  return c?.choices?.[0]?.message?.content || "";
}

async function geminiReply(p) {
  if (!genAI) throw new Error("GEMINI_NOT_CONFIGURED");
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    systemInstruction: buildRules({ ...p, language: "taglish" }),
  });
  const r = await model.generateContent(buildPrompt(p));
  return r?.response?.text?.() || "";
}

// --- REAL generate route (safe-mode OFF) ---
app.post("/api/generate-reply", async (req, res) => {
  try {
    const reviewText = clean(req.body?.reviewText);
    if (!reviewText) return res.status(400).json({ error: "reviewText required" });

    const lang = normalizeLanguage(req.body?.language, reviewText);

    const payload = {
      reviewText,
      productName: clean(req.body?.productName).slice(0, 60),
      platform: req.body?.platform || "shopee",
      rating: Number(req.body?.rating) || 5,
      tone: req.body?.tone || "friendly",
      language: lang,
    };

    let reply = "";
    let engine = "";

    if (lang === "taglish") {
      try {
        reply = await geminiReply(payload);
        engine = "gemini";
      } catch (e) {
        reply = await groqReply(payload);
        engine = "groq-fallback";
      }
    } else {
      reply = await groqReply(payload);
      engine = "groq";
    }

    if (!reply) return res.status(502).json({ error: "EMPTY_REPLY", engine });

    return res.json({ reply: polish(reply, lang), engine, language: lang });
  } catch (e) {
    return res.status(500).json({ error: "SERVER_ERROR", details: e.message });
  }
});


app.listen(PORT, () => console.log("ReplyPilot backend live on", PORT));

