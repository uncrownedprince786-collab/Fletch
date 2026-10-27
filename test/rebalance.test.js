// Two behaviours that make or break a download manager:
//  1. one slow connection must not hold the whole file hostage (segment stealing)
//  2. a paused download must resume from disk, not from zero
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');


const { HttpDownload } = require('../src/main/engine/http-download.js');

const SIZE = 80 * 1024 * 1024;
const DATA = crypto.randomBytes(SIZE);
const EXPECTED = crypto.createHash('sha256').update(DATA).digest('hex');
const SLOW_UNTIL = SIZE / 8; // the first eighth of the file crawls

const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
  res.writeHead(m ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${SIZE}`,
  });
  let pos = start;
  const slow = start < SLOW_UNTIL;
  const tick = () => {
    if (res.destroyed) return;
    if (pos > end) return res.end();
    const n = Math.min(slow ? 24 * 1024 : 2048 * 1024, end - pos + 1);
    res.write(DATA.subarray(pos, pos + n));
    pos += n;
    setTimeout(tick, slow ? 40 : 1);
  };
  tick();
});

function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/f.bin`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-rb-'));
  const spec = { url, filePath: path.join(outDir, 'f.bin'), size: SIZE, acceptRanges: true, connections: 8 };

  try {
    // ---- 1. segment stealing ----
    const dl = new HttpDownload(spec);
    let peakSegments = 0;
    dl.on('progress', (p) => { peakSegments = Math.max(peakSegments, p.segments.length); });
    await dl.start();
    console.log(`stealing: started with 8 segments, ended with ${peakSegments}`);
    console.log('stealing:', peakSegments > 8 ? 'PASS - idle connections split the slow range' : 'FAIL - no rebalancing happened');
    console.log('checksum:', sha(spec.filePath) === EXPECTED ? 'MATCHES' : 'MISMATCH');
    if (peakSegments <= 8 || sha(spec.filePath) !== EXPECTED) process.exitCode = 1;
    fs.rmSync(spec.filePath);

    // ---- 2. pause / resume ----
    const dl2 = new HttpDownload(spec);
    let paused = 0;
    dl2.on('progress', (p) => {
      if (!paused && p.downloaded > SIZE * 0.25) { paused = p.downloaded; dl2.pause(); }
    });
    await dl2.start();
    console.log(`resume: paused after ${(paused / 1048576).toFixed(1)} MB, part file on disk =`,
      fs.existsSync(spec.filePath + '.fletchpart') ? 'yes' : 'no');

    const dl3 = new HttpDownload(spec);
    let resumedAt = null;
    dl3.on('resumed', (r) => { resumedAt = r.downloaded; });
    await dl3.start();
    console.log(`resume: restarted at ${(resumedAt / 1048576).toFixed(1)} MB instead of 0`);
    console.log('resume:', resumedAt > SIZE * 0.2 ? 'PASS - continued from disk' : 'FAIL - started over');
    console.log('checksum:', sha(spec.filePath) === EXPECTED ? 'MATCHES' : 'MISMATCH');
    if (!resumedAt || resumedAt < SIZE * 0.2 || sha(spec.filePath) !== EXPECTED) process.exitCode = 1;
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
