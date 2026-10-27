'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { request, fetchText } = require('./net');

// Fletch ships no third-party binaries. It fetches two helpers from their
// official release pages and keeps them in its own folder, falling back to
// whatever is already on PATH:
//   yt-dlp  - resolves a page URL to real media URLs (site extractors)
//   ffmpeg  - muxes separate video/audio tracks and remuxes HLS into MP4
// Everything Fletch does with a plain file URL works without either of them,
// but a link to a web page does not, which is most of what people want.
//
// Both are verified against the checksum their project publishes before being
// kept, and anything that does not match is discarded rather than run.

const RELEASES = {
  'yt-dlp': {
    // `asset` is the name as it appears in the project's own checksum file.
    win32: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', file: 'yt-dlp.exe', asset: 'yt-dlp.exe' },
    darwin: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', file: 'yt-dlp', asset: 'yt-dlp_macos' },
    linux: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', file: 'yt-dlp', asset: 'yt-dlp' },
  },
  // Windows only, and deliberately. On macOS and Linux ffmpeg comes from a
  // package manager that installs it better than this could and keeps it
  // updated afterwards; there is nothing to improve on there.
  //
  // The LGPL build, not the GPL one: Fletch runs ffmpeg as a separate program
  // rather than linking to it, and the lighter licence keeps the choice open
  // for anyone who later passes a copy of Fletch on. The shared build is a
  // third of the size of the static one, at the cost of bringing its DLLs
  // along, which land beside it.
  ffmpeg: {
    win32: {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-shared.zip',
      asset: 'ffmpeg-master-latest-win64-lgpl-shared.zip',
      sums: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256',
      file: 'ffmpeg.exe',
      archive: 'zip',
      take: 'bin', // the folder inside the archive whose contents we keep
    },
  },
};

