'use strict';
// The extension's download takeover, driven through a stub browser.
//
// This exists because of a real incident: Chrome replays downloads.onCreated
// for every item already in its list when the browser starts, and the takeover
// treated each replayed record as a download to intercept — cancelling nothing,
// erasing the history entry, then fetching the file again. One cold boot
// re-downloaded months of history.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');

const now = () => new Date().toISOString();
const agesAgo = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

/** Load background.js over a stub chrome, and hand back its download listener. */
function load({ port, session = {}, cancelFails = false }) {
  const calls = { cancelled: [], erased: [], downloaded: [], notified: [] };
  const local = { port, token: 'test-token', takeover: true, skipExt: '' };
  const listeners = {};
  const noop = () => {};
  const evt = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });

  const chrome = {
    runtime: {
      id: 'fletchtest',
      getManifest: () => ({ version: '1.0.1' }),
      onInstalled: evt('installed'),
      onStartup: evt('startup'),
      onMessage: evt('message'),
    },
    contextMenus: { removeAll: (cb) => cb && cb(), create: noop, onClicked: evt('menu') },
    storage: {
      local: {
        get: (defaults, cb) => cb({ ...defaults, ...local }),
        set: (patch, cb) => { Object.assign(local, patch); cb && cb(); },
      },
      session: {
        get: async (key) => (key in session ? { [key]: session[key] } : {}),
        set: async (patch) => { Object.assign(session, patch); },
      },
    },
    downloads: {
      onCreated: evt('created'),
      cancel: async (id) => {
        if (cancelFails) throw new Error('download already finished');
        calls.cancelled.push(id);
      },
      erase: async (query) => { calls.erased.push(query.id); },
      download: async (opts) => { calls.downloaded.push(opts.url); return 99; },
    },
    cookies: { getAll: async () => [] },
    notifications: { create: (opts) => calls.notified.push(opts.title) },
    webRequest: { onHeadersReceived: { addListener: noop } },
    tabs: { onRemoved: evt('removed'), onUpdated: evt('updated'), query: noop },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  };

  vm.runInNewContext(SOURCE, { chrome, fetch, AbortSignal, URL, console, setTimeout, clearTimeout });
  return { calls, session, fire: (item) => listeners.created(item) };
}

function item(extra) {
  return {
    id: 1,
    url: 'https://example.test/holiday.zip',
    finalUrl: 'https://example.test/holiday.zip',
    filename: 'holiday.zip',
    referrer: '',
    state: 'in_progress',
    startTime: now(),
    ...extra,
  };
}

let pass = 0;
function ok(name) { pass++; process.stdout.write(`   ✓ ${name}\n`); }

(async () => {
  // The app, answering on a port of its own. /add can be told to refuse.
  let addFails = false;
  const app = http.createServer((req, res) => {
    if (req.url === '/ping') { res.writeHead(200); return res.end('ok'); }
    if (req.url === '/add') {
      if (addFails) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"busy"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"added":[{"title":"holiday.zip"}]}');
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  app.unref(); // a failed check must end the run, not leave it listening
  const port = app.address().port;
  const DEAD = 1; // nothing listens here, so the app reads as closed

  {
    const { calls, fire } = load({ port });
    await fire(item({ state: 'complete', startTime: agesAgo() }));
    await fire(item({ id: 2, state: 'interrupted', startTime: agesAgo() }));
    assert.deepStrictEqual(calls.cancelled, [], 'a finished download must not be cancelled');
    assert.deepStrictEqual(calls.downloaded, [], 'history replayed at browser start must not be re-downloaded');
    assert.deepStrictEqual(calls.erased, [], 'the download history must be left alone');
    ok('records replayed when Chrome starts are ignored');
  }

  {
    const { calls, fire } = load({ port });
    await fire(item({ startTime: agesAgo() }));
    assert.deepStrictEqual(calls.downloaded, [], 'a download begun long ago is not ours to take over');
    ok('an in-progress download from an earlier session is left alone');
  }

  {
    const { calls, fire } = load({ port: DEAD });
    await fire(item());
    assert.deepStrictEqual(calls.cancelled, [], 'with Fletch closed, Chrome keeps the download');
    assert.deepStrictEqual(calls.downloaded, [], 'and it is never cancelled and started again');
    ok('a closed Fletch leaves the browser untouched');
  }

  {
    const { calls, fire } = load({ port });
    await fire(item());
    assert.deepStrictEqual(calls.cancelled, [1], 'Chrome is stopped so the file is not fetched twice');
    assert.deepStrictEqual(calls.erased, [1], 'the cancelled entry is tidied away');
    assert.deepStrictEqual(calls.downloaded, [], 'Fletch has it; Chrome must not start it again');
    ok('a live download is handed to Fletch');
  }

  {
    const { calls, fire } = load({ port, cancelFails: true });
    await fire(item());
    assert.deepStrictEqual(calls.erased, [], 'a download that finished first keeps its history entry');
    assert.deepStrictEqual(calls.downloaded, [], 'and is not fetched a second time');
    ok('a download that finishes first is not duplicated');
  }

  {
    addFails = true;
    const session = {};
    const first = load({ port, session });
    await first.fire(item());
    assert.deepStrictEqual(first.calls.downloaded, ['https://example.test/holiday.zip'], 'a refused download goes back to Chrome');

    // The hand-back comes back round as a new download, redirected, so its
    // finalUrl is not the URL it was started with.
    await first.fire(item({ id: 2, finalUrl: 'https://cdn.example.test/holiday.zip?sig=abc' }));
    assert.strictEqual(first.calls.downloaded.length, 1, 'the hand-back must not be taken over again');

    // Chrome stops an idle service worker; session storage is what survives.
    const second = load({ port, session });
    await second.fire(item({ id: 3 }));
    assert.deepStrictEqual(second.calls.downloaded, [], 'a restarted service worker still remembers the hand-back');
    assert.deepStrictEqual(second.calls.cancelled, [], 'so the loop cannot start over');
    ok('a hand-back to Chrome never loops');
    addFails = false;
  }

  app.close();
  process.stdout.write(`\n   ${pass} checks passed\n`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
