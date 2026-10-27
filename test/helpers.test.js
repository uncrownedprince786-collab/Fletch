'use strict';
// Installing a helper: download, verify against the project's published
// checksum, unpack, and keep only what was asked for. The verification is the
// point — these files are about to be executed, so anything that does not
// match its published hash must be discarded rather than run.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Binaries } = require('../src/main/engine/binaries.js');

let pass = 0;
function ok(name) { pass++; process.stdout.write(`   ✓ ${name}\n`); }
function skip(name) { process.stdout.write(`   – ${name} (not this platform)\n`); }

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function zip(source, target) {
  const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path ${quote(source)} -DestinationPath ${quote(target)} -Force`],
    { timeout: 120000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

(async () => {
  if (process.platform !== 'win32') {
    skip('unpacking a helper archive');
    skip('refusing an archive that fails its checksum');
    process.stdout.write('\n   nothing to run on this platform\n');
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-helpers-'));
  // A stand-in for the real release: a build folder with the layout the
  // genuine archive has, so the "take the bin folder" logic is exercised.
  const build = path.join(work, 'ffmpeg-test-build');
  fs.mkdirSync(path.join(build, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(build, 'doc'), { recursive: true });
  fs.writeFileSync(path.join(build, 'bin', 'ffmpeg.exe'), crypto.randomBytes(2 * 1024 * 1024));
  fs.writeFileSync(path.join(build, 'bin', 'avcodec-60.dll'), crypto.randomBytes(512 * 1024));
  fs.writeFileSync(path.join(build, 'doc', 'readme.txt'), 'not wanted');

  const archive = path.join(work, 'ffmpeg-release.zip');
  await zip(build, archive);
  const bytes = fs.readFileSync(archive);
  const realHash = sha256(bytes);

  let claimedHash = realHash;
  const server = http.createServer((req, res) => {
    if (req.url === '/ffmpeg-release.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) });
      return res.end(bytes);
    }
    if (req.url === '/checksums.sha256') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(`${claimedHash}  ffmpeg-release.zip\n`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;
  const spec = {
    url: `${base}/ffmpeg-release.zip`,
    asset: 'ffmpeg-release.zip',
    sums: `${base}/checksums.sha256`,
    file: 'ffmpeg.exe',
    archive: 'zip',
    take: 'bin',
  };

  {
    const binDir = path.join(work, 'bin-good');
    const binaries = new Binaries(binDir);
    // The stand-in is random bytes, not a program. We are testing the install,
    // not whether a real ffmpeg runs.
    binaries._runs = async () => true;

    const result = await binaries.install('ffmpeg', null, spec);
    assert.ok(fs.existsSync(path.join(binDir, 'ffmpeg.exe')), 'the binary is kept');
    assert.ok(fs.existsSync(path.join(binDir, 'avcodec-60.dll')), 'and the libraries beside it');
    assert.ok(!fs.existsSync(path.join(binDir, 'readme.txt')), 'but nothing outside bin');
    assert.strictEqual(result.sha256, realHash, 'the hash it verified is reported back');
    const leftovers = (await fsp.readdir(binDir)).filter((f) => f.startsWith('.') || f.endsWith('.part'));
    assert.deepStrictEqual(leftovers, [], 'and no staging litter is left behind');
    ok('unpacking a helper archive keeps the right files');
  }

  {
    claimedHash = 'a'.repeat(64); // the published hash no longer matches
    const binDir = path.join(work, 'bin-bad');
    const binaries = new Binaries(binDir);
    binaries._runs = async () => true;

    await assert.rejects(
      () => binaries.install('ffmpeg', null, spec),
      /did not match its published checksum/,
      'a mismatch must be refused by name',
    );
    const after = fs.existsSync(binDir) ? await fsp.readdir(binDir) : [];
    assert.deepStrictEqual(after.filter((f) => f.endsWith('.exe') || f.endsWith('.dll')), [],
      'and nothing from it is left where Fletch would run it');
    ok('an archive that fails its checksum is discarded, not run');
  }

  server.close();
  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(`\n   ${pass} checks passed\n`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
