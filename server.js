// server.js - ReplyPilot backend using Groq

// -----------------------------
// Imports & setup
// -----------------------------
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// Environment & Groq client
// -----------------------------
if (!process.env.GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY is not set in environment variables.");
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// -----------------------------
// Helper: build prompts
// -----------------------------
function buildPrompts({ marketplace, rating, productName, language, reviewText }) {
  const safeProduct =
    productName && productName.trim() ? productName.trim() : "the product";

  const marketplaceText = marketplace === "lazada" ? "Lazada" : "Shopee";

  // Language style rules
  let styleInstruction = "";
  if (language === "english") {
    styleInstruction =
      "Reply ONLY in English. Sound like a friendly but professional seller. Keep it 2–4 sentences.";
  } else if (language === "tagalog") {
    styleInstruction =
      "Sumagot gamit ang magalang at propesyonal na Filipino lamang (walang English). 2–4 pangungusap lang.";
  } else {
    styleInstruction =
      "Sumagot gamit ang natural na Taglish (halo ng Filipino at English), parang friendly online seller. 2–4 sentences lang.";
  }

  const sentiment =
    rating >= 5
      ? "very positive 5-star review"
      : rating === 4
      ? "positive 4-star review"
      : rating === 3
      ? "neutral or mixed 3-star review"
      : rating === 2
      ? "negative 2-star review"
      : "very negative 1-star review";

  const systemPrompt = `
You are ReplyPilot, an assistant that writes short, empathetic, and professional public replies 
to customer reviews for ${marketplaceText} sellers.

Rules:
- Use this product name naturally when needed: "${safeProduct}".
- Match tone to rating: warm and thankful for positive reviews, apologetic and solution-focused for negative.
- Never mention that you are AI.
- Do NOT promise refunds or discounts directly; instead say things like "message us" or "we'll be happy to assist".
- Keep replies 2–4 sentences maximum.
- ${styleInstruction}
  `.trim();

  const userPrompt = `
Marketplace: ${marketplaceText}
Rating: ${rating} star(s) (${sentiment})
Language setting: ${language}
Product: ${safeProduct}

Customer review:
"""
${reviewText}
"""

Write the best possible public reply following all the rules.
  `.trim();

  return { systemPrompt, userPrompt };
}

// -----------------------------
// Routes
// -----------------------------

// Health check / landing route
app.get("/", (req, res) => {
  res.send("ReplyPilot backend (Groq) is running.");
});

// Main API endpoint used by your WordPress tool
app.post("/api/replypilot", async (req, res) => {
  try {
    const {
      marketplace = "shopee",
      rating = 5,
      productName = "",
      language = "taglish",
      reviewText,
    } = req.body || {};

    if (!reviewText || !reviewText.trim()) {
      return res.status(400).json({ error: "Missing review text" });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is not configured on the server.",
      });
    }

    const { systemPrompt, userPrompt } = buildPrompts({
      marketplace,
      rating: Number(rating) || 5,
      productName,
      language,
      reviewText,
    });

    // -----------------------------
    // Call Groq (Llama 3)
    // -----------------------------
    const completion = await groq.chat.completions.create({
  model: "llama-3.1-8b-instant", // correct Groq model ID
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ],
  temperature: 0.4,
  max_tokens: 220,
});


    const aiText =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Thank you for your review!";

    // Always return { reply: "..." } to the frontend
    return res.json({ reply: aiText });
  } catch (err) {
    console.error("❌ ReplyPilot (Groq) API error:", err?.response?.data || err);

    // Try to expose useful but safe error info
    const message =
      err?.response?.data?.error?.message ||
      err?.message ||
      "Internal server error";

    return res.status(500).json({
      error: "Internal server error",
      details: message,
    });
  }
});

// -----------------------------
// Start server
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ReplyPilot (Groq) server running on port ${PORT}`);
});

