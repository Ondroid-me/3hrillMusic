// scraper.js
const https = require('https');
const http  = require('http');
const { URL } = require('url');
const FEEDS = require('./feeds');

/* ══════════════════════════════════════════
   ZONES — EXACT COPY OF YOUR FRONTEND RULES
   (hot / warm / cold + keywords + tagClass)
══════════════════════════════════════════ */
const ZONES = {
  hot: {
    label: ' HOT',
    color: '#ff6b35',
    tagClass: 'hot-r',
    keywords: ['rumor', 'rumour', 'gossip', 'glitz', 'glitzy', 'glam', 'glamour', 'glamorous', 'red carpet', 'gala', 'tabloid'],
  },
  warm: {
    label: ' WARM',
    color: '#c084fc',
    tagClass: 'warm-r',
    keywords: ['sign', 'signing', 'signee', 'endorse', 'endorsement', 'ambassador', 'sponsorship', 'partnership', 'acquisition', 'acquire', 'acquiring', 'performance', 'perform', 'performing', 'concert', 'live show', 'residency'],
  },
  cold: {
    label: ' COLD',
    color: '#38bdf8',
    tagClass: 'cold-r',
    keywords: ['court', 'court case', 'lawsuit', 'sue', 'suing', 'judge', 'trial', 'verdict', 'settlement', 'divorce', 'divorcing', 'separation', 'split', 'splitting', 'breakup', 'contract ended', 'contract termination', 'terminate', 'parts ways', 'parted ways', 'part ways', 'demise', 'die', 'died', 'death', 'dead', 'passed away', 'funeral', 'bankruptcy'],
  }
};

/* Pre-compile keyword regexes with plural/past suffix tolerance */
const ZONE_RX = (() => {
  const esc = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const out = {};
  for (const z of Object.keys(ZONES)) {
    out[z] = ZONES[z].keywords.map(k => ({
      k,
      rx: new RegExp(`\\b${esc(k)}(?:s|es|ed|d|ing)?\\b`, 'i')
    }));
  }
  return out;
})();

/* Tie-break order when two zones score equally */
const ZONE_ORDER = ['cold', 'hot', 'warm'];

/* Route a scraped article into a zone. Returns { zone, score, why } or null. */
function routeZone(article) {
  const headline = String(article.headline || '').toLowerCase();
  const rest     = `${article.kicker || ''} ${article.body || ''}`.toLowerCase();
  let best = null;

  for (const z of Object.keys(ZONES)) {
    let score = 0, why = '';
    for (const { k, rx } of ZONE_RX[z]) {
      if (rx.test(headline)) { score += 3; why = why || k; }        // headline hit = 3×
      else if (rx.test(rest)) { score += 1; why = why || k; }       // body hit = 1×
    }
    if (!score) continue;
    if (!best || score > best.score ||
       (score === best.score && ZONE_ORDER.indexOf(z) < ZONE_ORDER.indexOf(best.zone))) {
      best = { zone: z, score, why };
    }
  }
  return best;
}

/* ══════════════════════════════════════════
   HTTP GET (no axios — raw https/http)
══════════════════════════════════════════ */
function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; 3HRILL-Scraper/1.0; +https://3hrill.example)',
        'Accept': 'application/rss+xml, application/xml, text/xml, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 12000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return fetchUrl(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ══════════════════════════════════════════
   TEXT / XML HELPERS
