import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
];

export async function scrapeWebsites(websites) {
    const browser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 120000,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    let results = [];

    for (const site of websites) {
        // ✅ context per site
        let context;
        if (typeof browser.createIncognitoBrowserContext === "function") {
            context = await browser.createIncognitoBrowserContext();
        } else if (typeof browser.createBrowserContext === "function") {
            context = await browser.createBrowserContext();
        } else {
            context = browser;
        }

        const page = await context.newPage();
        await rotateHeaders(page);

        try {
            console.log(`🌐 Scraping headlines from: ${site.headlineUrl}`);
            await safeGoto(page, site.headlineUrl);
            await new Promise(r => setTimeout(r, 3000));

            const headlines = await page.$$eval(site.urlHtmlTag, anchors =>
                anchors.map(a => ({
                    url: a.href,
                    text: a.innerText.trim()
                }))
            );

            const maxNeeded =
                site.headlineCount && site.headlineCount > 0
                    ? site.headlineCount
                    : headlines.length;

            let contentData = [];

            for (const headline of headlines) {
                if (contentData.length >= maxNeeded) break;

                // ✅ skip if already scraped
                if (contentData.some(a => a.articleUrl === headline.url)) {
                    console.log(`⏭️ Skipping duplicate: ${headline.url}`);
                    continue;
                }

                try {
                    console.log(`📰 Scraping article: ${headline.url}`);

                    // ✅ new incognito context per article
                    let articleContext;
                    if (typeof browser.createIncognitoBrowserContext === "function") {
                        articleContext = await browser.createIncognitoBrowserContext();
                    } else if (typeof browser.createBrowserContext === "function") {
                        articleContext = await browser.createBrowserContext();
                    } else {
                        articleContext = browser;
                    }

                    const articlePage = await articleContext.newPage();
                    await rotateHeaders(articlePage);

                    await safeGoto(articlePage, headline.url);
                    await autoScroll(articlePage);

                    const waitSelector =
                        site.contentHtmlTags?.content ||
                        site.contentHtmlTags?.newsContent ||
                        "div.l-container article div.zn-body__paragraph";
                    try {
                        await articlePage.waitForSelector(waitSelector, { timeout: 20000 });
                    } catch {
                        console.warn(`⚠️ No selector found: ${waitSelector}`);
                    }

                    const article = {};
                    article.articleUrl = headline.url;

                    // ✅ headline (title fallback)
                    article.headline = await getElementText(
                        articlePage,
                        site.contentHtmlTags?.headline ||
                        site.contentHtmlTags?.title ||
                        "h1.pg-headline"
                    );

                    // ✅ publishDate
                    article.publishDate =
                        (await getElementText(articlePage, site.contentHtmlTags?.publishDate || "time")) ||
                        (await getElementAttr(articlePage, site.contentHtmlTags?.publishDate || "meta[name='pubdate']", "content")) ||
                        (await getElementAttr(articlePage, site.contentHtmlTags?.publishDate || "time", "datetime")) ||
                        "";

                    article.author = await getElementText(
                        articlePage,
                        site.contentHtmlTags?.author || "span.metadata__byline__author"
                    );

                    article.publisher =
                        (await getElementAttr(
                            articlePage,
                            site.contentHtmlTags?.publisher || "meta[property='og:site_name']",
                            "content"
                        )) || new URL(site.headlineUrl).hostname;

                    try {
                        if (site.contentHtmlTags?.imageHtmlTag) {
                            await articlePage.waitForSelector(site.contentHtmlTags.imageHtmlTag, { timeout: 10000 });
                        }
                    } catch {
                        console.warn("⚠️ Image selector not found in time");
                    }

                    article.imageUrl =
                        (await getElementAttr(
                            articlePage,
                            site.contentHtmlTags?.imageHtmlTag || "img",
                            "src"
                        )) ||
                        (await getElementAttr(
                            articlePage,
                            "meta[property='og:image']",
                            "content"
                        )) ||
                        "";

                    // ✅ content (newsContent fallback)
                    article.content = await articlePage.$$eval(
                        waitSelector,
                        els => els.map(e => e.innerText.trim()).join("\n\n")
                    );

                    // ✅ only push if headline & content exist
                    if (article.headline && article.content) {
                        contentData.push(article);
                    } else {
                        console.warn(`⚠️ Skipped article (missing headline/content): ${headline.url}`);
                    }

                    if (!articlePage.isClosed()) await articlePage.close();
                    if (articleContext !== browser) await articleContext.close();

                    // ✅ human-like delay
                    await delay(5000, 12000);
                } catch (err) {
                    console.error(`⚠️ Error scraping article ${headline.url}:`, err.message);
                }
            }

            results.push({
                ...site,
                contentData,
                headlineCount: contentData.length
            });

            if (context !== browser) {
                await context.close();
            }
        } catch (err) {
            console.error(`❌ Error scraping ${site.headlineUrl}:`, err.message);
            results.push({
                ...site,
                contentData: [],
                headlineCount: 0,
                error: err.message
            });

            if (context !== browser) {
                await context.close();
            }
        }
    }

    await browser.close();
    return results;
}

/**
 * Rotate UA headers
 */
async function rotateHeaders(page) {
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
}

/**
 * Safe navigation with retry
 */
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

/**
 * Scroll to bottom
 */
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise(resolve => {
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

/**
 * Helpers
 */
async function getElementText(page, selector) {
    try {
        return await page.$eval(selector, el => el.innerText.trim());
    } catch {
        return "";
    }
}

async function getElementAttr(page, selector, attr) {
    try {
        if (attr === "src") {
            return await page.$eval(selector, el => el.src);
        }
        return await page.$eval(selector, el => el.getAttribute(attr));
    } catch {
        return "";
    }
}

/**
 * Random delay helper
 */
async function delay(min = 5000, max = 12000) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
}