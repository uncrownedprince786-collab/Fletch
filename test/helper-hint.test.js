'use strict';
// When a download from a web page fails and yt-dlp is not installed, the
// failure should say so. The address scraped off a page is borrowed — signed,
// short-lived, often tied to the session that was playing it — so when it
// stops working the user sees a network error and concludes the downloader is
// broken. It is not: it is the case the helper exists to handle.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DownloadManager } = require('../src/main/engine/manager.js');
const { JsonStore } = require('../src/main/store.js');

let pass = 0;
function ok(name) { pass++; process.stdout.write(`   ✓ ${name}\n`); }

function makeManager(ytdlpInstalled) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-hint-'));
  const store = new JsonStore(path.join(dir, 'downloads.json'), { tasks: [] });
  store.load();
  const settings = { get: (_k, fallback) => fallback, set: () => {} };
  const binaries = {
    setOverrides: () => {},
    resolve: async (name) => (name === 'yt-dlp' && ytdlpInstalled ? 'C:/fake/yt-dlp.exe' : null),
  };
  return new DownloadManager({ store, settings, binaries, tmpDir: dir });
}

/** A task in the state _fail leaves behind. */
function failedTask(extra) {
  return {
    id: 'x1',
    url: 'https://cdn.example.test/stream-9f3a.mp4?token=expired',
    state: 'error',
    error: 'The server closed the connection.',
    headers: {},
    ...extra,
  };
}

(async () => {
  {
    const m = makeManager(false);
    const task = failedTask({ headers: { Referer: 'https://news.example.test/live' } });
    await m._blameMissingHelper(task);
    assert.ok(/yt-dlp is not installed/.test(task.error), 'the real cause is named');
    assert.ok(/Settings/.test(task.error), 'and where to fix it');
    assert.ok(/The server closed the connection\./.test(task.error),
      'without throwing away what actually happened');
    ok('a page download that fails without yt-dlp says so');
  }

  {
    const m = makeManager(false);
    const task = failedTask({ forceVideo: true });
    await m._blameMissingHelper(task);
    assert.ok(/yt-dlp is not installed/.test(task.error), 'a page grab counts even with no Referer');
    ok('a "grab video from this page" failure says so too');
  }

  {
    const m = makeManager(true);
    const task = failedTask({ headers: { Referer: 'https://news.example.test/live' } });
    await m._blameMissingHelper(task);
    assert.strictEqual(task.error, 'The server closed the connection.',
      'nothing is added when the helper is already there');
    ok('an installed yt-dlp is not blamed');
  }

  {
    // A plain link that is dead is dead. Blaming a helper that would not have
    // helped sends people off installing things for nothing.
    const m = makeManager(false);
    const task = failedTask();
    await m._blameMissingHelper(task);
    assert.strictEqual(task.error, 'The server closed the connection.',
      'a direct link failure is not blamed on yt-dlp');
    ok('a plain broken link is not blamed on the helper');
  }

  {
    const m = makeManager(false);
    const task = failedTask({ state: 'queued', headers: { Referer: 'https://x.test/' } });
    await m._blameMissingHelper(task);
    assert.strictEqual(task.error, 'The server closed the connection.',
      'a task that is no longer failed is left alone');
    ok('a task that recovered while we looked is left alone');
  }

  process.stdout.write(`\n   ${pass} checks passed\n`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
