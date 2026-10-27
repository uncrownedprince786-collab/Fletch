'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { EventEmitter } = require('events');
const { fetchText, fetchBuffer } = require('./net');
const { SpeedMeter, sleep } = require('./util');

// How far the downloaders may run ahead of the writer. Segments land out of
// order but must be written in order, so this bounds how much we hold in RAM.
const LOOKAHEAD = 24;

function abs(uri, base) {
  try { return new URL(uri, base).toString(); } catch { return uri; }
}

function parseAttrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
  let m;
  while ((m = re.exec(line))) out[m[1].toUpperCase()] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

/** Split a master playlist into its variant streams, best bitrate last. */
function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const a = parseAttrs(line);
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || next.startsWith('#')) continue;
      uri = next;
      break;
    }
    if (!uri) continue;
    const res = /(\d+)x(\d+)/.exec(a.RESOLUTION || '');
    variants.push({
      url: abs(uri, baseUrl),
      bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0),
      width: res ? Number(res[1]) : 0,
      height: res ? Number(res[2]) : 0,
      codecs: a.CODECS || '',
      audioGroup: a.AUDIO || '',
    });
  }
  variants.sort((x, y) => (x.height - y.height) || (x.bandwidth - y.bandwidth));
  return variants;
}

/**
 * Alternative renditions. Most real streams keep audio out of the video
 * playlist and point at it from here, so a video-only download is the usual
 * result of ignoring these.
 */
function parseRenditions(text, baseUrl) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('#EXT-X-MEDIA')) continue;
    const a = parseAttrs(line);
    if (!a.URI) continue; // muxed into the video stream; nothing to fetch
    out.push({
      type: (a.TYPE || '').toUpperCase(),
      group: a['GROUP-ID'] || '',
      name: a.NAME || '',
      language: a.LANGUAGE || '',
      isDefault: /yes/i.test(a.DEFAULT || ''),
      channels: Number(a.CHANNELS || 0) || 0,
      url: abs(a.URI, baseUrl),
    });
  }
  return out;
}

/**
 * Work out what a stream actually consists of without downloading it: which
 * variant to take, and whether its audio lives somewhere separate.
 */
async function inspect(url, opts = {}) {
  const headers = opts.headers || {};
  const master = await fetchText(url, { headers });
  const text = master.body;
  const base = master.finalUrl || url;

  const variants = parseMaster(text, base);
  if (!variants.length) {
    // Already a media playlist: nothing to choose, and no separate audio.
    return { videoUrl: base, audioUrl: null, height: 0, container: containerFor(text) };
  }

  let chosen = variants[variants.length - 1];
  if (opts.preferHeight) {
    const fits = variants.filter((v) => v.height && v.height <= opts.preferHeight);
    if (fits.length) chosen = fits[fits.length - 1];
  }

  let audioUrl = null;
  if (chosen.audioGroup) {
    const audios = parseRenditions(text, base).filter((m) => m.type === 'AUDIO' && m.group === chosen.audioGroup);
    if (audios.length) {
      const pick = audios.find((m) => m.isDefault)
        || audios.find((m) => /^en/i.test(m.language))
        || audios[0];
      audioUrl = pick.url;
    }
  }

  // Peek at the chosen playlist to find out what container the pieces are in.
  let container = 'ts';
  try {
    const sub = await fetchText(chosen.url, { headers });
    container = containerFor(sub.body);
  } catch { /* fall back to .ts, which ffmpeg will sort out */ }

  return { videoUrl: chosen.url, audioUrl, height: chosen.height, bandwidth: chosen.bandwidth, container };
}

/** fMP4 streams carry an init section; everything else is transport stream. */
function containerFor(playlistText) {
  return /#EXT-X-MAP/i.test(playlistText) ? 'mp4' : 'ts';
}

/**
 * Parse `<length>[@<offset>]`. With the offset left out, the range starts
 * where the previous range on the same URL finished — which is why the running
 * `cursor` has to be tracked per URL.
 */
function parseByteRange(value, cursors, url) {
  if (!value) return null;
  const [lenPart, offPart] = String(value).trim().split('@');
  const length = Number(lenPart);
  if (!Number.isFinite(length) || length <= 0) return null;
  const offset = offPart !== undefined ? Number(offPart) : (cursors.get(url) || 0);
  if (!Number.isFinite(offset) || offset < 0) return null;
  cursors.set(url, offset + length);
  return { offset, length };
}

