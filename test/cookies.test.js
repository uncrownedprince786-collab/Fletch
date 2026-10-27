// Fletch runs as its own program, so it reaches every site signed out even
// while the browser is signed in. The extension passes along the session for
// the one site being downloaded from; these cover both that it is used, and
// that it goes nowhere else.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { DownloadManager } = require('../src/main/engine/manager.js');
const { JsonStore } = require('../src/main/store.js');
const { Binaries } = require('../src/main/engine/binaries.js');
const { toHeader, toNetscape, forUrl, writeCookieFile } = require('../src/main/engine/cookies.js');

const BODY = crypto.randomBytes(512 * 1024);
const SESSION = [
  { name: 'auth_token', value: 'secret123', domain: '.example.com', path: '/', secure: true, hostOnly: false, expires: 1893456000 },
  { name: 'ct0', value: 'abc', domain: 'example.com', path: '/', secure: false, hostOnly: true, expires: 0 },
];

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the pure parts, no network -------------------------------------------
check(toHeader(SESSION) === 'auth_token=secret123; ct0=abc', 'a Cookie header is built in order');
check(toHeader([{ name: 'a', value: '1' }, { name: 'a', value: '2' }]) === 'a=1',
  'a repeated name is not sent twice');
check(toHeader([]) === '' && toHeader(null) === '', 'no cookies yields no header');

const netscape = toNetscape(SESSION);
const rows = netscape.split('\n').filter((l) => l && !l.startsWith('#'));
check(rows.length === 2, 'the cookie file has a row per cookie');
check(rows[0].split('\t').length === 7, 'each row has the seven Netscape columns');
check(rows[0].startsWith('.example.com\tTRUE\t/\tTRUE\t1893456000\tauth_token\tsecret123'),
  'a domain cookie is marked as covering subdomains');
check(rows[1].startsWith('example.com\tFALSE\t/\tFALSE\t0\tct0\tabc'),
  'a host-only cookie is not');

// --- the boundary that matters: cookies must not cross sites --------------
check(forUrl(SESSION, 'https://example.com/x').length === 2, 'the site itself gets its cookies');
check(forUrl(SESSION, 'https://cdn.example.com/x').length === 1,
  'a subdomain gets only the cookies scoped to the parent domain');
check(forUrl(SESSION, 'https://evil.com/x').length === 0, 'another site gets none');
check(forUrl(SESSION, 'https://notexample.com/x').length === 0,
  'a lookalike domain gets none');

// --- a live request actually carries them ---------------------------------
let sawCookie = '';
const server = http.createServer((req, res) => {
  sawCookie = req.headers.cookie || '';
  if (!/auth_token=secret123/.test(sawCookie)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Please sign in');
  }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), BODY.length - 1) : BODY.length - 1;
  const h = { 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
  if (m) h['Content-Range'] = `bytes ${start}-${end}/${BODY.length}`;
  res.writeHead(m ? 206 : 200, h);
  res.end(BODY.subarray(start, end + 1));
});

server.listen(0, '127.0.0.1', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fletch-cookies-'));
  const store = new JsonStore(path.join(home, 't.json'), { tasks: [] });
  const settings = new JsonStore(path.join(home, 's.json'), {});
  store.load();
  settings.load();
  Object.assign(settings.data, { downloadDir: path.join(home, 'dl'), connections: 2, maxConcurrent: 1 });
  const mgr = new DownloadManager({
    store, settings,
    binaries: new Binaries(path.join(home, 'bin')),
    tmpDir: path.join(home, 'work'),
  });

  try {
    const port = server.address().port;
    const local = [{ name: 'auth_token', value: 'secret123', domain: '127.0.0.1', path: '/', secure: false, hostOnly: true, expires: 0 }];

    const t = await mgr.add(`http://127.0.0.1:${port}/members-only.mp4`, { cookies: local });
    const t0 = Date.now();
    while (Date.now() - t0 < 40000 && t.state !== 'done' && t.state !== 'error') await wait(100);

    check(t.state === 'done', `a members-only file downloads with the session (${t.state}${t.error ? ': ' + t.error : ''})`);
    check(/auth_token=secret123/.test(sawCookie), `the request carried the cookie (${sawCookie})`);
    if (t.state === 'done') {
      check(fs.readFileSync(t.filePath).equals(BODY), 'and the file is byte-for-byte correct');
    }

    // --- the session must not be written into the saved task list ---
    const saved = JSON.parse(fs.readFileSync(path.join(home, 't.json'), 'utf8'));
    const asText = JSON.stringify(saved);
    check(!asText.includes('secret123'),
      'the session is never written to the task file on disk');

    // --- nor left lying around as a cookie file ---
    const file = await writeCookieFile(SESSION, path.join(home, 'work', 'probe'), 'session');
    check(Boolean(file) && fs.existsSync(file), 'a cookie file is written for yt-dlp when needed');
    if (file && process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      check(mode === 0o600, `and only this user can read it (mode ${mode.toString(8)})`);
    }
    check(await writeCookieFile([], path.join(home, 'work', 'probe'), 'empty') === null,
      'no file is written when there are no cookies');
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    failed++;
  } finally {
    mgr.shutdown();
    server.close();
    await wait(200);
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
});
