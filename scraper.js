import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

puppeteer.use(StealthPlugin());

const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

// ---------- SQLITE SETUP ----------
let db;
async function initDb() {
    db = await open({
        filename: "./articles.db",
        driver: sqlite3.Database,
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            articleUrl TEXT UNIQUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 🔥 Delete articles older than 7 days
    await db.run(`
        DELETE FROM articles
        WHERE createdAt <= datetime('now', '-7 days')
    `);
}

// ---------- SCRAPER MAIN ----------
export async function scrapeWebsites(websites) {
    await initDb();

    const browser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 120000,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    let results = [];

    for (const site of websites) {
        let context = await browser.createBrowserContext?.() ?? browser;
        const page = await context.newPage();
        await rotateHeaders(page);

        try {
            console.log(`🌐 Scraping headlines from: ${site.headlineUrl}`);
            await safeGoto(page, site.headlineUrl);
            await new Promise((r) => setTimeout(r, 3000));

            let headlines = await page.$$eval(site.urlHtmlTag, (anchors) =>
                anchors.map((a) => ({
                    url: a.href,
                    text: a.innerText.trim(),
                }))
            );

            const maxNeeded =
                site.headlineCount && site.headlineCount > 0
                    ? site.headlineCount
                    : headlines.length;

            headlines = headlines.slice(0, maxNeeded);

            // 🔍 Pre-check DB
            let newCandidates = [];
            for (const h of headlines) {
                const exists = await db.get(
                    "SELECT 1 FROM articles WHERE articleUrl = ?",
                    [h.url]
                );
                if (!exists) newCandidates.push(h);
            }

            if (newCandidates.length === 0) {
                console.warn(`⚠️ All ${maxNeeded} headlines already in DB for ${site.headlineUrl}. Skipping.`);
                results.push({
                    ...site,
                    contentData: [],
                    headlineCount: 0,
                });
                if (context !== browser) await context.close();
                continue;
            }

            headlines = newCandidates;

            let contentData = [];
            console.log(`🔄 Collecting up to ${maxNeeded} fresh articles...`);

            for (const headline of headlines) {
                if (contentData.length >= maxNeeded) break;

                try {
                    console.log(`📰 Scraping article: ${headline.url}`);
                    let articleContext = await browser.createBrowserContext?.() ?? browser;
                    const articlePage = await articleContext.newPage();
                    await rotateHeaders(articlePage);

                    await safeGoto(articlePage, headline.url);
                    await autoScroll(articlePage);

                    const waitSelector = site.contentHtmlTags?.newsContent;
                    if (waitSelector) {
                        try {
                            await articlePage.waitForSelector(waitSelector, { timeout: 20000 });
                        } catch {
                            console.warn(`⚠️ No selector found: ${waitSelector}`);
                        }
                    }

                    const article = {};
                    article.articleUrl = headline.url;
                    article.channel = site.channel || "general";

                    // Title
                    article.headline = await getElementText(articlePage, site.contentHtmlTags?.title);

                    // Publish Date
                    article.publishDate =
                        (await getElementText(articlePage, site.contentHtmlTags?.publishDate)) ||
                        (await getElementAttr(articlePage, site.contentHtmlTags?.publishDate, "content")) ||
                        "";

                    // Author
                    article.author = await getElementText(articlePage, site.contentHtmlTags?.author);

                    // Publisher
                    article.publisher =
                        (await getElementAttr(articlePage, site.contentHtmlTags?.publisher, "content")) ||
                        new URL(site.headlineUrl).hostname;

                    // Image + Alt
                    let rawImageUrl =
                        (await getElementAttr(articlePage, site.contentHtmlTags?.imageHtmlTag, "src")) ||
                        (await getElementAttr(articlePage, site.contentHtmlTags?.imageHtmlTag, "content")) ||
                        (await extractFromSrcset(articlePage, site.contentHtmlTags?.imageHtmlTag)) ||
                        "";

                    if (rawImageUrl && !rawImageUrl.startsWith("http")) {
                        const base = new URL(site.headlineUrl);
                        rawImageUrl = new URL(rawImageUrl, base.origin).href;
                    }
                    article.imageUrl = await validateImageUrl(rawImageUrl);

                    article.imageAlt =
                        (await getElementAttr(articlePage, site.contentHtmlTags?.imageHtmlTag, "alt")) ||
                        (await getElementText(articlePage, site.contentHtmlTags?.imageAlt)) ||
                        (await articlePage.$eval("figure figcaption", el => el.innerText.trim()).catch(() => "")) ||
                        "";

                    // Content
                    if (waitSelector) {
                        article.content = await articlePage.$$eval(
                            waitSelector,
                            (els) => els.map((e) => e.innerText.trim()).join("\n\n")
                        );
                    } else {
                        article.content = "";
                    }

                    if (article.headline && article.content) {
                        contentData.push(article);

                        // Save with createdAt
                        await db.run(
                            "INSERT OR IGNORE INTO articles (articleUrl, createdAt) VALUES (?, datetime('now'))",
                            [article.articleUrl]
                        );

                        console.log(`✅ Added article: ${headline.url}`);
                    } else {
                        console.warn(`⚠️ Skipped (missing headline/content): ${headline.url}`);
                    }

                    await articlePage.close();
                    if (articleContext !== browser) await articleContext.close();

                    await delay(5000, 12000);
                } catch (err) {
                    console.error(`⚠️ Error scraping article ${headline.url}:`, err.message);
                }
            }

            if (contentData.length === 0) {
                console.warn(`⚠️ No new articles fetched for ${site.headlineUrl}. Skipping webhook.`);
                results.push({ ...site, contentData: [], headlineCount: 0 });
            } else {
                results.push({ ...site, contentData, headlineCount: contentData.length });

                if (site.webhook) {
                    await fetch(site.webhook, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ ...site, contentData, headlineCount: contentData.length }),
                    }).catch((err) => console.error(`⚠️ Failed to send webhook: ${err.message}`));
                }
            }

            if (context !== browser) await context.close();
        } catch (err) {
            console.error(`❌ Error scraping ${site.headlineUrl}:`, err.message);
            results.push({ ...site, contentData: [], headlineCount: 0, error: err.message });
            if (context !== browser) await context.close();
        }
    }

    await browser.close();
    return results;
}