/** Turn a media playlist into an ordered list of segments with their keys. */
function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  const cursors = new Map();
  let key = null;
  let initUri = null;
  let initRange = null;
  let seq = 0;
  let duration = 0;
  let nextDur = 0;
  let nextRange = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      seq = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-KEY')) {
      const a = parseAttrs(line);
      key = (a.METHOD && a.METHOD !== 'NONE')
        ? { method: a.METHOD, uri: a.URI ? abs(a.URI, baseUrl) : null, iv: a.IV || null }
        : null;
    } else if (line.startsWith('#EXT-X-MAP')) {
      const a = parseAttrs(line);
      if (a.URI) {
        initUri = abs(a.URI, baseUrl);
        initRange = parseByteRange(a.BYTERANGE, cursors, initUri);
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      nextRange = line.slice(line.indexOf(':') + 1);
    } else if (line.startsWith('#EXTINF')) {
      nextDur = parseFloat(line.split(':')[1]) || 0;
    } else if (!line.startsWith('#')) {
      const url = abs(line, baseUrl);
      segments.push({
        url,
        key,
        seq: seq + segments.length,
        duration: nextDur,
        // Many playlists carve one big file up with BYTERANGE rather than
        // shipping separate segment files. Without this we would fetch the
        // whole file once per segment.
        range: parseByteRange(nextRange, cursors, url),
      });
      duration += nextDur;
      nextDur = 0;
      nextRange = null;
    }
  }

  const isLive = !/#EXT-X-ENDLIST/.test(text);
  return { segments, initUri, initRange, duration, isLive };
}

function ivFor(segment) {
  if (segment.key && segment.key.iv) {
    const hex = segment.key.iv.replace(/^0x/i, '');
    return Buffer.from(hex.padStart(32, '0'), 'hex');
  }
  // Default per RFC 8216: the media sequence number as a big-endian 128-bit int.
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(segment.seq >>> 0, 12);
  return iv;
}

/**
 * Pull an HLS stream down as one contiguous file.
 *
 * Segments are fetched many at a time but committed strictly in order, so the
 * output is playable even if the job is interrupted. AES-128 streams are
 * decrypted on the way through; SAMPLE-AES and Widevine are not supported and
 * say so rather than writing a corrupt file.
 */
class HlsDownload extends EventEmitter {
  constructor(spec) {
    super();
    this.url = spec.url;
    this.filePath = spec.filePath;
    this.partPath = spec.filePath + '.fletchpart';
    this.headers = spec.headers || {};
    this.connections = Math.max(1, Math.min(24, spec.connections || 8));
    this.preferHeight = spec.preferHeight || 0; // 0 = best available
    this.meter = new SpeedMeter();

    this.state = 'idle';
    this.downloaded = 0;
    this.size = null;
    this.speed = 0;
    this.total = 0;
    this.completed = 0;
    this.duration = 0;
    this._stop = null;
    this._tick = null;
    this._keyCache = new Map();
  }

  get progress() { return this.total ? this.completed / this.total : 0; }
  get eta() {
    if (!this.total || !this.completed || this.speed <= 0) return null;
    const perSeg = this.downloaded / this.completed;
    return ((this.total - this.completed) * perSeg) / this.speed;
  }

  pause() { this._stop = 'paused'; this.state = 'paused'; }
  cancel() { this._stop = 'cancelled'; this.state = 'cancelled'; }

  async _key(segment) {
    if (!segment.key || !segment.key.uri) return null;
    if (segment.key.method !== 'AES-128') {
      throw new Error(`This stream uses ${segment.key.method} encryption, which Fletch cannot decrypt.`);
    }
    if (!this._keyCache.has(segment.key.uri)) {
      this._keyCache.set(segment.key.uri, await fetchBuffer(segment.key.uri, { headers: this.headers, maxBytes: 1024 }));
    }
    return this._keyCache.get(segment.key.uri);
  }

