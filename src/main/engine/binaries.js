'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { request, fetchText } = require('./net');

// Fletch ships no third-party binaries. It can fetch two optional helpers from
// their official release pages, on an explicit click, and otherwise uses
// whatever is already on PATH:
//   yt-dlp  - resolves a page URL to real media URLs (site extractors)
//   ffmpeg  - muxes separate video/audio tracks and remuxes HLS into MP4
// Everything Fletch does with a plain file URL works without either of them.

const RELEASES = {
  'yt-dlp': {
    // `asset` is the name as it appears in the project's own checksum file.
    win32: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', file: 'yt-dlp.exe', asset: 'yt-dlp.exe' },
    darwin: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', file: 'yt-dlp', asset: 'yt-dlp_macos' },
    linux: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', file: 'yt-dlp', asset: 'yt-dlp' },
  },
};

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
      ytdlp: { path: ytdlp, installed: Boolean(ytdlp), canAutoInstall: Boolean(RELEASES['yt-dlp'][process.platform]) },
      ffmpeg: { path: ffmpeg, installed: Boolean(ffmpeg), canAutoInstall: false, hint: FFMPEG_HINTS[process.platform] || '' },
      binDir: this.binDir,
    };
  }

  /**
   * Fetch yt-dlp from its official GitHub release into Fletch's own bin folder.
   * Only ever called from an explicit user action in Settings.
   */
  async installYtDlp(onProgress, override) {
    // `override` lets the tests point this at a local stand-in for the real
    // release, so the verification can be exercised without the network.
    const spec = override || RELEASES['yt-dlp'][process.platform];
    if (!spec) throw new Error(`No yt-dlp build is published for ${process.platform}.`);

    await fsp.mkdir(this.binDir, { recursive: true });
    const target = path.join(this.binDir, spec.file);
    const tmp = target + '.part';

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
      throw new Error('The downloaded file was too small to be yt-dlp; aborting.');
    }

    // This file is about to be executed, so size is nowhere near enough.
    // yt-dlp publishes a SHA-256 for every asset; check against it and refuse
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
        'Could not fetch yt-dlp’s published checksums, so the download could not be '
        + 'verified. Nothing was installed. Check your connection and try again.'
      );
    }
    const actual = await sha256File(tmp);
    if (actual !== expected) {
      await fsp.rm(tmp, { force: true });
      throw new Error(
        'The downloaded yt-dlp did not match its published checksum, so it was discarded. '
        + 'Do not install it by hand — this should never happen on a clean connection.'
      );
    }

    await fsp.rm(target, { force: true }).catch(() => {});
    await fsp.rename(tmp, target);
    if (process.platform !== 'win32') await fsp.chmod(target, 0o755);

    this._cache.delete('yt-dlp');
    const resolved = await this.resolve('yt-dlp');
    if (!resolved) throw new Error('yt-dlp was downloaded but would not run.');
    return { path: resolved, size: stat.size, sha256: actual };
  }

  async updateYtDlp() {
    const bin = await this.resolve('yt-dlp');
    if (!bin) return this.installYtDlp();
    // A PATH-installed copy is the user's to manage; only self-update our own.
    if (!bin.startsWith(this.binDir)) {
      throw new Error(`yt-dlp came from ${bin}; update it the way you installed it.`);
    }
    return this.installYtDlp();
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
