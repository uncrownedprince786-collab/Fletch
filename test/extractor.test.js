'use strict';
// What yt-dlp finds has to reach Fletch's own engines intact, or a site that
// yt-dlp reads perfectly still fails to download:
//  1. the session cookies yt-dlp picked up reading the page go with the media
//  2. its chunk size is honoured, so throttling CDNs stay at full speed
//  3. an estimated size never decides how big the file is laid out
//  4. a site that refuses Fletch's engine is handed to yt-dlp, not failed
//  5. picking a quality by hand keeps the parallel engine
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ytdlp = require('../src/main/engine/ytdlp.js');
const { DownloadManager } = require('../src/main/engine/manager.js');
const { JsonStore } = require('../src/main/store.js');

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZE = 6 * 1024 * 1024 + 777;
const BODY = crypto.randomBytes(SIZE);
const EXPECTED = crypto.createHash('sha256').update(BODY).digest('hex');
const CHUNK = 1024 * 1024;

const seen = { requests: 0, withoutCookie: 0, overChunk: 0, peak: 0, live: 0 };

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (route === '/blocked.mp4') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('no');
  }
  // The CDN only serves people holding the session cookie the page set.
  seen.requests++;
  if (!/cdn_session=s3cr3t/.test(req.headers.cookie || '')) {
    seen.withoutCookie++;
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('no session');
  }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
  if (route === '/chunked.mp4' && end - start + 1 > CHUNK) seen.overChunk++;
  seen.live++;
  seen.peak = Math.max(seen.peak, seen.live);
  let counted = true;
  const release = () => { if (counted) { counted = false; seen.live--; } };
  res.on('close', release);
  res.on('finish', release);
  const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (m) h['Content-Range'] = `bytes ${start}-${end}/${SIZE}`;
  res.writeHead(m ? 206 : 200, h);
  let pos = start;
  const tick = () => {
    if (res.destroyed) return;
    if (pos > end) return res.end();
    const n = Math.min(64 * 1024, end - pos + 1);
    res.write(BODY.subarray(pos, pos + n));
    pos += n;
    setTimeout(tick, 5);
  };
  tick();
});

/** What `yt-dlp -J` says about the page, in yt-dlp's own field names. */
function fakeInfo(base, formats) {
  return ytdlp.normaliseInfo({
    id: 'abc', title: 'A Clip', extractor_key: 'FakeSite', webpage_url: `${base}/watch/abc`,
    formats,
  });
}

function makeManager(home, extractImpl) {
  const store = new JsonStore(path.join(home, 't.json'), { tasks: [] });
  const settings = new JsonStore(path.join(home, 's.json'), {});
  store.load();
  settings.load();
  Object.assign(settings.data, { downloadDir: path.join(home, 'dl'), connections: 6, maxConcurrent: 2 });
  const binaries = {
    setOverrides: () => {},
    resolve: async (name) => (name === 'yt-dlp' ? 'C:/fake/yt-dlp.exe' : null),
  };
  ytdlp.extract = extractImpl;
  return new DownloadManager({ store, settings, binaries, tmpDir: path.join(home, 'work') });
}

async function until(task, states, ms = 60000) {
  const t0 = Date.now();
  while (!states.includes(task.state) && Date.now() - t0 < ms) await wait(50);
  return task.state;
}

