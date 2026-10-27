// Drives the queue the way the UI will: add links, watch them move through
// analyze -> queued -> running -> done, check concurrency, pause/resume,
// category sorting, persistence and restart-after-restore.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');


const { DownloadManager } = require('../src/main/engine/manager.js');
const { JsonStore } = require('../src/main/store.js');
const { Binaries } = require('../src/main/engine/binaries.js');

const FILES = {
  '/clip.mp4': { body: crypto.randomBytes(3 * 1024 * 1024), type: 'video/mp4' },
  '/song.mp3': { body: crypto.randomBytes(1024 * 1024), type: 'audio/mpeg' },
  '/paper.pdf': { body: crypto.randomBytes(700 * 1024), type: 'application/pdf' },
  '/setup.exe': { body: crypto.randomBytes(2 * 1024 * 1024), type: 'application/octet-stream' },
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const f = FILES[url];
  if (!f) { res.writeHead(404).end(); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const total = f.body.length;
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  const headers = {
    'Content-Type': f.type,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
  };
  if (m) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(m ? 206 : 200, headers);
  let pos = start;
  const tick = () => {
    if (res.destroyed) return;
    if (pos > end) return res.end();
    const n = Math.min(128 * 1024, end - pos + 1);
    res.write(f.body.subarray(pos, pos + n));
    pos += n;
    setTimeout(tick, 6);
  };
  tick();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await wait(100);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-mgr-'));
  const dlDir = path.join(home, 'Downloads');

  const mkManager = () => {
    const tasks = new JsonStore(path.join(home, 'tasks.json'), { tasks: [] });
    const settings = new JsonStore(path.join(home, 'settings.json'), {});
    tasks.load(); settings.load();
    settings.data.downloadDir = dlDir;
    settings.data.maxConcurrent = 2;
    settings.data.connections = 4;
    settings.data.sortIntoCategories = true;
    return new DownloadManager({ store: tasks, settings, binaries: new Binaries(path.join(home, 'bin')) });
  };

  let mgr = mkManager();
  let fail = false;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fail = true; };

  try {
    // ---- add four links, watch concurrency ----
    let peakRunning = 0;
    const watcher = setInterval(() => {
      peakRunning = Math.max(peakRunning, mgr.list().filter((t) => t.state === 'running').length);
    }, 40);

    for (const name of Object.keys(FILES)) await mgr.add(base + name);
    await until(() => mgr.list().length === 4, 'all four tasks created');
    await until(() => mgr.list().every((t) => t.state === 'done'), 'all four finished');
    clearInterval(watcher);

    check(peakRunning <= 2 && peakRunning > 0, `concurrency limit respected (peak ${peakRunning}, limit 2)`);

    const byName = Object.fromEntries(mgr.list().map((t) => [t.filename, t]));
    check(Object.keys(byName).length === 4, 'four distinct files on disk');

    // ---- bytes are correct, not just "finished" ----
    let allMatch = true;
    for (const [url, f] of Object.entries(FILES)) {
      const t = mgr.list().find((x) => x.sourceUrl.endsWith(url));
      const got = fs.readFileSync(t.filePath);
      if (!got.equals(f.body)) { allMatch = false; console.log('   mismatch:', t.filename); }
    }
    check(allMatch, 'every downloaded file matches the source byte for byte');

    // ---- category sorting ----
    const folderOf = (u) => path.basename(path.dirname(mgr.list().find((x) => x.sourceUrl.endsWith(u)).filePath));
    const cats = `${folderOf('/clip.mp4')}/${folderOf('/song.mp3')}/${folderOf('/paper.pdf')}/${folderOf('/setup.exe')}`;
    check(cats === 'Video/Audio/Documents/Programs', `sorted into category folders (${cats})`);

    // ---- duplicate guard ----
    const before = mgr.list().length;
    await mgr.add(base + '/clip.mp4');
    await wait(400);
    check(mgr.list().length === before + 1, 'a finished download can be fetched again');

    // ---- pause / resume mid-flight ----
    mgr.clearCompleted();
    const t = await mgr.add(base + '/clip.mp4', { allowDuplicate: true });
    await until(() => t.state === 'running' && t.downloaded > 200 * 1024, 'download under way');
    mgr.pause(t.id);
    await until(() => t.state === 'paused', 'paused');
    const atPause = t.downloaded;
    await wait(500);
    check(t.downloaded === atPause && t.speed === 0, `paused and stayed paused (${(atPause / 1024).toFixed(0)} KB in)`);
    mgr.resume(t.id);
    await until(() => t.state === 'done', 'resumed to completion');
    check(fs.readFileSync(t.filePath).equals(FILES['/clip.mp4'].body), 'resumed file is still byte-perfect');

    // ---- cancel cleans up ----
    const c = await mgr.add(base + '/setup.exe', { allowDuplicate: true });
    await until(() => c.state === 'running' && c.downloaded > 0, 'second download under way');
    mgr.cancel(c.id);
    await until(() => c.state === 'cancelled', 'cancelled');
    await wait(400);
    check(!fs.existsSync(c.filePath + '.fletchpart'), 'cancel removed the partial file');

    // ---- persistence across a restart ----
    const liveCount = mgr.list().length;
    mgr.shutdown();
    await wait(400);
    mgr = mkManager();
    check(mgr.list().length === liveCount, `queue survived a restart (${mgr.list().length} items reloaded)`);
    check(!mgr.list().some((x) => x.state === 'running'), 'nothing claims to be running after a cold start');

    // ---- speed limit is applied ----
    mgr.settings.data.speedLimitKbps = 256;
    mgr.applySettings();
    const limited = await mgr.add(base + '/clip.mp4', { allowDuplicate: true });
    const t0 = Date.now();
    await until(() => limited.downloaded > 512 * 1024, 'limited download moving', 60000);
    const kbps = limited.downloaded / 1024 / ((Date.now() - t0) / 1000);
    check(kbps < 700, `speed cap engaged (measured ~${kbps.toFixed(0)} KB/s against a 256 KB/s cap)`);
    mgr.cancel(limited.id);

    console.log('\nstats snapshot:', JSON.stringify(mgr.stats()));
  } catch (err) {
    console.error('ERROR:', err.message);
    fail = true;
  } finally {
    try { mgr.shutdown(); } catch {}
    server.close();
    await wait(300);
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = fail ? 1 : 0;
  }
});
