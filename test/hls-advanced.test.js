// Two things real streams do that naive HLS code gets wrong:
//   1. EXT-X-BYTERANGE — every "segment" is a slice of one big file. Ignoring
//      the tag means fetching the whole file once per segment.
//   2. EXT-X-MEDIA — the audio lives in its own playlist, so a video-only
//      download is what you get if you only read EXT-X-STREAM-INF.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { HlsDownload, inspect, parseMedia, parseRenditions } = require('../src/main/engine/hls.js');

const INIT = crypto.randomBytes(2048);
const PIECES = Array.from({ length: 30 }, () => crypto.randomBytes(100 * 1024));
const WHOLE = Buffer.concat([INIT, ...PIECES]);        // one contiguous fMP4
const EXPECTED = crypto.createHash('sha256').update(WHOLE).digest('hex');
const AUDIO = crypto.randomBytes(300 * 1024);

let wholeFileRequests = 0;
let rangedRequests = 0;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/master.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="French",LANGUAGE="fr",DEFAULT=NO,URI="audio_fr/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="aud"',
      'v360/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"',
      'v1080/index.m3u8',
      '',
    ].join('\n'));
  }

  if (/^\/v\d+\/index\.m3u8$/.test(url)) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
      `#EXT-X-MAP:URI="main.mp4",BYTERANGE="${INIT.length}@0"`];
    let offset = INIT.length;
    for (const p of PIECES) {
      lines.push('#EXTINF:4.0,');
      lines.push(`#EXT-X-BYTERANGE:${p.length}@${offset}`);
      lines.push('main.mp4');
      offset += p.length;
    }
    lines.push('#EXT-X-ENDLIST', '');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(lines.join('\n'));
  }

  if (url === '/audio/index.m3u8' || url === '/audio_fr/index.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:4.0,', 'a0.aac', '#EXT-X-ENDLIST', ''].join('\n'));
  }

  if (url.endsWith('/a0.aac')) {
    res.writeHead(200, { 'Content-Length': String(AUDIO.length) });
    return res.end(AUDIO);
  }

  if (url.endsWith('/main.mp4')) {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) {
      wholeFileRequests++;
      res.writeHead(200, { 'Content-Length': String(WHOLE.length) });
      return res.end(WHOLE);
    }
    rangedRequests++;
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), WHOLE.length - 1) : WHOLE.length - 1;
    res.writeHead(206, {
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${WHOLE.length}`,
    });
    return res.end(WHOLE.subarray(start, end + 1));
  }

  res.writeHead(404).end();
});

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-hls2-'));

  try {
    // ---- inspect finds the separate audio and the container ----
    const plan = await inspect(`${base}/master.m3u8`, {});
    check(/v1080/.test(plan.videoUrl), `picked the 1080p variant (${plan.height}p)`);
    check(Boolean(plan.audioUrl) && /\/audio\//.test(plan.audioUrl),
      `found the separate audio rendition, defaulting to English (${plan.audioUrl ? plan.audioUrl.replace(base, '') : 'none'})`);
    check(plan.container === 'mp4', `detected an fMP4 stream, so the file is named .mp4 (got .${plan.container})`);

    const plan480 = await inspect(`${base}/master.m3u8`, { preferHeight: 480 });
    check(/v360/.test(plan480.videoUrl), 'a 480p ceiling drops to the 360p variant');

    // ---- byte ranges are honoured ----
    const dl = new HlsDownload({ url: plan.videoUrl, filePath: path.join(dir, 'v.mp4'), connections: 6 });
    const res = await dl.start();
    const got = crypto.createHash('sha256').update(fs.readFileSync(res.filePath)).digest('hex');

    check(got === EXPECTED, 'reassembled the ranged pieces into exactly the original file');
    check(wholeFileRequests === 0,
      `never fetched the whole file (${wholeFileRequests} unranged vs ${rangedRequests} ranged requests)`);
    check(res.size === WHOLE.length, `size is ${res.size} bytes, not ${PIECES.length}x that`);

    // ---- the parser itself ----
    const media = parseMedia(
      `#EXTM3U\n#EXT-X-MAP:URI="m.mp4",BYTERANGE="100@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:50@100\nm.mp4\n`
      + `#EXTINF:4,\n#EXT-X-BYTERANGE:60\nm.mp4\n#EXT-X-ENDLIST\n`,
      `${base}/x/`
    );
    check(media.segments[0].range.offset === 100 && media.segments[0].range.length === 50,
      'explicit offsets parse');
    check(media.segments[1].range.offset === 150 && media.segments[1].range.length === 60,
      'an omitted offset continues from the previous range (150, per the spec)');

    const rends = parseRenditions(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="x",URI="a.m3u8"\n'
      + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="muxed"\n',
      base
    );
    check(rends.length === 1, 'renditions without a URI are skipped, being already muxed in');
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
});