// ---------- HELPERS ----------
async function rotateHeaders(page) {
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
}

async function safeGoto(page, url) {
    for (let i = 0; i < 3; i++) {
        try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
            return;
        } catch (err) {
            console.warn(`Retrying navigation to ${url} (${i + 1}/3)...`);
            if (i === 2) throw err;
        }
    }
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 300;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 200);
        });
    });
}

async function getElementText(page, selectorString) {
    if (!selectorString) return "";
    try {
        return await page.$eval(selectorString, (el) => el.innerText.trim());
    } catch {
        return "";
    }
}

async function getElementAttr(page, selectorString, attr) {
    if (!selectorString) return "";
    try {
        return await page.$eval(selectorString, (el, attrName) => el.getAttribute(attrName), attr);
    } catch {
        return "";
    }
}

async function extractFromSrcset(page, selectorString) {
    if (!selectorString) return "";
    try {
        return await page.$eval(selectorString, (el) => {
            const srcset = el.getAttribute("data-srcset") || el.getAttribute("srcset");
            if (!srcset) return "";
            const urls = srcset.split(",").map((s) => s.trim().split(" ")[0]);
            return urls[urls.length - 1];
        });
    } catch {
        return "";
    }
}

async function validateImageUrl(url) {
    if (!url) return "";
    try {
        const res = await fetch(url, { method: "HEAD" });
        if (res.ok) return url;
        return "";
    } catch {
        return "";
    }
}

async function delay(min = 5000, max = 12000) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
}