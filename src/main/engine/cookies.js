'use strict';
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

// Cookies handed over by the browser extension for one site.
//
// Two consumers want them in different shapes: our own HTTP and HLS engines
// take an ordinary Cookie header, while yt-dlp wants a file in the Netscape
// format that curl and wget have used for decades.

/** `name=value; name=value` for a request header. */
function toHeader(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return '';
  const seen = new Set();
  const parts = [];
  for (const c of cookies) {
    if (!c || !c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join('; ');
}

function tab(...fields) {
  return fields.join('\t');
}

/**
 * The Netscape cookie file format:
 *   domain  includeSubdomains  path  secure  expires  name  value
 *
 * A leading dot on the domain is how the format spells "and its subdomains",
 * and yt-dlp is strict about the column being TRUE in that case.
 */
function toNetscape(cookies) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Written by Fletch from the cookies the browser extension supplied.',
    '',
  ];
  for (const c of cookies || []) {
    if (!c || !c.name) continue;
    const domain = String(c.domain || '');
    if (!domain) continue;
    const includeSub = domain.startsWith('.') ? 'TRUE' : (c.hostOnly ? 'FALSE' : 'TRUE');
    const normalised = domain.startsWith('.') || c.hostOnly ? domain : `.${domain}`;
    lines.push(tab(
      normalised,
      includeSub,
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      String(Math.floor(Number(c.expires) || 0)),
      c.name,
      String(c.value ?? ''),
    ));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Write a cookie file for yt-dlp and return its path, or null when there is
 * nothing worth writing. The caller is responsible for removing it.
 */
async function writeCookieFile(cookies, dir, id) {
  if (!Array.isArray(cookies) || !cookies.length) return null;
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.cookies.txt`);
  // Readable only by this user: it is a live session for whatever site it came
  // from, and worth no less care than a password.
  await fsp.writeFile(file, toNetscape(cookies), { mode: 0o600 });
  return file;
}

/** Keep only the cookies a given URL would actually receive. */
function forUrl(cookies, url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return []; }
  return (cookies || []).filter((c) => {
    const raw = String(c.domain || '').toLowerCase();
    const domain = raw.replace(/^\./, '');
    if (!domain) return false;
    // A host-only cookie belongs to that exact host. Sending it to a
    // subdomain would hand one site's session to another.
    if (c.hostOnly && !raw.startsWith('.')) return host === domain;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

module.exports = { toHeader, toNetscape, writeCookieFile, forUrl };
