// feeds.js
// All RSS feeds. Add BBC, CNN, Sky, Reuters + every outlet on your original list.
// `origin` is just for labelling; the scraper uses `rss`.

module.exports = [
  // ── Mainstream news (BBC, CNN, Sky, Reuters) ──
  { name: 'BBC Music',             rss: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', homepage: 'https://www.bbc.com/news/entertainment_and_arts' },
  { name: 'CNN Entertainment',     rss: 'http://rss.cnn.com/rss/edition_entertainment.rss',             homepage: 'https://edition.cnn.com/entertainment' },
  { name: 'Sky News Entertainment',rss: 'https://feeds.skynews.com/feeds/rss/entertainment.xml',        homepage: 'https://news.sky.com/entertainment' },
  { name: 'Reuters Music',         rss: 'https://www.reutersagency.com/feed/?best-topics=music',        homepage: 'https://www.reuters.com/lifestyle/' },

  // ── Music outlets ──
  { name: 'Billboard',             rss: 'https://www.billboard.com/feed/',                   homepage: 'https://www.billboard.com' },
  { name: 'NME',                   rss: 'https://www.nme.com/feed',                         homepage: 'https://www.nme.com' },
  { name: 'Pitchfork',             rss: 'https://pitchfork.com/feed/feed-news/rss',         homepage: 'https://pitchfork.com' },
  { name: 'Rolling Stone',         rss: 'https://www.rollingstone.com/music/feed/',         homepage: 'https://www.rollingstone.com/music' },
  { name: 'The Guardian Music',    rss: 'https://www.theguardian.com/music/rss',            homepage: 'https://www.theguardian.com/music' },
  { name: 'Consequence',           rss: 'https://consequence.net/feed/',                    homepage: 'https://consequence.net' },
  { name: 'Variety Music',         rss: 'https://variety.com/v/music/feed/',                homepage: 'https://variety.com/v/music' },
  { name: 'DJ Mag',                rss: 'https://djmag.com/feed',                           homepage: 'https://djmag.com' },
  { name: 'Mixmag',                rss: 'https://mixmag.net/feed',                          homepage: 'https://mixmag.net' },
  { name: 'Afrobeats Intelligence',rss: 'https://www.afrobeatsintelligence.com/feed/',      homepage: 'https://www.afrobeatsintelligence.com' },
  { name: 'Pulse Nigeria',         rss: 'https://www.pulse.ng/rss',                         homepage: 'https://www.pulse.ng/entertainment/music' },
  { name: 'HipHopDX',              rss: 'https://hiphopdx.com/rss/news.xml',                homepage: 'https://hiphopdx.com' },
  { name: 'Clash Magazine',        rss: 'https://www.clashmusic.com/feed/',                 homepage: 'https://www.clashmusic.com' },
  { name: 'Complex Music',         rss: 'https://www.complex.com/music/rss',                homepage: 'https://www.complex.com/music' },
  { name: 'Resident Advisor',      rss: 'https://ra.co/xml/news.xml',                       homepage: 'https://ra.co' },
  { name: 'XLR8R',                 rss: 'https://xlr8r.com/feed/',                          homepage: 'https://xlr8r.com' },
  { name: 'The Line of Best Fit',  rss: 'https://www.thelineofbestfit.com/feed',            homepage: 'https://www.thelineofbestfit.com' },
  { name: 'Rap-Up',                rss: 'https://www.rap-up.com/feed/',                     homepage: 'https://www.rap-up.com' },
  { name: 'Stereogum',             rss: 'https://www.stereogum.com/feed/',                  homepage: 'https://www.stereogum.com' },
  { name: 'The FADER',             rss: 'https://www.thefader.com/rss',                     homepage: 'https://www.thefader.com' },
];