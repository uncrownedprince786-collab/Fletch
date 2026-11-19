'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { PassThrough } = require('stream');
const { UA_DESKTOP } = require('./util');

// Keep sockets warm: a fresh TLS handshake per segment would eat most of the
// benefit of splitting the file up in the first place. The ceiling is per
// host and generous, because several downloads from one CDN, each with a
// full pool of workers, should run side by side rather than queue.
const AGENT_OPTS = { keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 };
const agents = {
  'http:': new http.Agent(AGENT_OPTS),
  'https:': new https.Agent(AGENT_OPTS),
};

const insecureAgents = {
  'http:': agents['http:'],
  'https:': new https.Agent({ ...AGENT_OPTS, rejectUnauthorized: false }),
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

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// Second-level labels that are a registry's own, not somebody's site, under a
// two-letter country code: example.co.uk is a site, co.uk is not.
const GENERIC_SLDS = new Set([
  'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'gob', 'nic', 'mil',
  'ltd', 'plc', 'sch', 'nom', 'or', 'ne', 'go',
]);

/**
 * The site a host belongs to, near enough to what a browser calls one:
 * www.example.com and dl.example.com are one site, a.co.uk and b.co.uk are two.
 * An IP address or a single-label host such as localhost is a site of its own.
 *
 * A heuristic rather than the full public-suffix list, and it errs towards
 * treating hosts as different sites — which only ever means a cookie is not
 * sent, never that it is sent somewhere it should not go.
 */
function siteOf(host) {
  let h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h) return '';
  if (h.includes(':')) return h;                          // IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;         // IPv4
  const labels = h.split('.');
  if (labels.length < 2) return h;                        // localhost and the like
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (labels.length >= 3 && tld.length === 2 && GENERIC_SLDS.has(sld)) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

function siteOfUrl(url) {
  return siteOf(hostOf(url));
}

/**
 * Cookies filed by the site they belong to. A redirect can hand a download
 * from one site to another, and a browser never sends the first site's
 * cookies — a signed-in session, often — to the second. Neither does this:
 * each site only ever gets back what it, or the caller for it, put in.
 */
class SiteJar {
  constructor() { this.sites = new Map(); }

  _for(site) {
    if (!this.sites.has(site)) this.sites.set(site, new Map());
    return this.sites.get(site);
  }

  /** A `name=value; …` header that belongs to this site. */
  addHeader(site, header) {
    if (!site || !header) return;
    const map = this._for(site);
    for (const part of String(header).split(';')) {
      const piece = part.trim();
      const eq = piece.indexOf('=');
      if (eq > 0) map.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
    }
  }

  /**
   * Set-Cookie lines from a response by `host`. They are filed under the
   * host's own site whatever their Domain says: a Domain that matches the
   * host stays inside its site anyway, and one that does not — or that
   * names a whole registry like co.uk — is not allowed to widen the reach.
   */
  addSetCookie(host, setCookie) {
    if (!setCookie) return;
    const site = siteOf(host);
    if (!site) return;
    const map = this._for(site);
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair] = String(line).split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /** The Cookie header for a request to this host: its own site's, nothing else. */
  headerFor(host) {
    const map = this.sites.get(siteOf(host));
    return map ? [...map].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  }
}

/**
 * Issue a request, following redirects by hand so we keep the final URL and any
 * cookies the hops handed us. Resolves with the live response — the caller owns
 * draining or destroying it.
 *
 * The caller's Cookie header belongs to the site of the URL it asked for, and
 * a hop's Set-Cookie to that hop's site; each hop is sent only its own site's
 * cookies. `res.cookieJar` is what the final URL's site holds, which is what
 * a caller may safely send on to that URL again.
 */
function requestNode(url, opts = {}) {
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
    const jar = new SiteJar();
    jar.addHeader(siteOfUrl(url), headers.Cookie || headers.cookie || '');
    let startOrigin = '';
    try { startOrigin = new URL(url).origin; } catch { /* reported below */ }

    const go = (currentUrl) => {
      let u;
      try { u = new URL(currentUrl); } catch { return reject(new Error(`Invalid URL: ${currentUrl}`)); }
      if (!/^https?:$/.test(u.protocol)) return reject(new Error(`Unsupported protocol: ${u.protocol}`));

      const lib = u.protocol === 'https:' ? https : http;
      const agentSet = insecure ? insecureAgents : agents;
      const h = defaultHeaders(currentUrl, headers);
      // defaultHeaders copies the caller's Cookie onto every hop; the jar
      // decides instead, so another site never sees it.
      delete h.Cookie;
      // Credentials given for one origin are not repeated to another that a
      // redirect points at — the rule browsers follow.
      if (u.origin !== startOrigin) delete h.Authorization;
      const cookie = jar.headerFor(u.hostname);
      if (cookie) h.Cookie = cookie;

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
          jar.addSetCookie(u.hostname, res.headers['set-cookie']);

          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            if (++hops > maxRedirects) return reject(new Error('Too many redirects'));
            let next;
            try { next = new URL(res.headers.location, currentUrl).toString(); }
            catch { return reject(new Error('Bad redirect target')); }
            return go(next);
          }

          res.finalUrl = currentUrl;
          res.cookieJar = jar.headerFor(u.hostname);
          res.request = req;
          res.transport = 'node';
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

// ---- Chromium's network stack ----------------------------------------------
//
// Fletch runs inside Electron, which carries a complete copy of Chrome's
// network stack. Plenty of sites — anything behind Cloudflare's or Akamai's
// bot screening, for a start — turn away Node's TLS handshake on sight while
// waving the identical request from Chrome straight through. Asking Chromium
// to make the request gets Chrome's handshake, Chrome's HTTP/2, the system's
// certificate store and the system proxy, and it still speaks byte ranges, so
// a download that has to go this way keeps every one of its parallel workers.
//
// Node stays the first choice: it has no per-host connection ceiling, and it
// is what every other part of Fletch is tested against. A host only moves
// over once it has refused Node, and then stays over for the rest of the
// session so every worker goes straight there.

let electron = null;
let chromiumOverride = null;
const chromiumHosts = new Map();      // host -> why it moved over
const chromiumFailedAt = new Map();   // host -> when Chromium also failed
const CHROMIUM_RETRY_MS = 60 * 1000;

// Chrome holds itself to six connections per host, per network session.
// Spreading requests across several in-memory sessions gives each its own
// six, so a download that moves to Chromium keeps a full pool of workers.
const LANES = 6;
const lanes = [];
let laneCursor = 0;
// Cookies already placed in a lane's jar, so a request does not set them again.
const seeded = new Map();

function electronNet() {
  if (!process.versions.electron || process.type !== 'browser') return null;
  try {
    if (!electron) electron = require('electron');
    if (!electron.net || !electron.app || !electron.app.isReady()) return null;
    return electron;
  } catch {
    return null;
  }
}

function laneSession(e, lane) {
  if (!lanes[lane]) {
    // In memory only, and apart from the window's own session: downloads
    // should neither see nor leave anything behind in the app's UI storage.
    const ses = e.session.fromPartition(`fletch-net-${lane}`, { cache: false });
    try { ses.setUserAgent(UA_DESKTOP); } catch { /* per-request header still applies */ }
    lanes[lane] = ses;
  }
  return lanes[lane];
}

function cookiePairs(header) {
  const out = [];
  for (const part of String(header || '').split(';')) {
    const piece = part.trim();
    const eq = piece.indexOf('=');
    if (eq > 0) out.push([piece.slice(0, eq).trim(), piece.slice(eq + 1).trim()]);
  }
  return out;
}

/**
 * Put the caller's cookies in the lane's jar for this URL.
 *
 * Chromium will not carry a hand-set Cookie header: it drops it on a redirect,
 * and replaces it with the jar's own when the jar is in use. It does keep
 * whatever is in the jar, including cookies a redirect hop sets — which it
 * hides from us — so the jar is where the cookies have to live.
 */
async function seedCookies(ses, lane, url, header) {
  if (!header) return;
  let u;
  try { u = new URL(url); } catch { return; }
  for (const [name, value] of cookiePairs(header)) {
    const key = `${lane}|${u.host}|${name}`;
    if (seeded.get(key) === value) continue;
    try {
      await ses.cookies.set({ url: `${u.protocol}//${u.host}/`, name, value, path: '/' });
      seeded.set(key, value);
    } catch { /* a value Chromium will not store; the request goes without it */ }
  }
}

/** Every cookie the lane's jar would send to this URL, as a header. */
async function jarHeader(ses, url) {
  try {
    const list = await ses.cookies.get({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

/** Normalise Chromium's header record into the shape Node hands out. */
function nodeHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const key = k.toLowerCase();
    if (key === 'set-cookie') out[key] = Array.isArray(v) ? v : [v];
    else out[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/**
 * The same contract as requestNode — resolves with a readable response that
 * carries statusCode, headers, finalUrl, cookieJar and a request handle that
 * can be destroyed — but made by Chromium.
 */
function requestChromium(url, opts = {}) {
  const e = electronNet();
  if (!e) return Promise.reject(new Error('Chromium network stack unavailable'));
  const {
    method = 'GET',
    headers = {},
    maxRedirects = 10,
    timeout = 30000,
    signal,
  } = opts;

  const lane = laneCursor++ % LANES;
  const ses = laneSession(e, lane);
  const given = headers.Cookie || headers.cookie || '';
  let site = '';
  let startOrigin = '';
  try {
    site = siteOf(new URL(url).hostname);
    startOrigin = new URL(url).origin;
  } catch { /* reported below */ }

  return new Promise((resolve, reject) => {
    let hops = 0;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const go = async (currentUrl) => {
      let u;
      try { u = new URL(currentUrl); } catch { return fail(new Error(`Invalid URL: ${currentUrl}`)); }
      if (!/^https?:$/.test(u.protocol)) return fail(new Error(`Unsupported protocol: ${u.protocol}`));

      // The caller's cookies go with every hop on the same site, as they do
      // on the Node side; a hop to some other site does not get them.
      if (given && siteOf(u.hostname) === site) await seedCookies(ses, lane, currentUrl, given);

      const h = defaultHeaders(currentUrl, headers);
      delete h.Connection; // Chromium manages its own connections
      delete h.Cookie;     // the jar supplies these; see seedCookies
      if (u.origin !== startOrigin) delete h.Authorization; // as requestNode

      let req;
      try {
        req = e.net.request({
          method,
          url: currentUrl,
          session: ses,
          // Redirects are re-issued here rather than followed by Chromium, so
          // every hop carries the same headers and the final URL is known.
          redirect: 'manual',
          cache: 'no-store',
          // Send the Referer as given; some hosts check the full page URL.
          referrerPolicy: 'unsafe-url',
          useSessionCookies: true,
        });
        for (const [k, v] of Object.entries(h)) {
          try { req.setHeader(k, v); } catch { /* one Chromium will not let us set */ }
        }
      } catch (err) {
        return fail(err);
      }

      let done = false; // this hop has handed over or been abandoned
      let timer = null;
      let body = null;  // the stream handed to the caller, once there is one
      const abort = () => { try { req.abort(); } catch { /* already closed */ } };
      const arm = (fn) => { clearTimeout(timer); timer = setTimeout(fn, timeout); };
      arm(() => { if (!done) { done = true; abort(); fail(new Error(`Timed out after ${Math.round(timeout / 1000)}s`)); } });

      req.on('login', (_info, callback) => callback()); // no credentials to give
      req.on('error', (err) => {
        clearTimeout(timer);
        // Mid-body, the failure belongs to whoever is reading the body.
        if (body) { body.destroy(err); return; }
        if (done) return;
        done = true;
        fail(err);
      });

      req.on('redirect', (code, _m, redirectUrl) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Any cookie this hop set is already in the jar; Chromium put it there.
        abort(); // not following it ourselves cancels this request
        if (++hops > maxRedirects) return fail(new Error('Too many redirects'));
        let next;
        try { next = new URL(redirectUrl, currentUrl).toString(); }
        catch { return fail(new Error('Bad redirect target')); }
        go(next).catch(fail);
      });

      req.on('response', (res) => {
        if (done) { abort(); return; }
        done = true;
        const resHeaders = nodeHeaders(res.headers);

        // Hand back a plain Node stream so every caller can treat both
        // transports alike. The pipe carries backpressure through to Chromium.
        const out = new PassThrough({ highWaterMark: 1024 * 1024 });
        out.statusCode = res.statusCode;
        out.statusMessage = res.statusMessage || '';
        out.headers = resHeaders;
        out.finalUrl = currentUrl;
        out.cookieJar = given;
        out.transport = 'chromium';
        let ended = false;
        out.request = { destroy: () => { if (!ended) abort(); } };

        // Every listener goes on now, before anything can happen to the body.
        // An idle body is a dead connection, as it is for the Node transport.
        const idle = () => out.destroy(new Error(`Timed out after ${Math.round(timeout / 1000)}s`));
        arm(idle);
        res.on('data', () => arm(idle));
        res.on('end', () => { ended = true; clearTimeout(timer); });
        res.on('aborted', () => { clearTimeout(timer); out.destroy(new Error('Connection aborted')); });
        res.on('error', (err) => { clearTimeout(timer); out.destroy(err); });
        out.on('close', () => { clearTimeout(timer); if (!ended) abort(); });
        // Kept quiet until the caller has it; a failure before then is
        // reported through the promise instead.
        out.on('error', () => {});
        body = out;
        res.pipe(out);

        // Everything the site has set along the way, for callers that carry
        // the session on to other requests (the probe hands it to the workers).
        // Chromium's jar is already scoped to this URL; the caller's own
        // cookies only join it if the redirects ended on the site they
        // were given for.
        jarHeader(ses, currentUrl).then((fromJar) => {
          const ownSite = siteOf(u.hostname) === site;
          out.cookieJar = pickCookies(resHeaders['set-cookie'], mergeCookieHeader(ownSite ? given : '', fromJar));
          if (out.destroyed && !ended) return fail(out.errored || new Error('Connection closed'));
          if (settled) { out.destroy(); return; }
          settled = true;
          resolve(out);
        });
      });

      if (signal) {
        if (signal.aborted) { done = true; abort(); return fail(new Error('Aborted')); }
        signal.addEventListener('abort', () => { abort(); fail(new Error('Aborted')); }, { once: true });
      }

      if (opts.body) req.write(opts.body);
      req.end();
    };

    go(url).catch(fail);
  });
}

function mergeCookieHeader(...headers) {
  const map = new Map();
  for (const header of headers) for (const [k, v] of cookiePairs(header)) map.set(k, v);
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** The Chromium transport, if this process has one. */
function chromiumTransport() {
  if (chromiumOverride) return chromiumOverride;
  return electronNet() ? requestChromium : null;
}

/** Failures Node hits before any response arrives that Chromium may not. */
function isConnectionError(err) {
  const msg = String(err && err.message || err || '');
  const code = String(err && err.code || '');
  if (/^(Invalid URL|Unsupported protocol|Too many redirects|Bad redirect target|Aborted)/.test(msg)) return false;
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPROTO|EPIPE|ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(code)
    || /econnreset|socket hang up|connection (reset|aborted|refused)|tls|ssl|certificate|issuer|timed out/i.test(msg);
}

/**
 * Does this response look like a bot screen rather than a real answer? Any
 * 403 is worth one try as Chrome: it costs one request and the difference is
 * often the whole download. A 429 or 503 is usually honest throttling, which
 * the downloader handles itself, so those only count with a screen's mark.
 */
function looksLikeBotWall(res) {
  const code = res.statusCode || 0;
  if (code !== 403 && code !== 429 && code !== 503) return false;
  const h = res.headers || {};
  if (h['cf-mitigated'] || h['x-datadome'] || h['x-amzn-waf-action'] || h['x-sucuri-id']) return true;
  if (/cloudflare|akamai|ddos-guard|sucuri|incapsula|imperva/i.test(String(h.server || ''))) return true;
  return code === 403;
}

function rememberChromium(reason, ...urls) {
  for (const url of urls) {
    const host = hostOf(url);
    if (host) chromiumHosts.set(host, reason);
  }
}

function chromiumRecentlyFailed(url) {
  const at = chromiumFailedAt.get(hostOf(url));
  return Boolean(at && Date.now() - at < CHROMIUM_RETRY_MS);
}

function drop(res) {
  try { res.resume(); } catch { /* ignore */ }
  try { res.destroy(); } catch { /* ignore */ }
}

/**
 * Make a request through whichever network stack this host accepts.
 *
 * `opts.transport` forces one: 'node' or 'chromium'. Left out, Node is tried
 * first and Chromium takes over when Node is refused.
 */
async function request(url, opts = {}) {
  const chromium = opts.transport === 'node' ? null : chromiumTransport();
  if (!chromium) return requestNode(url, opts);
  if (opts.transport === 'chromium' || chromiumHosts.has(hostOf(url))) return chromium(url, opts);

  let res;
  try {
    res = await requestNode(url, opts);
  } catch (err) {
    if (!isConnectionError(err) || chromiumRecentlyFailed(url)) throw err;
    try {
      const alt = await chromium(url, opts);
      rememberChromium(`Node: ${err.message}`, url, alt.finalUrl);
      return alt;
    } catch (altErr) {
      chromiumFailedAt.set(hostOf(url), Date.now());
      throw new Error(`${err.message} (and through the browser network stack: ${altErr.message})`);
    }
  }

  if (!looksLikeBotWall(res) || chromiumRecentlyFailed(url)) return res;
  let alt;
  try {
    alt = await chromium(url, opts);
  } catch {
    chromiumFailedAt.set(hostOf(url), Date.now());
    return res;
  }
  if ((alt.statusCode || 0) < 400) {
    drop(res);
    rememberChromium(`Node: HTTP ${res.statusCode}`, url, res.finalUrl, alt.finalUrl);
    return alt;
  }
  // Chrome got no further. The original answer is the one to report.
  drop(alt);
  chromiumFailedAt.set(hostOf(url), Date.now());
  return res;
}

/** Send every later request to this URL's host through Chromium, if there is one. */
function useChromiumFor(url, reason = 'asked to') {
  if (chromiumTransport()) rememberChromium(reason, url);
}

/** Which stack a request to this URL would go out on. For display and tests. */
function transportFor(url) {
  if (!chromiumTransport()) return 'node';
  return chromiumHosts.has(hostOf(url)) ? 'chromium' : 'node';
}

/** Read a whole response into memory. For playlists and API calls, never media. */
async function fetchText(url, opts = {}) {
  const limit = opts.maxBytes || 16 * 1024 * 1024;
  const res = await request(url, opts);
  const code = res.statusCode || 0;
  if (code < 200 || code >= 300) {
    drop(res);
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
    drop(res);
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

/**
 * Tests only: stand in for Chromium's stack (pass null to remove), and forget
 * which hosts have moved over.
 */
function _setChromiumTransport(fn) {
  chromiumOverride = fn || null;
  chromiumHosts.clear();
  chromiumFailedAt.clear();
}

module.exports = {
  request, fetchText, fetchBuffer, defaultHeaders,
  requestNode, requestChromium, transportFor, useChromiumFor, isConnectionError, looksLikeBotWall,
  siteOf, _setChromiumTransport,
};
