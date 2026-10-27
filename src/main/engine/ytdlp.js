'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// yt-dlp is used as an *extractor*, not as a downloader. It knows how to turn a
// page URL into real media URLs for well over a thousand sites; Fletch then
// pulls those URLs down with its own multi-connection engine, which is the part
// that makes it fast. We only hand the whole job back to yt-dlp for protocols
// our engine does not speak (DASH segments, RTMP and friends).

const NO_CODEC = (v) => !v || v === 'none';

function normaliseFormat(f) {
  return {
    id: f.format_id,
    url: f.url,
    ext: f.ext || '',
    protocol: f.protocol || '',
    height: f.height || 0,
    width: f.width || 0,
    fps: f.fps || 0,
    vcodec: f.vcodec || 'none',
    acodec: f.acodec || 'none',
    tbr: f.tbr || 0,
    abr: f.abr || 0,
    size: f.filesize || f.filesize_approx || null,
    note: f.format_note || '',
    language: f.language || '',
    headers: f.http_headers || {},
    hasVideo: !NO_CODEC(f.vcodec),
    hasAudio: !NO_CODEC(f.acodec),
  };
}

function labelFor(f) {
  if (f.hasVideo) {
    const res = f.height ? `${f.height}p` : (f.width ? `${f.width}w` : f.ext.toUpperCase());
    const fps = f.fps && f.fps > 30 ? String(Math.round(f.fps)) : '';
    return `${res}${fps}${f.hasAudio ? '' : ' (video only)'} · ${f.ext}`;
  }
  if (f.hasAudio) return `${f.abr ? Math.round(f.abr) + ' kbps' : 'audio'} · ${f.ext}`;
  return f.ext || f.id;
}

/** Ask yt-dlp what a page contains, without downloading anything. */
async function extract(ytdlpPath, url, opts = {}) {
  const args = [
    '-J',
    '--no-warnings',
    '--no-playlist-reverse',
    '--no-call-home',
    '--ignore-config',
    '--socket-timeout', '20',
  ];
  if (opts.flatPlaylist) args.push('--flat-playlist');
  else args.push('--no-playlist');
  if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', opts.cookiesFromBrowser);
  if (opts.cookieFile) args.push('--cookies', opts.cookieFile);
  if (opts.proxy) args.push('--proxy', opts.proxy);
  if (opts.userAgent) args.push('--user-agent', opts.userAgent);
  if (opts.referer) args.push('--referer', opts.referer);
  args.push('--', url);

  const raw = await runJson(ytdlpPath, args, opts.signal);
  return normaliseInfo(raw);
}

/** Same, but keeps every entry of a playlist or channel. */
async function extractPlaylist(ytdlpPath, url, opts = {}) {
  const args = [
    '-J', '--no-warnings', '--no-call-home', '--ignore-config',
    '--flat-playlist', '--socket-timeout', '20',
  ];
  if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', opts.cookiesFromBrowser);
  if (opts.proxy) args.push('--proxy', opts.proxy);
  args.push('--', url);
  const raw = await runJson(ytdlpPath, args, opts.signal);
  const entries = (raw.entries || []).filter(Boolean).map((e) => ({
    url: e.url || e.webpage_url || e.id,
    title: e.title || e.id || 'Untitled',
    duration: e.duration || 0,
    thumbnail: e.thumbnail || (e.thumbnails && e.thumbnails[0] && e.thumbnails[0].url) || '',
  }));
  return {
    isPlaylist: raw._type === 'playlist' || entries.length > 0,
    title: raw.title || 'Playlist',
    uploader: raw.uploader || raw.channel || '',
    entries,
  };
}

