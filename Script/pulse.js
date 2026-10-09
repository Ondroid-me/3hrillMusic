/* ═══════════════════════════════════════════════════════════
   3HRILL MUSIC — Pulse.js
   Links newssplash.html to the Python scraper (pulse.py).

   • Live mode   : python pulse.py is running  → /api/news, /api/refresh, /api/status
   • Static mode : GitHub Pages / any static host → reads feed.json (written by pulse.py --once)

   newssplash.html needs NO other edits. Pulse.js sits in front of fetch(),
   so the page's existing fetchZone() / Refresh button work in both modes.
   It also polls for new stories and re-renders when the scraper publishes some.

   Optional config (put BEFORE the script tag):
     <script>window.PULSE_CONFIG = { api: 'https://my-server.example.com', feedUrl: 'feed.json', pollMinutes: 5 };</script>
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const CFG = Object.assign({ api: '', feedUrl: 'feed.json', pollMinutes: 5, maxPerZone: 24 }, window.PULSE_CONFIG || {});
  const nativeFetch = window.fetch.bind(window);

  let mode = 'unknown';          // 'live' | 'static' | 'unknown'
  let lastScrapedAt = null;      // newest scrape stamp the page has displayed

  /* ── helpers ── */
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  function ago(epoch) {
    const s = Math.max(0, Date.now() / 1000 - epoch);
    if (s < 3600)  return Math.max(1, Math.floor(s / 60)) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function apiUrl(path, search) {
    const base = (CFG.api || window.location.origin).replace(/\/$/, '');
    return base + path + (search || '');
  }

  async function loadFeedFile() {
    const r = await nativeFetch(CFG.feedUrl + (CFG.feedUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('feed.json HTTP ' + r.status);
    return r.json();
  }

  /* ── /api/news ── */
  async function handleNews(reqUrl, input, init) {
    const zone = (reqUrl.searchParams.get('zone') || 'hot').toLowerCase();

    if (mode !== 'static') {
      try {
        const r = await nativeFetch(apiUrl('/api/news', '?zone=' + zone), init || { cache: 'no-store' });
        if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
          mode = 'live';
          const clone = r.clone();
          clone.json().then(d => { if (d.scrapedAt) lastScrapedAt = d.scrapedAt; }).catch(() => {});
          return r;
        }
        throw new Error('API not available');
      } catch (_) {
        mode = 'static';
        console.info('[Pulse] no live API — using ' + CFG.feedUrl);
      }
    }

    try {
      const d = await loadFeedFile();
      lastScrapedAt = d.scrapedAt || lastScrapedAt;
      const articles = ((d.zones || {})[zone] || []).slice(0, CFG.maxPerZone)
        .map(a => Object.assign({}, a, { timeAgo: a.published ? ago(a.published) : 'Recently' }));
      return json({ zone, scrapedAt: d.scrapedAt, articles });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }

  /* ── /api/refresh ── */
  async function handleRefresh(input, init) {
    if (mode !== 'static') {
      try {
        const r = await nativeFetch(apiUrl('/api/refresh'), init);
        if (r.ok) { mode = 'live'; return r; }
      } catch (_) { /* fall through */ }
      mode = 'static';
    }
    // Static host: a scrape can't be forced from the browser; the page will just re-read feed.json.
    return json({ ok: true, static: true });
  }

  /* ── intercept the page's fetch calls ── */
  window.fetch = function (input, init) {
    let u;
    try { u = new URL(typeof input === 'string' ? input : input.url, window.location.href); }
    catch (_) { return nativeFetch(input, init); }

    if (u.pathname.endsWith('/api/news'))    return handleNews(u, input, init);
    if (u.pathname.endsWith('/api/refresh')) return handleRefresh(input, init);
    return nativeFetch(input, init);
  };

  /* ── auto-publish: notice new scrapes and re-render ── */
  async function currentStamp() {
    if (mode === 'live') {
      const r = await nativeFetch(apiUrl('/api/status'), { cache: 'no-store' });
      if (r.ok) return (await r.json()).scrapedAt;
    }
    return (await loadFeedFile()).scrapedAt;
  }

  async function checkForNewStories() {
    if (document.hidden || mode === 'unknown') return;
    try {
      const stamp = await currentStamp();
      if (!stamp || stamp === lastScrapedAt) return;
      const firstLoad = lastScrapedAt === null;
      lastScrapedAt = stamp;
      if (firstLoad) return;

      // Re-render the visible zone, mark the others stale so they reload when opened.
      ['hot', 'warm', 'cold'].forEach(z => { if (z !== currentZone) zoneData[z] = null; });
      zoneData[currentZone] = null;
      fetchZone(currentZone);
      if (typeof showToast === 'function') showToast('New stories published');
    } catch (e) {
      console.warn('[Pulse] poll failed:', e.message);
    }
  }

  setInterval(checkForNewStories, Math.max(1, CFG.pollMinutes) * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForNewStories(); });

  /* ── tiny public API for the console / other scripts ── */
  window.Pulse = {
    get mode() { return mode; },
    get lastScrapedAt() { return lastScrapedAt; },
    checkNow: checkForNewStories,
    config: CFG
  };
})();
