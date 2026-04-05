const fs   = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS   = require("rss");

const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";
const OUTPUT_FILE     = "./feeds/feed.xml";
const MAX_ITEMS       = 500;

fs.mkdirSync("./feeds", { recursive: true });

// ===== BANGLA DIGIT → ASCII =====
function banglaToAscii(str) {
  const map = {
    '০':'0','১':'1','২':'2','৩':'3','৪':'4',
    '৫':'5','৬':'6','৭':'7','৮':'8','৯':'9',
  };
  return str.replace(/[০-৯]/g, d => map[d] ?? d);
}

// ===== DATE PARSING =====
// Handles:
//   ISO 8601         → "2026-04-04T16:11:45+06:00"   (Ittefaq data-published, AmarDesh dateTime)
//   Space-separated  → "2026-04-05 09:48:24"          (JatiyoArthoniti time[datetime])
//   Bangla datetime  → "০৩ এপ্রিল ২০২৬, ১২:০২ এএম"  (Inqilab)
//   Bangla date-only → "০৩ এপ্রিল ২০২৬"              (Inqilab lead fallback)

const BANGLA_MONTHS = {
  'জানুয়ারি':0, 'ফেব্রুয়ারি':1, 'মার্চ':2,    'এপ্রিল':3,
  'মে':4,        'জুন':5,         'জুলাই':6,    'আগস্ট':7,
  'সেপ্টেম্বর':8,'অক্টোবর':9,    'নভেম্বর':10, 'ডিসেম্বর':11,
};

function parseDate(raw) {
  if (!raw || !raw.trim()) return new Date();
  // Normalise space-separated datetime ("2026-04-05 09:48:24") → ISO T form
  const str = raw.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/, '$1T$2');

  // ISO 8601 (Ittefaq data-published, AmarDesh time[datetime], JatiyoArthoniti normalised)
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) return d;
  }

  // Bangla datetime: "০৩ এপ্রিল ২০২৬, ১২:০২ এএম"
  const dtRe = /^([০-৯]+)\s+(\S+)\s+([০-৯]+)[,،]?\s*([০-৯]+):([০-৯]+)\s*(এএম|পিএম)?/;
  const m = str.match(dtRe);
  if (m) {
    const day   = parseInt(banglaToAscii(m[1]), 10);
    const month = BANGLA_MONTHS[m[2]];
    const year  = parseInt(banglaToAscii(m[3]), 10);
    let   hour  = parseInt(banglaToAscii(m[4]), 10);
    const min   = parseInt(banglaToAscii(m[5]), 10);
    const ampm  = m[6];
    if (month === undefined) {
      console.warn(`⚠️  Unknown Bangla month: "${m[2]}" in "${str}"`);
      return new Date();
    }
    if (ampm === 'পিএম' && hour < 12) hour += 12;
    if (ampm === 'এএম' && hour === 12) hour = 0;
    return new Date(year, month, day, hour, min, 0);
  }

  // Bangla date-only: "০৩ এপ্রিল ২০২৬"
  const dRe = /^([০-৯]+)\s+(\S+)\s+([০-৯]+)/;
  const m2 = str.match(dRe);
  if (m2) {
    const day   = parseInt(banglaToAscii(m2[1]), 10);
    const month = BANGLA_MONTHS[m2[2]];
    const year  = parseInt(banglaToAscii(m2[3]), 10);
    if (month !== undefined) return new Date(year, month, day, 0, 0, 0);
  }

  // Native fallback
  const d = new Date(str);
  if (!isNaN(d)) return d;

  console.warn(`⚠️  Could not parse date: "${str}" — using now()`);
  return new Date();
}

// ===== FLARESOLVERR =====
async function fetchWithFlareSolverr(url) {
  console.log(`Fetching ${url} via FlareSolverr...`);
  const response = await axios.post(
    `${flareSolverrURL}/v1`,
    { cmd: "request.get", url, maxTimeout: 60_000 },
    { headers: { "Content-Type": "application/json" }, timeout: 65_000 }
  );
  if (response.data?.solution) {
    console.log("✅ FlareSolverr OK");
    return response.data.solution.response;
  }
  throw new Error("FlareSolverr did not return a solution");
}

