'use strict';
// A finished download carries Windows' "came from the internet" mark, the
// same one a browser writes, so SmartScreen and Office's Protected View treat
// it exactly as they would a file Chrome had fetched. The mark says where the
// file came from, but never the signed part of the link.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { DownloadManager } = require('../src/main/engine/manager.js');
const { JsonStore } = require('../src/main/store.js');
const { markDownload, zoneText } = require('../src/main/engine/motw.js');

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readMark = (file) => { try { return fs.readFileSync(`${file}:Zone.Identifier`, 'utf8'); } catch { return null; } };

// What goes into the mark, on any platform.
const text = zoneText({
  hostUrl: 'https://user:secret@cdn.example.test/files/setup.exe?sig=abc123&exp=99#frag',
  referrerUrl: 'https://site.example.test/download?id=7',
});
check(/^\[ZoneTransfer\]\r\nZoneId=3\r\n/.test(text), 'the mark says "internet zone", in the layout Windows reads');
check(/HostUrl=https:\/\/cdn\.example\.test\/files\/setup\.exe\r\n/.test(text), 'it records where the file came from');
check(!/sig=|abc123|secret|user|#frag/.test(text), 'without the signed query string, fragment or password');
check(/ReferrerUrl=https:\/\/site\.example\.test\/download\r\n/.test(text), 'and the page it was found on');
check(/HostUrl=about:internet/.test(zoneText({ hostUrl: 'magnet:?xt=urn:btih:abc' })), 'a magnet still counts as from the internet');

if (process.platform !== 'win32') {
  console.log('SKIP  the stream itself is Windows-only (NTFS)');
  process.exitCode = failed ? 1 : 0;
} else {
  const BODY = crypto.randomBytes(1536 * 1024);
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), BODY.length - 1) : BODY.length - 1;
    const h = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'attachment; filename="setup.exe"',
    };
    if (m) h['Content-Range'] = `bytes ${start}-${end}/${BODY.length}`;
    res.writeHead(m ? 206 : 200, h);
    res.end(BODY.subarray(start, end + 1));
  });

  server.listen(0, '127.0.0.1', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-motw-'));
    const tasksStore = new JsonStore(path.join(home, 't.json'), { tasks: [] });
    const settings = new JsonStore(path.join(home, 's.json'), {});
    tasksStore.load();
    settings.load();
    Object.assign(settings.data, { downloadDir: path.join(home, 'dl'), connections: 4, maxConcurrent: 1 });
    const mgr = new DownloadManager({
      store: tasksStore, settings,
      binaries: { setOverrides: () => {}, resolve: async () => null },
      tmpDir: path.join(home, 'work'),
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      let opened = null;
      // The moment a download completes is when Fletch may open it (it does
      // for an installer it fetched for itself). The mark must already be there.
      mgr.on('completed', (t) => { opened = readMark(t.filePath); });
      const task = await mgr.add(`${base}/files/setup.exe?sig=s3cr3t`, { headers: { Referer: `${base}/page?ref=1` } });
      const t0 = Date.now();
      while (Date.now() - t0 < 30000 && !['done', 'error'].includes(task.state)) await wait(100);
      check(task.state === 'done', `the download finished (${task.state}${task.error ? `: ${task.error}` : ''})`);

      const mark = readMark(task.filePath) || '';
      check(/ZoneId=3/.test(mark), 'the finished file carries the internet-zone mark');
      check(mark.includes(`HostUrl=${base}/files/setup.exe\r\n`) && !/s3cr3t/.test(mark), 'naming where it came from, minus the signature');
      check(mark.includes(`ReferrerUrl=${base}/page\r\n`), 'and the page that linked to it');
      check(Boolean(opened && /ZoneId=3/.test(opened)), 'it was in place before the file was handed on as complete');
      check(crypto.createHash('sha256').update(fs.readFileSync(task.filePath)).digest('hex')
        === crypto.createHash('sha256').update(BODY).digest('hex'), 'the file itself is untouched, byte for byte');

      // A torrent can arrive as a folder: every file in it is marked.
      const folder = path.join(home, 'dl', 'Torrents', 'Some Album');
      fs.mkdirSync(path.join(folder, 'CD2'), { recursive: true });
      fs.writeFileSync(path.join(folder, '01.flac'), 'a');
      fs.writeFileSync(path.join(folder, 'CD2', '02.flac'), 'b');
      const marked = await markDownload(folder, { hostUrl: 'magnet:?xt=urn:btih:abc' });
      check(marked === 2 && /ZoneId=3/.test(readMark(path.join(folder, 'CD2', '02.flac')) || ''),
        `every file in a downloaded folder is marked (${marked} of 2)`);

      check(await markDownload(path.join(home, 'no-such-file.bin'), {}) === 0, 'a file that is gone is skipped quietly');
    } catch (err) {
      console.error('ERROR:', err.stack || err.message);
      failed++;
    } finally {
      mgr.shutdown();
      server.close();
      await wait(200);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      process.exitCode = failed ? 1 : 0;
    }
  });
}
