// server.js
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { scrapeAll, processResults, ZONES } = require('./scraper');
const cache = require('./cache');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
};

/* ── Static file server for /public ── */
function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const full = path.join(PUBLIC_DIR, p);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ── /api/zones — returns your ZONES map to the frontend ── */
function handleZones(res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(ZONES));
}

/* ── /api/news?zone=hot|warm|cold|all ── */
async function handleNews(req, res) {
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const zone = url.searchParams.get('zone') || 'all';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    let data = cache.get('news');
    if (!data) {
      const t0 = Date.now();
      const raw = await scrapeAll(6);
      const processed = processResults(raw);
      data = {
        buckets  : processed.buckets,
        failed   : processed.failed,
        total    : processed.total,
        scrapedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
      };
      cache.set('news', data);
      console.log(`[scrape] ${data.total} articles · ${raw.filter(r=>r.ok).length} sources ok · ${data.durationMs}ms`);
      if (data.failed.length) console.warn('[scrape] failed:', data.failed.map(f => f.source).join(', '));
    }

    if (zone === 'all') {
      res.writeHead(200); res.end(JSON.stringify(data));
    } else if (data.buckets[zone]) {
      res.writeHead(200); res.end(JSON.stringify({
        zone,
        articles : data.buckets[zone],
        scrapedAt: data.scrapedAt,
      }));
    } else {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid zone' }));
    }
  } catch (err) {
    console.error('[api/news]', err);
    res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
  }
}

/* ── /api/refresh — force re-scrape ── */
function handleRefresh(res) {
  cache.clear();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message: 'Cache cleared. Next /api/news re-scrapes.' }));
}

const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/api/news')    return handleNews(req, res);
  if (p === '/api/refresh') return handleRefresh(res);
  if (p === '/api/zones')   return handleZones(res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  3HRILL SCRAPER SERVER`);
  console.log(`  ─────────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  API:  http://localhost:${PORT}/api/news?zone=hot`);
  console.log(`  Zones: http://localhost:${PORT}/api/zones\n`);
});