══════════════════════════════════════════ */
function stripHtml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#8217;/g,"'").replace(/&#8216;/g,"'")
    .replace(/&#8220;/g,'"').replace(/&#8221;/g,'"')
    .replace(/\s+/g, ' ').trim();
}
function trimWords(s, n) {
  const w = String(s || '').split(/\s+/).filter(Boolean);
  return w.length > n ? w.slice(0, n).join(' ') + '…' : w.join(' ');
}
function pickTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripHtml(m[1]) : '';
}
function formatTimeAgo(date) {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d}d ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/* ══════════════════════════════════════════
   MEDIA EXTRACTION  (image / video / audio)
══════════════════════════════════════════ */
function extractMedia(itemXml) {
  const media = { image: null, video: null, audio: null };

  // <enclosure url="..." type="image|video|audio">
  for (const enc of itemXml.matchAll(/<enclosure[^>]*>/gi)) {
    const url  = (enc[0].match(/url=["']([^"']+)["']/i)  || [])[1];
    const type = (enc[0].match(/type=["']([^"']+)["']/i) || [])[1] || '';
    if (!url) continue;
    if (/^image\//i.test(type) && !media.image) media.image = url;
    else if (/^video\//i.test(type) && !media.video) media.video = url;
    else if (/^audio\//i.test(type) && !media.audio) media.audio = url;
  }

  // <media:content url="..." medium="image|video|audio">
  for (const mc of itemXml.matchAll(/<media:content[^>]*>/gi)) {
    const url    = (mc[0].match(/url=["']([^"']+)["']/i)    || [])[1];
    const medium = (mc[0].match(/medium=["']([^"']+)["']/i) || [])[1] || '';
    if (!url) continue;
    if (medium === 'image' && !media.image) media.image = url;
    else if (medium === 'video' && !media.video) media.video = url;
    else if (medium === 'audio' && !media.audio) media.audio = url;
  }

  // <media:thumbnail url="...">
  for (const th of itemXml.matchAll(/<media:thumbnail[^>]*>/gi)) {
    const url = (th[0].match(/url=["']([^"']+)["']/i) || [])[1];
    if (url && !media.image) media.image = url;
  }

  // <itunes:image href="...">
  if (!media.image) {
    const it = itemXml.match(/<itunes:image[^>]+href=["']([^"']+)["']/i);
    if (it) media.image = it[1];
  }

  // <img src="..."> inside description or content:encoded
  if (!media.image) {
    const im = itemXml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (im) media.image = im[1];
  }

  return media;
}

/* ══════════════════════════════════════════
   PARSE ONE RSS/ATOM DOCUMENT
══════════════════════════════════════════ */
function parseFeed(xml, source) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];

  for (const item of items.slice(0, 25)) {
    const title = pickTag(item, 'title');
    if (!title) continue;

    let url = pickTag(item, 'link');
    if (!url) { const m = item.match(/<link[^>]+href=["']([^"']+)["']/i); if (m) url = m[1]; }
    if (!url) url = pickTag(item, 'guid');
    if (!url || url === '#') continue;

    const rawDesc = pickTag(item, 'description') || pickTag(item, 'summary') || pickTag(item, 'content:encoded') || '';
    const rawBody = pickTag(item, 'content:encoded') || rawDesc;

    const dateStr = pickTag(item, 'pubDate') || pickTag(item, 'published') || pickTag(item, 'updated') || pickTag(item, 'dc:date') || '';
    const date = dateStr ? new Date(dateStr) : new Date();

    const author = pickTag(item, 'dc:creator') || pickTag(item, 'author') || source.name;
    const media  = extractMedia(item);

    out.push({
      headline : trimWords(title, 14),
      kicker   : trimWords(rawDesc, 30),
      body     : stripHtml(rawBody).slice(0, 2000),
      source   : source.name,
      author,
      timeAgo  : formatTimeAgo(isNaN(date) ? new Date() : date),
      date     : (isNaN(date) ? new Date() : date).toISOString(),
      url,
      image    : media.image || '',
      video    : media.video || null,
      audio    : media.audio || null,
    });
  }
  return out;
}

/* ══════════════════════════════════════════
   SCRAPE ONE SOURCE
══════════════════════════════════════════ */
async function scrapeSource(source) {
  try {
    const xml = await fetchUrl(source.rss);
    return { source: source.name, ok: true, articles: parseFeed(xml, source) };
  } catch (err) {
    return { source: source.name, ok: false, error: err.message, articles: [] };
  }
}

/* ══════════════════════════════════════════
   SCRAPE ALL SOURCES (concurrency-capped)
══════════════════════════════════════════ */
async function scrapeAll(concurrency = 6) {
  const results = [];
  const queue = [...FEEDS];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const src = queue.shift();
      results.push(await scrapeSource(src));
    }
  });
  await Promise.all(workers);
  return results;
}

/* ══════════════════════════════════════════
   MERGE · DEDUPE · ROUTE INTO ZONES
   (tagClass from your ZONES is attached)
══════════════════════════════════════════ */
function processResults(results) {
  const seen = new Set();
  const buckets = { hot: [], warm: [], cold: [] };
  const failed  = [];
  let total = 0;

  for (const r of results) {
    if (!r.ok) { failed.push({ source: r.source, error: r.error }); continue; }
    for (const a of r.articles) {
      const key = a.headline.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);

      const hit = routeZone(a);
      if (!hit) continue;                       // no keyword match → drop

      a.zone     = hit.zone;
      a.zoneWhy  = hit.why;
      a.tagClass = ZONES[hit.zone].tagClass;    // ← your zone CSS class
      a.color    = ZONES[hit.zone].color;
      a.label    = ZONES[hit.zone].label;
      buckets[hit.zone].push(a);
      total++;
    }
  }

  for (const z of Object.keys(buckets)) {
    buckets[z].sort((a, b) => new Date(b.date) - new Date(a.date));
    buckets[z] = buckets[z].slice(0, 40);       // cap per zone
  }

  return { buckets, failed, total, zones: ZONES };
}

module.exports = { scrapeAll, processResults, routeZone, fetchUrl, stripHtml, ZONES };
