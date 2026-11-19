'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

// Windows tags every file a browser downloads with a note saying it came from
// the internet: a small hidden NTFS stream called Zone.Identifier, known as
// the Mark of the Web. It is what makes SmartScreen check a program before it
// first runs, and Office open a downloaded document in Protected View.
//
// A download manager that leaves it off quietly switches those protections
// off for everything it fetches — including whatever it took over from the
// browser, which never got to run its own download checks either. Fletch
// writes the same mark a browser would, so a file is treated the same way
// whichever of the two fetched it.

const ZONE_INTERNET = 3;

/**
 * Where a file came from, without what a stranger reading the mark should not
 * see: no signed query string, no fragment, no user name or password.
 */
function cleanUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/^https?:$/.test(u.protocol)) return '';
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '';
  }
}

/** The mark's contents, laid out as Windows and browsers write it. */
function zoneText({ hostUrl, referrerUrl } = {}) {
  const lines = ['[ZoneTransfer]', `ZoneId=${ZONE_INTERNET}`];
  const referrer = cleanUrl(referrerUrl);
  if (referrer) lines.push(`ReferrerUrl=${referrer}`);
  // A magnet or an address we cannot show still came from the internet.
  lines.push(`HostUrl=${cleanUrl(hostUrl) || 'about:internet'}`);
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Mark one file. Returns whether the mark was written. Never throws: a drive
 * that cannot hold the mark (FAT32 and exFAT have no streams) or a file that
 * has moved on is no reason to fail a finished download.
 */
function markFileSync(file, info) {
  if (process.platform !== 'win32' || !file) return false;
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, zoneText(info));
    return true;
  } catch {
    return false;
  }
}

/** Every file under a folder, for a torrent that arrived as one. */
async function filesUnder(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await filesUnder(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Mark a finished download, which may be one file or a folder of them.
 *
 * A single file is marked before this returns, so the mark is in place before
 * anything gets the chance to open it. A folder is walked afterwards.
 */
function markDownload(target, info) {
  if (process.platform !== 'win32' || !target) return Promise.resolve(0);
  let stat;
  try { stat = fs.statSync(target); } catch { return Promise.resolve(0); }
  if (stat.isFile()) return Promise.resolve(markFileSync(target, info) ? 1 : 0);
  if (!stat.isDirectory()) return Promise.resolve(0);
  return filesUnder(target).then((files) => files.filter((f) => markFileSync(f, info)).length);
}

module.exports = { markDownload, markFileSync, zoneText, cleanUrl };
