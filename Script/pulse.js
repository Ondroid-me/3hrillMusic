(function () {
  'use strict';

  const DEFAULT_CFG = {
    api: '',
    feedUrl: 'feed.json',
    pollMinutes: 5,
    maxPerZone: 24,
    pageSize: 8
  };

  const CFG = Object.assign({}, DEFAULT_CFG, window.PULSE_CONFIG || {});
  const nativeFetch = window.fetch.bind(window);

  const state = {
    mode: 'unknown',
    lastScrapedAt: null,
    currentZone: 'hot'
  };

  function ago(epoch) {
    const seconds = Math.max(0, Date.now() / 1000 - Number(epoch || 0));
    if (seconds < 3600) return Math.max(1, Math.floor(seconds / 60)) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }

  function sanitizeZone(zone) {
    const z = (zone || 'hot').toLowerCase();
    return ['hot', 'warm', 'cold'].includes(z) ? z : 'hot';
  }

  function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  function apiBase() {
    const base = (CFG.api || window.location.origin || '').replace(/\/$/, '');
    return base;
  }

  function buildApiUrl(path, params = {}) {
    const url = new URL(path, window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
    const base = apiBase();
    if (base) {
      return new URL(url.pathname + url.search, base).toString();
    }
    return url.toString();
  }

  function normalizeArticle(article, fallbackZone) {
    const zone = sanitizeZone(fallbackZone || article.zone || 'hot');
    const cfg = (window.PULSE_ZONE_COLORS && window.PULSE_ZONE_COLORS[zone]) || {
      label: zone === 'hot' ? ' HOT' : zone === 'warm' ? ' WARM' : ' COLD',
      color: zone === 'hot' ? '#ff6b35' : zone === 'warm' ? '#c084fc' : '#38bdf8',
      tagClass: zone === 'hot' ? 'hot-r' : zone === 'warm' ? 'warm-r' : 'cold-r'
    };

    return {
      headline: article.headline || article.title || '',
      kicker: article.kicker || article.summary || article.description || '',
      body: article.body || '',
      source: article.source || article.site || '3HRILL MUSIC',
      author: article.author || '',
      url: article.url || article.link || '',
      image: article.image || article.img || '',
      timeAgo: article.timeAgo || (article.published ? ago(article.published) : 'Recently'),
      published: Number(article.published || Date.now() / 1000),
      tagClass: article.tagClass || cfg.tagClass,
      color: article.color || cfg.color,
      label: article.label || cfg.label,
      zone
    };
  }

  async function loadFeedFile() {
    const url = CFG.feedUrl + (CFG.feedUrl.includes('?') ? '&' : '?') + '_=' + Date.now();
    const res = await nativeFetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('feed.json HTTP ' + res.status);
    return res.json();
  }

  function payloadFromFeed(data, zone, page = 1, pageSize = CFG.pageSize) {
    const entries = Array.isArray(data?.zones?.[zone]) ? data.zones[zone] : [];
    const normalized = entries
      .slice(0, CFG.maxPerZone)
      .map(item => normalizeArticle(item, zone));

    const currentPage = Math.max(1, Number(page) || 1);
    const size = Math.max(1, Number(pageSize) || CFG.pageSize);
    const chunk = normalized.slice((currentPage - 1) * size, currentPage * size);

    return {
      zone: sanitizeZone(zone),
      scrapedAt: data?.scrapedAt || null,
      page: currentPage,
      total: normalized.length,
      hasMore: currentPage * size < normalized.length,
      articles: chunk
    };
  }

  async function liveNews(zone) {
    const url = buildApiUrl('/api/news', { zone: sanitizeZone(zone) });
    const res = await nativeFetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('live API error ' + res.status);
    const data = await res.json();
    state.mode = 'live';
    if (data && data.scrapedAt) state.lastScrapedAt = data.scrapedAt;
    if (data && Array.isArray(data.articles)) {
      return data;
    }
    if (data && data.zones) {
      return {
        zone: sanitizeZone(zone),
        scrapedAt: data.scrapedAt,
        articles: (data.zones[zone] || []).slice(0, CFG.maxPerZone).map(item => normalizeArticle(item, zone))
      };
    }
    throw new Error('Unexpected API payload');
  }

  async function liveFeed(zone, page, pageSize) {
    const url = buildApiUrl('/api/feed', {
      zone: sanitizeZone(zone),
      page: page || 1,
      pageSize: pageSize || CFG.pageSize
    });
    const res = await nativeFetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('live feed error ' + res.status);
    const data = await res.json();
    state.mode = 'live';
    if (data && data.scrapedAt) state.lastScrapedAt = data.scrapedAt;
    return data;
  }

  async function liveStatus() {
    const url = buildApiUrl('/api/status');
    const res = await nativeFetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('status error ' + res.status);
    const data = await res.json();
    state.mode = 'live';
    if (data && data.scrapedAt) state.lastScrapedAt = data.scrapedAt;
    return data;
  }

  async function staticNews(zone) {
    const data = await loadFeedFile();
    state.mode = 'static';
    state.lastScrapedAt = data?.scrapedAt || state.lastScrapedAt;
    return payloadFromFeed(data, zone, 1, CFG.maxPerZone);
  }

  async function staticFeed(zone, page, pageSize) {
    const data = await loadFeedFile();
    state.mode = 'static';
    state.lastScrapedAt = data?.scrapedAt || state.lastScrapedAt;
    return payloadFromFeed(data, zone, page, pageSize);
  }

  async function staticStatus() {
    const data = await loadFeedFile();
    state.mode = 'static';
    state.lastScrapedAt = data?.scrapedAt || state.lastScrapedAt;
    return {
      scrapedAt: data?.scrapedAt || null,
      counts: data?.zones ? Object.fromEntries(Object.entries(data.zones).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])) : { hot: 0, warm: 0, cold: 0 },
      sources: 0,
      refreshMinutes: CFG.pollMinutes
    };
  }

  function handleNewsRequest(urlLike, input, init) {
    const url = new URL(typeof urlLike === 'string' ? urlLike : urlLike.href, window.location.href);
    const zone = sanitizeZone(url.searchParams.get('zone') || 'hot');

    if (state.mode !== 'static') {
      return (async () => {
        try {
          return await liveNews(zone);
        } catch (error) {
          state.mode = 'static';
          return staticNews(zone);
        }
      })();
    }

    return staticNews(zone);
  }

  function handleFeedRequest(urlLike, input, init) {
    const url = new URL(typeof urlLike === 'string' ? urlLike : urlLike.href, window.location.href);
    const zone = sanitizeZone(url.searchParams.get('zone') || 'hot');
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.max(1, Number(url.searchParams.get('pageSize')) || CFG.pageSize);

    if (state.mode !== 'static') {
      return (async () => {
        try {
          return await liveFeed(zone, page, pageSize);
        } catch (error) {
          state.mode = 'static';
          return staticFeed(zone, page, pageSize);
        }
      })();
    }

    return staticFeed(zone, page, pageSize);
  }

  function handleRefreshRequest() {
    if (state.mode !== 'static') {
      return (async () => {
        try {
          const res = await nativeFetch(buildApiUrl('/api/refresh'), { cache: 'no-store' });
          if (res.ok) {
            state.mode = 'live';
            return res;
          }
          throw new Error('Refresh failed');
        } catch (error) {
          state.mode = 'static';
          return jsonResponse({ ok: true, static: true, message: 'Static feed refresh only' });
        }
      })();
    }

    return Promise.resolve(jsonResponse({ ok: true, static: true, message: 'Static feed refresh only' }));
  }

  function handleStatusRequest() {
    if (state.mode !== 'static') {
      return (async () => {
        try {
          return await liveStatus();
        } catch (error) {
          state.mode = 'static';
          return staticStatus();
        }
      })();
    }

    return staticStatus();
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input, init) {
    let url;
    try {
      const source = typeof input === 'string' ? input : (input && input.url) || '';
      url = new URL(source, window.location.href);
    } catch (error) {
      return originalFetch(input, init);
    }

    if (url.pathname.endsWith('/api/news')) {
      return Promise.resolve(handleNewsRequest(url, input, init));
    }
    if (url.pathname.endsWith('/api/feed')) {
      return Promise.resolve(handleFeedRequest(url, input, init));
    }
    if (url.pathname.endsWith('/api/refresh')) {
      return handleRefreshRequest();
    }
    if (url.pathname.endsWith('/api/status')) {
      return Promise.resolve(handleStatusRequest());
    }

    return originalFetch(input, init);
  };

  async function checkForNewStories() {
    if (document.hidden || state.mode === 'unknown') return;

    try {
      const status = state.mode === 'live'
        ? await liveStatus()
        : await staticStatus();

      const stamp = status && status.scrapedAt ? status.scrapedAt : null;
      if (!stamp || stamp === state.lastScrapedAt) return;

      const wasFirstLoad = !state.lastScrapedAt;
      state.lastScrapedAt = stamp;

      if (wasFirstLoad) return;

      if (window.fetchZone) {
        const zone = window.currentZone || 'hot';
        if (typeof window.zoneData !== 'undefined') {
          window.zoneData[zone] = null;
        }
        window.fetchZone(zone);
      }

      if (typeof window.showToast === 'function') {
        window.showToast('New stories published');
      }
    } catch (error) {
      console.warn('[Pulse] poll failed:', error && error.message ? error.message : error);
    }
  }

  setInterval(() => {
    if (state.mode !== 'unknown') {
      checkForNewStories();
    }
  }, Math.max(1, Number(CFG.pollMinutes) || 5) * 60 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.mode !== 'unknown') {
      checkForNewStories();
    }
  });

  window.Pulse = {
    get mode() { return state.mode; },
    get lastScrapedAt() { return state.lastScrapedAt; },
    checkNow: checkForNewStories,
    config: CFG,
    refresh: handleRefreshRequest,
    status: handleStatusRequest,
    news: handleNewsRequest,
    feed: handleFeedRequest
  };
})();
