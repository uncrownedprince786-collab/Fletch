// Deciding what a link *is* matters more than any single engine.
//
// The case that prompted this: a file host served a perfectly good .mp4 but
// rejected the ranged request Fletch probes with. Fletch read the refusal as
// "this must be a web page", handed it to the video extractor, and the user
// got "Unsupported URL" for a link that any browser would have downloaded.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { DownloadManager } = require('../src/main/engine/manager.js');
const { JsonStore } = require('../src/main/store.js');
const { Binaries } = require('../src/main/engine/binaries.js');
const { probe } = require('../src/main/engine/probe.js');
const { scrapePage, candidates } = require('../src/main/engine/scrape.js');

const BODY = crypto.randomBytes(1024 * 1024);
let rangedRejections = 0;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // A file host that refuses ranged requests but serves the file happily.
  if (url === '/grumpy.mp4') {
    if (req.headers.range) {
      rangedRejections++;
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Range not allowed');
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(BODY.length) });
    return res.end(BODY);
  }

  // The same, but it will not describe itself at all.
  if (url === '/silent.mp4') {
    res.writeHead(403).end();
    return;
  }

  if (url === '/player.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><html><head>
      <title>Verity (2026) - watch</title>
      <meta property="og:title" content="Verity 2026 Hindi Dubbed">
      </head><body>
      <video poster="/p.jpg" controls><source src="/media/movie.mp4" type="video/mp4"></video>
      <script>var player = {file: "/media/movie.mp4", image: "/p.jpg"};</script>
      </body></html>`);
  }

  if (url === '/media/movie.mp4') {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), BODY.length - 1) : BODY.length - 1;
    const h = { 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
    if (m) h['Content-Range'] = `bytes ${start}-${end}/${BODY.length}`;
    res.writeHead(m ? 206 : 200, h);
    return res.end(BODY.subarray(start, end + 1));
  }

  res.writeHead(404).end();
});

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-routing-'));
  const tasksStore = new JsonStore(path.join(home, 't.json'), { tasks: [] });
  const settings = new JsonStore(path.join(home, 's.json'), {});
  tasksStore.load();
  settings.load();
  Object.assign(settings.data, { downloadDir: path.join(home, 'dl'), connections: 4, maxConcurrent: 2 });

  // No yt-dlp: if routing is wrong, the task fails outright instead of
  // quietly succeeding because the extractor happened to cope.
  const mgr = new DownloadManager({
    store: tasksStore, settings,
    binaries: new Binaries(path.join(home, 'bin-none')),
    tmpDir: path.join(home, 'work'),
  });
  mgr.binaries.resolve = async () => null;

  try {
    // ---- probe retries without the Range header ----
    const info = await probe(`${base}/grumpy.mp4`);
    check(rangedRejections > 0, 'the host rejected the ranged probe, as the real one did');
    check(info.size === BODY.length, `probing fell back to a plain request and learned the size (${info.size})`);
    check(info.mime === 'video/mp4', 'and the real content type');

    // ---- a direct file whose host says nothing at all ----
    const t = await mgr.add(`${base}/silent.mp4`);
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && t.state === 'analyzing') await wait(100);
    check(t.engine === 'http',
      `a .mp4 link is downloaded, not sent to the extractor (engine: ${t.engine})`);
    check(!/unsupported|yt-dlp/i.test(t.error || ''),
      `no "unsupported URL" for a plain file link (${t.error || 'no error'})`);
    check(t.filename === 'silent.mp4', `named from the URL (${t.filename})`);

    // ---- a real page still goes down the video path ----
    const page = await mgr.add(`${base}/player.html`);
    const t1 = Date.now();
    while (Date.now() - t1 < 30000 && page.state === 'analyzing') await wait(100);
    check(page.kind === 'video', 'an .html link is still treated as a page');

    // ---- reading a page when no extractor knows it ----
    const found = await scrapePage(`${base}/player.html`);
    check(Boolean(found), 'media was found by reading the page');
    check(found && /\/media\/movie\.mp4$/.test(found.url),
      `found the player's source (${found ? found.url.replace(base, '') : 'nothing'})`);
    check(found && found.title === 'Verity 2026 Hindi Dubbed',
      `took the page's own title (${found ? found.title : ''})`);

    // ---- the scraper's ranking ----
    const ranked = candidates(
      '<video src="/low.mp4"></video><script>file:"/stream/index.m3u8"</script>',
      `${base}/x/`
    );
    check(ranked.length >= 2, 'several candidates are collected');
    check(/\.m3u8$/.test(ranked[0].url),
      `a playlist outranks a single file (${ranked[0].url.replace(base, '')})`);

    const none = candidates('<p>nothing here</p>', base);
    check(none.length === 0, 'a page with no media yields nothing rather than a guess');
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    mgr.shutdown();
    server.close();
    await wait(300);
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
});
