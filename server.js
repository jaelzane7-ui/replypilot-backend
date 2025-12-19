// server.js - v0.8 Hybrid (Groq + Optional OpenAI)

require("dotenv").config();
const express = require("express");
const cors = require("cors");

// ----- Groq Client -----
const Groq = require("groq-sdk");
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ----- OpenAI Client (optional) -----
let openai = null;
if (process.env.OPENAI_API_KEY) {
  const OpenAI = require("openai");
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

const app = express();
const PORT = process.env.PORT || 4000;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Utility: Prompts for Languages ----------

// Keep your existing helper (still useful for one specific awkward phrase)
function normalizeStrictTagalogPoliteness(text) {
  if (!text || typeof text !== "string") return text;

  const replacements = [
    {
      // Fix: "malugod naming tinatanggap kayo"
      pattern: /malugod naming tinatanggap kayo/gi,
      replacement: "malugod po naming kayong tinatanggap",
    },
    {
      // Fix common variant without "malugod"
      pattern: /naming tinatanggap kayo/gi,
      replacement: "po naming kayong tinatanggap",
    },
  ];

  let normalized = text;
  for (const r of replacements) {
    normalized = normalized.replace(r.pattern, r.replacement);
  }

  return normalized;
}

function normalizeTaglish(text) {
  if (!text || typeof text !== "string") return text;

  return text
    // Fix awkward literal Tagalog
    .replace(/pagkuha ng oras na magbigay ng puna/gi, "feedback n'yo")
    .replace(/pagbigay ng inyong pagbalik/gi, "feedback n'yo")
    .replace(/pagbigay ng inyong komento/gi, "comment n'yo")
    // Normalize opening
    .replace(/^Salamat\s+/i, "Salamat po ")
    .replace(/^Salamat po sa feedback n'yo!/i, "Salamat po sa feedback n'yo!");
}

// ✅ tiny "po" de-duper (final cleanup)
function dedupePo(text) {
  if (!text || typeof text !== "string") return text;

  return text
    .replace(/\bpo\s+po\b/gi, "po")
    .replace(/\b(po\s+){2,}/gi, "po ");
}

// ✅ NEW: Limit output to avoid long/essay replies
function trimToMaxSentences(text, maxSentences = 3) {
  if (!text || typeof text !== "string") return text;
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.slice(0, maxSentences).join(" ").trim();
}

// ✅ NEW: Make Filipino sound like real marketplace sellers (not formal textbook Tagalog)
function normalizeFilipinoSellerTone(text) {
  if (!text || typeof text !== "string") return text;

  let t = text.trim();

  // Remove very formal / letter-like phrases
  t = t.replace(/\bLubos na gumagalang\b.*$/i, "").trim();

  // Replace stiff words/phrases with natural marketplace phrasing
  const replacements = [
    [/\bpuna\b/gi, "review"],
    [/\bkomento\b/gi, "review"],
    [/\bikinagagalak\b/gi, "Masaya po kami"],
    [/\bnatutuwa kami\b/gi, "Masaya po kami"],
    [/\bnatutuwa\b/gi, "Masaya po"],
    [/\baming tindahan\b/gi, "shop namin"],
    [/\bmga produkto\b/gi, "products"],
    [/\bpaghatid\b/gi, "delivery"],
    [/\bpaghahatid\b/gi, "delivery"],
    [/\bpagbabalik ng bayad\b/gi, "refund"],
    [/\bkapalit\b/gi, "replacement"],
    [/\bmalugod po naming kayong tinatanggap\b/gi, "welcome po kayo"],
  ];

  for (const [pattern, replacement] of replacements) {
    t = t.replace(pattern, replacement);
  }

  // Prevent double "po"
  t = dedupePo(t);

  // Ensure it ends cleanly
  if (t && !/[.!?]$/.test(t)) t += ".";

  return t;
}

// ---------- Language prompts ----------
function normalizeLanguage(raw) {
  const v = String(raw || "").trim().toLowerCase();

  const map = {
    en: "english",
    eng: "english",
    english: "english",

    tl: "filipino",
    fil: "filipino",
    filipino: "filipino",
    tagalog: "filipino",

    taglish: "taglish",

    auto: "auto",
  };

  return map[v] || "english";
}

function getLanguagePrompts(language) {
  const lang = normalizeLanguage(language);

  // ✅ UPDATED: Filipino prompt = natural marketplace Filipino (NOT strict Tagalog-only essay style)
  if (lang === "filipino") {
    return {
      system: `
Ikaw ay AI assistant para sa mga online seller sa Pilipinas (Shopee/Lazada).
Gumawa ng MAIKLI, MAGALANG, at NATURAL na sagot na parang totoong seller.

PANUNTUNAN (Filipino):
- Gumamit ng natural na Filipino na ginagamit sa marketplace.
- Iwasan ang sobrang pormal o malalim na salita (hal. "puna", "naikumpara", "ikinagagalak").
- Maiksi lang: 2–3 pangungusap.
- Laging magpasalamat.
- Kung may reklamo, mag-sorry at mag-alok ng tulong (replacement/refund) nang magalang.
- Pwede ang common marketplace words kung mas natural (review, item, shop, order, delivery, refund).
- Huwag gawing parang essay o formal letter.
      `.trim(),

      examples: `
[Preferred Filipino style – Positive]
Review: "Ang ganda ng tuwalya at mabilis dumating."
Reply: "Maraming salamat po sa review! Masaya po kami na nagustuhan ninyo ang tuwalya at mabilis dumating. Sana po ay makabili ulit kayo sa shop namin—salamat po! 😊"

[Preferred Filipino style – Complaint]
Review: "May sira yung dumating."
Reply: "Pasensya na po sa abala. Paki-message po kami para maasikaso namin agad ang replacement o refund. Salamat po sa pagpaalam. 🙏"

[Too formal – avoid]
"Maraming salamat sa magandang puna! Ikinagagalak namin..."
      `.trim(),
    };
  }

  if (lang === "taglish") {
    return {
      system: `
Ikaw ay AI assistant para sa online seller. Gumamit ng Taglish: halo ng Tagalog at English,
pero natural at pang-araw-araw na pananalita sa Pilipinas.

PANUNTUNAN:
- Gumamit ng natural na Taglish, gaya ng karaniwang sagot ng online sellers sa Pilipinas.
- Ang unang pangungusap ay dapat natural at conversational, tulad ng:
  "Salamat po sa feedback n'yo!"
  "Thanks po sa comment n'yo!"
  "Salamat po sa message n'yo!"
- Iwasan ang masyadong pormal o literal na Tagalog gaya ng:
  "pagkuha ng oras na magbigay ng puna"
- Huwag gumamit ng malalim o literal na Tagalog na parang salin-wika.
- Iwasan ang awkward na parirala gaya ng "pagbigay ng inyong pagbalik".
- Panatilihing maikli: 2–4 pangungusap.
- Kung may reklamo (late delivery), mag-sorry, mag-explain lightly, at mag-assure ng improvement.
      `.trim(),

      examples: `
[Halimbawa – Late delivery]
Review: "Okay yung item pero medyo late dumating."
Reply: "Salamat po sa feedback n'yo! Pasensya na po kung na-delay ang dating ng parcel—minsan po may aberya sa courier. Gagawin po namin ang best namin para mas mabilis sa susunod. 😊"
      `.trim(),
    };
  }

  // Default: English
  return {
    system: `
You are a helpful AI assistant for online sellers.
Your job is to write SHORT, polite, and friendly customer-service replies
to reviews in clear, conversational English.

Rules:
- Be brief: 2–4 sentences only.
- Keep the total length under 45 words.
- Always thank the customer.
- If the review is negative, politely apologize and offer help.
- Reply only in English (do not use Tagalog/Filipino words).
    `.trim(),

    examples: `
Examples:

[Example 1 – Positive]
Review: "Item arrived quickly and was well packed."
Reply: "Thank you so much for your positive feedback! We're glad to hear your order arrived quickly and in good condition. We appreciate your support and hope to serve you again soon. 😊"

[Example 2 – Negative]
Review: "The product was damaged when it arrived."
Reply: "We're very sorry to hear that your item arrived damaged. Please send us a message so we can help arrange a replacement or refund for you as soon as possible. Thank you for letting us know."

[Example 3 – Neutral]
Review: "The product is okay, nothing special."
Reply: "Thank you for taking the time to share your feedback. We appreciate your honesty and will use your comments to keep improving our products and service. 😊"
    `.trim(),
  };
}

// ---------- Utility: choose which provider to use ----------
function shouldUseOpenAI(language) {
  if (!openai) return false; // no key, can't use OpenAI
  const lang = normalizeLanguage(language);

  // Hybrid logic: prefer OpenAI for Filipino/Taglish if available
  if (lang === "filipino" || lang === "taglish") return true;

  // English & others → keep using Groq for now
  return false;
}

function fallbackMessage(lang) {
  if (lang === "filipino") {
    return "Pasensya na po, nagkaroon ng problema sa pag-generate ng sagot. Paki-try po ulit mamaya.";
  }
  if (lang === "taglish") {
    return "Sorry po—nagka-problem sa pag-generate ng reply. Please try again later.";
  }
  return "Sorry—there was a problem generating the reply. Please try again later.";
}

// ---------- Language guard helpers ----------
function looksLikeFilipino(text = "") {
  const t = text.toLowerCase();
  const markers = [
    " po",
    " salamat",
    " pasensya",
    " paumanhin",
    " namin",
    " inyong",
    " kayo",
    " kami",
    " muli",
    " paghatid",
    " paghahatid",
  ];

  const hits = markers.filter((w) => t.includes(w)).length;
  return hits >= 2; // threshold
}

async function groqRewriteToEnglish(originalReply, reviewText) {
  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";

  const completion = await groq.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 220,
    messages: [
      {
        role: "system",
        content:
          "You are a strict rewriter. Output English ONLY. Keep it short (2–4 sentences), polite, and professional.",
      },
      {
        role: "user",
        content: `
Customer review:
"${reviewText}"

Rewrite the reply below into English ONLY.
Do not include any Filipino/Tagalog words.

Reply to rewrite:
"${originalReply}"
        `.trim(),
      },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || originalReply;
}

// ---------- Core: Generate reply with Groq ----------
async function generateWithGroq({ reviewText, language }) {
  const lang = normalizeLanguage(language);
  const { system, examples } = getLanguagePrompts(lang);

  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";

  const completion = await groq.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 220,
    messages: [
      { role: "system", content: system },
      { role: "system", content: examples },
      {
        role: "user",
        content: `
Customer review:
"${reviewText}"

Write a SHORT reply (2–3 sentences) following the rules above.
Reply ONLY in ${lang}.
If ${lang} is english: do not use any Filipino/Tagalog words (e.g., po, salamat, pasensya, kayo, namin, inyong).
        `.trim(),
      },
    ],
  });

  // ✅ FIXED: "reply" must be let (you reassign it during English guard)
  let reply =
    completion.choices?.[0]?.message?.content?.trim() || fallbackMessage(lang);

  // 🔒 English guard: if English selected but output looks Filipino, rewrite once
  if (lang === "english" && looksLikeFilipino(reply)) {
    reply = await groqRewriteToEnglish(reply, reviewText);
  }

  let finalReply = reply;

  if (lang === "filipino") {
    finalReply = trimToMaxSentences(finalReply, 3);
    finalReply = normalizeFilipinoSellerTone(finalReply);
    // keep your old micro-fix too (harmless)
    finalReply = normalizeStrictTagalogPoliteness(finalReply);
    finalReply = dedupePo(finalReply);
  } else if (lang === "taglish") {
    finalReply = trimToMaxSentences(finalReply, 4);
    finalReply = normalizeTaglish(finalReply);
    finalReply = dedupePo(finalReply);
  } else if (lang === "english") {
    finalReply = trimToMaxSentences(finalReply, 4);
  }

  return {
    reply: finalReply,
    provider: "groq",
    model,
  };
}

// ---------- Core: Generate reply with OpenAI ----------
async function generateWithOpenAI({ reviewText, language }) {
  if (!openai) {
    throw new Error("OpenAI client not initialized");
  }

  const { system, examples } = getLanguagePrompts(language);
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 220,
    messages: [
      { role: "system", content: system },
      { role: "system", content: examples },
      {
        role: "user",
        content: `
Customer review:
"${reviewText}"

Write a SHORT reply (2–3 sentences) following the rules above.
Ensure the reply is written in the correct language: ${language}.
        `.trim(),
      },
    ],
  });

  const reply =
    completion.choices?.[0]?.message?.content?.trim() || fallbackMessage("filipino");

  // ✅ Make normalization language-aware + dedupe (use normalizeLanguage for consistency)
  const lang = normalizeLanguage(language);
  let finalReply = reply;

  if (lang === "filipino") {
    finalReply = trimToMaxSentences(finalReply, 3);
    finalReply = normalizeFilipinoSellerTone(finalReply);
    finalReply = normalizeStrictTagalogPoliteness(finalReply);
    finalReply = dedupePo(finalReply);
  } else if (lang === "taglish") {
    finalReply = trimToMaxSentences(finalReply, 4);
    finalReply = normalizeTaglish(finalReply);
    finalReply = dedupePo(finalReply);
  } else if (lang === "english") {
    finalReply = trimToMaxSentences(finalReply, 4);
  }

  return {
    reply: finalReply,
    provider: "openai",
    model,
  };
}

// ---------- Route: Health check ----------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    groq: !!process.env.GROQ_API_KEY,
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    port: PORT,
  });
});

// ---------- Route: Generate Reply ----------
app.post("/api/generate-reply", async (req, res) => {
  try {
    const { reviewText, language } = req.body;

    if (!reviewText || typeof reviewText !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing or invalid 'reviewText' in request body.",
      });
    }

    const lang = language || "english";

    let result;
    // Decide provider
    if (shouldUseOpenAI(lang)) {
      // Try OpenAI first, fall back to Groq if something breaks
      try {
        result = await generateWithOpenAI({ reviewText, language: lang });
      } catch (err) {
        console.error("[OpenAI error, falling back to Groq]", err.message);
        result = await generateWithGroq({ reviewText, language: lang });
      }
    } else {
      // Groq-first
      result = await generateWithGroq({ reviewText, language: lang });
    }

    res.json({
      success: true,
      reply: result.reply,
      providerUsed: result.provider,
      modelUsed: result.model,
      language: lang,
    });
  } catch (error) {
    console.error("[/api/generate-reply] Error:", error);

    res.status(500).json({
      success: false,
      error: "Failed to generate reply. Please try again later.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`ReplyPilot backend v0.8 running on port ${PORT}`);
});
