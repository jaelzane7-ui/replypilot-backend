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

// Keep API route alive even if AI deps are missing
app.post("/api/generate-reply", async (req, res) => {
  return res.status(503).json({
    error: "AI_DISABLED_TEMP",
    details:
      "Boot-safe mode. Install deps and re-enable Groq/Gemini code after Render is stable.",
  });
});

app.listen(PORT, () => console.log("ReplyPilot backend live on", PORT));
