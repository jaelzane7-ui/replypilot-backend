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
function normalizeStrictTagalogPoliteness(text) {
  if (!text || typeof text !== "string") return text;

  const replacements = [
    {
      // Fix: "malugod naming tinatanggap kayo"
      pattern: /malugod naming tinatanggap kayo/gi,
      replacement: "malugod po naming kayong tinatanggap"
    },
    {
      // Fix common variant without "malugod"
      pattern: /naming tinatanggap kayo/gi,
      replacement: "po naming kayong tinatanggap"
    }
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



function getLanguagePrompts(language) {
  const lang = (language || "english").toLowerCase();

 if (lang === "tagalog" || lang === "filipino") {
  return {
    system: `
Ikaw ay isang AI assistant para sa mga online seller sa Pilipinas (Shopee, Lazada, atbp.).
Ang tungkulin mo ay magsulat ng MAIKLI, MAGALANG, at NATURAL na sagot
gamit ang **MAHIGPIT NA TAGALOG LAMANG**.

MAHIGPIT NA PANUNTUNAN:
- Gumamit ng Tagalog lamang.
- IWASAN ang mga karaniwang salitang Ingles tulad ng:
  feedback, item, welcome, shop, order, delivery, refund, replacement, product.
- Gamitin ang mga katumbas na salitang Tagalog:
  - feedback → puna / komento
  - item / product → produkto
  - shop → tindahan
  - welcome → malugod naming tinatanggap
  - order → umorder / inorder
  - delivery → hatid / paghahatid
  - refund → pagbabalik ng bayad
  - replacement → kapalit
- Pinapayagan lamang ang Ingles kung ito ay pangalan ng tatak o eksaktong modelo ng produkto.
- Panatilihing maikli: 2–4 na pangungusap lamang.
- Laging magpasalamat sa mamimili.
- Kung may reklamo, magpaumanhin at mag-alok ng tulong nang magalang.
    `.trim(),

    examples: `
Narito ang mga halimbawa ng tamang pagsagot:

[Halimbawa 1 – Positibong Puna]
Puna: "Ang bilis dumating at maayos ang pagkakabalot. Salamat po!"
Sagot: "Maraming salamat po sa magandang komento! Natutuwa kami na mabilis ninyong natanggap ang produkto at maayos ang pagkakabalot. Sana po ay magustuhan ninyo ang produkto at malugod po naming kayong tinatanggap muli sa aming tindahan. 😊"

[Halimbawa 2 – May Reklamo]
Puna: "May sira ang produktong dumating kaya hindi ako nasiyahan."
Sagot: "Paumanhin po kung may sira ang produktong inyong natanggap. Nais po naming ito ay agad na maitama—maaari po ba ninyo kaming kontakin upang matulungan namin kayo sa kapalit o pagbabalik ng bayad? Salamat po sa pagpapaalam."

[Halimbawa 3 – Karaniwang Puna]
Puna: "Maayos naman ang produkto, ayon sa inaasahan."
Sagot: "Salamat po sa inyong komento! Ikinalulugod po naming natugunan ang inyong inaasahan. Inaasahan po naming muli kayong makapaglingkod sa susunod."
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
- Always thank the customer.
- If the review is negative, politely apologize and offer help.
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
  const lang = (language || "").toLowerCase();
  // Hybrid logic: prefer OpenAI for Tagalog/Taglish if available
  if (lang === "tagalog" || lang === "filipino" || lang === "taglish") {
    return true;
  }
  // English & others → keep using Groq for now
  return false;
}

// ---------- Core: Generate reply with Groq ----------
async function generateWithGroq({ reviewText, language }) {
  const { system, examples } = getLanguagePrompts(language);

  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";

  const completion = await groq.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 220,
    messages: [
      {
        role: "system",
        content: system,
      },
      {
        role: "system",
        content: examples,
      },
      {
        role: "user",
        content: `
Customer review:
"${reviewText}"

Write a SHORT reply (2–4 sentences) following the rules above.
Ensure the reply is written in STRICT TAGALOG ONLY.
Before finalizing, scan your reply and replace any unnecessary English words with Tagalog equivalents.

        `.trim(),
      },
    ],
  });

  const reply =
    completion.choices?.[0]?.message?.content?.trim() ||
    "Pasensya na po, nagkaroon ng problema sa pag-generate ng sagot. Paki-try po ulit mamaya.";

  let finalReply = reply;

const lang = (language || "").toLowerCase();

if (lang === "tagalog" || lang === "filipino") {
  finalReply = normalizeStrictTagalogPoliteness(finalReply);
}

if (lang === "taglish") {
  finalReply = normalizeTaglish(finalReply);
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
      {
        role: "system",
        content: system,
      },
      {
        role: "system",
        content: examples,
      },
      {
        role: "user",
        content: `
Customer review:
"${reviewText}"

Write a SHORT reply (2–4 sentences) following the rules above.
Ensure the reply is written in the correct language: ${language}.
        `.trim(),
      },
    ],
  });

  const reply =
    completion.choices?.[0]?.message?.content?.trim() ||
    "Pasensya na po, nagkaroon ng problema sa pag-generate ng sagot. Paki-try po ulit mamaya.";

  return {
    reply: normalizeStrictTagalogPoliteness(reply),

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
      details:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`ReplyPilot backend v0.8 running on port ${PORT}`);
});
