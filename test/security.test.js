// Invariants that matter for safety rather than for features. A failure here
// is the kind nobody notices until it matters.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Binaries, publishedChecksum, sha256File } = require('../src/main/engine/binaries.js');
const { sanitizeFilename } = require('../src/main/engine/util.js');
const { Bridge } = require('../src/main/bridge.js');
const { JsonStore } = require('../src/main/store.js');

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a downloaded filename can never escape the download folder ----------
// Names come from servers, from Content-Disposition, and from page titles.
// None of those are trustworthy.
const ESCAPES = [
  '../../../../Windows/System32/drivers/etc/hosts',
  '..\\..\\..\\Windows\\System32\\cmd.exe',
  '/etc/passwd',
  'C:\\Windows\\System32\\evil.dll',
  'a/b/../../../c.mp4',
  'file\u0000.mp4',
  '....//....//escape.mp4',
];
const root = path.resolve('/downloads');
for (const nasty of ESCAPES) {
  const cleaned = sanitizeFilename(nasty);
  const resolved = path.resolve(root, cleaned);
  const contained = resolved.toLowerCase().startsWith(root.toLowerCase());
  check(contained && !/[\\/]/.test(cleaned) && !cleaned.includes('\u0000'),
    `"${nasty.slice(0, 32)}" stays inside the folder (-> ${cleaned.slice(0, 32)})`);
}
check(sanitizeFilename('CON') === '_CON' && sanitizeFilename('nul.txt') === '_nul.txt',
  'reserved Windows device names are defused');

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-sec-'));

  try {
    // ---- the local endpoint listens on loopback and nowhere else ---------
    const settings = new JsonStore(path.join(home, 's.json'), {});
    settings.load();
    const bridge = new Bridge({
      settings,
      manager: { add: async () => ({ id: 'x', title: 'x' }), stats: () => ({}) },
    });
    const port = await bridge.start(0);
    const bound = bridge.server.address().address;
    check(bound === '127.0.0.1',
      `the local endpoint is bound to loopback only, not to the network (${bound}:${port})`);
    check(bridge.token.length >= 32,
      `the pairing token is long enough not to be guessed (${bridge.token.length} chars)`);

    const other = new JsonStore(path.join(home, 's2.json'), {});
    other.load();
    const second = new Bridge({ settings: other, manager: {} });
    check(second.token !== bridge.token, 'each install generates its own token');
    bridge.stop();

    // ---- an executable Fletch downloads must match its published sum -----
    const REAL = crypto.randomBytes(1024 * 1024 + 10);
    const REAL_SUM = crypto.createHash('sha256').update(REAL).digest('hex');
    const TAMPERED = Buffer.concat([REAL.subarray(0, REAL.length - 1), Buffer.from([0x00])]);

    let serve = REAL;
    let sumsBody = `${REAL_SUM}  yt-dlp.exe\n`;
    const server = http.createServer((req, res) => {
      if (req.url.includes('SUMS')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(sumsBody);
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(serve.length) });
      return res.end(serve);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const spec = { url: `${base}/yt-dlp.exe`, file: 'yt-dlp.exe', asset: 'yt-dlp.exe', sums: `${base}/SHA2-256SUMS` };

    const bin = new Binaries(path.join(home, 'bin'));
    const attempt = async () => {
      try { await bin.installYtDlp(null, spec); return ''; }
      catch (err) { return err.message; }
    };

    // The checksum file is parsed correctly in the first place.
    check(await publishedChecksum('yt-dlp.exe', spec.sums) === REAL_SUM,
      'the published checksum is read for the right asset');
    check(await publishedChecksum('not-listed', spec.sums) === null,
      'an asset missing from the checksum file yields nothing, not a wrong value');

    serve = TAMPERED;
    let why = await attempt();
    check(/did not match its published checksum/i.test(why),
      `a tampered binary is refused (${why.slice(0, 52)}\u2026)`);
    check(!fs.existsSync(path.join(home, 'bin', 'yt-dlp.exe')),
      'and nothing is left behind for the user to run by accident');

    serve = REAL;
    sumsBody = 'deadbeef  some-other-asset\n';
    why = await attempt();
    check(/could not be verified|could not fetch/i.test(why),
      `an unverifiable download is refused rather than trusted (${why.slice(0, 52)}\u2026)`);

    // And the hash itself is computed over the whole file.
    const sample = path.join(home, 'sample.bin');
    fs.writeFileSync(sample, REAL);
    check(await sha256File(sample) === REAL_SUM, 'the file hash is computed over the whole file');

    server.close();
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    await wait(150);
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
})();
