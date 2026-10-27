// Some servers do not say "too many connections" — they just go quiet. Fletch
// should notice, drop to fewer connections by itself, and finish, rather than
// leaving a dead download for the user to deal with.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { DownloadManager } = require('../src/main/engine/manager.js');
const { JsonStore } = require('../src/main/store.js');
const { Binaries } = require('../src/main/engine/binaries.js');

const SIZE = 6 * 1024 * 1024;
const DATA = crypto.randomBytes(SIZE);
const EXPECTED = crypto.createHash('sha256').update(DATA).digest('hex');

// While sulking, the server accepts connections, dribbles a little, then stops
// sending forever — the silent-stall case, with no error code to read.
let sulking = true;
let served = 0;

const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
  res.writeHead(m ? 206 : 200, {
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${SIZE}`,
  });

  if (sulking) {
    // A trickle, then silence. Clamped to the range we promised: writing more
    // bytes than Content-Length makes Node tear the response down with an
    // error, which is not the behaviour this test is trying to produce.
    const trickle = Math.min(1024, end - start + 1);
    res.write(DATA.subarray(start, start + trickle));
    return;
  }

  served++;
  let pos = start;
  const tick = () => {
    if (res.destroyed) return;
    if (pos > end) return res.end();
    const n = Math.min(128 * 1024, end - pos + 1);
    res.write(DATA.subarray(pos, pos + n));
    pos += n;
    setTimeout(tick, 2);
  };
  tick();
});

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, '127.0.0.1', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-recover-'));
  const tasksStore = new JsonStore(path.join(home, 't.json'), { tasks: [] });
  const settings = new JsonStore(path.join(home, 's.json'), {});
  tasksStore.load();
  settings.load();
  Object.assign(settings.data, {
    downloadDir: path.join(home, 'dl'),
    connections: 8,
    maxConcurrent: 1,
    stallSeconds: 5, // the app default is 90; shortened to keep the test quick
  });
  const mgr = new DownloadManager({
    store: tasksStore, settings, binaries: new Binaries(path.join(home, 'bin')),
  });

  try {
    const task = await mgr.add(`http://127.0.0.1:${server.address().port}/f.bin`);

    // Let the first attempt stall out, then let the server behave.
    let sawRetryNotice = false;
    const watcher = setInterval(() => {
      if (task.warning && /trying again on/i.test(task.warning)) sawRetryNotice = true;
    }, 100);

    setTimeout(() => { sulking = false; }, 9000);

    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (task.state === 'done' || task.state === 'error') break;
      await wait(200);
    }
    clearInterval(watcher);

    check(task.state === 'done', `recovered on its own and finished (state: ${task.state})`);
    if (task.error) console.log('   error:', task.error);
    check(sawRetryNotice, `told the user what it was doing ("${(task.warning || '').slice(0, 70)}")`);
    check((task.autoRetries || 0) === 0 && task.connectionsOverride > 0,
      `backed off to ${task.connectionsOverride} connections from 8`);
    if (task.state === 'done') {
      const got = crypto.createHash('sha256').update(fs.readFileSync(task.filePath)).digest('hex');
      check(got === EXPECTED, 'the recovered file is byte-perfect');
    }
    check(served > 0, 'the download only succeeded once the server started answering');
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
