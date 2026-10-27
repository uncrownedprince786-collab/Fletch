'use strict';
/*
 * Live regression: drives the real DownloadManager against the real internet.
 *
 * Kept out of `npm test` because it needs a network, bandwidth and the two
 * optional helpers. Run it with `npm run test:live` when you want proof that
 * the whole stack works against real servers rather than a local stub.
 *
 * Integrity is checked two ways: a byte-for-byte comparison against a plain
 * single-connection fetch, and ffprobe on the media files, which only decodes
 * cleanly if the bytes were reassembled in the right order.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { DownloadManager } = require('../src/main/engine/manager.js');
const { JsonStore } = require('../src/main/store.js');
const { Binaries } = require('../src/main/engine/binaries.js');
const { request } = require('../src/main/engine/net.js');

const SMALL = 'https://proof.ovh.net/files/10Mb.dat';
const LARGE = 'https://ash-speed.hetzner.com/100MB.bin';
const HLS = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8';
// Blender Foundation's own upload of their CC-BY short film.
const PAGE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
};
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** A plain one-socket download, to compare Fletch's output against. */
function fetchPlain(url, dest) {
  return new Promise((resolve, reject) => {
    request(url).then((res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const sink = fs.createWriteStream(dest);
      res.pipe(sink);
      sink.on('finish', resolve);
      sink.on('error', reject);
      res.on('error', reject);
    }).catch(reject);
  });
}

