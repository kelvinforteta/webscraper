import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { scrapeWebsites } from "./scraper.js";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ✅ middleware to check Bearer token
function authMiddleware(req, res, next) {
    const authHeader = req.headers["authorization"];

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Unauthorized: Missing Bearer token" });
    }

    const token = authHeader.split(" ")[1];

    if (token !== process.env.API_TOKEN) {
        return res.status(403).json({ error: "Forbidden: Invalid token" });
    }

    next();
}

// ✅ protected route
app.post("/scrape", authMiddleware, async (req, res) => {
    try {
        const websites = req.body;
        const data = await scrapeWebsites(websites);
        res.json(data);
    } catch (err) {
        console.error("Scraping error:", err);
        res.status(500).json({ error: "Scraping failed" });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});