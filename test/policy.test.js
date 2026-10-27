'use strict';
// The release policy: the rule that decides whether a copy of Fletch is still
// fit to run. It gates a screen the user cannot dismiss, so the failure that
// matters most is a false one — a missing or malformed policy file must never
// lock anybody out of a version that was fine.
const assert = require('assert');
const http = require('http');
const { Updater, compareVersions, olderThan } = require('../src/main/updater');

function stubApp(version) {
  return { getVersion: () => version, isPackaged: false };
}

function stubSettings(values = {}) {
  return { get: (key, fallback) => (key in values ? values[key] : fallback), set: () => {} };
}

let pass = 0;
function ok(name) { pass++; process.stdout.write(`   ✓ ${name}\n`); }

(async () => {
  assert.strictEqual(compareVersions('1.2.1', '1.2.2'), -1);
  assert.strictEqual(compareVersions('1.2.2', '1.2.2'), 0);
  assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1, 'versions compare as numbers, not text');
  assert.strictEqual(compareVersions('1.2.2-beta.1', '1.2.2'), 0, 'a pre-release counts as its release');
  assert.strictEqual(olderThan('1.2.1', ''), false, 'no floor means nothing to be older than');
  ok('versions compare the way versions should');

  // A policy file served from somewhere we control, so the test needs no network.
  let body = JSON.stringify({
    minimumVersion: '1.2.2',
    minimumExtensionVersion: '1.0.1',
    reason: 'It filled your Downloads folder.',
    downloadUrl: 'https://example.test/latest',
  });
  let status = 200;
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const policyUrl = `http://127.0.0.1:${server.address().port}/release-policy.json`;

  {
    const u = new Updater({ app: stubApp('1.2.1'), settings: stubSettings(), policyUrl });
    await u.checkPolicy();
    assert.strictEqual(u.required, true, 'a withdrawn version must be held back');
    const s = u.status();
    assert.strictEqual(s.required, true);
    assert.strictEqual(s.reason, 'It filled your Downloads folder.', 'the user is told why');
    assert.strictEqual(s.downloadUrl, 'https://example.test/latest', 'and where to get the replacement');
    ok('a version below the floor is required to update');
  }

  {
    const u = new Updater({ app: stubApp('1.2.2'), settings: stubSettings(), policyUrl });
    await u.checkPolicy();
    assert.strictEqual(u.required, false, 'the version named by the policy is the fixed one');
    ok('the fixed version is not asked to update');
  }

  {
    const u = new Updater({ app: stubApp('2.0.0'), settings: stubSettings(), policyUrl });
    await u.checkPolicy();
    assert.strictEqual(u.required, false);
    ok('a later version is not dragged backwards');
  }

  {
    // Turning updates off is a choice about convenience. It is not a way to
    // keep running something that was withdrawn.
    const u = new Updater({ app: stubApp('1.2.1'), settings: stubSettings({ autoUpdate: false }), policyUrl });
    await u.checkPolicy();
    assert.strictEqual(u.required, true, 'the preference does not override a recall');
    ok('switching updates off does not waive a required one');
  }

  {
    const u = new Updater({ app: stubApp('1.2.1'), settings: stubSettings(), policyUrl });
    assert.strictEqual(u.extensionOutdated, false, 'an extension never seen is not called outdated');
    await u.checkPolicy();
    u.noteExtension('1.0.0');
    assert.strictEqual(u.extensionOutdated, true, 'the browser is holding the old extension');
    u.noteExtension('1.0.1');
    assert.strictEqual(u.extensionOutdated, false, 'and now it is not');
    ok('an out-of-date extension is noticed separately from the app');
  }

  // Everything below is a policy that could not be read. Each one must leave
  // the app running, because locking someone out by accident is the worse bug.
  {
    status = 404;
    const u = new Updater({ app: stubApp('1.2.1'), settings: stubSettings(), policyUrl });
    await u.checkPolicy();
    assert.strictEqual(u.required, false, 'a missing policy file blocks nobody');
    status = 200;
    ok('a missing policy file is not a recall');
  }

  {
    body = 'not json at all';
    const u = new Updater({ app: stubApp('1.2.1'), settings: stubSettings(), policyUrl });
    await u.checkPolicy();
    assert.strictEqual(u.required, false, 'a corrupt policy file blocks nobody');
    body = JSON.stringify({ minimumVersion: '1.2.2' });
    ok('a corrupt policy file is not a recall');
  }

  {
    const u = new Updater({
      app: stubApp('1.2.1'),
      settings: stubSettings(),
      policyUrl: 'http://127.0.0.1:1/release-policy.json', // nothing listens
    });
    await u.checkPolicy();
    assert.strictEqual(u.required, false, 'being offline blocks nobody');
    ok('an unreachable policy file is not a recall');
  }

  server.close();
  process.stdout.write(`\n   ${pass} checks passed\n`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
