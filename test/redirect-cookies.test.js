'use strict';
// A download link that redirects to another site must not take the first
// site's cookies with it. A browser never does that, and those cookies are
// often a signed-in session handed over by the extension.
//
// 127.0.0.1 and localhost reach the same test server but are different sites,
// which is all it takes to tell a same-site redirect from a cross-site one.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const net = require('../src/main/engine/net.js');
const { HttpDownload } = require('../src/main/engine/http-download.js');

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };

const SIZE = 3 * 1024 * 1024 + 17;
const BODY = crypto.randomBytes(SIZE);
const EXPECTED = crypto.createHash('sha256').update(BODY).digest('hex');
let port = 0;
let fileRefusals = 0;

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  const echo = (extra = {}) => {
    res.writeHead(200, { 'Content-Type': 'application/json', ...extra });
    res.end(JSON.stringify({
      host: req.headers.host,
      cookie: req.headers.cookie || '',
      authorization: req.headers.authorization || '',
    }));
  };
  const hop = (to, setCookie) => {
    res.writeHead(302, { Location: to, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) });
    res.end();
  };

  // Same site all the way.
  if (route === '/same-start') return hop(`http://127.0.0.1:${port}/same-end`, 'hop1=a; Path=/');
  if (route === '/same-end') return echo();

  // Off to another site, which sets a cookie of its own.
  if (route === '/cross-start') return hop(`http://localhost:${port}/cross-end`, 'hop1=a; Path=/');
  if (route === '/cross-end') return echo({ 'Set-Cookie': 'theirs=z; Path=/' });

  // A Domain attribute naming the other site must not smuggle a cookie over.
  if (route === '/smuggle') return hop(`http://localhost:${port}/cross-end`, 'sneaky=1; Domain=localhost; Path=/');

  // Away and back: the first site's cookies are still its own on return.
  if (route === '/away') return hop(`http://localhost:${port}/back`, 'hop1=a; Path=/');
  if (route === '/back') return hop(`http://127.0.0.1:${port}/home-again`);
  if (route === '/home-again') return echo();

  // A file host that hands out a ticket on the redirect and checks it after.
  if (route === '/file') return hop(`http://127.0.0.1:${port}/file.bin`, 'ticket=ok; Path=/');
  if (route === '/file.bin') {
    if (!/ticket=ok/.test(req.headers.cookie || '') || !/session=abc/.test(req.headers.cookie || '')) {
      fileRefusals++;
      res.writeHead(403);
      return res.end('no ticket');
    }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    const h = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
    if (m) h['Content-Range'] = `bytes ${start}-${end}/${SIZE}`;
    res.writeHead(m ? 206 : 200, h);
    return res.end(BODY.subarray(start, end + 1));
  }
  res.writeHead(404);
  res.end();
});

async function json(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Dual-stack where the machine has IPv6, so "localhost" answers whichever
// way it resolves; plain IPv4 otherwise.
function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', () => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port)).once('error', reject);
    });
    server.listen({ port: 0, host: '::', ipv6Only: false }, () => resolve(server.address().port));
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-redir-'));
  try {
    port = await listen();
    const base = `http://127.0.0.1:${port}`;
    const caller = { headers: { Cookie: 'session=abc' } };

    // ---- what counts as one site ----
    const same = (a, b) => net.siteOf(a) === net.siteOf(b);
    check(same('www.example.com', 'dl.example.com'), 'www.example.com and dl.example.com are one site');
    check(same('example.com', 'www.example.com'), 'example.com and www.example.com are one site');
    check(same('www.example.co.uk', 'dl.example.co.uk'), 'two hosts under example.co.uk are one site');
    check(!same('a.co.uk', 'b.co.uk'), 'a.co.uk and b.co.uk are different sites');
    check(same('cdn.example.com.pk', 'example.com.pk'), 'cdn.example.com.pk and example.com.pk are one site');
    check(!same('example.com', 'example.net'), 'example.com and example.net are different sites');
    check(!same('127.0.0.1', 'localhost'), '127.0.0.1 and localhost are different sites');
    check(!same('10.0.0.1', '10.0.0.2'), 'two IP addresses are different sites');
    check(same('[::1]', '::1'), 'an IPv6 address is its own site, bracketed or not');

    // ---- same-site redirect: everything carries on as before ----
    let res = await net.request(`${base}/same-start`, caller);
    let seen = await json(res);
    check(/session=abc/.test(seen.cookie) && /hop1=a/.test(seen.cookie),
      `a same-site redirect keeps the caller's cookie and the hop's (${seen.cookie})`);
    check(/session=abc/.test(res.cookieJar) && /hop1=a/.test(res.cookieJar), `and both are in the jar handed back (${res.cookieJar})`);

    // ---- cross-site redirect: nothing of the first site's goes over ----
    res = await net.request(`${base}/cross-start`, caller);
    seen = await json(res);
    check(/^localhost/.test(seen.host), `the redirect really did land on the other site (${seen.host})`);
    check(!/session=abc/.test(seen.cookie), `the caller's cookie was not sent to the other site ("${seen.cookie}")`);
    check(!/hop1=a/.test(seen.cookie), 'nor was the cookie the first site set on the way');
    check(!/session=abc|hop1=a/.test(res.cookieJar) && /theirs=z/.test(res.cookieJar),
      `the jar handed back holds only the final site's own cookies ("${res.cookieJar}")`);

    res = await net.request(`${base}/smuggle`, {});
    seen = await json(res);
    check(!/sneaky/.test(seen.cookie), 'a cookie whose Domain names the other site is not carried over to it');

    // ---- a login header goes no further than the origin it was given for ----
    const authed = { headers: { Authorization: 'Bearer t0ken' } };
    res = await net.request(`${base}/same-start`, authed);
    seen = await json(res);
    check(seen.authorization === 'Bearer t0ken', 'an Authorization header survives a redirect within its origin');
    res = await net.request(`${base}/cross-start`, authed);
    seen = await json(res);
    check(!seen.authorization, `and is dropped when a redirect leads to another site ("${seen.authorization || ''}")`);

    // ---- there and back: the first site gets its own cookies again ----
    res = await net.request(`${base}/away`, caller);
    seen = await json(res);
    check(/session=abc/.test(seen.cookie) && /hop1=a/.test(seen.cookie),
      `coming back to the first site, its cookies come back too (${seen.cookie})`);

    // ---- a real download through a same-site redirect still works ----
    const dl = new HttpDownload({
      url: `${base}/file`, filePath: path.join(dir, 'f.bin'), size: SIZE, acceptRanges: true,
      connections: 4, headers: { Cookie: 'session=abc' },
    });
    let peak = 0;
    dl.on('progress', (p) => { peak = Math.max(peak, p.connections); });
    await dl.start();
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'f.bin'))).digest('hex');
    check(got === EXPECTED, `a parallel download through a same-site redirect is byte-perfect (${peak} connections)`);
    check(fileRefusals === 0, 'every request carried both the caller’s cookie and the redirect’s ticket');
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    process.exitCode = failed ? 1 : 0;
  }
})();
