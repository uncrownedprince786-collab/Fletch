// Torrents, tested without touching the public swarm: one WebTorrent client
// seeds a file, and Fletch's engine fetches it back over loopback by being
// handed the seeder's address directly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  TorrentDownload, isTorrentSource, nameFromMagnet, destroyClient,
} = require('../src/main/engine/torrent.js');

const PAYLOAD = crypto.randomBytes(3 * 1024 * 1024);
const EXPECTED = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // --- the pure functions first, no network at all ---
  check(isTorrentSource('magnet:?xt=urn:btih:abc'), 'a magnet link is recognised');
  check(isTorrentSource('https://example.com/a.torrent'), 'a .torrent URL is recognised');
  check(!isTorrentSource('https://example.com/a.mp4'), 'an ordinary media link is not mistaken for one');
  check(
    nameFromMagnet('magnet:?xt=urn:btih:abc&dn=Debian+13+netinst.iso') === 'Debian 13 netinst.iso',
    'the display name is read out of the magnet link'
  );

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-torrent-'));
  const seedDir = path.join(home, 'seed');
  const outDir = path.join(home, 'out');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, 'payload.bin'), PAYLOAD);

  const { default: WebTorrent } = await import('webtorrent');
  const seeder = new WebTorrent({ dht: false, lsd: false, tracker: false });

  try {
    const seeded = await new Promise((resolve, reject) => {
      seeder.on('error', reject);
      seeder.seed(path.join(seedDir, 'payload.bin'), { announce: [] }, resolve);
    });
    const port = seeder.torrentPort;
    console.log(`    seeding ${seeded.name} (${(seeded.length / 1048576).toFixed(1)} MB) on 127.0.0.1:${port}`);

    const dl = new TorrentDownload({
      url: seeded.magnetURI,
      dir: outDir,
      announce: [],                       // no trackers: this is a closed test
      addPeers: [`127.0.0.1:${port}`],
      metadataTimeout: 45000,
    });

    let sawPeers = 0;
    let sawPieces = 0;
    let metaName = '';
    dl.on('meta', (m) => { metaName = m.name; });
    dl.on('progress', (p) => {
      sawPeers = Math.max(sawPeers, p.connections);
      sawPieces = Math.max(sawPieces, (p.segments || []).length);
    });

    const t0 = Date.now();
    const res = await dl.start();
    const secs = (Date.now() - t0) / 1000;

    check(Boolean(res && res.filePath), `finished in ${secs.toFixed(1)}s`);
    check(metaName === 'payload.bin', `metadata arrived from the peer (name: ${metaName || 'none'})`);
    check(sawPeers >= 1, `connected to the swarm (${sawPeers} peer)`);
    check(sawPieces > 1, `reported piece-level progress for the bar (${sawPieces} blocks)`);

    const got = fs.existsSync(res.filePath)
      ? crypto.createHash('sha256').update(fs.readFileSync(res.filePath)).digest('hex')
      : '';
    check(got === EXPECTED, 'the downloaded file matches the seeded one byte for byte');

    await dl.stopSeeding();
    check(true, 'released the torrent without hanging');
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    await new Promise((r) => seeder.destroy(() => r()));
    await destroyClient();
    await wait(300);
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
    // WebTorrent keeps a few handles warm; nothing is left to do here.
    setTimeout(() => process.exit(failed ? 1 : 0), 500).unref();
  }
})();
