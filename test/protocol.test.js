// The magnet association is the one piece of Fletch that reaches into the
// Windows registry, so its decision-making is kept pure and tested: it must
// take over its own leftovers and never touch another program's setting.
const path = require('path');
const { exePathFrom } = require('../src/main/protocol.js');

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };

// --- reading the executable out of a registry command string ---
check(
  exePathFrom('"C:\\Program Files\\Fletch\\Fletch.exe" "%1"') === 'C:\\Program Files\\Fletch\\Fletch.exe',
  'a quoted path with spaces is read correctly'
);
check(
  exePathFrom('C:\\Apps\\qbittorrent.exe "%1"') === 'C:\\Apps\\qbittorrent.exe',
  'an unquoted path is read correctly'
);
check(exePathFrom('') === '', 'an empty command yields nothing');
check(exePathFrom(null) === '', 'a missing command yields nothing');

// --- the ownership rule, as the module applies it ---
const isFletch = (p) => /[\\/]fletch\.exe$/i.test(p);
check(isFletch('C:\\Program Files\\Fletch\\Fletch.exe'), 'an installed Fletch is recognised as ours');
check(isFletch('D:\\build\\win-unpacked\\fletch.exe'), 'a Fletch elsewhere is still ours, whatever the case');
check(!isFletch('C:\\Program Files\\qBittorrent\\qbittorrent.exe'), 'qBittorrent is not ours');
check(!isFletch('C:\\Tools\\FletchHelper.exe'), 'a similarly named program is not ours');
check(!isFletch(''), 'an empty path is not ours');

// --- the exact case the user hit: a Fletch that has been moved or removed ---
const self = 'C:\\Program Files\\Fletch\\Fletch.exe';
const stale = 'C:\\Users\\me\\Documents\\Fletch\\release\\win-unpacked\\Fletch.exe';
check(stale.toLowerCase() !== self.toLowerCase(),
  'an association pointing at an old build folder is not treated as current');
// path.win32 explicitly: these are Windows paths, and this suite also runs on
// the Linux and macOS CI runners, where plain path.basename ignores backslashes.
check(isFletch(stale) && path.win32.basename(stale).toLowerCase() === path.win32.basename(self).toLowerCase(),
  'both are called Fletch.exe, which is why matching on the name alone is not enough');

process.exitCode = failed ? 1 : 0;