/** Unpack a zip. Windows only, which is the only platform that needs it. */
function extractZip(zipFile, destDir) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${quote(zipFile)} -DestinationPath ${quote(destDir)} -Force`],
    { timeout: 10 * 60 * 1000, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300) || 'could not unpack'));
      else resolve();
    });
  });
}

/** The first directory of this name anywhere under root, or null. */
async function findDir(root, wanted) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === wanted) return path.join(root, entry.name);
    const deeper = await findDir(path.join(root, entry.name), wanted);
    if (deeper) return deeper;
  }
  return null;
}

const YTDLP_SUMS = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS';

/**
 * The SHA-256 the project published for this asset, or null if the checksum
 * file could not be read.
 */
async function publishedChecksum(assetName, sumsUrl) {
  const { body } = await fetchText(sumsUrl || YTDLP_SUMS, { maxBytes: 256 * 1024, timeout: 30000 });
  for (const line of body.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m && m[2] === assetName) return m[1].toLowerCase();
  }
  return null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

const FFMPEG_HINTS = {
  win32: 'https://www.gyan.dev/ffmpeg/builds/  (grab "release essentials", unzip, point Fletch at ffmpeg.exe)',
  darwin: 'brew install ffmpeg',
  linux: 'sudo apt install ffmpeg   (or your distro’s equivalent)',
};

class Binaries {
  constructor(binDir) {
    this.binDir = binDir;
    this.overrides = {};
    this._cache = new Map();
  }

  setOverrides(overrides = {}) {
    this.overrides = overrides;
    this._cache.clear();
  }

  _candidates(name) {
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    const list = [];
    if (this.overrides[name]) list.push(this.overrides[name]);
    list.push(path.join(this.binDir, exe));
    // Bare name lets the OS resolve it from PATH.
    list.push(exe);
    if (process.platform !== 'win32') {
      list.push(`/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/bin/${name}`);
    }
    return list;
  }

  /** Resolve a tool to a runnable path, or null. Cached after the first hit. */
  async resolve(name) {
    if (this._cache.has(name)) return this._cache.get(name);
    for (const candidate of this._candidates(name)) {
      if (!candidate) continue;
      const ok = await this._runs(candidate);
      if (ok) {
        this._cache.set(name, candidate);
        return candidate;
      }
    }
    this._cache.set(name, null);
    return null;
  }

  _runs(cmd) {
    return new Promise((resolve) => {
      const args = /ffmpeg|ffprobe/.test(cmd) ? ['-version'] : ['--version'];
      // yt-dlp ships as a PyInstaller bundle that unpacks itself on first run;
      // on a cold or busy machine that can take well over ten seconds, and
      // timing out here makes Fletch wrongly report it as missing.
      execFile(cmd, args, { timeout: 45000, windowsHide: true }, (err) => resolve(!err));
    });
  }

  async status() {
    const [ytdlp, ffmpeg] = await Promise.all([this.resolve('yt-dlp'), this.resolve('ffmpeg')]);
    return {
      ytdlp: { path: ytdlp, installed: Boolean(ytdlp), canAutoInstall: this.canAutoInstall('yt-dlp') },
      ffmpeg: {
        path: ffmpeg,
        installed: Boolean(ffmpeg),
        canAutoInstall: this.canAutoInstall('ffmpeg'),
        hint: FFMPEG_HINTS[process.platform] || '',
      },
      binDir: this.binDir,
    };
  }

  /** Whether this platform has a published build Fletch can fetch itself. */
  canAutoInstall(name) {
    return Boolean(RELEASES[name] && RELEASES[name][process.platform]);
  }

  async installYtDlp(onProgress, override) {
    return this.install('yt-dlp', onProgress, override);
  }

  /**
   * Fetch a helper from its official release into Fletch's own bin folder.
   *
   * Everything here exists because the file is about to be executed: the size
   * floor catches an error page served with a 200, and the checksum catches
   * everything else. Nothing that fails either is kept, let alone run.
   */
  async install(name, onProgress, override) {
    // `override` lets the tests point this at a local stand-in for the real
    // release, so the verification can be exercised without the network.
    const spec = override || (RELEASES[name] && RELEASES[name][process.platform]);
    if (!spec) throw new Error(`No ${name} build is published for ${process.platform}.`);

    await fsp.mkdir(this.binDir, { recursive: true });
    const target = path.join(this.binDir, spec.file);
    // An archive is staged under a .zip name: Expand-Archive refuses to look
    // at a file called anything else, whatever is actually inside it.
    const tmp = spec.archive === 'zip'
      ? path.join(this.binDir, `.${name}-download.zip`)
      : `${target}.part`;

    const res = await request(spec.url, { timeout: 60000 });
    if ((res.statusCode || 0) !== 200) {
      res.resume();
      throw new Error(`Download failed with HTTP ${res.statusCode}.`);
    }
    const total = Number(res.headers['content-length']) || 0;

    await new Promise((resolve, reject) => {
      const sink = fs.createWriteStream(tmp);
      let got = 0;
      res.on('data', (c) => {
        got += c.length;
        if (onProgress) onProgress({ downloaded: got, size: total });
      });
      res.pipe(sink);
      sink.on('finish', resolve);
      sink.on('error', reject);
      res.on('error', reject);
    });

    const stat = await fsp.stat(tmp);
    // A truncated or error-page download would be orders of magnitude smaller.
    if (stat.size < 1024 * 1024) {
      await fsp.rm(tmp, { force: true });
      throw new Error(`The downloaded file was too small to be ${name}; aborting.`);
    }

    // This file is about to be executed, so size is nowhere near enough. Both
    // projects publish a SHA-256 for every asset; check against it and refuse
    // anything that does not match.
    let expected = null;
    try {
      expected = await publishedChecksum(spec.asset, spec.sums);
    } catch {
      expected = null; // checksum file unreachable; handled just below
    }
    if (!expected) {
      await fsp.rm(tmp, { force: true });
      throw new Error(
        `Could not fetch ${name}’s published checksums, so the download could not be `
        + 'verified. Nothing was installed. Check your connection and try again.'
      );
    }
    const actual = await sha256File(tmp);
    if (actual !== expected) {
      await fsp.rm(tmp, { force: true });
      throw new Error(
        `The downloaded ${name} did not match its published checksum, so it was discarded. `
        + 'Do not install it by hand — this should never happen on a clean connection.'
      );
    }

    if (spec.archive === 'zip') {
      // Unpacked somewhere of its own first: a half-extracted archive must not
      // leave a broken ffmpeg.exe sitting where Fletch would try to run it.
      const staging = path.join(this.binDir, `.${name}-unpack`);
      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(staging, { recursive: true });
      try {
        await extractZip(tmp, staging);
        const from = spec.take ? await findDir(staging, spec.take) : staging;
        if (!from) throw new Error(`The ${name} archive had no ${spec.take} folder in it.`);
        for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          await fsp.copyFile(path.join(from, entry.name), path.join(this.binDir, entry.name));
        }
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    } else {
      await fsp.rm(target, { force: true }).catch(() => {});
      await fsp.rename(tmp, target);
      if (process.platform !== 'win32') await fsp.chmod(target, 0o755);
    }

    this._cache.delete(name);
    const resolved = await this.resolve(name);
    if (!resolved) throw new Error(`${name} was downloaded but would not run.`);
    return { path: resolved, size: stat.size, sha256: actual };
  }

  async updateYtDlp() {
    return this.update('yt-dlp');
  }

  /** Replace a helper Fletch installed. One it did not install is not its to touch. */
  async update(name) {
    const bin = await this.resolve(name);
    if (!bin) return this.install(name);
    // A PATH-installed copy is the user's to manage; only self-update our own.
    if (!bin.startsWith(this.binDir)) {
      throw new Error(`${name} came from ${bin}; update it the way you installed it.`);
    }
    return this.install(name);
  }

  /** Run a tool and collect stdout. Rejects with stderr on a non-zero exit. */
  run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true, ...opts });
      let out = '';
      let err = '';
      const cap = opts.maxBuffer || 64 * 1024 * 1024;
      child.stdout.on('data', (d) => { if (out.length < cap) out += d; });
      child.stderr.on('data', (d) => { if (err.length < 1024 * 1024) err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout: out, stderr: err });
        else reject(new Error(err.trim().split('\n').slice(-4).join(' ') || `exited with code ${code}`));
      });
      if (opts.signal) opts.signal.addEventListener('abort', () => child.kill(), { once: true });
    });
  }
}

function defaultBinDir(userDataPath) {
  return path.join(userDataPath || path.join(os.homedir(), '.fletch'), 'bin');
}

module.exports = { Binaries, defaultBinDir, FFMPEG_HINTS, publishedChecksum, sha256File };