const realExtract = ytdlp.extract;
const RealYtDlpDownload = ytdlp.YtDlpDownload;

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-extract-'));
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  try {
    // ---- yt-dlp's cookie string becomes a Cookie header ----
    const header = ytdlp.cookieHeaderFrom(
      'cdn_session=s3cr3t; Domain=.example.test; Path=/; Secure; Expires=1999999999; lang=en; Domain=example.test; Path=/'
    );
    check(header === 'cdn_session=s3cr3t; lang=en', `yt-dlp's cookie string is read as cookies, not attributes ("${header}")`);
    check(ytdlp.mergeCookieHeaders('a=1; b=2', 'b=3; c=4') === 'a=1; b=3; c=4', 'cookie headers merge, the later value winning');

    // ---- 1-3. cookies, chunking and an estimated size, end to end ----
    const mgr = makeManager(home, async () => fakeInfo(base, [{
      format_id: 'hd', url: `${base}/chunked.mp4`, ext: 'mp4', protocol: 'https',
      vcodec: 'avc1', acodec: 'mp4a', height: 720,
      filesize_approx: SIZE * 2, // a guess, and a bad one
      http_headers: { 'User-Agent': 'Mozilla/5.0 test', Cookie: 'leaked=1' },
      cookies: `cdn_session=s3cr3t; Domain=127.0.0.1; Path=/`,
      downloader_options: { http_chunk_size: CHUNK },
    }]));
    const task = await mgr.add(`${base}/watch/abc`, { forceVideo: true });
    let peakConns = 0;
    mgr.on('tasks', () => { peakConns = Math.max(peakConns, task.connections || 0); });
    const state = await until(task, ['done', 'error']);
    check(state === 'done', `the video downloaded (${state}${task.error ? `: ${task.error}` : ''})`);
    check(seen.withoutCookie === 0, `every request carried the page's session cookie (${seen.requests} requests)`);
    check(seen.overChunk === 0, 'no request asked for more than yt-dlp\u2019s chunk size');
    check(seen.peak > 1, `the chunked format still used parallel connections (peak ${seen.peak})`);
    check(state === 'done' && fs.statSync(task.filePath).size === SIZE, 'the file is its real size, not the estimate');
    check(state === 'done' && sha(task.filePath) === EXPECTED, 'and byte-perfect');
    check(!/leaked=1/.test(JSON.stringify(task.headers)), 'a stray Cookie inside the format\u2019s headers is not used');

    // ---- 5. picking a quality by hand stays on the parallel engine ----
    ytdlp.extract = async () => fakeInfo(base, [
      { format_id: 'sd', url: `${base}/chunked.mp4?sd`, ext: 'mp4', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a', height: 360, cookies: 'cdn_session=s3cr3t; Domain=127.0.0.1' },
      { format_id: 'hd', url: `${base}/chunked.mp4?hd`, ext: 'mp4', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a', height: 720, cookies: 'cdn_session=s3cr3t; Domain=127.0.0.1' },
    ]);
    await mgr.chooseFormat(task.id, 'sd');
    const picked = await until(task, ['done', 'error']);
    check(picked === 'done', `the hand-picked quality downloaded (${picked}${task.error ? `: ${task.error}` : ''})`);
    check(task.engine === 'http' && /\?sd$/.test(task.url), `on Fletch's own engine, at the picked format (engine ${task.engine})`);

    // ---- 4. refused outright: yt-dlp takes over ----
    let handedTo = null;
    ytdlp.YtDlpDownload = class extends require('events').EventEmitter {
      constructor(spec) { super(); this.spec = spec; handedTo = spec; }
      pause() {}
      cancel() {}
      async start() {
        fs.mkdirSync(path.dirname(this.spec.filePath), { recursive: true });
        fs.writeFileSync(this.spec.filePath, BODY);
        return { filePath: this.spec.filePath, size: SIZE };
      }
    };
    ytdlp.extract = async () => fakeInfo(base, [{
      format_id: 'only', url: `${base}/blocked.mp4`, ext: 'mp4', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a', height: 480,
    }]);
    const t0 = Date.now();
    const blocked = await mgr.add(`${base}/watch/blocked`, { forceVideo: true });
    const end = await until(blocked, ['done', 'error']);
    const secs = (Date.now() - t0) / 1000;
    check(end === 'done', `a refused download was finished by yt-dlp (${end}${blocked.error ? `: ${blocked.error}` : ''})`);
    check(handedTo && handedTo.formatId === 'only', `with the format already chosen (${handedTo && handedTo.formatId})`);
    check(/yt-dlp is fetching it/.test(blocked.warning || ''), 'and the user is told why');
    check(secs < 15, `without a minute of pointless retries first (${secs.toFixed(1)}s)`);
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    ytdlp.extract = realExtract;
    ytdlp.YtDlpDownload = RealYtDlpDownload;
    server.close();
    await wait(200);
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
    // The manager's pulse is unref'd, but be sure nothing keeps us alive.
    setTimeout(() => process.exit(process.exitCode), 500).unref();
  }
});
