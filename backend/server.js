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

  const modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const model = genAI.getGenerativeModel({ model: modelName });

  // IMPORTANT: rules are embedded in the prompt (no systemInstruction)
  const prompt = `
${buildRules({ ...p, language: "taglish" })}

${buildPrompt(p)}
`.trim();

  const r = await model.generateContent(prompt);
  return r.response.text();
}


app.post("/api/generate-reply", async (req, res) => {
  try {
    const text = (req.body.reviewText || "").toString().trim();
    if (!text) return res.status(400).json({ error: "reviewText required" });

    const langRaw = (req.body.language || "auto").toString().toLowerCase();
    const lang = (langRaw === "taglish" || langRaw === "english")
      ? langRaw
      : (/[ñ]|(\b(po|opo|salamat|mabilis|sana|ang|ng|kasi|wala|meron)\b)/i.test(text) ? "taglish" : "english");

    const payload = {
      reviewText: text,
      rating: req.body.rating || 5,
      tone: req.body.tone || "friendly",
      language: lang,
      platform: req.body.platform || "shopee",
      productName: (req.body.productName || "").toString().trim(),
    };

    let reply = "";
    let engine = "";

    // Taglish primary = Gemini, fallback = Groq
    if (lang === "taglish") {
      try {
        if (!genAI) throw new Error("GEMINI_NOT_CONFIGURED");
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.0-flash" });

        const prompt = `
You are ReplyPilot, a Shopee/Lazada seller assistant.
Write a short, natural Taglish reply to a ${payload.rating}-star review.

Rules:
- 1–3 sentences only
- No prices, stock, shipping, COD, location
- Sound like a real PH seller; polite but not OA
${payload.productName ? `- Mention product name naturally: ${payload.productName}` : ""}

Customer review:
"${payload.reviewText}"
`.trim();

        const r = await model.generateContent(prompt);
        reply = r.response.text();
        engine = "gemini";
      } catch (e) {
        console.log("GEMINI_ERROR:", e?.message || e);
        if (!groq) throw new Error("GROQ_NOT_CONFIGURED");
        const c = await groq.chat.completions.create({
          model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          temperature: 0.4,
          max_tokens: 200,
          messages: [
            { role: "system", content: "You are ReplyPilot. Write short, natural Taglish replies for Shopee/Lazada sellers. 1–3 sentences. No placeholders." },
            { role: "user", content: payload.reviewText }
          ],
        });
        reply = c.choices?.[0]?.message?.content || "";
        engine = "groq-fallback";
      }
    } else {
      // English primary = Groq
      if (!groq) throw new Error("GROQ_NOT_CONFIGURED");
      const c = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        temperature: 0.4,
        max_tokens: 200,
        messages: [
          { role: "system", content: "You are ReplyPilot. Write short, friendly English seller replies. 1–3 sentences. No placeholders." },
          { role: "user", content: payload.reviewText }
        ],
      });
      reply = c.choices?.[0]?.message?.content || "";
      engine = "groq";
    }

    reply = (reply || "").toString().trim();
    if (!reply) return res.status(500).json({ error: "AI_ERROR", details: "Empty reply", engine });

    // light clean-up
    if (lang === "taglish") {
      reply = reply
        .replace(/\brecieve\b/gi, "receive")
        .replace(/\brecieved\b/gi, "received")
        .replace(/\s+/g, " ")
        .trim();
      if (!/\bpo\b/i.test(reply)) reply += " Salamat po!";
    }

    res.json({ reply, engine, language: lang });
  } catch (e) {
    res.status(500).json({ error: "SERVER_ERROR", details: e.message });
  }
});


app.listen(PORT, () => console.log("ReplyPilot backend live on", PORT));



