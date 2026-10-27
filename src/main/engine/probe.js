'use strict';
const path = require('path');
const { URL } = require('url');
const { request } = require('./net');
const { sanitizeFilename, extFromMime } = require('./util');

function filenameFromDisposition(disposition) {
  if (!disposition) return '';
  // RFC 5987 form wins when present: filename*=UTF-8''name.mp4
  const star = /filename\*\s*=\s*([^';]+)'[^']*'([^;]+)/i.exec(disposition);
  if (star) {
    try { return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(disposition);
  if (plain) {
    const raw = (plain[2] !== undefined ? plain[2] : plain[3] || '').trim();
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return '';
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last && last !== '/') return last;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Ask the server what we're dealing with: total size, whether it honours byte
 * ranges, and what to call the file. We use a one-byte GET rather than HEAD —
 * plenty of CDNs answer HEAD with lies, or with 405.
 */
async function probe(url, opts = {}) {
  const headers = { ...(opts.headers || {}), Range: 'bytes=0-0' };
  const res = await request(url, { method: 'GET', headers, timeout: opts.timeout || 20000, insecure: opts.insecure });
  const code = res.statusCode || 0;
  const h = res.headers || {};
  res.resume();
  res.destroy();

  if (code === 401 || code === 403) throw new Error(`Access denied (HTTP ${code}). The link may need sign-in headers or cookies.`);
  if (code === 404 || code === 410) throw new Error(`Not found (HTTP ${code}).`);
  if (code >= 400) throw new Error(`Server refused the request (HTTP ${code}).`);

  let size = null;
  let acceptRanges = false;

  if (code === 206) {
    acceptRanges = true;
    const m = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(h['content-range'] || '');
    if (m && m[1] !== '*') size = Number(m[1]);
  } else if (code === 200) {
    const len = Number(h['content-length']);
    if (Number.isFinite(len) && len > 0) size = len;
    // A 200 to an explicit Range means the server ignored it — single stream only.
    acceptRanges = /bytes/i.test(h['accept-ranges'] || '') && size !== null;
  }

  const mime = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
  let name = filenameFromDisposition(h['content-disposition']) || filenameFromUrl(res.finalUrl || url);
  name = sanitizeFilename(name);
  if (!path.extname(name)) {
    const ext = extFromMime(mime);
    if (ext) name += ext;
  }

  return {
    url: res.finalUrl || url,
    filename: name || 'download',
    size,
    acceptRanges: Boolean(acceptRanges && size && size > 0),
    mime,
    cookies: res.cookieJar || '',
    lastModified: h['last-modified'] || '',
    etag: h.etag || '',
    isPlaylist: /mpegurl/i.test(mime) || /\.m3u8(\?|$)/i.test(url) || /dash\+xml/i.test(mime) || /\.mpd(\?|$)/i.test(url),
  };
}

module.exports = { probe, filenameFromUrl, filenameFromDisposition };
