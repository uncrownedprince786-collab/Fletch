'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Claiming magnet: links.
//
// On Windows the installer writes the machine-wide association under HKCR, but
// a per-user association under HKCU beats it. Earlier copies of Fletch (and the
// Electron API, which matches only on the executable's filename) could leave
// that per-user key pointing at a build folder that no longer exists, so
// clicking a magnet appeared to do nothing at all.
//
// Fletch only ever touches that key when it names a Fletch.exe, and never when
// it belongs to some other torrent client.

const KEY = 'HKCU\\Software\\Classes\\magnet\\shell\\open\\command';

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '') });
    });
  });
}

/** Escape a string for the right-hand side of a .reg file value. */
function regEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Write the association by importing a .reg file.
 *
 * `reg add /d "\"C:\path\app.exe\" \"%1\""` has to survive Node's argument
 * quoting, Windows' command-line parsing and reg.exe's own, and the quotes do
 * not come out the other side intact — which is why the repair silently did
 * nothing. A .reg file has one well-defined escaping scheme and no shell in
 * the middle of it.
 */
async function writeUserAssociation(exePath) {
  const body = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\magnet]',
    '@="URL:Magnet Protocol"',
    '"URL Protocol"=""',
    '"Content Type"="application/x-magnet"',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\magnet\\DefaultIcon]',
    `@="${regEscape(exePath)},0"`,
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\magnet\\shell\\open\\command]',
    `@="${regEscape(`"${exePath}" "%1"`)}"`,
    '',
  ].join('\r\n');

  const file = path.join(os.tmpdir(), `fletch-magnet-${Date.now()}.reg`);
  try {
    // reg.exe reads .reg files as UTF-16LE when they carry a BOM.
    await fsp.writeFile(file, '\ufeff' + body, 'ucs2');
    const res = await reg(['import', file]);
    return res.ok;
  } catch {
    return false;
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}

/** The command string the current user's magnet association points at. */
async function readUserAssociation() {
  const { ok, out } = await reg(['query', KEY, '/ve']);
  if (!ok) return null;
  const m = /REG_SZ\s+(.+)/i.exec(out);
  return m ? m[1].trim() : null;
}

function exePathFrom(command) {
  const quoted = /^"([^"]+)"/.exec(command || '');
  if (quoted) return quoted[1];
  const bare = /^(\S+)/.exec(command || '');
  return bare ? bare[1] : '';
}

/**
 * Make magnet links reach this copy of Fletch.
 * Returns a short description of what was done, for the log and for Settings.
 */
async function ensureMagnetHandler({ app, enabled = true }) {
  if (!enabled) return { state: 'disabled' };

  if (process.platform !== 'win32') {
    // macOS and Linux have no equivalent tangle; the normal API is reliable.
    try {
      app.setAsDefaultProtocolClient('magnet');
      return { state: 'registered' };
    } catch (err) {
      return { state: 'failed', error: err.message };
    }
  }

  const self = process.execPath;
  const current = await readUserAssociation();

  if (!current) {
    // Nothing per-user, so the installer's machine-wide entry is in charge.
    if (!app.isPackaged) return { state: 'skipped-dev' };
    return { state: 'machine-wide' };
  }

  const target = exePathFrom(current);
  if (target.toLowerCase() === self.toLowerCase()) return { state: 'already-ours' };

  const isFletch = /[\\/]fletch\.exe$/i.test(target);
  if (!isFletch) {
    // Another torrent client owns this. Leave it alone and say so.
    return { state: 'taken', by: target };
  }

  // It is a Fletch, but not this one. If that copy is gone the association is
  // simply broken, so take it over; if it still exists, point it here anyway,
  // since the installed copy is the one that should win.
  const stale = !fs.existsSync(target);
  if (!app.isPackaged && !stale) return { state: 'skipped-dev' };

  if (!await writeUserAssociation(self)) {
    return { state: 'failed', error: 'could not write the association' };
  }

  // Confirm it actually landed, rather than trusting the exit code.
  const after = exePathFrom(await readUserAssociation());
  if (after.toLowerCase() !== self.toLowerCase()) {
    return { state: 'failed', error: `association still points at ${after || 'nothing'}` };
  }

  return { state: stale ? 'repaired-stale' : 'taken-over', from: target };
}

module.exports = { ensureMagnetHandler, readUserAssociation, exePathFrom };
