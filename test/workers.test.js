// Every download should end up on as many parallel workers as the server will
// allow, whatever route it took to get there:
//  1. a file whose size nobody could learn up front is split once the first
//     response says how big it is
//  2. a body with no length at all still finishes, on one stream
//  3. a chunk ceiling keeps each request short and reuses its socket
//  4. a server that answers extra connections with 403 is capping sockets,
//     not refusing ranges: ease off, do not fall back to a single stream
//  5. a host that turns Node away is retried on Chromium's network stack
//     (a stand-in here), and every worker follows it there
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { HttpDownload } = require('../src/main/engine/http-download.js');
const net = require('../src/main/engine/net.js');

const SIZE = 24 * 1024 * 1024 + 4321;
const DATA = crypto.randomBytes(SIZE);
const EXPECTED = crypto.createHash('sha256').update(DATA).digest('hex');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };

// One server, several personalities, chosen by path.
const stats = { live: 0, peak: 0, sockets: new Set(), maxAsked: 0, refused: 0, requests: 0 };
// Each case gets a fresh generation, so a late close from the last case cannot
// leak into this one's count.
let generation = 0;
const resetStats = () => { generation++; Object.assign(stats, { live: 0, peak: 0, sockets: new Set(), maxAsked: 0, refused: 0, requests: 0 }); };
const CAP = 3;
let socketId = 0;

