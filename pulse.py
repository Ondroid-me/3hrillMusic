#!/usr/bin/env python3
"""
3HRILL MUSIC — The Pulse
Python news scraper + web server for newssplash.html

What it does
  1. Pulls music news from RSS feeds (and optional HTML listing pages).
  2. Visits each new article to grab the image, description and an excerpt.
  3. Sorts every story into HOT / WARM / COLD using the same keywords as the page.
  4. Serves /api/news?zone=hot|warm|cold  (exactly what newssplash.html calls)
  5. Re-scrapes automatically every REFRESH_MINUTES — new stories appear on the page
     with no manual work.

Run
  pip install -r requirements.txt
  python pulse.py                 # serve site + API + auto-scrape on http://localhost:5000
  python pulse.py --once          # scrape once, write feed.json, exit (cron / GitHub Action)

Open http://localhost:5000/newssplash.html
"""
import argparse
import html
import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib import robotparser
from urllib.parse import urljoin, urlparse

import feedparser
import requests
from bs4 import BeautifulSoup
from flask import Flask, abort, jsonify, request, send_from_directory

# ───────────────────────── CONFIG ─────────────────────────
SITE_DIR = os.environ.get("SITE_DIR", os.path.dirname(os.path.abspath(__file__)))
FEED_FILE = os.path.join(SITE_DIR, "feed.json")
ROBOTS_FILE = os.path.join(SITE_DIR, "robots.json")
REFRESH_MINUTES = int(os.environ.get("REFRESH_MINUTES", 20))
MAX_PER_SOURCE = 12        # newest items taken from each source per run
MAX_STORED_PER_ZONE = 80   # kept on disk / available for paging
MAX_AGE_DAYS = 10          # drop stories older than this
DEFAULT_ZONE = "warm"      # where stories that match no keyword go
EXCERPT_CHARS = 1400
USER_AGENT = "3HrillPulseBot/1.0 (+https://3hrillmusic.com; news aggregator)"
TIMEOUT = 12

# type "rss" → feed URL.  type "html" → listing page + regex that article links must match.
# Dead / blocked feeds are simply skipped, so add and remove freely.
SOURCES = [
    {"name": "Pitchfork",         "type": "rss", "url": "https://pitchfork.com/feed/feed-news/rss"},
    {"name": "NME",               "type": "rss", "url": "https://www.nme.com/news/music/feed"},
    {"name": "Billboard",         "type": "rss", "url": "https://www.billboard.com/feed/"},
    {"name": "Rolling Stone",     "type": "rss", "url": "https://www.rollingstone.com/music/feed/"},
    {"name": "Stereogum",         "type": "rss", "url": "https://www.stereogum.com/feed/"},
    {"name": "Consequence",       "type": "rss", "url": "https://consequence.net/feed/"},
    {"name": "SPIN",              "type": "rss", "url": "https://www.spin.com/feed/"},
    {"name": "The Guardian",      "type": "rss", "url": "https://www.theguardian.com/music/rss"},
    {"name": "Variety Music",     "type": "rss", "url": "https://variety.com/v/music/feed/"},
    {"name": "Music Business Worldwide", "type": "rss", "url": "https://www.musicbusinessworldwide.com/feed/"},
    {"name": "XXL",               "type": "rss", "url": "https://www.xxlmag.com/feed/"},
    {"name": "Okayplayer",        "type": "rss", "url": "https://www.okayplayer.com/feed"},
    {"name": "Soompi",            "type": "rss", "url": "https://www.soompi.com/feed"},
    # Example of a site with no feed — scrape its listing page instead:
    # {"name": "Some Blog", "type": "html", "url": "https://example.com/news", "link_pattern": r"/news/[a-z0-9-]+"},
]

# Same zones/keywords as newssplash.html
ZONES = {
    "hot": {
        "label": " HOT", "color": "#ff6b35", "tagClass": "hot-r",
        "keywords": ["rumor", "rumour", "gossip", "glitz", "glitzy", "glam", "glamour", "glamorous",
                     "red carpet", "gala", "tabloid", "feud", "beef", "shade", "spotted", "dating",
                     "engaged", "pregnant", "steamy", "viral"],
    },
    "warm": {
        "label": " WARM", "color": "#c084fc", "tagClass": "warm-r",
        "keywords": ["sign", "signing", "signee", "endorse", "endorsement", "ambassador", "sponsorship",
                     "partnership", "acquisition", "acquire", "acquiring", "performance", "perform",
                     "performing", "concert", "live show", "residency", "tour", "collab", "collaboration",
                     "album", "single", "deal"],
    },
    "cold": {
        "label": " COLD", "color": "#38bdf8", "tagClass": "cold-r",
        "keywords": ["court", "court case", "lawsuit", "sue", "suing", "judge", "trial", "verdict",
                     "settlement", "divorce", "divorcing", "separation", "split", "splitting", "breakup",
                     "contract ended", "contract termination", "terminate", "parts ways", "parted ways",
                     "part ways", "demise", "die", "died", "death", "dead", "passed away", "funeral",
                     "bankruptcy", "arrested", "charged", "sentenced", "cancelled"],
    },
}
ZONE_PRIORITY = ["cold", "hot", "warm"]  # tie-break order

