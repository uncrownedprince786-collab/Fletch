// Exercises the segmented downloader against a local server that supports
// ranges, throttles randomly, and drops a connection partway to test recovery.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');


const { HttpDownload } = require('../src/main/engine/http-download.js');
const { probe } = require('../src/main/engine/probe.js');

const SIZE = 12 * 1024 * 1024 + 12345;
const DATA = crypto.randomBytes(SIZE);
const EXPECTED = crypto.createHash('sha256').update(DATA).digest('hex');

let dropsLeft = 3;

const server = http.createServer((req, res) => {
  const range = req.headers.range;
  let start = 0;
  let end = SIZE - 1;
  let status = 200;

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), SIZE - 1);
      status = 206;
    }
  }

  const len = end - start + 1;
  const headers = {
    'Content-Type': 'video/mp4',
    'Content-Length': String(len),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'attachment; filename="big sample:video?.mp4"',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${SIZE}`;
  res.writeHead(status, headers);

  if (req.method === 'HEAD') return res.end();

  // Dribble it out in chunks so parallelism and rebalancing actually engage.
  let pos = start;
  const willDrop = len > 400000 && dropsLeft-- > 0;
  const dropAt = willDrop ? start + Math.floor(len / 3) : -1;

  const tick = () => {
    if (res.destroyed) return;
    if (dropAt > 0 && pos >= dropAt) { res.destroy(); return; }
    if (pos > end) return res.end();
    const n = Math.min(64 * 1024, end - pos + 1);
    const ok = res.write(DATA.subarray(pos, pos + n));
    pos += n;
    if (ok) setTimeout(tick, 2); else res.once('drain', tick);
  };
  tick();
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/sample.mp4`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-test-'));

  try {
    const info = await probe(url);
    console.log('probe ->', JSON.stringify({
      filename: info.filename, size: info.size,
      acceptRanges: info.acceptRanges, mime: info.mime,
    }));
    if (info.size !== SIZE) throw new Error('probe reported the wrong size');
    if (!info.acceptRanges) throw new Error('probe missed range support');
    if (info.filename !== 'big sample_video_.mp4') throw new Error('filename not sanitised: ' + info.filename);

    const dl = new HttpDownload({
      url,
      filePath: path.join(outDir, info.filename),
      size: info.size,
      acceptRanges: info.acceptRanges,
      connections: 8,
    });

    let maxConns = 0;
    let splits = 0;
    dl.on('progress', (p) => {
      maxConns = Math.max(maxConns, p.connections);
      splits = Math.max(splits, p.segments.length);
    });
    dl.on('retry', (r) => console.log('  retry: segment', r.segment, '-', r.message));

    const t0 = Date.now();
    const result = await dl.start();
    const secs = (Date.now() - t0) / 1000;

    const got = crypto.createHash('sha256').update(fs.readFileSync(result.filePath)).digest('hex');
    console.log(`done in ${secs.toFixed(1)}s | peak connections ${maxConns} | segments after splitting ${splits}`);
    console.log('checksum', got === EXPECTED ? 'MATCHES source' : 'MISMATCH');
    if (got !== EXPECTED) process.exitCode = 1;
    if (splits <= 8) console.log('note: dynamic splitting did not add segments this run');

    const leftovers = fs.readdirSync(outDir).filter((f) => f.includes('fletchpart'));
    console.log('leftover part files:', leftovers.length === 0 ? 'none (clean)' : leftovers.join(', '));
    if (leftovers.length) process.exitCode = 1;
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
