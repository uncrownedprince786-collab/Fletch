'use strict';
// saveNow() is the shutdown save, and it has to be the last word. A save that
// was queued just before it used to land up to ~300ms later: on a real quit
// that overwrote the newer copy with an older one, and in the test suite it
// wrote into a folder being deleted, which failed the Windows release build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore } = require('../src/main/store.js');

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-store-'));
  const file = path.join(dir, 't.json');
  try {
    const store = new JsonStore(file, { tasks: [] });
    store.load();

    store.set('tasks', [1]);       // a save is now pending
    await wait(20);
    store.set('tasks', [1, 2]);    // and another is queued behind it
    store.saveNow();

    const late = [];
    const watcher = fs.watch(dir, (ev, name) => late.push(`${ev} ${name}`));
    await wait(600);
    watcher.close();

    check(late.length === 0, `nothing was written after the shutdown save (${late.length ? late.join(', ') : 'no writes'})`);
    check(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).tasks) === '[1,2]', 'the newest data is what is on disk');
    check(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp file is left beside it');

    // The store is still usable afterwards: a later change is saved as usual.
    store.set('tasks', [1, 2, 3]);
    await wait(400);
    check(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).tasks) === '[1,2,3]', 'a change made after it is still saved');
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    process.exitCode = failed ? 1 : 0;
  }
})();