# ───────────────────────── SETUP ─────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("pulse")

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en"})

ZONE_RX = {
    z: re.compile(r"\b(?:%s)(?:s|es|d|ed|ing)?\b" % "|".join(re.escape(k) for k in sorted(cfg["keywords"], key=len, reverse=True)), re.I)
    for z, cfg in ZONES.items()
}

STATE = {"zones": {z: [] for z in ZONES}, "scrapedAt": None}
STATE_LOCK = threading.Lock()
SCRAPE_LOCK = threading.Lock()
FIRST_RUN_DONE = threading.Event()

# ───────────────────────── HELPERS ─────────────────────────
_robots = {}

# robots.json = YOUR extra rules. It can only make the scraper stricter:
# a site's own robots.txt is always obeyed.
POLICY = {"default_crawl_delay": 0.3, "domains": {}, "disallow_paths": []}


def load_policy():
    try:
        with open(ROBOTS_FILE, encoding="utf-8") as f:
            POLICY.update({k: v for k, v in json.load(f).items() if not k.startswith("_")})
        log.info("loaded robots.json (%d domain rules)", len(POLICY["domains"]))
    except FileNotFoundError:
        pass
    except Exception as e:
        log.warning("robots.json unreadable — %s", e)


def domain_policy(url):
    host = urlparse(url).netloc.lower()
    host = host[4:] if host.startswith("www.") else host
    return POLICY["domains"].get(host, {})


def crawl_delay(url):
    return float(domain_policy(url).get("crawl_delay", POLICY["default_crawl_delay"]))


def allowed(url):
    """robots.json rules first, then the site's own robots.txt."""
    if domain_policy(url).get("allow") is False:
        return False
    path = urlparse(url).path
    if any(path.startswith(p) for p in POLICY["disallow_paths"]):
        return False
    p = urlparse(url)
    base = f"{p.scheme}://{p.netloc}"
    rp = _robots.get(base)
    if rp is None:
        rp = robotparser.RobotFileParser()
        try:
            r = SESSION.get(base + "/robots.txt", timeout=8)
            rp.parse(r.text.splitlines() if r.ok else [])
        except Exception:
            rp.parse([])
        _robots[base] = rp
    return rp.can_fetch(USER_AGENT, url)


def get(url):
    if not allowed(url):
        log.info("robots.txt disallows %s", url)
        return None
    try:
        r = SESSION.get(url, timeout=TIMEOUT)
        r.raise_for_status()
        return r
    except Exception as e:
        log.warning("fetch failed %s — %s", url, e)
        return None


