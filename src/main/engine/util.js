'use strict';
const path = require('path');
const fs = require('fs');

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(2) : n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitizeFilename(name, fallback = 'download') {
  let out = String(name || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();
  if (!out) out = fallback;
  if (RESERVED.test(out)) out = `_${out}`;
  if (out.length > 180) {
    const ext = path.extname(out).slice(0, 12);
    out = out.slice(0, 180 - ext.length) + ext;
  }
  return out;
}

function uniquePath(dir, filename) {
  let candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate) && !fs.existsSync(candidate + '.fletchpart')) return candidate;
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate) && !fs.existsSync(candidate + '.fletchpart')) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/** Exponentially weighted speed meter: smooth enough to read, quick enough to be honest. */
class SpeedMeter {
  constructor(halfLifeMs = 1500) {
    this.tau = halfLifeMs / Math.LN2;
    this.rate = 0;
    this.last = Date.now();
    this.pending = 0;
  }
  add(bytes) { this.pending += bytes; }
  sample() {
    const now = Date.now();
    const dt = Math.max(1, now - this.last);
    const instant = (this.pending * 1000) / dt;
    const w = Math.exp(-dt / this.tau);
    this.rate = this.rate * w + instant * (1 - w);
    this.last = now;
    this.pending = 0;
    return this.rate;
  }
  reset() { this.rate = 0; this.pending = 0; this.last = Date.now(); }
}

/** Shared token bucket, so a global speed cap caps the total rather than each connection. */
class RateLimiter {
  constructor(bytesPerSec = 0) {
    this.limit = bytesPerSec;
    this.tokens = bytesPerSec;
    this.last = Date.now();
    this.waiters = [];
    this.timer = null;
  }
  setLimit(bytesPerSec) {
    this.limit = Math.max(0, Math.floor(bytesPerSec) || 0);
    if (this.limit > 0) this.tokens = Math.min(this.tokens, this.limit);
    this._drain();
  }
  _refill() {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (this.limit > 0) this.tokens = Math.min(this.limit, this.tokens + dt * this.limit);
  }
  _drain() {
    this._refill();
    while (this.waiters.length && (this.limit <= 0 || this.tokens >= 0)) {
      this.waiters.shift().resolve();
    }
    if (this.waiters.length && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this._drain(); }, 40);
    }
  }
  /**
   * Charge `bytes` to the budget. Returns null if we were still in credit, or a
   * promise that settles once the debt has been earned back.
   *
   * The debt may exceed the bucket: a single socket read can be larger than one
   * second's allowance, and refusing to account for it would wedge the stream.
   */
  consume(bytes) {
    if (this.limit <= 0) return null;
    this._refill();
    this.tokens -= bytes;
    if (this.tokens >= 0) return null;
    return new Promise((resolve) => {
      this.waiters.push({ resolve });
      this._drain();
    });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Run `worker` over `items` with at most `limit` in flight. Rejects on the first failure. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let failed = null;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (err) { failed = failed || err; return; }
    }
  });
  await Promise.all(runners);
  if (failed) throw failed;
  return results;
}

function extFromMime(mime) {
  if (!mime) return '';
  const m = String(mime).split(';')[0].trim().toLowerCase();
  const map = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
    'video/quicktime': '.mov', 'video/x-msvideo': '.avi', 'video/mpeg': '.mpg',
    'video/x-flv': '.flv', 'video/3gpp': '.3gp', 'video/mp2t': '.ts',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg',
    'audio/opus': '.opus', 'audio/flac': '.flac', 'audio/wav': '.wav',
    'application/pdf': '.pdf', 'application/zip': '.zip',
    'application/x-7z-compressed': '.7z', 'application/vnd.rar': '.rar',
    'application/vnd.apple.mpegurl': '.m3u8', 'application/x-mpegurl': '.m3u8',
    'application/dash+xml': '.mpd',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  };
  return map[m] || '';
}

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg', '.wmv', '.m3u8', '.mpd']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wav', '.wma']);
const DOC_EXT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.epub', '.mobi', '.csv']);
const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso']);
const PROGRAM_EXT = new Set(['.exe', '.msi', '.apk', '.dmg', '.pkg', '.deb', '.rpm', '.appimage']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif', '.heic']);

function categoryFor(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (DOC_EXT.has(ext)) return 'documents';
  if (ARCHIVE_EXT.has(ext)) return 'archives';
  if (PROGRAM_EXT.has(ext)) return 'programs';
  if (IMAGE_EXT.has(ext)) return 'images';
  return 'other';
}

function looksLikeMediaUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const ext = path.extname(u.pathname).toLowerCase();
    return VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext);
  } catch { return false; }
}

const PAGE_EXT = new Set(['.html', '.htm', '.php', '.asp', '.aspx', '.jsp', '.cgi', '']);

const DOWNLOADABLE_EXT = new Set([
  ...VIDEO_EXT, ...AUDIO_EXT, ...DOC_EXT, ...ARCHIVE_EXT, ...PROGRAM_EXT, ...IMAGE_EXT,
  '.torrent', '.srt', '.vtt', '.sub', '.json', '.xml', '.bin', '.img', '.dat',
]);

/**
 * Does this URL name an actual file rather than a page?
 *
 * Used when the server will not answer a probe: a link ending in .mp4 is a
 * file even if the host refuses to describe it, and handing it to the video
 * extractor instead of simply downloading it is how a working link turns into
 * "unsupported URL".
 */
function looksLikeFileUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) return false;
    const ext = path.extname(u.pathname).toLowerCase();
    if (!ext || PAGE_EXT.has(ext)) return false;
    // Only extensions we actually recognise. Anything else is more likely a
    // dot inside a slug than a file, and guessing wrong here sends a real
    // page to the downloader instead of the extractor.
    return DOWNLOADABLE_EXT.has(ext);
  } catch { return false; }
}

function isHttpUrl(url) {
  try { return /^https?:$/.test(new URL(String(url)).protocol); } catch { return false; }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  UA_DESKTOP, formatBytes, formatDuration, sanitizeFilename, uniquePath,
  SpeedMeter, RateLimiter, sleep, pool, extFromMime, categoryFor,
  looksLikeMediaUrl, looksLikeFileUrl, isHttpUrl, newId, VIDEO_EXT, AUDIO_EXT,
};
