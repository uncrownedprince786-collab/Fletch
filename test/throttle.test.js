// Servers that cap concurrent connections answer the extras with 429. Fletch
// must read that as "use fewer sockets" and still finish, rather than retrying
// into the same wall. Also covers the stall detector.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { HttpDownload } = require('../src/main/engine/http-download.js');

const SIZE = 16 * 1024 * 1024;
const DATA = crypto.randomBytes(SIZE);
const EXPECTED = crypto.createHash('sha256').update(DATA).digest('hex');
const CAP = 3; // this server tolerates three at once, like proof.ovh.net

let live = 0;
let rejections = 0;
let peakLive = 0;

const server = http.createServer((req, res) => {
  if (live >= CAP) {
    rejections++;
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '1' });
    return res.end('Too Many Requests');
  }
  live++;
  peakLive = Math.max(peakLive, live);
  res.on('close', () => { live--; });

  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
  res.writeHead(m ? 206 : 200, {
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${SIZE}`,
  });
  let pos = start;
  const tick = () => {
    if (res.destroyed) return;
    if (pos > end) return res.end();
    const n = Math.min(128 * 1024, end - pos + 1);
    res.write(DATA.subarray(pos, pos + n));
    pos += n;
    setTimeout(tick, 3);
  };
  tick();
});

// A second server that accepts the connection and then says nothing at all.
const blackhole = http.createServer((req, res) => {
  res.writeHead(206, {
    'Content-Length': '1048576',
    'Accept-Ranges': 'bytes',
    'Content-Range': 'bytes 0-1048575/1048576',
  });
  res.write(Buffer.alloc(1024)); // a trickle, then silence
});

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, '127.0.0.1', () => blackhole.listen(0, '127.0.0.1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-throttle-'));
  try {
    // ---- 1. backs off to the server's limit and still completes ----
    const dl = new HttpDownload({
      url: `http://127.0.0.1:${server.address().port}/f.bin`,
      filePath: path.join(dir, 'f.bin'),
      size: SIZE, acceptRanges: true, connections: 12,
    });
    let eased = null;
    dl.on('throttled', (t) => { eased = t; });

    const t0 = Date.now();
    await dl.start();
    const secs = (Date.now() - t0) / 1000;

    check(Boolean(eased), `noticed the 429s and eased off (${eased ? `${eased.requested} -> ${eased.connections}` : 'never did'})`);
    check(dl.maxConnections <= CAP + 1,
      `settled at ${dl.maxConnections} connections against a server cap of ${CAP}`);
    check(peakLive <= CAP, `never exceeded the server's limit (peak ${peakLive} concurrent)`);
    check(crypto.createHash('sha256').update(fs.readFileSync(dl.filePath)).digest('hex') === EXPECTED,
      `finished intact in ${secs.toFixed(1)}s despite ${rejections} rejections`);
    check(secs < 90, `did not spend forever retrying (${secs.toFixed(1)}s)`);

    // ---- 2. a server that goes silent is given up on, not waited on ----
    const dead = new HttpDownload({
      url: `http://127.0.0.1:${blackhole.address().port}/stuck.bin`,
      filePath: path.join(dir, 'stuck.bin'),
      size: 1048576, acceptRanges: true, connections: 2,
      stallMs: 4000, // the app default is 90s; shortened so the test is quick
    });
    const t1 = Date.now();
    let message = '';
    try { await dead.start(); } catch (err) { message = err.message; }
    const stalledAfter = (Date.now() - t1) / 1000;
    check(/stopped waiting/i.test(message), `a silent server is reported clearly: "${message.slice(0, 72)}…"`);
    check(stalledAfter < 20, `gave up promptly (${stalledAfter.toFixed(1)}s, not minutes)`);
    check(fs.existsSync(path.join(dir, 'stuck.bin.fletchpart')), 'partial data kept on disk so it can be resumed');
  } catch (err) {
    console.error('ERROR:', err.message);
    failed++;
  } finally {
    server.close();
    blackhole.close();
    await wait(200);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
}));