  _rangeHeaders(range) {
    if (!range) return this.headers;
    return { ...this.headers, Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
  }

  async _fetchSegment(segment) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this._stop) throw new Error('stopped');
      try {
        let buf = await fetchBuffer(segment.url, {
          headers: this._rangeHeaders(segment.range),
          maxBytes: 256 * 1024 * 1024,
        });
        if (segment.range && buf.length > segment.range.length) {
          // The server ignored the range and sent the whole file; take our slice.
          buf = buf.subarray(segment.range.offset, segment.range.offset + segment.range.length);
        }
        const key = await this._key(segment);
        if (key) {
          const d = crypto.createDecipheriv('aes-128-cbc', key, ivFor(segment));
          buf = Buffer.concat([d.update(buf), d.final()]);
        }
        return buf;
      } catch (err) {
        lastErr = err;
        if (/cannot decrypt/.test(err.message)) throw err;
        await sleep(400 * 2 ** attempt);
      }
    }
    throw lastErr || new Error('Segment failed');
  }

  async start() {
    this.state = 'running';
    this._stop = null;

    const master = await fetchText(this.url, { headers: this.headers });
    let mediaUrl = master.finalUrl || this.url;
    let mediaText = master.body;

    const variants = parseMaster(mediaText, mediaUrl);
    if (variants.length) {
      let chosen = variants[variants.length - 1];
      if (this.preferHeight) {
        const fit = variants.filter((v) => v.height && v.height <= this.preferHeight);
        if (fit.length) chosen = fit[fit.length - 1];
      }
      this.emit('variant', chosen);
      const sub = await fetchText(chosen.url, { headers: this.headers });
      mediaUrl = sub.finalUrl || chosen.url;
      mediaText = sub.body;
    }

    const media = parseMedia(mediaText, mediaUrl);
    if (!media.segments.length) throw new Error('The playlist contained no media segments.');
    if (media.isLive) this.emit('warning', 'This looks like a live stream; Fletch will capture the segments currently listed.');

    this.total = media.segments.length;
    this.duration = media.duration;

    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const sink = fs.createWriteStream(this.partPath);
    this._tick = setInterval(() => this._emit(), 500);

    try {
      if (media.initUri) {
        let init = await fetchBuffer(media.initUri, {
          headers: this._rangeHeaders(media.initRange),
          maxBytes: 64 * 1024 * 1024,
        });
        if (media.initRange && init.length > media.initRange.length) {
          init = init.subarray(media.initRange.offset, media.initRange.offset + media.initRange.length);
        }
        sink.write(init);
        this.downloaded += init.length;
      }
      await this._stream(media.segments, sink);
    } finally {
      clearInterval(this._tick);
      this._tick = null;
      await new Promise((r) => sink.end(r));
    }

    if (this._stop === 'cancelled') {
      await fsp.rm(this.partPath, { force: true }).catch(() => {});
      this.emit('cancelled');
      return { cancelled: true };
    }
    if (this._stop === 'paused') {
      // Partial HLS output is still a playable prefix, so keep it as the result.
      this.emit('paused');
      return { paused: true };
    }

    await fsp.rm(this.filePath, { force: true }).catch(() => {});
    await fsp.rename(this.partPath, this.filePath);
    const stat = await fsp.stat(this.filePath);
    this.size = stat.size;
    this.state = 'done';
    this.speed = 0;
    this._emit();
    this.emit('done', { filePath: this.filePath, size: stat.size, duration: this.duration });
    return { filePath: this.filePath, size: stat.size, duration: this.duration };
  }

  /** Fetch many, write in order, never hold more than LOOKAHEAD segments. */
  async _stream(segments, sink) {
    const ready = new Map();
    let writeAt = 0;
    let fetchAt = 0;
    const inFlight = new Set();
    let failure = null;

    const writeReady = async () => {
      while (ready.has(writeAt)) {
        const buf = ready.get(writeAt);
        ready.delete(writeAt);
        if (!sink.write(buf)) await new Promise((r) => sink.once('drain', r));
        this.downloaded += buf.length;
        this.meter.add(buf.length);
        this.completed = ++writeAt;
      }
    };

    while (writeAt < segments.length && !failure) {
      if (this._stop) break;

      while (
        fetchAt < segments.length &&
        inFlight.size < this.connections &&
        fetchAt - writeAt < LOOKAHEAD
      ) {
        const index = fetchAt++;
        const job = this._fetchSegment(segments[index])
          .then((buf) => { ready.set(index, buf); })
          .catch((err) => { if (!/stopped/.test(err.message)) failure = failure || err; })
          .finally(() => { inFlight.delete(job); });
        inFlight.add(job);
      }

      if (!inFlight.size) break;
      await Promise.race([...inFlight]);
      await writeReady();
    }

    await Promise.allSettled([...inFlight]);
    if (!failure && !this._stop) await writeReady();
    if (failure) throw failure;
  }

  _emit() {
    this.speed = this.state === 'running' ? this.meter.sample() : 0;
    // Segment counts are exact; byte totals are an extrapolation until the end.
    const estimate = this.completed ? Math.round((this.downloaded / this.completed) * this.total) : null;
    this.emit('progress', {
      downloaded: this.downloaded,
      size: this.size || estimate,
      estimated: !this.size,
      speed: this.speed,
      progress: this.progress,
      eta: this.eta,
      connections: this.connections,
      segments: [{ start: 0, end: this.total, pos: this.completed, done: this.progress, state: 'active' }],
      note: `${this.completed} / ${this.total} segments`,
    });
  }
}

module.exports = { HlsDownload, parseMaster, parseMedia, parseRenditions, inspect };