function ffprobe(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration,format_name',
      '-show_entries', 'stream=codec_type,codec_name,height',
      '-of', 'json', file,
    ], { timeout: 60000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function settle(mgr, task, label, timeoutMs = 600000) {
  const t0 = Date.now();
  let peakConns = 0;
  let peakSegs = 0;
  let lastShown = 0;
  while (Date.now() - t0 < timeoutMs) {
    peakConns = Math.max(peakConns, task.connections || 0);
    peakSegs = Math.max(peakSegs, (task.segments || []).length);
    if (task.state === 'done' || task.state === 'error' || task.state === 'cancelled') break;
    if (Date.now() - lastShown > 4000) {
      lastShown = Date.now();
      const pct = Math.round((task.progress || 0) * 100);
      process.stdout.write(
        `    ${label}: ${task.state} ${pct}% ${mb(task.downloaded)} @ ${mb(task.speed)}/s`
        + ` ${task.connections ? `${task.connections} conns` : ''} ${task.stage || ''}\n`
      );
    }
    await wait(250);
  }
  const timedOut = !['done', 'error', 'cancelled'].includes(task.state);
  return { seconds: (Date.now() - t0) / 1000, peakConns, peakSegs, timedOut };
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-live-'));
  const dlDir = path.join(home, 'Downloads');
  const tasks = new JsonStore(path.join(home, 'tasks.json'), { tasks: [] });
  const settings = new JsonStore(path.join(home, 'settings.json'), {});
  tasks.load();
  settings.load();
  Object.assign(settings.data, {
    downloadDir: dlDir, maxConcurrent: 1, connections: 8,
    sortIntoCategories: true, maxHeight: 360, remuxHls: true,
  });
  const mgr = new DownloadManager({ store: tasks, settings, binaries: new Binaries(path.join(home, 'bin')) });

  try {
    const tools = await mgr.binaries.status();
    console.log(`helpers: yt-dlp ${tools.ytdlp.installed ? 'ready' : 'MISSING'}, ffmpeg ${tools.ffmpeg.installed ? 'ready' : 'MISSING'}\n`);

    // ---- 1. a real file, checked byte for byte against a plain fetch -------
    console.log('1. direct file, multi-connection vs single-connection');
    const t1 = await mgr.add(SMALL);
    const r1 = await settle(mgr, t1, '10Mb.dat');
    check(t1.state === 'done', `downloaded in ${r1.seconds.toFixed(1)}s using up to ${r1.peakConns} connections`);
    if (t1.state === 'error') console.log('    error:', t1.error);

    if (t1.state === 'done') {
      const ref = path.join(home, 'reference.dat');
      await fetchPlain(SMALL, ref);
      check(sha(ref) === sha(t1.filePath), 'byte-for-byte identical to a plain single-socket download');
      check(fs.statSync(t1.filePath).size === 10485760, `size exactly as advertised (${mb(fs.statSync(t1.filePath).size)})`);
      check(r1.peakConns > 1, `genuinely parallel (${r1.peakConns} sockets, ${r1.peakSegs} segments)`);
    }

    // ---- 2. a bigger file, to see the splitting work ----------------------
    // Skippable with SKIP_LARGE=1: this one is at the mercy of whichever public
    // mirror is having a good day, and the splitting it exercises is covered
    // offline and deterministically by rebalance.test.js.
    if (process.env.SKIP_LARGE) {
      console.log('\n2. larger file  (skipped, SKIP_LARGE is set)');
    } else {
    console.log('\n2. larger file, dynamic segment splitting');
    const t2 = await mgr.add(LARGE);
    const r2 = await settle(mgr, t2, '100MB.bin', 900000);
    check(t2.state === 'done', `downloaded ${mb(t2.size || 0)} in ${r2.seconds.toFixed(1)}s`
      + ` (${mb((t2.size || 0) / r2.seconds)}/s average)`);
    if (t2.state === 'error') console.log('    error:', t2.error);
    else if (r2.timedOut) console.log('    gave up waiting; still in state ' + t2.state);
    else check(fs.statSync(t2.filePath).size === 104857600, 'full 100 MB landed, no short file');
    console.log(`    peaked at ${r2.peakConns} connections across ${r2.peakSegs} segments`);
    if (t2.warning) console.log(`    note: ${t2.warning}`);
    }

    // ---- 3. a real HLS stream --------------------------------------------
    console.log('\n3. HLS stream (Apple reference stream), with remux');
    const t3 = await mgr.add(HLS);
    const r3 = await settle(mgr, t3, 'bipbop');
    check(t3.state === 'done', `streamed and saved as ${path.basename(t3.filePath || '')} in ${r3.seconds.toFixed(1)}s`);
    if (t3.state === 'error') console.log('    error:', t3.error);
    if (t3.state === 'done' && fs.existsSync(t3.filePath)) {
      const probe = await ffprobe(t3.filePath);
      const kinds = probe ? probe.streams.map((s) => s.codec_type) : [];
      check(Boolean(probe), 'ffprobe decodes the result, so the segments were joined in order');
      check(kinds.includes('video'), `contains a video track (${probe ? probe.streams.map((s) => `${s.codec_type}/${s.codec_name}`).join(', ') : 'n/a'})`);
      if (probe) console.log(`    duration ${Number(probe.format.duration).toFixed(1)}s, container ${probe.format.format_name}`);
    }

    // ---- 4. a web page, via the extractor + merge path --------------------
    console.log('\n4. web page -> extractor -> separate tracks -> merge');
    const t4 = await mgr.add(PAGE);
    const r4 = await settle(mgr, t4, 'youtube');
    check(t4.state === 'done', `saved "${t4.title}"`);
    if (t4.state === 'error') console.log('    error:', t4.error);
    if (t4.state === 'done' && fs.existsSync(t4.filePath)) {
      console.log(`    chose: ${t4.formatLabel} | engine: ${t4.engine} | ${mb(t4.size || 0)} in ${r4.seconds.toFixed(1)}s`);
      const probe = await ffprobe(t4.filePath);
      check(Boolean(probe), 'ffprobe decodes the merged file');
      if (probe) {
        const kinds = probe.streams.map((s) => s.codec_type);
        check(kinds.includes('video') && kinds.includes('audio'),
          `has both picture and sound (${probe.streams.map((s) => `${s.codec_type}/${s.codec_name}`).join(', ')})`);
        const v = probe.streams.find((s) => s.codec_type === 'video');
        check(v && v.height <= 480, `respected the 480p ceiling (got ${v ? `${v.height}p` : '?'})`);
        console.log(`    duration ${Number(probe.format.duration).toFixed(1)}s`);
      }
      check((t4.availableFormats || []).length > 0, `offered ${(t4.availableFormats || []).length} alternative formats for the quality picker`);
    }

    // ---- 5. nothing left lying around ------------------------------------
    console.log('\n5. tidiness');
    const strays = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/fletchpart|\.fletch-tmp/.test(p)) strays.push(p);
      }
    };
    if (fs.existsSync(dlDir)) walk(dlDir);
    check(strays.length === 0, strays.length ? `leftovers: ${strays.join(', ')}` : 'no partial or temporary files left behind');

    const folders = fs.existsSync(dlDir) ? fs.readdirSync(dlDir).sort().join(', ') : '(none)';
    console.log(`    category folders created: ${folders}`);
  } catch (err) {
    console.error('ERROR:', err && err.stack ? err.stack : err);
    failed++;
  } finally {
    mgr.shutdown();
    await wait(500);
    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${failed ? `✗ ${failed} check(s) failed` : '✓ every live check passed'}`);
    process.exitCode = failed ? 1 : 0;
  }
})();
