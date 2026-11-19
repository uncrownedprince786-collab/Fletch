'use strict';
// Runs inside Electron (npm run test:electron), because the thing under test
// is Chromium's own network stack. Checks that a request made through it
// behaves like one made through Node — the same headers reach the server,
// cookies survive redirects, byte ranges work — and that a whole segmented
// download can run through it with every parallel worker.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const net = require('../src/main/engine/net.js');
const { HttpDownload } = require('../src/main/engine/http-download.js');

const SIZE = 48 * 1024 * 1024 + 99;
const BODY = crypto.randomBytes(SIZE);
const EXPECTED = crypto.createHash('sha256').update(BODY).digest('hex');

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };

let live = 0;
let peak = 0;
const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (route === '/echo') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fresh=yes; Path=/' });
    return res.end(JSON.stringify(req.headers));
  }
  if (route === '/hop') {
    res.writeHead(302, { Location: '/echo?after-hop', 'Set-Cookie': 'hop=1; Path=/' });
    return res.end();
  }
  live++;
  peak = Math.max(peak, live);
  let counted = true;
  const release = () => { if (counted) { counted = false; live--; } };
  res.on('close', release);
  res.on('finish', release);
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
  const h = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (m) h['Content-Range'] = `bytes ${start}-${end}/${SIZE}`;
  res.writeHead(m ? 206 : 200, h);
  let pos = start;
  // A per-connection cap, like many real hosts, so that every worker is
  // still busy when the last one starts and the count of them means something.
  if (route === '/paced.bin') {
    const tick = () => {
      if (res.destroyed) return;
      if (pos > end) return res.end();
      const n = Math.min(64 * 1024, end + 1 - pos);
      res.write(BODY.subarray(pos, pos + n));
      pos += n;
      setTimeout(tick, 10);
    };
    return tick();
  }
  const pump = () => {
    while (pos <= end && !res.destroyed) {
      const n = Math.min(256 * 1024, end + 1 - pos);
      const ok = res.write(BODY.subarray(pos, pos + n));
      pos += n;
      if (!ok) return res.once('drain', pump);
    }
    if (pos > end) res.end();
  };
  pump();
});

async function readJson(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function timedDownload(url, dir, name) {
  peak = 0;
  const dl = new HttpDownload({ url, filePath: path.join(dir, name), size: SIZE, acceptRanges: true, connections: 8 });
  let note = '';
  dl.on('progress', (p) => { if (p.note) note = p.note; });
  const t0 = Date.now();
  await dl.start();
  const secs = (Date.now() - t0) / 1000;
  const intact = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex') === EXPECTED;
  return { secs, intact, peak, note, mbps: (SIZE / 1048576) / secs };
}

app.whenReady().then(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))).then(async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-chromium-'));
  try {
    // ---- headers ----
    let res = await net.requestChromium(`${base}/echo`, {
      headers: { Cookie: 'session=abc', Referer: 'https://site.test/watch?v=1', 'X-Extra': 'kept' },
    });
    check(res.transport === 'chromium', 'the request went out through Chromium');
    const seenHeaders = await readJson(res);
    check(seenHeaders.cookie === 'session=abc', `the Cookie header arrived (${seenHeaders.cookie})`);
    check(seenHeaders.referer === 'https://site.test/watch?v=1', `the full Referer arrived (${seenHeaders.referer})`);
    check(/Chrome\/\d+/.test(seenHeaders['user-agent'] || '') && !/Electron/.test(seenHeaders['user-agent']),
      'the User-Agent is Chrome’s, not Electron’s');
    check((seenHeaders['accept-encoding'] || '') === 'identity', `bodies are asked for uncompressed (${seenHeaders['accept-encoding']})`);
    check(seenHeaders['x-extra'] === 'kept', 'custom headers pass through');
    check(Array.isArray(res.headers['set-cookie']) && res.cookieJar.includes('fresh=yes'), 'Set-Cookie is read back');

    // ---- redirects carry cookies, and the final URL is known ----
    res = await net.requestChromium(`${base}/hop`, { headers: { Cookie: 'session=abc' } });
    const afterHop = await readJson(res);
    check(/after-hop/.test(res.finalUrl), `the redirect was followed (${res.finalUrl.replace(base, '')})`);
    check(/hop=1/.test(afterHop.cookie || '') && /session=abc/.test(afterHop.cookie || ''),
      `the hop's cookie went with the next request (${afterHop.cookie})`);

    // ---- byte ranges ----
    res = await net.requestChromium(`${base}/file.bin`, { headers: { Range: 'bytes=100-199' } });
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const got = Buffer.concat(chunks);
    check(res.statusCode === 206 && got.equals(BODY.subarray(100, 200)), `a ranged request returns exactly that range (HTTP ${res.statusCode}, ${got.length} bytes)`);

    // ---- abandoning a response mid-body ----
    res = await net.requestChromium(`${base}/file.bin`, {});
    await new Promise((r) => res.once('data', r));
    res.destroy();
    await new Promise((r) => setTimeout(r, 300));
    check(live === 0, 'destroying a response closes its connection');

    // ---- a whole segmented download, each way ----
    const viaNode = await timedDownload(`${base}/node.bin`, dir, 'node.bin');
    net.useChromiumFor(`${base}/`);
    check(net.transportFor(`${base}/x`) === 'chromium', 'a host can be moved to Chromium for every later request');
    const viaChromium = await timedDownload(`${base}/chromium.bin`, dir, 'chromium.bin');
    check(viaChromium.intact, 'a segmented download through Chromium is byte-perfect');
    check(/Chrome/.test(viaChromium.note), `the progress note says which stack it used ("${viaChromium.note}")`);
    // Past Chrome's own limit of six connections per host, which the
    // download spreads across several network sessions to get around.
    const paced = await timedDownload(`${base}/paced.bin`, dir, 'paced.bin');
    check(paced.intact && paced.peak >= 8, `and keeps all 8 parallel workers, beyond Chrome's 6-per-host limit (${paced.peak} at once)`);
    console.log(`      speed on loopback: Node ${viaNode.mbps.toFixed(0)} MB/s, Chromium ${viaChromium.mbps.toFixed(0)} MB/s`);
    check(viaNode.intact, 'the same download through Node is byte-perfect too');
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failed ? `\n${failed} check(s) failed` : '\nall Chromium checks passed');
    app.exit(failed ? 1 : 0);
  }
});
