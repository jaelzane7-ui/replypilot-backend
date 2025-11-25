const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Uses your OPENAI_API_KEY from env / Render
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Simple test route to confirm server is running
app.get("/", (req, res) => {
  res.send("ReplyPilot backend is running.");
});

// Main API endpoint used by your WordPress tool
app.post("/api/replypilot", async (req, res) => {
  try {
    const {
      marketplace,
      rating,
      productName,
      language,
      reviewText,
    } = req.body;

    if (!reviewText) {
      return res.status(400).json({ error: "Missing review text" });
    }

    const safeProduct = productName && productName.trim()
      ? productName.trim()
      : "the product";

    const marketplaceText =
      marketplace === "lazada" ? "Lazada" : "Shopee";

    // Style / language rules
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
- Match tone to rating: warm for positive, apologetic and solution-focused for negative.
- Never mention that you are AI.
- Do NOT promise refunds or discounts; instead say things like "message us" or "we'll be happy to assist".
- Keep replies 2–4 sentences maximum.
- ${styleInstruction}
`;

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
`;

    // Use chat completions API (stable structure)
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini", // or "gpt-4o-mini" if you prefer
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 220,
    });

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Thank you for your review!";

    // IMPORTANT: always send back { reply: "..." }
    res.json({ reply: aiText });
  } catch (err) {
    console.error("ReplyPilot API error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
});

// Render sets process.env.PORT; default 3000 for local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ReplyPilot server running on port ${PORT}`);
});