function normaliseInfo(raw) {
  if (raw && raw._type === 'playlist' && Array.isArray(raw.entries)) {
    const first = raw.entries.find(Boolean);
    if (first && first.formats) raw = first;
  }
  const formats = (raw.formats || []).filter((f) => f && f.url).map(normaliseFormat);
  for (const f of formats) f.label = labelFor(f);

  const thumb = raw.thumbnail
    || (Array.isArray(raw.thumbnails) && raw.thumbnails.length
      ? raw.thumbnails[raw.thumbnails.length - 1].url
      : '');

  return {
    id: raw.id || '',
    title: raw.title || raw.id || 'Untitled',
    extractor: raw.extractor_key || raw.extractor || '',
    webpageUrl: raw.webpage_url || '',
    uploader: raw.uploader || raw.channel || raw.uploader_id || '',
    duration: raw.duration || 0,
    thumbnail: thumb,
    description: raw.description || '',
    isLive: Boolean(raw.is_live),
    formats,
    subtitles: Object.keys(raw.subtitles || {}),
  };
}

/**
 * Choose what to actually download.
 * Returns { video, audio, needsMerge, reason } — `audio` is null when `video`
 * already carries sound.
 */
function chooseFormats(info, prefs = {}) {
  const maxHeight = prefs.maxHeight || 0; // 0 = best available
  const audioOnly = Boolean(prefs.audioOnly);
  const canMerge = prefs.canMerge !== false;

  const fits = (f) => !maxHeight || !f.height || f.height <= maxHeight;
  const audios = info.formats.filter((f) => f.hasAudio && !f.hasVideo);
  const videos = info.formats.filter((f) => f.hasVideo && !f.hasAudio && fits(f));
  const both = info.formats.filter((f) => f.hasVideo && f.hasAudio && fits(f));

  const bestAudio = audios.slice().sort((a, b) => (a.abr - b.abr) || (a.tbr - b.tbr)).pop() || null;
  const rank = (a, b) => (a.height - b.height) || (a.fps - b.fps) || (a.tbr - b.tbr);
  const bestVideo = videos.slice().sort(rank).pop() || null;
  const bestBoth = both.slice().sort(rank).pop() || null;

  if (audioOnly) {
    const pick = bestAudio || bestBoth;
    if (!pick) throw new Error('No audio stream was offered for this item.');
    return { video: null, audio: pick, needsMerge: false, reason: 'audio only' };
  }

  // Split streams usually carry the higher resolutions, but they are only worth
  // taking if we have ffmpeg to put the two halves back together.
  if (bestVideo && bestAudio && canMerge && (!bestBoth || bestVideo.height > bestBoth.height)) {
    return {
      video: bestVideo,
      audio: bestAudio,
      needsMerge: true,
      reason: `${bestVideo.height}p video + ${Math.round(bestAudio.abr) || '?'} kbps audio, merged`,
    };
  }
  if (bestBoth) return { video: bestBoth, audio: null, needsMerge: false, reason: `${bestBoth.height || '?'}p combined stream` };
  if (bestVideo) {
    return {
      video: bestVideo, audio: null, needsMerge: false,
      reason: canMerge ? `${bestVideo.height}p (no audio stream offered)` : `${bestVideo.height}p video only — install ffmpeg to get sound`,
    };
  }
  if (bestAudio) return { video: null, audio: bestAudio, needsMerge: false, reason: 'audio only (no video offered)' };
  throw new Error('No downloadable stream was found on that page.');
}

