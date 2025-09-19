import express from "express";
import dotenv from "dotenv";
import { scrapeWebsites } from "./scraper.js";

dotenv.config();
const app = express();
app.use(express.json());

app.post("/scrape", async (req, res) => {
    try {
        const { websites } = req.body;

        if (!websites || !Array.isArray(websites)) {
            return res.status(400).json({ error: "Invalid request" });
        }

        console.log("📩 Incoming scrape request:", JSON.stringify(websites, null, 2));

        const results = await scrapeWebsites(websites);

        console.log("✅ Scraping finished. Results count:", results.length);
        res.json(results);
    } catch (err) {
        // 👇 add detailed logging
        console.error("❌ Scraping error (server):", err.stack || err);

        res.status(500).json({
            error: "Scraping failed",
            details: err.message || "Unknown error",
        });
    }
});

app.timeout = 660000; // 11 minutes
app.listen(4000, () => {
    console.log("🚀 Server running on http://localhost:4000");
});