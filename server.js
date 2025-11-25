const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

    const systemPrompt = `
You are ReplyPilot, an AI assistant that writes short, helpful, and professional 
responses to customer reviews for online marketplaces.

Rules:
- If language = "english", reply ONLY in English.
- If language = "tagalog", reply ONLY in Filipino (no Taglish).
- If language = "taglish", use natural Filipino-English mix.
- Keep replies 2–5 sentences unless the user review clearly needs more.
- Adjust tone based on star rating: 
   5⭐ thankful, warm  
   4⭐ positive and appreciative  
   3⭐ apologetic but hopeful  
   2⭐ apologetic + offer help  
   1⭐ serious apology + fix request  
`;

    const userPrompt = `
Marketplace: ${marketplace}
Rating: ${rating}
Language: ${language}
Product name: ${productName || "the product"}
Customer review:
"${reviewText}"

Write the best reply following the guidelines.
`;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const aiText =
      response.output?.[0]?.content?.[0]?.text ||
      "Sorry, I couldn't generate a response.";

    res.json({ reply: aiText });
  } catch (err) {
    console.error("ReplyPilot API error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ReplyPilot server running on port ${PORT}`);
});