function runJson(ytdlpPath, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { if (err.length < 512 * 1024) err += d; });
    child.on('error', (e) => reject(new Error(`Could not run yt-dlp: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const msg = err.split('\n').map((l) => l.replace(/^ERROR:\s*/i, '').trim())
          .filter((l) => l && !/^\[/.test(l)).pop();
        return reject(new Error(msg || `yt-dlp exited with code ${code}`));
      }
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error('yt-dlp returned something that was not JSON.')); }
    });
    if (signal) signal.addEventListener('abort', () => child.kill(), { once: true });
  });
}

/**
 * Last resort: let yt-dlp download the thing itself, for protocols our engine
 * does not implement. Progress is scraped from its --newline output.
 */
class YtDlpDownload extends EventEmitter {
  constructor(spec) {
    super();
    this.bin = spec.ytdlpPath;
    this.url = spec.url;
    this.outPath = spec.filePath;
    this.formatId = spec.formatId || null;
    this.opts = spec;
    this.child = null;
    this.state = 'idle';
    this.downloaded = 0;
    this.size = null;
    this.speed = 0;
    this.progressRatio = 0;
    this._eta = null;
  }

  get progress() { return this.progressRatio; }
  get eta() { return this._eta; }

  cancel() { this.state = 'cancelled'; if (this.child) this.child.kill(); }
  pause() { this.cancel(); this.state = 'paused'; }

  start() {
    this.state = 'running';
    const args = ['--no-warnings', '--no-call-home', '--ignore-config', '--newline', '--no-part',
      '--no-playlist', '-o', this.outPath];
    if (this.formatId) args.push('-f', this.formatId);
    if (this.opts.ffmpegPath) args.push('--ffmpeg-location', this.opts.ffmpegPath);
    if (this.opts.cookiesFromBrowser) args.push('--cookies-from-browser', this.opts.cookiesFromBrowser);
    if (this.opts.proxy) args.push('--proxy', this.opts.proxy);
    if (this.opts.connections) args.push('--concurrent-fragments', String(this.opts.connections));
    args.push('--', this.url);

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { windowsHide: true });
      this.child = child;
      let tail = '';

      child.stdout.on('data', (d) => {
        for (const line of String(d).split(/\r?\n/)) this._parse(line);
      });
      child.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
      child.on('error', reject);
      child.on('close', (code) => {
        this.child = null;
        if (this.state === 'cancelled') return resolve({ cancelled: true });
        if (this.state === 'paused') return resolve({ paused: true });
        if (code !== 0) {
          const msg = tail.split('\n').map((l) => l.replace(/^ERROR:\s*/i, '').trim())
            .filter(Boolean).pop();
          return reject(new Error(msg || `yt-dlp exited with code ${code}`));
        }
        this.state = 'done';
        this.progressRatio = 1;
        this.emit('done', { filePath: this.outPath, size: this.size });
        resolve({ filePath: this.outPath, size: this.size });
      });
    });
  }

  _parse(line) {
    //  [download]  43.2% of  118.47MiB at   4.12MiB/s ETA 00:16
    const m = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)(\w+)(?:\s+at\s+([\d.]+)(\w+)\/s)?(?:\s+ETA\s+([\d:]+))?/.exec(line);
    if (m) {
      const pct = parseFloat(m[1]) / 100;
      const total = toBytes(parseFloat(m[2]), m[3]);
      this.progressRatio = pct;
      this.size = total;
      this.downloaded = Math.round(total * pct);
      this.speed = m[4] ? toBytes(parseFloat(m[4]), m[5]) : 0;
      this._eta = m[6] ? m[6].split(':').reduce((a, v) => a * 60 + Number(v), 0) : null;
      this.emit('progress', {
        downloaded: this.downloaded, size: this.size, speed: this.speed,
        progress: pct, eta: this._eta, connections: 1,
        segments: [{ start: 0, end: 1, pos: pct, done: pct, state: 'active' }],
        note: 'handled by yt-dlp',
      });
      return;
    }
    if (/\[Merger\]|\[ffmpeg\]/.test(line)) this.emit('stage', 'Merging tracks…');
    else if (/\[ExtractAudio\]/.test(line)) this.emit('stage', 'Extracting audio…');
  }
}

function toBytes(n, unit) {
  const u = String(unit || '').toUpperCase();
  const mult = u.startsWith('K') ? 1024 : u.startsWith('M') ? 1024 ** 2 : u.startsWith('G') ? 1024 ** 3 : 1;
  return Math.round(n * mult);
}

/** Which engine should handle a given format's URL. */
function engineFor(format) {
  const p = (format.protocol || '').toLowerCase();
  if (/m3u8/.test(p) || /\.m3u8(\?|$)/i.test(format.url || '')) return 'hls';
  if (p === 'http' || p === 'https' || p === '') return 'http';
  return 'ytdlp'; // dash segments, rtmp, rtsp, ism, ...
}

module.exports = { extract, extractPlaylist, chooseFormats, YtDlpDownload, engineFor, labelFor };
