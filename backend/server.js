require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- ENV Clean ----------
const cleanKey = (v) => (v ? String(v).trim().replace(/^bearer\s+/i, "") : "");
const GROQ_API_KEY = cleanKey(process.env.GROQ_API_KEY);
const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY);

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const usageTracker = {};

// ---------------- Helpers ----------------
const clean = (v) => (v ?? "").toString().trim();

function detectLanguage(text) {
  const t = text.toLowerCase();
  const markers = ["salamat","po","opo","mabilis","sana","ang","ng","kasi","meron","wala"];
  const hits = markers.filter(w => new RegExp(`\\b${w}\\b`).test(t)).length;
  return hits >= 2 ? "taglish" : "english";
}

function normalizeLanguage(language, text) {
  const l = (language || "auto").toLowerCase();
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
Platform: ${platform}
${productName ? `Product: ${productName}` : ""}

Customer review:
"${reviewText}"

Write a natural seller reply.
`.trim();
}

function polish(text, lang) {
  let s = text
    .replace(/\brecieve\b/gi,"receive")
    .replace(/\brecieved\b/gi,"received")
    .replace(/we appreciate your business\.?/gi,"Salamat po sa order ninyo!")
    .replace(/hope to serve you again soon\.?/gi,"Sana po makabalik kayo ulit!");
  if (lang === "taglish" && !/\bpo\b/i.test(s)) s += " Salamat po!";
  return s.trim();
}

// ---------------- AI ----------------
async function groqReply(p) {
  const c = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0.4,
    max_tokens: 200,
    messages: [
      { role: "system", content: buildRules(p) },
      { role: "user", content: buildPrompt(p) },
    ],
  });
  return c.choices[0].message.content;
}

async function geminiReply(p) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: buildRules({ ...p, language: "taglish" }),
  });
  const r = await model.generateContent(buildPrompt(p));
  return r.response.text();
}

// ---------------- Routes ----------------
app.get("/", (req,res)=>res.send("ReplyPilot backend running"));
app.get("/status",(req,res)=>res.json({
  status:"ok",
  groq:!!groq,
  gemini:!!genAI
}));

app.post("/api/generate-reply", async (req,res)=>{
  try{
    const text = clean(req.body.reviewText);
    if(!text) return res.status(400).json({error:"reviewText required"});

    const lang = normalizeLanguage(req.body.language, text);
    const data = {
      reviewText:text,
      productName:clean(req.body.productName),
      platform:req.body.platform || "shopee",
      rating:req.body.rating || 5,
      tone:req.body.tone || "friendly",
      language:lang
    };

    let reply;
    let engine;

    if(lang==="taglish"){
      try{
        reply = await geminiReply(data);
        engine="gemini";
      }catch{
        reply = await groqReply(data);
        engine="groq-fallback";
      }
    }else{
      reply = await groqReply(data);
      engine="groq";
    }

    res.json({
      reply: polish(reply, lang),
      engine,
      language: lang
    });

  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.listen(PORT, ()=>console.log("ReplyPilot backend live on",PORT));
