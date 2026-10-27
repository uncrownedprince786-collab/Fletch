'use strict';
const { URL } = require('url');
const { fetchText } = require('./net');

// yt-dlp knows about eighteen hundred sites, which still leaves the long tail
// of one-off hosts, embed pages and file lockers that answer "Unsupported
// URL". Before giving up, Fletch reads the page itself and looks for the
// media the player is about to load. It is a last resort, not a first one:
// yt-dlp is better at this wherever it has an extractor.

const MEDIA_EXT = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|ts|mp3|m4a|aac|ogg|opus|flac|wav)(\?|#|$)/i;

/** Pull the obvious candidates out of player markup and config blobs. */
function candidates(html, baseUrl) {
  const found = new Map(); // url -> score, highest wins

  const add = (raw, score) => {
    if (!raw) return;
    let value = String(raw).trim().replace(/\\\//g, '/').replace(/&amp;/g, '&');
    if (!value || value.length > 2000) return;
    if (/^(data|blob|javascript):/i.test(value)) return;
    let abs;
    try { abs = new URL(value, baseUrl).toString(); } catch { return; }
    if (!/^https?:/i.test(abs)) return;
    const prev = found.get(abs) || 0;
    if (score > prev) found.set(abs, score);
  };

  // <video src>, <source src>, and the poster-less <video><source> pattern.
  for (const m of html.matchAll(/<(?:video|audio|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    add(m[1], 100);
  }
  // <video data-src>, used by lazy players.
  for (const m of html.matchAll(/<(?:video|audio|source)\b[^>]*\bdata-src\s*=\s*["']([^"']+)["']/gi)) {
    add(m[1], 95);
  }
  // Player configs: file:, src:, source:, url: "...". jwplayer, video.js, plyr.
  for (const m of html.matchAll(/\b(?:file|src|source|url|hls|videoUrl|video_url)\s*[:=]\s*["']([^"']{8,})["']/gi)) {
    if (MEDIA_EXT.test(m[1])) add(m[1], 80);
  }
  // Anything that simply looks like a media URL anywhere in the page.
  for (const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>\\]{8,}/gi)) {
    const value = m[0].replace(/\\/g, '');
    if (MEDIA_EXT.test(value)) add(value, 40);
  }
  // og:video and twitter:player:stream meta tags.
  for (const m of html.matchAll(/<meta\b[^>]*\b(?:property|name)\s*=\s*["'](?:og:video(?::url|:secure_url)?|twitter:player:stream)["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/gi)) {
    add(m[1], 90);
  }

  return [...found.entries()]
    .map(([url, score]) => ({
      url,
      // A playlist beats a progressive file: it usually carries the better
      // renditions, and the HLS engine can pick among them. The bonus has to
      // be big enough to outweigh the gap between a <video src> and a URL
      // found in a player config, which is where playlists usually live.
      score: score + (/\.m3u8(\?|#|$)/i.test(url) ? 25 : 0) + (/\.mpd(\?|#|$)/i.test(url) ? 18 : 0),
    }))
    .sort((a, b) => b.score - a.score);
}

function titleOf(html) {
  const og = /<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i.exec(html);
  if (og) return decodeEntities(og[1]);
  const t = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
  return t ? decodeEntities(t[1]) : '';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

/**
 * Look at a page and report the most likely media on it.
 * Returns null when nothing convincing turns up.
 */
async function scrapePage(url, opts = {}) {
  const page = await fetchText(url, {
    headers: { ...(opts.headers || {}), Accept: 'text/html,*/*' },
    maxBytes: 4 * 1024 * 1024,
    timeout: opts.timeout || 20000,
  });

  const baseUrl = page.finalUrl || url;
  const list = candidates(page.body, baseUrl);
  if (!list.length) return null;

  return {
    url: list[0].url,
    title: titleOf(page.body),
    pageUrl: baseUrl,
    alternatives: list.slice(0, 8).map((c) => c.url),
  };
}

module.exports = { scrapePage, candidates, titleOf };
