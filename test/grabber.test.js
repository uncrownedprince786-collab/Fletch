'use strict';
// Which video the grabber actually grabs.
//
// This exists because of a real report: on a YouTube watch page the button
// downloaded a video from the sidebar instead of the one playing. That is a
// worse failure than not downloading at all — it succeeds, loudly, at the
// wrong thing, and the user has no reason to suspect the button rather than
// their own click.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

/** Load content.js over a stub browser and hand back what it exports. */
function load() {
  const noop = () => {};
  const module = { exports: {} };
  const context = {
    module,
    // The script asks for its settings and only starts the grabber once they
    // arrive; never calling back keeps the DOM machinery out of the way.
    chrome: { storage: { local: { get: noop }, onChanged: { addListener: noop } }, runtime: { sendMessage: noop } },
    document: { addEventListener: noop, documentElement: {}, createElement: () => ({ style: {} }) },
    addEventListener: noop,
    setInterval: noop,
    setTimeout: noop,
    MutationObserver: function MutationObserver() { this.observe = noop; },
    location: { href: 'https://example.test/' },
    WeakSet,
  };
  vm.runInNewContext(SOURCE, context);
  return module.exports;
}

/** The smallest stand-in for a video sitting in a page. */
function videoIn({ inside = null, ancestors = [] } = {}) {
  const build = (level) => ({
    querySelectorAll: () => level.links || [],
    parentElement: null,
  });
  const nodes = ancestors.map(build);
  for (let i = 0; i < nodes.length - 1; i += 1) nodes[i].parentElement = nodes[i + 1];
  return {
    closest: () => inside,
    parentElement: nodes[0] || null,
  };
}

const link = (href) => ({ href });

let pass = 0;
function ok(name) { pass++; process.stdout.write(`   ✓ ${name}\n`); }

const { chooseTarget, permalinkFor, magnetWasTaken } = load();

// ---- which address is handed to Fletch ------------------------------------

{
  const watch = 'https://www.youtube.com/watch?v=REAL';
  const sidebar = 'https://www.youtube.com/watch?v=SOMETHINGELSE';
  assert.strictEqual(chooseTarget(watch, sidebar), watch,
    'on a watch page the address bar is the video, whatever links are nearby');
  ok('a watch page downloads the video on it, not one beside it');
}

{
  const feed = 'https://x.com/home';
  const post = 'https://x.com/someone/status/123';
  assert.strictEqual(chooseTarget(feed, post), post,
    'on a feed the address bar is a list, so the post link is the video');
  ok('a feed still downloads the post the video belongs to');
}

{
  const feed = 'https://x.com/home';
  assert.strictEqual(chooseTarget(feed, ''), feed, 'with no permalink there is only the page');
  ok('a feed with nothing to point at falls back to the page');
}

// ---- and how that permalink is found --------------------------------------

{
  // A YouTube player a few levels below a container holding the whole
  // sidebar. Every one of those links matches the selector.
  const video = videoIn({
    ancestors: [
      { links: [] },
      { links: [link('https://www.youtube.com/watch?v=NEXT'), link('https://www.youtube.com/watch?v=AFTER')] },
    ],
  });
  assert.strictEqual(permalinkFor(video), '',
    'several candidates means no answer, not the first one');
  ok('a page full of other videos yields no permalink at all');
}

{
  const video = videoIn({ inside: link('https://x.com/someone/status/123') });
  assert.strictEqual(permalinkFor(video), 'https://x.com/someone/status/123',
    'the anchor the video sits inside is unambiguous');
  ok('a video wrapped in its own link uses that link');
}

{
  const video = videoIn({ ancestors: [{ links: [link('https://site.test/video/9')] }] });
  assert.strictEqual(permalinkFor(video), 'https://site.test/video/9',
    'exactly one candidate leaves nothing to get wrong');
  ok('a single nearby link is taken');
}

// ---- magnet links when Fletch is closed -----------------------------------

{
  assert.strictEqual(magnetWasTaken({ ok: true }), true, 'Fletch queued it');
  assert.strictEqual(magnetWasTaken({ ok: false, reason: 'Fletch is not running' }), false,
    'a refusal is not a success, so the system should get the link instead');
  assert.strictEqual(magnetWasTaken(undefined), false,
    'no reply at all means the background script never answered');
  assert.strictEqual(magnetWasTaken(null), false, 'and neither does a null one');
  ok('a magnet Fletch did not take is handed back to the system');
}

process.stdout.write(`\n   ${pass} checks passed\n`);