// ===== SCRAPER: DAILY INQILAB EDITORIAL =====
// Structure:
//   Lead  → .row.d-flex.flex-row > a  (h4 = title, img = image, no date element)
//   Grid  → .row.mt-5 .col-md-6 > a  (p.content-heading, img.img-fluid,
//                                      section.news-date-time)
function scrapeInqilab(html, seen) {
  const $       = cheerio.load(html);
  const baseURL = "https://dailyinqilab.com";
  const items   = [];

  // ── Lead article ──────────────────────────────────────────────────────────
  const $leadAnchor = $(".row.d-flex.flex-row").first().find("> a").first();
  if ($leadAnchor.length) {
    const href  = $leadAnchor.attr("href") || "";
    const link  = href.startsWith("http") ? href : baseURL + href;
    if (href && !seen.has(link)) {
      seen.add(link);
      const title       = $leadAnchor.find("h4").first().text().trim();
      const description = $leadAnchor.find("p").first().text().trim();
      const image       = $leadAnchor.find("img").first().attr("src") || null;
      if (title) {
        items.push({
          title, link, description, image,
          date:     new Date(),     // lead block has no date element
          category: "সম্পাদকীয়",
        });
      }
    }
  }

  // ── Regular article grid ───────────────────────────────────────────────────
  $(".row.mt-5 .col-md-6").each((_, el) => {
    const $a = $(el).find("> a").first();
    if (!$a.length) return;

    const href = $a.attr("href") || "";
    const link = href.startsWith("http") ? href : baseURL + href;
    if (!href || seen.has(link)) return;
    seen.add(link);

    const title = $a.find("p.content-heading").text().trim();
    if (!title) return;

    const image   = $a.find("img.img-fluid").first().attr("src") || null;
    const rawDate = $a.find("section.news-date-time").text().trim();

    items.push({
      title,
      link,
      description: "",
      image,
      date:     parseDate(rawDate),
      category: "সম্পাদকীয়",
    });
  });

  console.log(`  [Inqilab] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: DAILY ITTEFAQ OPINION =====
// Structure:
//   Each article → .each.col_in
//   Title / link → h2.title a.link_overlay  (href is protocol-relative //...)
//   Description  → div.summery
//   Author       → span.author.aitm  (used as category)
//   Date         → span.time.aitm[data-published]  (ISO 8601)
//   Image        → span[data-ari] JSON  →  {path: "media/YYYY/...jpg?..."}
//                  full URL: CDN_BASE + path_before_query
const ITTEFAQ_CDN = "https://cdn.ittefaqbd.com/contents/cache/images/800x450x1/uploads/";

function scrapeIttefaq(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $(".each.col_in").each((_, el) => {
    const $el = $(el);

    // Title & link
    const $anchor = $el.find("h2.title a.link_overlay").first();
    const title   = ($anchor.attr("title") || $anchor.text()).trim();
    let   href    = $anchor.attr("href") || "";
    if (!href || !title) return;

    // Normalise: protocol-relative or relative → absolute
    if (href.startsWith("//"))          href = "https:" + href;
    else if (!href.startsWith("http"))  href = "https://www.ittefaq.com.bd" + href;

    if (seen.has(href)) return;
    seen.add(href);

    // Description
    const description = $el.find("div.summery").text().trim();

    // Author as category
    const category = $el.find("span.author.aitm").text().trim() || "মতামত";

    // Date — always use ISO data-published when available
    const $timeEl   = $el.find("span.time.aitm").first();
    const published = ($timeEl.attr("data-published") || "").trim();
    const date      = parseDate(published || $timeEl.text().trim());

    // Image from data-ari JSON
    let image = null;
    const $ariSpan = $el.find("span[data-ari]").first();
    if ($ariSpan.length) {
      try {
        const ari = JSON.parse($ariSpan.attr("data-ari"));
        if (ari.path) {
          const cleanPath = ari.path.split("?")[0];   // strip jadewits_media_id query
          image = ITTEFAQ_CDN + cleanPath;
        }
      } catch (_) { /* malformed JSON — skip image */ }
    }

    items.push({ title, link: href, description, image, date, category });
  });

  console.log(`  [Ittefaq] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: AMAR DESH – OP-ED =====
// Page: https://www.dailyamardesh.com/op-ed  (Next.js SSR)
//
// Three article sections, all EXCLUDING সর্বাধিক পঠিত sidebar:
//
//   Section 1 – Hero (1 article):
//     article > a            where class="group" (no other classes)
//     Title  → h2 > span
//
//   Section 2 – Secondary list (3 articles):
//     article > a            where class contains "grid-cols-5" and "group"
//                            but NOT "text-red-600" (which marks most-read)
//     Title  → h3 > span
//
//   Section 3 – Paginated grid (12 articles, below the 3-col layout):
//     a[class="bg-white group block h-full"]
//     Title  → h3 > span
//
//   Date  → time[itemprop="datePublished"][datetime]  — ISO 8601 with +06:00
//   Image → img srcset (widths format "url 640w, url 1024w…") → take first URL

const AMARDESH_BASE = "https://www.dailyamardesh.com";

function extractAmarDeshImage($el) {
  const $img = $el.find("img").first();
  if (!$img.length) return null;

  const srcset = $img.attr("srcset") || "";
  if (srcset) {
    const firstUrl = srcset.split(",")[0].trim().split(/\s+/)[0];
    if (firstUrl && firstUrl.startsWith("http")) return firstUrl;
  }

  const src = $img.attr("src") || "";
  if (src.startsWith("http")) return src;

  return null;
}

function scrapeAmarDesh(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  // ── Sections 1 & 2: all <article> > <a> elements ────────────────────────
  $("article > a").each((_, el) => {
    const $a  = $(el);
    const cls = $a.attr("class") || "";

    if (cls.includes("text-red-600")) return;

    const href = $a.attr("href") || "";
    if (!href) return;

    const link = href.startsWith("http") ? href : AMARDESH_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    const title = (
      $a.find("h2 span, h3 span").first().text() ||
      $a.find("h2, h3").first().text()
    ).trim();
    if (!title) return;

    const rawDate = $a.find('time[itemprop="datePublished"]').attr("datetime") || "";

    items.push({
      title,
      link,
      description: "",
      image:    extractAmarDeshImage($a),
      date:     parseDate(rawDate),
      category: "মতামত",
    });
  });

  // ── Section 3: paginated grid ────────────────────────────────────────────
  $("a").filter((_, el) => {
    return $(el).attr("class") === "bg-white group block h-full";
  }).each((_, el) => {
    const $a   = $(el);
    const href = $a.attr("href") || "";
    if (!href) return;

    const link = href.startsWith("http") ? href : AMARDESH_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    const title = (
      $a.find("h3 span").first().text() ||
      $a.find("h3").first().text()
    ).trim();
    if (!title) return;

    const rawDate = $a.find('time[itemprop="datePublished"]').attr("datetime") || "";

    items.push({
      title,
      link,
      description: "",
      image:    extractAmarDeshImage($a),
      date:     parseDate(rawDate),
      category: "মতামত",
    });
  });

  console.log(`  [AmarDesh] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: JATIYO ARTHONITI – OPINION (মত-দ্বিমত) =====
// URL: https://jatiyoarthoniti.com/category/opinion-and-editorial
// Framework: Laravel + Bootstrap (standard SSR — no JS tricks needed)
//
// Structure (per article):
//   Container  → article.col-sm-6
//   Link       → div.ratio_360-202 a[href]  (same link also on h3 anchor)
//   Image      → img.img-fluid[data-src]    (lazy-loaded; src === data-src)
//   Title      → h3.card-title a            (text content)
//   Date       → time[datetime]             → "2026-04-05 09:48:24" (space-sep, no tz)
//                normalised to ISO T-form before parseDate()
//   Description→ p.card-text               (truncated teaser)
//   Category   → "মত-দ্বিমত" (hardcoded — page is category-scoped)

const JATIYOARTHONITI_BASE = "https://jatiyoarthoniti.com";

function scrapeJatiyoArthoniti(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("article.col-sm-6").each((_, el) => {
    const $el = $(el);

    // ── Link ──────────────────────────────────────────────────────────────
    // Prefer the image anchor; h3 anchor is identical but grab either.
    const href = (
      $el.find("div.ratio_360-202 a").first().attr("href") ||
      $el.find("h3.card-title a").first().attr("href") ||
      ""
    ).trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : JATIYOARTHONITI_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    // ── Title ─────────────────────────────────────────────────────────────
    const title = (
      $el.find("h3.card-title a").first().text().trim() ||
      $el.find("img.img-fluid").first().attr("alt") || ""
    );
    if (!title) return;

    // ── Image ─────────────────────────────────────────────────────────────
    // data-src is the real URL; src may be a placeholder before JS runs.
    const $img  = $el.find("img.img-fluid").first();
    const image = ($img.attr("data-src") || $img.attr("src") || null) || null;

    // ── Date ──────────────────────────────────────────────────────────────
    // datetime format: "2026-04-05 09:48:24" — no timezone, space-separated.
    // parseDate() will normalise the space to T and treat as local time.
    const rawDate = $el.find("time").first().attr("datetime") || "";

    // ── Description ───────────────────────────────────────────────────────
    const description = $el.find("p.card-text").first().text().trim();

    items.push({
      title,
      link,
      description,
      image,
      date:     parseDate(rawDate),
      category: "মত-দ্বিমত",
    });
  });

  console.log(`  [JatiyoArthoniti] Scraped ${items.length} articles`);
  return items;
}

// ===== SOURCE REGISTRY =====
const SOURCES = [
  {
    label:   "Daily Inqilab – Editorial",
    url:     "https://dailyinqilab.com/editorial",
    scraper: scrapeInqilab,
  },
  {
    label:   "Daily Ittefaq – Opinion",
    url:     "https://www.ittefaq.com.bd/opinion",
    scraper: scrapeIttefaq,
  },
  {
    label:   "Amar Desh – Op-Ed",
    url:     "https://www.dailyamardesh.com/op-ed",
    scraper: scrapeAmarDesh,
  },
  {
    label:   "Jatiyo Arthoniti – Opinion (মত-দ্বিমত)",
    url:     "https://jatiyoarthoniti.com/category/opinion-and-editorial",
    scraper: scrapeJatiyoArthoniti,
  },
];

// ===== LOAD EXISTING ITEMS FROM XML =====
function loadExistingItems(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const xml    = fs.readFileSync(filePath, "utf8");
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const items  = [];

  for (const block of blocks) {
    const get = (tag) => {
      const m = block.match(
        new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([^<]*)<\\/${tag}>`)
      );
      return m ? (m[1] !== undefined ? m[1] : m[2]) : "";
    };
    const getAttr = (tag, attr) => {
      const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`));
      return m ? m[1] : null;
    };

    const link = get("link").trim();
    if (!link) continue;

    items.push({
      title:       get("title"),
      link,
      description: get("description"),
      category:    get("category"),
      image:       getAttr("media:content", "url") || getAttr("media:thumbnail", "url") || null,
      date:        new Date(get("pubDate") || Date.now()),
    });
  }

  console.log(`  Loaded ${items.length} existing items from ${filePath}`);
  return items;
}

// ===== BUILD XML =====
function buildFeed(items) {
  const feed = new RSS({
    title:       "ইনকিলাব, ইত্তেফাক, আমার দেশ ও জাতীয় অর্থনীতি – সম্পাদকীয় ও মতামত",
    description: "Editorial and opinion pieces from Daily Inqilab, Daily Ittefaq, Amar Desh, and Jatiyo Arthoniti",
    feed_url:    "https://dailyinqilab.com/editorial",
    site_url:    "https://dailyinqilab.com",
    language:    "bn",
    pubDate:     new Date().toUTCString(),
    custom_namespaces: { media: "http://search.yahoo.com/mrss/" },
  });

  for (const item of items) {
    const customElements = [];
    if (item.image) {
      customElements.push({ "media:content":   { _attr: { url: item.image, medium: "image" } } });
      customElements.push({ "media:thumbnail": { _attr: { url: item.image } } });
    }
    feed.item({
      title:           item.title,
      url:             item.link,
      description:     item.description || undefined,
      categories:      item.category ? [item.category] : undefined,
      date:            item.date,
      custom_elements: customElements.length ? customElements : undefined,
    });
  }

  return feed.xml({ indent: true });
}

// ===== MAIN =====
async function generateRSS() {
  try {
    const seen     = new Set();
    let   newItems = [];

    for (const source of SOURCES) {
      console.log(`\n--- ${source.label} ---`);
      try {
        const html  = await fetchWithFlareSolverr(source.url);
        const items = source.scraper(html, seen);
        newItems = newItems.concat(items);
      } catch (err) {
        console.error(`❌ Failed to scrape ${source.url}: ${err.message}`);
      }
    }

    console.log(`\nNew articles scraped: ${newItems.length}`);

    const existingItems = loadExistingItems(OUTPUT_FILE);
    existingItems.forEach(item => seen.add(item.link));

    const trulyNew = newItems.filter(
      item => !existingItems.some(e => e.link === item.link)
    );
    console.log(`Truly new (not in existing feed): ${trulyNew.length}`);

    const merged = [...trulyNew, ...existingItems].slice(0, MAX_ITEMS);
    console.log(`Merged feed size: ${merged.length} / ${MAX_ITEMS}`);

    if (merged.length === 0) {
      merged.push({
        title:       "No articles found yet",
        link:        "https://dailyinqilab.com",
        description: "RSS feed could not scrape any articles.",
        category:    "",
        image:       null,
        date:        new Date(),
      });
    }

    fs.writeFileSync(OUTPUT_FILE, buildFeed(merged));
    console.log(`\n✅ RSS written with ${merged.length} items → ${OUTPUT_FILE}`);

  } catch (err) {
    console.error("❌ Fatal error:", err.message);

    if (!fs.existsSync(OUTPUT_FILE)) {
      const feed = new RSS({
        title:       "Feed (error fallback)",
        description: "RSS feed failed to scrape.",
        feed_url:    "https://dailyinqilab.com",
        site_url:    "https://dailyinqilab.com",
        language:    "bn",
        pubDate:     new Date().toUTCString(),
      });
      feed.item({
        title:       "Feed generation failed",
        url:         "https://dailyinqilab.com",
        description: "An error occurred during scraping.",
        date:        new Date(),
      });
      fs.writeFileSync(OUTPUT_FILE, feed.xml({ indent: true }));
    } else {
      console.log("⚠️  Keeping existing feed intact.");
    }
  }
}

generateRSS();
