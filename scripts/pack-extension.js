'use strict';
/*
 * Produces release/fletch-extension-<version>.zip, ready to upload to the
 * Chrome Web Store (which also covers Edge Add-ons; both take the same zip).
 *
 * Publishing matters for more than tidiness: a store listing is the only way
 * Chrome will let an installer add an extension automatically. See
 * docs/EXTENSION.md.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'release');
const version = require(path.join(ROOT, 'package.json')).version;
const zipPath = path.join(OUT, `fletch-extension-${version}.zip`);

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(zipPath, { force: true });

// The store assigns the ID from the key it is given at upload time, so the
// local "key" field is stripped to avoid a mismatch later.
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
delete manifest.key;
manifest.version = version;

const staging = path.join(OUT, '.ext-staging');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
for (const name of fs.readdirSync(SRC)) {
  if (name === 'manifest.json') continue;
  fs.copyFileSync(path.join(SRC, name), path.join(staging, name));
}
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

execFileSync('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${staging}\*' -DestinationPath '${zipPath}' -Force`,
], { stdio: 'inherit' });

fs.rmSync(staging, { recursive: true, force: true });
const kb = Math.round(fs.statSync(zipPath).size / 1024);
console.log(`wrote ${path.relative(ROOT, zipPath)} (${kb} KB) — upload this at`);
console.log('  https://chrome.google.com/webstore/devconsole');
