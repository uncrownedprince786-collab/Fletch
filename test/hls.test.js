// Serves a master playlist -> a 1080p variant -> 40 AES-128 segments, and
// checks Fletch reassembles the original bytes in the right order.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');


const { HlsDownload, parseMaster, parseMedia } = require('../src/main/engine/hls.js');

const KEY = crypto.randomBytes(16);
const COUNT = 40;
const SEGS = Array.from({ length: COUNT }, () => crypto.randomBytes(180 * 1024));
const PLAIN = Buffer.concat(SEGS);
const EXPECTED = crypto.createHash('sha256').update(PLAIN).digest('hex');

function encrypt(buf, seq) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq, 12);
  const c = crypto.createCipheriv('aes-128-cbc', KEY, iv);
  return Buffer.concat([c.update(buf), c.final()]);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/master.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'v360/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080',
      'v1080/index.m3u8',
      '',
    ].join('\n'));
  }

  if (url.endsWith('/index.m3u8')) {
    const tier = url.includes('1080') ? '1080' : '360';
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-KEY:METHOD=AES-128,URI="/key.bin"'];
    for (let i = 0; i < COUNT; i++) { lines.push('#EXTINF:4.0,'); lines.push(`seg${i}.ts?t=${tier}`); }
    lines.push('#EXT-X-ENDLIST', '');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(lines.join('\n'));
  }

  if (url === '/key.bin') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(KEY);
  }

  const m = /\/v\d+\/seg(\d+)\.ts$/.exec(url);
  if (m) {
    const i = Number(m[1]);
    const body = encrypt(SEGS[i], i);
    // Random latency so segments genuinely complete out of order.
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': String(body.length) });
      res.end(body);
    }, Math.random() * 120);
    return;
  }

  res.writeHead(404).end();
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-hls-'));

  try {
    // Parser sanity first.
    const master = await (await fetch(`${base}/master.m3u8`)).text();
    const vs = parseMaster(master, `${base}/master.m3u8`);
    console.log(`variants found: ${vs.map((v) => v.height + 'p').join(', ')} (best = ${vs[vs.length - 1].height}p)`);

    const dl = new HlsDownload({ url: `${base}/master.m3u8`, filePath: path.join(outDir, 'stream.ts'), connections: 8 });
    let picked = null;
    dl.on('variant', (v) => { picked = v; });
    const r = await dl.start();

    console.log(`picked variant: ${picked.height}p @ ${(picked.bandwidth / 1e6).toFixed(1)} Mbps`);
    console.log(`segments: ${dl.completed}/${dl.total}, duration ${dl.duration}s, size ${(r.size / 1048576).toFixed(2)} MB`);
    const got = crypto.createHash('sha256').update(fs.readFileSync(r.filePath)).digest('hex');
    console.log('decrypted + ordered output:', got === EXPECTED ? 'MATCHES source' : 'MISMATCH');
    if (got !== EXPECTED) process.exitCode = 1;
    if (picked.height !== 1080) { console.log('FAIL: did not pick the best variant'); process.exitCode = 1; }

    // And a quality preference.
    const dl2 = new HlsDownload({ url: `${base}/master.m3u8`, filePath: path.join(outDir, 's2.ts'), connections: 6, preferHeight: 480 });
    let picked2 = null;
    dl2.on('variant', (v) => { picked2 = v; });
    await dl2.start();
    console.log(`preferHeight 480 -> picked ${picked2.height}p`, picked2.height === 360 ? '(correct: best that fits)' : '(WRONG)');
    if (picked2.height !== 360) process.exitCode = 1;
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
