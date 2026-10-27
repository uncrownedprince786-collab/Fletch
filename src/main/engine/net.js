'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { UA_DESKTOP } = require('./util');

// Keep sockets warm: a fresh TLS handshake per segment would eat most of the
// benefit of splitting the file up in the first place.
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 }),
};

const insecureAgents = {
  'http:': agents['http:'],
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000, rejectUnauthorized: false }),
};

function defaultHeaders(url, extra = {}) {
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* leave blank */ }
  const base = {
    'User-Agent': UA_DESKTOP,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    // identity only: a gzipped body makes Content-Length and byte ranges lie.
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
  };
  if (origin) base.Referer = extra.Referer || extra.referer || origin + '/';
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') continue;
    base[k.replace(/\b\w/g, (c) => c.toUpperCase())] = String(v);
  }
  return base;
}

function pickCookies(setCookie, jar) {
  if (!setCookie) return jar;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const map = new Map();
  for (const part of String(jar || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) map.set(k, rest.join('='));
  }
  for (const line of list) {
    const [pair] = String(line).split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Issue a request, following redirects by hand so we keep the final URL and any
 * cookies the hops handed us. Resolves with the live response — the caller owns
 * draining or destroying it.
 */
function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    maxRedirects = 10,
    timeout = 30000,
    signal,
    insecure = false,
  } = opts;

  return new Promise((resolve, reject) => {
    let hops = 0;
    let jar = headers.Cookie || headers.cookie || '';

    const go = (currentUrl) => {
      let u;
      try { u = new URL(currentUrl); } catch { return reject(new Error(`Invalid URL: ${currentUrl}`)); }
      if (!/^https?:$/.test(u.protocol)) return reject(new Error(`Unsupported protocol: ${u.protocol}`));

      const lib = u.protocol === 'https:' ? https : http;
      const agentSet = insecure ? insecureAgents : agents;
      const h = defaultHeaders(currentUrl, headers);
      if (jar) h.Cookie = jar;

      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers: h,
          agent: agentSet[u.protocol],
        },
        (res) => {
          const code = res.statusCode || 0;
          jar = pickCookies(res.headers['set-cookie'], jar);

          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            if (++hops > maxRedirects) return reject(new Error('Too many redirects'));
            let next;
            try { next = new URL(res.headers.location, currentUrl).toString(); }
            catch { return reject(new Error('Bad redirect target')); }
            return go(next);
          }

          res.finalUrl = currentUrl;
          res.cookieJar = jar;
          res.request = req;
          resolve(res);
        }
      );

      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Timed out after ${Math.round(timeout / 1000)}s`));
      });
      req.on('error', reject);

      if (signal) {
        if (signal.aborted) { req.destroy(new Error('Aborted')); return; }
        signal.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
      }

      if (opts.body) req.write(opts.body);
      req.end();
    };

    go(url);
  });
}

/** Read a whole response into memory. For playlists and API calls, never media. */
async function fetchText(url, opts = {}) {
  const limit = opts.maxBytes || 16 * 1024 * 1024;
  const res = await request(url, opts);
  const code = res.statusCode || 0;
  if (code < 200 || code >= 300) {
    res.resume();
    throw new Error(`HTTP ${code} for ${url}`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    res.on('data', (c) => {
      total += c.length;
      if (total > limit) { res.destroy(); return reject(new Error('Response too large')); }
      chunks.push(c);
    });
    res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), finalUrl: res.finalUrl, headers: res.headers }));
    res.on('error', reject);
  });
}

async function fetchBuffer(url, opts = {}) {
  const limit = opts.maxBytes || 64 * 1024 * 1024;
  const res = await request(url, opts);
  const code = res.statusCode || 0;
  if (code < 200 || code >= 300) {
    res.resume();
    throw new Error(`HTTP ${code} for ${url}`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    res.on('data', (c) => {
      total += c.length;
      if (total > limit) { res.destroy(); return reject(new Error('Response too large')); }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

module.exports = { request, fetchText, fetchBuffer, defaultHeaders };