def plain(text):
    """HTML → clean single-line text, with no angle brackets (page inserts headlines via innerHTML)."""
    text = BeautifulSoup(text or "", "html.parser").get_text(" ")
    text = html.unescape(text)
    text = re.sub(r"[<>]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def safe_url(u):
    """Only http(s) URLs without quotes (the page puts image URLs inside CSS url('...'))."""
    if not u or not u.startswith(("http://", "https://")):
        return ""
    return "" if any(c in u for c in "'\"()<> \n") else u


def to_epoch(entry):
    for key in ("published_parsed", "updated_parsed"):
        t = entry.get(key)
        if t:
            return int(datetime(*t[:6], tzinfo=timezone.utc).timestamp())
    for key in ("published", "updated"):
        try:
            return int(parsedate_to_datetime(entry.get(key)).timestamp())
        except Exception:
            pass
    return int(time.time())


def time_ago(epoch):
    s = max(0, int(time.time() - epoch))
    if s < 3600:
        return f"{max(1, s // 60)}m ago"
    if s < 86400:
        return f"{s // 3600}h ago"
    return f"{s // 86400}d ago"


def entry_image(e):
    for key in ("media_content", "media_thumbnail"):
        for m in e.get(key) or []:
            if safe_url(m.get("url", "")):
                return m["url"]
    for l in list(e.get("links", [])) + list(e.get("enclosures", [])):
        if str(l.get("type", "")).startswith("image") and safe_url(l.get("href", "")):
            return l["href"]
    body = (e.get("content") or [{}])[0].get("value") or e.get("summary", "")
    img = BeautifulSoup(body, "html.parser").find("img")
    if img and safe_url(img.get("src", "")):
        return img["src"]
    return ""


def classify(headline, text):
    scores = {}
    for z, rx in ZONE_RX.items():
        scores[z] = 2 * len(rx.findall(headline)) + len(rx.findall(text))
    best = max(scores.values())
    if best == 0:
        return DEFAULT_ZONE
    for z in ZONE_PRIORITY:
        if scores[z] == best:
            return z


# ───────────────────────── SCRAPING ─────────────────────────
def scrape_rss(src):
    r = get(src["url"])
    if not r:
        return []
    feed = feedparser.parse(r.content)
    out = []
    for e in feed.entries[:MAX_PER_SOURCE]:
        url = safe_url(e.get("link", ""))
        if not url:
            continue
        out.append({
            "url": url,
            "headline": plain(e.get("title", "")),
            "kicker": plain(e.get("summary", ""))[:220],
            "author": plain(e.get("author", "")),
            "image": entry_image(e),
            "source": src["name"],
            "published": to_epoch(e),
        })
    return out


def scrape_html_listing(src):
    r = get(src["url"])
    if not r:
        return []
    soup = BeautifulSoup(r.text, "html.parser")
    rx = re.compile(src.get("link_pattern", r"."))
    seen, out = set(), []
    for a in soup.find_all("a", href=True):
        url = safe_url(urljoin(src["url"], a["href"]).split("#")[0])
        if url and url not in seen and rx.search(url) and url.rstrip("/") != src["url"].rstrip("/"):
            seen.add(url)
            out.append({"url": url, "headline": plain(a.get_text()), "kicker": "", "author": "",
                        "image": "", "source": src["name"], "published": int(time.time())})
        if len(out) >= MAX_PER_SOURCE:
            break
    return out


def scrape_source(src):
    try:
        items = scrape_rss(src) if src["type"] == "rss" else scrape_html_listing(src)
        log.info("%-26s %d items", src["name"], len(items))
        return items
    except Exception as e:
        log.warning("source %s failed — %s", src["name"], e)
        return []


def enrich(a):
    """Open the article page: fill in og:image, description, headline and an excerpt."""
    time.sleep(crawl_delay(a["url"]))  # be polite
    r = get(a["url"])
    body = a.get("kicker", "")
    if r:
        soup = BeautifulSoup(r.text, "html.parser")

        def meta(*names):
            for n in names:
                t = soup.find("meta", attrs={"property": n}) or soup.find("meta", attrs={"name": n})
                if t and t.get("content"):
                    return t["content"].strip()
            return ""

        if not a["headline"]:
            a["headline"] = plain(meta("og:title", "twitter:title") or (soup.title.string if soup.title else ""))
        if not a["image"]:
            a["image"] = safe_url(urljoin(a["url"], meta("og:image", "twitter:image")))
        if not a["kicker"]:
            a["kicker"] = plain(meta("og:description", "description"))[:220]
        if not a["author"]:
            a["author"] = plain(meta("author", "article:author"))[:60]

        scope = soup.find("article") or soup
        paras = [plain(p.get_text(" ")) for p in scope.find_all("p")]
        paras = [p for p in paras if len(p) > 70]
        text, total = [], 0
        for p in paras:
            text.append(p)
            total += len(p)
            if total >= EXCERPT_CHARS:
                break
        if text:
            body = "\n".join(text)[: EXCERPT_CHARS + 300]
    # body is rendered with innerHTML → escape it
    a["body"] = "\n".join(html.escape(p) for p in (body or a["kicker"]).split("\n"))
    return a


def run_scrape():
    if not SCRAPE_LOCK.acquire(blocking=False):
        log.info("scrape already running")
        return
    try:
        t0 = time.time()
        with ThreadPoolExecutor(8) as ex:
            raw = [i for batch in ex.map(scrape_source, SOURCES) for i in batch]

        with STATE_LOCK:
            known = {a["url"] for z in STATE["zones"].values() for a in z}
        cutoff = time.time() - MAX_AGE_DAYS * 86400
        fresh, seen = [], set(known)
        for a in raw:
            if a["url"] not in seen and a["published"] >= cutoff:
                seen.add(a["url"])
                fresh.append(a)
        log.info("%d new articles to fetch", len(fresh))

        with ThreadPoolExecutor(6) as ex:
            fresh = list(ex.map(enrich, fresh))
        fresh = [a for a in fresh if a["headline"]]

        with STATE_LOCK:
            for a in fresh:
                zone = classify(a["headline"], a["kicker"] + " " + a.get("body", ""))
                a["zone"] = zone
                STATE["zones"][zone].append(a)
            for z, items in STATE["zones"].items():
                items = [i for i in items if i["published"] >= cutoff]
                items.sort(key=lambda i: i["published"], reverse=True)
                STATE["zones"][z] = items[:MAX_STORED_PER_ZONE]
            STATE["scrapedAt"] = datetime.now(timezone.utc).isoformat()
            snapshot = json.dumps(STATE, ensure_ascii=False, indent=1)
        with open(FEED_FILE, "w", encoding="utf-8") as f:
            f.write(snapshot)
        log.info("scrape done in %.1fs — HOT %d · WARM %d · COLD %d", time.time() - t0,
                 *(len(STATE["zones"][z]) for z in ("hot", "warm", "cold")))
    finally:
        SCRAPE_LOCK.release()
        FIRST_RUN_DONE.set()


def load_cache():
    try:
        with open(FEED_FILE, encoding="utf-8") as f:
            data = json.load(f)
        with STATE_LOCK:
            STATE["zones"].update(data.get("zones", {}))
            STATE["scrapedAt"] = data.get("scrapedAt")
        if any(STATE["zones"].values()):
            FIRST_RUN_DONE.set()
        log.info("loaded cached feed.json")
    except Exception:
        pass


def scheduler():
    while True:
        try:
            run_scrape()
        except Exception:
            log.exception("scheduled scrape crashed")
        time.sleep(REFRESH_MINUTES * 60)


_started = False


def start_background():
    global _started
    if not _started:
        _started = True
        load_policy()
        load_cache()
        threading.Thread(target=scheduler, daemon=True).start()


# ───────────────────────── WEB SERVER ─────────────────────────
app = Flask(__name__, static_folder=None)
BLOCKED_EXT = (".py", ".json", ".env", ".txt", ".md", ".log", ".pyc")


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"  # lets the page live on another host
    return resp


@app.before_request
def _boot():
    start_background()


def shape(a, zone):
    cfg = ZONES[zone]
    return {
        "headline": a["headline"], "kicker": a["kicker"], "body": a.get("body", ""),
        "source": a["source"], "author": a.get("author", ""), "url": a["url"],
        "image": a.get("image", ""), "timeAgo": time_ago(a["published"]),
        "published": a["published"],
        "tagClass": cfg["tagClass"], "color": cfg["color"], "label": cfg["label"],
    }


@app.route("/api/news")
def api_news():
    zone = request.args.get("zone", "hot").lower()
    if zone not in ZONES:
        abort(400, "zone must be hot, warm or cold")
    FIRST_RUN_DONE.wait(60)  # first ever scrape may still be running
    with STATE_LOCK:
        items = STATE["zones"][zone][:24]
        arts = [shape(a, zone) for a in items]
        return jsonify({"zone": zone, "scrapedAt": STATE["scrapedAt"], "articles": arts})


@app.route("/api/feed")  # paged endpoint for infinite scroll
def api_feed():
    zone = request.args.get("zone", "hot").lower()
    if zone not in ZONES:
        abort(400)
    page = max(1, int(request.args.get("page", 1)))
    size = min(48, max(1, int(request.args.get("pageSize", 8))))
    FIRST_RUN_DONE.wait(60)
    with STATE_LOCK:
        items = STATE["zones"][zone]
        chunk = items[(page - 1) * size: page * size]
        return jsonify({"zone": zone, "page": page, "total": len(items),
                        "hasMore": page * size < len(items),
                        "articles": [shape(a, zone) for a in chunk]})


@app.route("/api/refresh")
def api_refresh():
    threading.Thread(target=run_scrape, daemon=True).start()
    return jsonify({"ok": True, "message": "scrape started"})


@app.route("/api/status")
def api_status():
    with STATE_LOCK:
        return jsonify({"scrapedAt": STATE["scrapedAt"],
                        "counts": {z: len(v) for z, v in STATE["zones"].items()},
                        "sources": len(SOURCES), "refreshMinutes": REFRESH_MINUTES})


@app.route("/")
def root():
    return send_from_directory(SITE_DIR, "newssplash.html")


@app.route("/<path:path>")
def static_files(path):
    if path.lower().endswith(BLOCKED_EXT) or path.startswith("."):
        abort(404)
    return send_from_directory(SITE_DIR, path)


# ───────────────────────── ENTRY ─────────────────────────
if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="scrape once, write feed.json, exit")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5000)))
    args = ap.parse_args()
    if args.once:
        load_policy()
        load_cache()
        run_scrape()
    else:
        app.run(host="0.0.0.0", port=args.port, threaded=True)
