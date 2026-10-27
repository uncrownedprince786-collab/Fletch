// Working files must never appear in the user's download folder, and folders
// left behind by earlier versions must be cleared away on startup.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { DownloadManager } = require('../src/main/engine/manager.js');
const { JsonStore } = require('../src/main/store.js');
const { Binaries } = require('../src/main/engine/binaries.js');

const BODY = crypto.randomBytes(2 * 1024 * 1024);

const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), BODY.length - 1) : BODY.length - 1;
  const h = {
    'Content-Type': 'video/mp4',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'attachment; filename="clip.mp4"',
  };
  if (m) h['Content-Range'] = `bytes ${start}-${end}/${BODY.length}`;
  res.writeHead(m ? 206 : 200, h);
  res.end(BODY.subarray(start, end + 1));
});

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function walk(dir, hits = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { hits.push(p + path.sep); walk(p, hits); } else hits.push(p);
  }
  return hits;
}

server.listen(0, '127.0.0.1', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-tmpf-'));
  const dlDir = path.join(home, 'Downloads');
  const workDir = path.join(home, 'work');

  // A folder exactly as an older build would have left it, plus a stale
  // fragment inside so a plain rmdir would refuse to remove it.
  const legacy = path.join(dlDir, 'Video', '.fletch-tmp');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'abc123.video.mp4.fletchpart'), Buffer.alloc(712));

  const tasksStore = new JsonStore(path.join(home, 't.json'), { tasks: [] });
  const settings = new JsonStore(path.join(home, 's.json'), {});
  tasksStore.load();
  settings.load();
  Object.assign(settings.data, { downloadDir: dlDir, connections: 4, maxConcurrent: 2 });

  const mgr = new DownloadManager({
    store: tasksStore,
    settings,
    binaries: new Binaries(path.join(home, 'bin')),
    tmpDir: workDir,
  });

  try {
    await mgr.sweep();
    check(!fs.existsSync(legacy), 'a .fletch-tmp folder left by an older build is swept away on startup');

    const task = await mgr.add(`http://127.0.0.1:${server.address().port}/clip.mp4`);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000 && task.state !== 'done' && task.state !== 'error') await wait(150);
    check(task.state === 'done', `a normal download finishes (${task.state})`);

    const seen = walk(dlDir);
    const junk = seen.filter((p) => /\.fletch-tmp|\.fletchpart|\.merging/.test(p));
    check(junk.length === 0,
      junk.length ? `found working files in the download folder: ${junk.join(', ')}`
        : 'the download folder holds only the finished file and its category folders');
    console.log(`    download folder now: ${seen.map((p) => path.relative(dlDir, p)).join(', ')}`);

    // Removing a task clears its scratch folder too.
    fs.mkdirSync(path.join(workDir, task.id), { recursive: true });
    fs.writeFileSync(path.join(workDir, task.id, 'part.bin'), Buffer.alloc(16));
    await mgr.remove(task.id, false);
    check(!fs.existsSync(path.join(workDir, task.id)), 'removing a download clears its scratch folder');

    // And orphans from tasks that no longer exist get collected.
    fs.mkdirSync(path.join(workDir, 'ghosttask'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'ghosttask', 'x.bin'), Buffer.alloc(16));
    await mgr.sweep();
    check(!fs.existsSync(path.join(workDir, 'ghosttask')), 'scratch folders with no matching task are collected');
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    mgr.shutdown();
    server.close();
    await wait(200);
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
});
