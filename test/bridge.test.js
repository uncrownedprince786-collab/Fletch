// The loopback endpoint is the only thing on this machine that will queue a
// download on command, so who it answers to matters. Automatic pairing hands
// the token to the extension on the strength of the Origin header the browser
// stamps on the request — a header a web page cannot forge — and nothing else
// may have it.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { Bridge } = require('../src/main/bridge.js');
const { JsonStore } = require('../src/main/store.js');

const EXTENSION = 'lmaaeoobpbmcgnaelmpakgnhbhaoejim';
const GOOD_ORIGIN = `chrome-extension://${EXTENSION}`;

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: {
        ...headers,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-bridge-'));
  const settings = new JsonStore(path.join(home, 's.json'), {});
  settings.load();

  const queued = [];
  let pairedCalls = 0;
  const bridge = new Bridge({
    settings,
    manager: {
      add: async (url) => { queued.push(url); return { id: 'x', title: url }; },
      stats: () => ({ speed: 0, active: 0, queued: queued.length, total: queued.length }),
    },
    onActivate: () => {},
    onPaired: () => { pairedCalls++; },
  });

  try {
    const port = await bridge.start(0);
    check(Boolean(port), `bridge listening on 127.0.0.1:${port}`);

    // --- /ping is open, so the extension can tell whether the app is up ---
    const ping = await call(port, '/ping');
    check(ping.status === 200 && ping.json.app === 'Fletch', 'anyone may ask whether Fletch is running');

    // --- pairing ---
    const paired = await call(port, '/pair', { headers: { Origin: GOOD_ORIGIN } });
    check(paired.status === 200 && paired.json.token === bridge.token,
      'the extension is handed the token on request');
    check(pairedCalls === 1, 'the app is told that pairing happened');
    check(paired.headers['access-control-allow-origin'] === GOOD_ORIGIN,
      'the response is addressed back to that extension, not to everyone');

    const strangerExt = await call(port, '/pair', {
      headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    check(strangerExt.status === 403, 'a different extension is refused the token');

    const webPage = await call(port, '/pair', { headers: { Origin: 'https://example.com' } });
    check(webPage.status === 403, 'a web page is refused the token');

    const noOrigin = await call(port, '/pair');
    check(noOrigin.status === 403, 'a request with no origin at all is refused the token');

    // --- queueing ---
    const byToken = await call(port, '/add', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridge.token}` },
      body: { url: 'https://example.com/a.mp4', show: false },
    });
    check(byToken.status === 200, 'the token still works for queueing');

    const byIdentity = await call(port, '/add', {
      method: 'POST',
      headers: { Origin: GOOD_ORIGIN },
      body: { url: 'https://example.com/b.mp4', show: false },
    });
    check(byIdentity.status === 200, 'the extension may queue without carrying the token');

    const anonymous = await call(port, '/add', {
      method: 'POST',
      body: { url: 'https://evil.example/c.mp4', show: false },
    });
    check(anonymous.status === 401, 'an unidentified caller may not queue');

    const pageTrying = await call(port, '/add', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: { url: 'https://evil.example/d.mp4', show: false },
    });
    check(pageTrying.status === 401, 'a web page may not queue, even naming itself');

    // --- identifying the extension when Chrome sends no Origin ---
    // This is the case that actually happens: a fetch from an extension
    // service worker often carries no Origin at all, and requiring one meant
    // the extension could never pair while curl, which sends it, worked.
    const headerOnly = await call(port, '/pair', { headers: { 'X-Fletch-Extension': EXTENSION } });
    check(headerOnly.status === 200 && headerOnly.json.token === bridge.token,
      'an extension naming itself, with no Origin, can pair');

    const headerQueue = await call(port, '/add', {
      method: 'POST',
      headers: { 'X-Fletch-Extension': EXTENSION },
      body: { url: 'https://example.com/f.mp4', show: false },
    });
    check(headerQueue.status === 200, 'and can queue');

    const wrongHeader = await call(port, '/pair', {
      headers: { 'X-Fletch-Extension': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    check(wrongHeader.status === 403, 'a different extension id in that header is refused');

    const junkHeader = await call(port, '/pair', { headers: { 'X-Fletch-Extension': 'not-an-id' } });
    check(junkHeader.status === 403, 'a malformed id is refused');

    // The important one: a page must not get in by setting the header itself.
    // A browser always puts an Origin on a page's cross-origin request, so an
    // http(s) Origin is conclusive regardless of what else is claimed.
    const pageWithHeader = await call(port, '/pair', {
      headers: { Origin: 'https://evil.example', 'X-Fletch-Extension': EXTENSION },
    });
    check(pageWithHeader.status === 403,
      'a web page claiming the extension id is still refused');

    const pageQueueWithHeader = await call(port, '/add', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'X-Fletch-Extension': EXTENSION },
      body: { url: 'https://evil.example/g.mp4', show: false },
    });
    check(pageQueueWithHeader.status === 401,
      'and cannot queue that way either');

    // ...and it could not even send the header: the preflight does not allow it.
    const preflight = await call(port, '/add', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Headers': 'x-fletch-extension' },
    });
    const allowed = String(preflight.headers['access-control-allow-headers'] || '').toLowerCase();
    check(!allowed.includes('x-fletch-extension'),
      `the preflight refuses that header to a page (allows: ${allowed || 'nothing'})`);

    const wrongToken = await call(port, '/add', {
      method: 'POST',
      headers: { Authorization: `Bearer ${'0'.repeat(bridge.token.length)}` },
      body: { url: 'https://evil.example/e.mp4', show: false },
    });
    check(wrongToken.status === 401, 'a wrong token is refused');

    check(queued.every((u) => /^https:\/\/example\.com\//.test(u)),
      `only authorised requests reached the queue (${queued.length}, none from evil.example)`);
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    bridge.stop();
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
})();
