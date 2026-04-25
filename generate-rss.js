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
//   ISO 8601         → "2026-04-24T09:07:05.453827+06:00"  (AjkerPatrika first_published_at)
//   ISO 8601 simple  → "2026-04-04T16:11:45+06:00"         (Ittefaq data-published)
//   Space-separated  → "2026-04-05 09:48:24"               (JatiyoArthoniti)
//   Month-first BD   → "এপ্রিল ২, ২০২৬,  ০৪:২১ পিএম"    (RupaliBD)
//   Day-first BD DT  → "০৩ এপ্রিল ২০২৬, ১২:০২ এএম"       (Inqilab)
//   Day-first BD DO  → "০৩ এপ্রিল ২০২৬"                   (Inqilab fallback)
//   MZamin           → "১১ এপ্রিল (শনিবার), ২০২৬"         (day-of-week stripped)

const BANGLA_MONTHS = {
  'জানুয়ারি':0, 'ফেব্রুয়ারি':1, 'মার্চ':2,    'এপ্রিল':3,
  'মে':4,        'জুন':5,         'জুলাই':6,    'আগস্ট':7,
  'সেপ্টেম্বর':8,'অক্টোবর':9,    'নভেম্বর':10, 'ডিসেম্বর':11,
};

function parseDate(raw) {
  if (!raw || !raw.trim()) return new Date();

  // Strip parenthetical day-of-week: "১১ এপ্রিল (শনিবার), ২০২৬" → "১১ এপ্রিল ২০২৬"
  let str = raw.trim().replace(/\s*\([^)]+\),?\s*/g, ' ').trim();

  // Normalise space-separated datetime → ISO T form
  str = str.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/, '$1T$2');

  // ISO 8601 (includes +06:00 offset variants from AjkerPatrika)
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) return d;
  }

  // Month-first Bangla datetime: "এপ্রিল ২, ২০২৬,  ০৪:২১ পিএম"
  const mfRe = /^(\S+)\s+([০-৯\d]+),?\s+([০-৯\d]+)[,،]?\s+([০-৯\d]+):([০-৯\d]+)\s*(এএম|পিএম|AM|PM)?/i;
  const mfm  = str.match(mfRe);
  if (mfm && BANGLA_MONTHS[mfm[1]] !== undefined) {
    const month = BANGLA_MONTHS[mfm[1]];
    const day   = parseInt(banglaToAscii(mfm[2]), 10);
    const year  = parseInt(banglaToAscii(mfm[3]), 10);
    let   hour  = parseInt(banglaToAscii(mfm[4]), 10);
    const min   = parseInt(banglaToAscii(mfm[5]), 10);
    const ampm  = (mfm[6] || "").trim().toUpperCase();
    if (ampm === 'পিএম' || ampm === 'PM') { if (hour < 12) hour += 12; }
    if (ampm === 'এএম' || ampm === 'AM') { if (hour === 12) hour = 0; }
    return new Date(year, month, day, hour, min, 0);
  }

  // Day-first Bangla datetime: "০৩ এপ্রিল ২০২৬, ১২:০২ এএম"
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
function scrapeInqilab(html, seen) {
  const $       = cheerio.load(html);
  const baseURL = "https://dailyinqilab.com";
  const items   = [];

  const $leadAnchor = $(".row.d-flex.flex-row").first().find("> a").first();
  if ($leadAnchor.length) {
    const href = $leadAnchor.attr("href") || "";
    const link = href.startsWith("http") ? href : baseURL + href;
    if (href && !seen.has(link)) {
      seen.add(link);
      const title       = $leadAnchor.find("h4").first().text().trim();
      const description = $leadAnchor.find("p").first().text().trim();
      const image       = $leadAnchor.find("img").first().attr("src") || null;
      if (title) {
        items.push({ title, link, description, image, date: new Date(), category: "সম্পাদকীয়" });
      }
    }
  }

  $(".row.mt-5 .col-md-6").each((_, el) => {
    const $a = $(el).find("> a").first();
    if (!$a.length) return;
    const href = $a.attr("href") || "";
    const link = href.startsWith("http") ? href : baseURL + href;
    if (!href || seen.has(link)) return;
    seen.add(link);

    const title = $a.find("p.content-heading").text().trim();
    if (!title) return;

    items.push({
      title,
      link,
      description: "",
      image:    $a.find("img.img-fluid").first().attr("src") || null,
      date:     parseDate($a.find("section.news-date-time").text().trim()),
      category: "সম্পাদকীয়",
    });
  });

  console.log(`  [Inqilab] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: DAILY ITTEFAQ OPINION =====
const ITTEFAQ_CDN = "https://cdn.ittefaqbd.com/contents/cache/images/800x450x1/uploads/";

function scrapeIttefaq(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $(".each.col_in").each((_, el) => {
    const $el     = $(el);
    const $anchor = $el.find("h2.title a.link_overlay").first();
    const title   = ($anchor.attr("title") || $anchor.text()).trim();
    let   href    = $anchor.attr("href") || "";
    if (!href || !title) return;

    if (href.startsWith("//"))         href = "https:" + href;
    else if (!href.startsWith("http")) href = "https://www.ittefaq.com.bd" + href;
    if (seen.has(href)) return;
    seen.add(href);

    const $timeEl   = $el.find("span.time.aitm").first();
    const published = ($timeEl.attr("data-published") || "").trim();

    let image = null;
    const $ariSpan = $el.find("span[data-ari]").first();
    if ($ariSpan.length) {
      try {
        const ari = JSON.parse($ariSpan.attr("data-ari"));
        if (ari.path) image = ITTEFAQ_CDN + ari.path.split("?")[0];
      } catch (_) {}
    }

    items.push({
      title,
      link:        href,
      description: $el.find("div.summery").text().trim(),
      image,
      date:        parseDate(published || $timeEl.text().trim()),
      category:    $el.find("span.author.aitm").text().trim() || "মতামত",
    });
  });

  console.log(`  [Ittefaq] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: AMAR DESH – OP-ED =====
const AMARDESH_BASE = "https://www.dailyamardesh.com";

function extractAmarDeshImage($el) {
  const $img  = $el.find("img").first();
  if (!$img.length) return null;
  const srcset = $img.attr("srcset") || "";
  if (srcset) {
    const firstUrl = srcset.split(",")[0].trim().split(/\s+/)[0];
    if (firstUrl && firstUrl.startsWith("http")) return firstUrl;
  }
  const src = $img.attr("src") || "";
  return src.startsWith("http") ? src : null;
}

function scrapeAmarDesh(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("article > a").each((_, el) => {
    const $a = $(el);
    if (($a.attr("class") || "").includes("text-red-600")) return;
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

    items.push({
      title,
      link,
      description: "",
      image:    extractAmarDeshImage($a),
      date:     parseDate($a.find('time[itemprop="datePublished"]').attr("datetime") || ""),
      category: "মতামত",
    });
  });

  $("a").filter((_, el) => $(el).attr("class") === "bg-white group block h-full").each((_, el) => {
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

    items.push({
      title,
      link,
      description: "",
      image:    extractAmarDeshImage($a),
      date:     parseDate($a.find('time[itemprop="datePublished"]').attr("datetime") || ""),
      category: "মতামত",
    });
  });

  console.log(`  [AmarDesh] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: JATIYO ARTHONITI – OPINION (মত-দ্বিমত) =====
// Container: article.col-sm-4 (3-col grid)
const JATIYOARTHONITI_BASE = "https://jatiyoarthoniti.com";

function scrapeJatiyoArthoniti(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("article.col-sm-4").each((_, el) => {
    const $el = $(el);

    const href = (
      $el.find("div.ratio_360-202 a").first().attr("href") ||
      $el.find("h3.card-title a").first().attr("href") ||
      ""
    ).trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : JATIYOARTHONITI_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    const title = (
      $el.find("h3.card-title a").first().text().trim() ||
      $el.find("img.img-fluid").first().attr("alt") || ""
    );
    if (!title) return;

    const $img = $el.find("img.img-fluid").first();

    items.push({
      title,
      link,
      description: $el.find("p.card-text").first().text().trim(),
      image:       ($img.attr("data-src") || $img.attr("src") || null) || null,
      date:        parseDate($el.find("time").first().attr("datetime") || ""),
      category:    "মত-দ্বিমত",
    });
  });

  console.log(`  [JatiyoArthoniti] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: SHAREBIZ – EDITORIAL (সম্পাদকীয়) =====
const SHAREBIZ_BASE = "https://sharebiz.net";

function extractShareBizImage($el) {
  const bgSrc   = ($el.find(".thumbnail-container").first().attr("data-src") || "").trim();
  if (bgSrc && !bgSrc.startsWith("data:")) return bgSrc;
  const lazySrc = ($el.find("img").first().attr("data-src") || "").trim();
  if (lazySrc && !lazySrc.startsWith("data:")) return lazySrc;
  const src     = ($el.find("img").first().attr("src") || "").trim();
  return (src && !src.startsWith("data:")) ? src : null;
}

function scrapeShareBiz(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("article.jeg_post[class*='jeg_hero_item']").each((_, el) => {
    const $el = $(el);
    if (!$el.find("div.jeg_post_category a.category-editorial").length) return;
    const href = ($el.find("div.jeg_thumb > a").first().attr("href") || "").trim();
    if (!href) return;
    const link = href.startsWith("http") ? href : SHAREBIZ_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);
    const title = $el.find("h2.jeg_post_title a").text().trim();
    if (!title) return;
    items.push({ title, link, description: "", image: extractShareBizImage($el), date: new Date(), category: "সম্পাদকীয়" });
  });

  $("article.jeg_post.jeg_pl_md_1").each((_, el) => {
    const $el = $(el);
    const href = (
      $el.find("div.jeg_thumb > a").first().attr("href") ||
      $el.find("h3.jeg_post_title a").first().attr("href") ||
      ""
    ).trim();
    if (!href) return;
    const link = href.startsWith("http") ? href : SHAREBIZ_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);
    const title = $el.find("h3.jeg_post_title a").text().trim();
    if (!title) return;
    items.push({ title, link, description: "", image: extractShareBizImage($el), date: new Date(), category: "সম্পাদকীয়" });
  });

  console.log(`  [ShareBiz] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: JOBAN MAGAZINE =====
const JOBAN_BASE  = "https://jobanmagazine.com";
const BG_IMAGE_RE = /background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i;

function scrapeJoban(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("article.post-card").each((_, el) => {
    const $el    = $(el);
    const $thumb = $el.find("a.card-thumbnail").first();
    const href   = ($thumb.attr("href") || "").trim();
    if (!href) return;
    const link = href.startsWith("http") ? href : JOBAN_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    const $clone = $el.find("h2.card-title").first().clone();
    $clone.find("span").remove();
    const title = $clone.text().trim();
    if (!title) return;

    let image = null;
    const bgMatch = ($thumb.attr("style") || "").match(BG_IMAGE_RE);
    if (bgMatch && bgMatch[1]) image = bgMatch[1].trim();
    if (!image) {
      const fallback = ($thumb.find("img.d-none").first().attr("src") || "").trim();
      if (fallback && !fallback.startsWith("data:")) image = fallback;
    }
    if (image && image.startsWith("data:")) image = null;

    items.push({
      title,
      link,
      description: $el.find("p.card-description").first().text().trim(),
      image,
      date:     new Date(),
      category: $el.find("a.post-category").first().text().trim() || "চলতি চিন্তা",
    });
  });

  console.log(`  [Joban] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: MANAB ZAMIN – মত-মতান্তর =====
// Date format: "১১ এপ্রিল (শনিবার), ২০২৬" — day-of-week stripped by parseDate
const MZAMIN_BASE = "https://www.mzamin.com";

function scrapeMzamin(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("article").each((_, el) => {
    const $el     = $(el);
    const $anchor = $el.find("h2.font-semibold a").first();
    const href    = ($anchor.attr("href") || "").trim();
    if (!href) return;
    const link = href.startsWith("http") ? href : MZAMIN_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);
    const title = $anchor.text().trim();
    if (!title) return;

    items.push({
      title,
      link,
      description: $el.find("p.mt-3.text-sm").first().text().trim(),
      image:       $el.find("div.relative.h-48 img").first().attr("src") || null,
      date:        parseDate($el.find("span.flex.items-center.gap-2").first().text().trim()),
      category:    "মত-মতান্তর",
    });
  });

  console.log(`  [MzaminOpinion] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: RUPALI BANGLADESH – মুক্তবাক =====
// Date: "এপ্রিল ২, ২০২৬,  ০৪:২১ পিএম" (month-first Bangla)
const RUPALI_BASE = "https://www.rupalibangladesh.com";

function scrapeRupali(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("div.category-news").each((_, el) => {
    const $el     = $(el);
    const $anchor = $el.find("> a").first();
    const href    = ($anchor.attr("href") || "").trim();
    if (!href) return;
    const link = href.startsWith("http") ? href : RUPALI_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);
    const title = $el.find("div.category-news-text h2").first().text().trim();
    if (!title) return;

    items.push({
      title,
      link,
      description: $el.find("div.category-news-text p").first().text().trim(),
      image:       $el.find("div.category-news-img img").first().attr("src") || null,
      date:        parseDate($el.find("div.category-news-text small").first().text().trim()),
      category:    "মুক্তবাক",
    });
  });

  console.log(`  [RupaliBD] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: DAILY SANGRAM – মতামত =====
// No images or dates in listing view
const SANGRAM_BASE = "https://dailysangram.com";

function scrapeSangram(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("div.card-content").each((_, el) => {
    const $el     = $(el);
    const $anchor = $el.find("a[href]").first();
    const href    = ($anchor.attr("href") || "").trim();
    if (!href) return;
    const link = href.startsWith("http") ? href : SANGRAM_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);
    const title = $el.find("h2.title").first().text().trim();
    if (!title) return;

    items.push({
      title,
      link,
      description: $el.find("p.summary").first().text().trim(),
      image:    null,
      date:     new Date(),
      category: "মতামত",
    });
  });

  console.log(`  [Sangram] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: AJKER PATRIKA – মতামত & বিশ্লেষণ =====
// URL: https://www.ajkerpatrika.com/op-ed   (category slug: op-ed)
//      https://www.ajkerpatrika.com/analysis (category slug: analysis)
// Framework: Next.js RSC — article data embedded in self.__next_f.push([1,"..."]) script tags
//
// Strategy:
//   1. Extract the RSC payload from <script> tags containing "categoryStories"
//   2. Un-escape the JS string literal (\" → ", \\n → etc.)
//   3. Use bracket-counting extractor to pull the "categoryStories" JSON array
//   4. Map each story to item: dates from meta.first_published_at (ISO 8601 +06:00),
//      images from blog_image.download_url, excerpts, subcategory names
//   5. URL: /op-ed/{subcat_slug}/{news_slug}  or  /analysis/{news_slug}
//
//   Also scrape the hero article from the HTML DOM (it is NOT in categoryStories).
//   Hero selector: the first <a> with class containing both "grid-cols-1" and "group"
//   that has an <h2> child. Date unavailable for hero → new Date().

const AJKER_BASE = "https://www.ajkerpatrika.com";

// Bracket-counting JSON array extractor.
// Finds the first "[" after `"key":` and returns the balanced substring.
function extractJsonArray(text, key) {
  const keyIdx = text.indexOf(`"${key}":`);
  if (keyIdx === -1) return null;

  const start = text.indexOf('[', keyIdx);
  if (start === -1) return null;

  let depth    = 0;
  let inString = false;
  let escape   = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape)               { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"')           { inString = !inString; continue; }
    if (inString)             continue;
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function scrapeAjkerPatrika(html, seen, catLabel) {
  const $     = cheerio.load(html);
  const items = [];

  // ── Extract categoryStories from RSC payload ─────────────────────────────
  let stories = [];

  $("script").each((_, el) => {
    const raw = $(el).html() || "";
    if (!raw.includes("categoryStories")) return;

    // The payload is a JS string literal inside self.__next_f.push([1,"..."])
    // Un-escape the most common escape sequences to recover the embedded JSON
    const decoded = raw
      .replace(/\\"/g,   '"')
      .replace(/\\n/g,   '')
      .replace(/\\r/g,   '')
      .replace(/\\t/g,   '')
      .replace(/\\u003c/gi, '<')
      .replace(/\\u003e/gi, '>')
      .replace(/\\u0026/gi, '&');

    const arrayStr = extractJsonArray(decoded, "categoryStories");
    if (!arrayStr) return;

    try {
      stories = JSON.parse(arrayStr);
    } catch (e) {
      console.warn(`  [AjkerPatrika] JSON parse failed: ${e.message}`);
    }
  });

  for (const story of stories) {
    const catSlug    = story.categories?.[0]?.slug || "op-ed";
    const subcatSlug = story.subcategories?.[0]?.slug || "";
    const newsSlug   = story.news_slug;
    if (!newsSlug) continue;

    const link = subcatSlug
      ? `${AJKER_BASE}/${catSlug}/${subcatSlug}/${newsSlug}`
      : `${AJKER_BASE}/${catSlug}/${newsSlug}`;

    if (seen.has(link)) continue;
    seen.add(link);

    const title = (story.title || "").trim();
    if (!title) continue;

    items.push({
      title,
      link,
      description: (story.excerpt || "").trim(),
      image:       story.blog_image?.download_url || null,
      date:        parseDate(story.meta?.first_published_at || ""),
      category:    story.subcategories?.[0]?.name || catLabel,
    });
  }

  // ── Hero article (in DOM, not in categoryStories) ─────────────────────────
  // Selector: first <a> whose class contains "grid-cols-1" and "group"
  // that also has an <h2> child
  $("a").each((_, el) => {
    const $a  = $(el);
    const cls = $a.attr("class") || "";
    if (!cls.includes("grid-cols-1") || !cls.includes("group")) return;
    if (!$a.find("h2").length) return;

    const href = ($a.attr("href") || "").trim();
    if (!href) return;
    const link = href.startsWith("http") ? href : AJKER_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    const title = (
      $a.find("h2 span").first().text() ||
      $a.find("h2").first().text()
    ).trim();
    if (!title) return;

    items.push({
      title,
      link,
      description: $a.find("p").first().text().trim(),
      image:       $a.find("img").first().attr("src") || null,
      date:        new Date(),   // hero block has no date in listing HTML
      category:    catLabel,
    });
  });

  console.log(`  [AjkerPatrika/${catLabel}] Scraped ${items.length} articles (${stories.length} from JSON + hero)`);
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
  {
    label:   "ShareBiz – Editorial (সম্পাদকীয়)",
    url:     "https://sharebiz.net/category/daily-paper/editorial/",
    scraper: scrapeShareBiz,
  },
  {
    label:   "Joban Magazine – Opinion",
    url:     "https://jobanmagazine.com/",
    scraper: scrapeJoban,
  },
  {
    label:   "Manab Zamin – মত-মতান্তর",
    url:     "https://www.mzamin.com/category/%E0%A6%AE%E0%A6%A4-%E0%A6%AE%E0%A6%A4%E0%A6%BE%E0%A6%A8%E0%A7%8D%E0%A6%A4%E0%A6%B0",
    scraper: scrapeMzamin,
  },
  {
    label:   "Rupali Bangladesh – মুক্তবাক",
    url:     "https://www.rupalibangladesh.com/ajkerpatrika/opinion",
    scraper: scrapeRupali,
  },
  {
    label:   "Daily Sangram – মতামত",
    url:     "https://dailysangram.com/opinion/",
    scraper: scrapeSangram,
  },
  {
    label:   "Ajker Patrika – মতামত",
    url:     "https://www.ajkerpatrika.com/op-ed",
    // bind catLabel into the generic scraper
    scraper: (html, seen) => scrapeAjkerPatrika(html, seen, "মতামত"),
  },
  {
    label:   "Ajker Patrika – বিশ্লেষণ",
    url:     "https://www.ajkerpatrika.com/analysis",
    scraper: (html, seen) => scrapeAjkerPatrika(html, seen, "বিশ্লেষণ"),
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
    title:       "বাংলাদেশি সংবাদপত্র – সম্পাদকীয়, মতামত ও বিশ্লেষণ",
    description: "Editorial, opinion and analysis from major Bangladeshi newspapers",
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