const server = http.createServer((req, res) => {
  stats.requests++;
  if (!req.socket.fletchId) req.socket.fletchId = ++socketId;
  stats.sockets.add(req.socket.fletchId);
  const route = req.url.split('?')[0];
  const fromChrome = req.headers['x-stand-in-chromium'] === '1';

  // 5. Turns Node away, as a bot screen would.
  if (route === '/screened.bin' && !fromChrome) {
    res.writeHead(403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge', Server: 'cloudflare' });
    return res.end('<html>Just a moment...</html>');
  }
  if (route === '/reset.bin' && !fromChrome) {
    req.socket.destroy(); // a TLS-fingerprint block looks like this from Node's side
    return;
  }

  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  // 4. Accepts three at once and answers the rest with 403.
  if (route === '/capped.bin' && stats.live >= CAP) {
    stats.refused++;
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  stats.live++;
  stats.peak = Math.max(stats.peak, stats.live);
  let counted = true;
  const born = generation;
  const release = () => { if (counted) { counted = false; if (born === generation) stats.live--; } };
  res.on('close', release);
  res.on('finish', release);

  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
  stats.maxAsked = Math.max(stats.maxAsked, end - start + 1);

  const headers = { 'Content-Type': 'application/octet-stream' };
  // 2. No length, no ranges: the end of the body is the end of the file.
  if (route === '/nolength.bin') {
    res.writeHead(200, headers);
  } else {
    headers['Accept-Ranges'] = 'bytes';
    headers['Content-Length'] = String(end - start + 1);
    if (m) headers['Content-Range'] = `bytes ${start}-${end}/${SIZE}`;
    res.writeHead(m ? 206 : 200, headers);
  }

  // Dribble it out. Routes marked slow hold each connection to about 3 MB/s,
  // like a host with a per-connection cap, so there is time for the pool to
  // grow and for the extra connections to collide with a limit.
  const slow = /slow/.test(req.url);
  let pos = start;
  const tick = () => {
    if (res.destroyed) return;
    if (pos > end) return res.end();
    const n = Math.min(slow ? 64 * 1024 : 256 * 1024, end - pos + 1);
    const ok = res.write(DATA.subarray(pos, pos + n));
    pos += n;
    // A capped connection waits its turn even when the socket could take more.
    if (slow) setTimeout(tick, 20);
    else if (ok) setTimeout(tick, 4);
    else res.once('drain', tick);
  };
  tick();
});

async function fetchWith(dir, name, spec) {
  const dl = new HttpDownload({ filePath: path.join(dir, name), ...spec });
  let peakConns = 0;
  let peakSegs = 0;
  const warnings = [];
  dl.on('progress', (p) => {
    peakConns = Math.max(peakConns, p.connections);
    peakSegs = Math.max(peakSegs, p.segments.length);
  });
  dl.on('warning', (w) => warnings.push(w));
  const t0 = Date.now();
  await dl.start();
  return { dl, peakConns, peakSegs, warnings, secs: (Date.now() - t0) / 1000, file: path.join(dir, name) };
}

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-workers-'));
  try {
    // ---- 1. size unknown at the start ----
    resetStats();
    let r = await fetchWith(dir, 'unknown.bin', { url: `${base}/unknown.bin?slow`, size: null, acceptRanges: undefined, connections: 8 });
    check(r.dl.size === SIZE, `learned the size from the first response (${r.dl.size})`);
    check(r.peakConns > 1, `one stream grew into parallel workers (peak ${r.peakConns}, ${r.peakSegs} segments, ${r.secs.toFixed(1)}s)`);
    check(sha(r.file) === EXPECTED, 'the split download is byte-perfect');

    // ---- 2. no length at all ----
    resetStats();
    r = await fetchWith(dir, 'nolength.bin', { url: `${base}/nolength.bin`, size: null, acceptRanges: undefined, connections: 8 });
    check(sha(r.file) === EXPECTED, `a body with no length still finishes, intact (${r.secs.toFixed(1)}s)`);

    // ---- 3. chunked requests ----
    resetStats();
    const CHUNK = 2 * 1024 * 1024;
    r = await fetchWith(dir, 'chunked.bin', { url: `${base}/chunked.bin`, size: SIZE, acceptRanges: true, connections: 4, chunkSize: CHUNK });
    check(stats.maxAsked <= CHUNK, `no request asked for more than one chunk (largest ${(stats.maxAsked / 1048576).toFixed(2)} MB)`);
    check(stats.requests >= Math.ceil(SIZE / CHUNK), `walked the file in chunks (${stats.requests} requests)`);
    check(stats.sockets.size < stats.requests, `chunks reused their sockets (${stats.sockets.size} sockets for ${stats.requests} requests)`);
    check(sha(r.file) === EXPECTED, 'the chunked download is byte-perfect');

    // ---- 4. 403 on the connections over the cap ----
    resetStats();
    r = await fetchWith(dir, 'capped.bin', { url: `${base}/capped.bin?slow`, size: SIZE, acceptRanges: true, connections: 10 });
    check(stats.refused > 0, `the server refused some connections (${stats.refused} times)`);
    check(!r.warnings.some((w) => /one stream/i.test(w)), 'did not give up on ranges and fall back to one stream');
    check(stats.peak > 1 && stats.peak <= CAP, `kept parallel workers, within the cap (server saw ${stats.peak} at once against a cap of ${CAP})`);
    check(sha(r.file) === EXPECTED, `finished intact in ${r.secs.toFixed(1)}s`);

    // ---- 5. Chromium takes over where Node is turned away ----
    // The stand-in marks its requests so the server can tell them apart.
    let viaChromium = 0;
    net._setChromiumTransport((url, opts = {}) => {
      viaChromium++;
      return net.requestNode(url, { ...opts, headers: { ...(opts.headers || {}), 'X-Stand-In-Chromium': '1' } });
    });

    resetStats();
    r = await fetchWith(dir, 'screened.bin', { url: `${base}/screened.bin`, size: SIZE, acceptRanges: true, connections: 6 });
    check(net.transportFor(`${base}/screened.bin`) === 'chromium', 'a bot-screened host moved over to Chromium');
    check(r.peakConns > 1, `and kept its parallel workers there (peak ${r.peakConns}, ${viaChromium} requests via Chromium)`);
    check(sha(r.file) === EXPECTED, 'the screened download is byte-perfect');

    // Installing the stand-in again also forgets which hosts already moved.
    net._setChromiumTransport((url, opts = {}) => {
      viaChromium++;
      return net.requestNode(url, { ...opts, headers: { ...(opts.headers || {}), 'X-Stand-In-Chromium': '1' } });
    });
    resetStats();
    r = await fetchWith(dir, 'reset.bin', { url: `${base}/reset.bin`, size: SIZE, acceptRanges: true, connections: 6 });
    check(net.transportFor(`${base}/reset.bin`) === 'chromium', 'a host that resets Node’s connections moved over to Chromium');
    check(sha(r.file) === EXPECTED, 'the reset-prone download is byte-perfect');

    // Without a Chromium stack the same block is reported, not hidden.
    net._setChromiumTransport(null);
    let message = '';
    try {
      const res = await net.request(`${base}/screened.bin`);
      message = `HTTP ${res.statusCode}`;
      res.resume();
    } catch (err) { message = err.message; }
    check(/403/.test(message), `with no Chromium stack the refusal is passed through (${message})`);
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    net._setChromiumTransport(null);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
});
