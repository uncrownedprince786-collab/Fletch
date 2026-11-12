'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { EventEmitter } = require('events');
const { fetchText, fetchBuffer } = require('./net');
const { SpeedMeter, sleep } = require('./util');

// How far the downloaders may run ahead of the writer.
const LOOKAHEAD = 24;

function abs(uri, base) {
  try { return new URL(uri, base).toString(); } catch { return uri; }
}

/**
 * Parse an MPD manifest into a flat list of segments for the best video
 * representation. Returns { segments, initUri, duration, total }.
 *
 * Handles the common SegmentTemplate with $Number$ / $Time$ / $RepresentationID$
 * substitution, plus SegmentList and SegmentBase (byte ranges).
 */
function parseMpd(text, baseUrl) {
  const result = { segments: [], initUri: null, duration: 0, isLive: false };

  // Media presentation duration (ISO 8601, e.g. PT123.456S or PT1H2M3S).
  const mpdDur = /mediaPresentationDuration\s*=\s*"([^"]+)"/i.exec(text);
  if (mpdDur) result.duration = parseIsoDuration(mpdDur[1]);

  // type="dynamic" means a live stream.
  if (/type\s*=\s*"dynamic"/i.test(text)) result.isLive = true;

  // Find all Periods (usually one).
  const periods = text.match(/<Period\b[^>]*>[\s\S]*?<\/Period>/gi) || [text];

  // Collect all video AdaptationSets across periods.
  const videoSets = [];
  for (const period of periods) {
    const sets = period.match(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/gi) || [];
    for (const set of sets) {
      const mime = /mimeType\s*=\s*"([^"]+)"/i.exec(set);
      const contentType = /contentType\s*=\s*"([^"]+)"/i.exec(set);
      const isVideo = (mime && /video/i.test(mime[1])) || (contentType && /video/i.test(contentType[1]));
      if (isVideo) videoSets.push(set);
    }
  }

  if (!videoSets.length) {
    // Fall back: any AdaptationSet with video in its representations.
    const allSets = text.match(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/gi) || [];
    for (const set of allSets) {
      if (/video/i.test(set)) videoSets.push(set);
    }
  }

  if (!videoSets.length) return result;

  // Pick the best video AdaptationSet (highest bandwidth representation).
  let bestSet = videoSets[0];
  let bestBw = 0;
  for (const set of videoSets) {
    const reps = set.match(/<Representation\b[^>]*>/gi) || [];
    for (const rep of reps) {
      const bw = /bandwidth\s*=\s*"(\d+)"/i.exec(rep);
      const b = bw ? Number(bw[1]) : 0;
      if (b > bestBw) { bestBw = b; bestSet = set; }
    }
  }

  // Pick the best Representation within the set.
  const reps = bestSet.match(/<Representation\b[^>]*>[\s\S]*?<\/Representation>/gi) ||
               bestSet.match(/<Representation\b[^>]*\/>/gi) || [];
  let bestRep = null;
  let bestRepBw = 0;
  for (const rep of reps) {
    const bw = /bandwidth\s*=\s*"(\d+)"/i.exec(rep);
    const b = bw ? Number(bw[1]) : 0;
    if (b >= bestRepBw) { bestRepBw = b; bestRep = rep; }
  }
  if (!bestRep && reps.length) bestRep = reps[reps.length - 1];
  if (!bestRep) return result;

  const repId = /id\s*=\s*"([^"]+)"/i.exec(bestRep);
  const representationId = repId ? repId[1] : '1';
  const bandwidth = /bandwidth\s*=\s*"(\d+)"/i.exec(bestRep);
  const bw = bandwidth ? Number(bandwidth[1]) : 0;

  // BaseURL for this representation.
  const baseUrlMatch = bestRep.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
  const repBaseUrl = baseUrlMatch ? abs(baseUrlMatch[1].trim(), baseUrl) : baseUrl;

  // SegmentTemplate
  const segTemplate = bestRep.match(/<SegmentTemplate\b[^>]*>/i) || bestSet.match(/<SegmentTemplate\b[^>]*>/i);
  if (segTemplate) {
    const tmpl = segTemplate[0];
    const initTmpl = /initialization\s*=\s*"([^"]+)"/i.exec(tmpl);
    const mediaTmpl = /media\s*=\s*"([^"]+)"/i.exec(tmpl);
    const timescale = /timescale\s*=\s*"(\d+)"/i.exec(tmpl);
    const ts = timescale ? Number(timescale[1]) : 1;
    const startNumber = /startNumber\s*=\s*"(\d+)"/i.exec(tmpl);
    const sn = startNumber ? Number(startNumber[1]) : 1;
    const duration = /duration\s*=\s*"(\d+)"/i.exec(tmpl);
    const segDuration = duration ? Number(duration[1]) : 0;

    // SegmentTimeline
    const timeline = bestRep.match(/<SegmentTimeline>[\s\S]*?<\/SegmentTimeline>/i) ||
                     bestSet.match(/<SegmentTimeline>[\s\S]*?<\/SegmentTimeline>/i);
    const times = [];
    if (timeline) {
      const sEls = timeline[0].match(/<S\b[^>]*\/>/gi) || [];
      let t = 0;
      for (const s of sEls) {
        const d = /d\s*=\s*"(\d+)"/i.exec(s);
        const r = /r\s*=\s*"(\d+)"/i.exec(s);
        const timeAttr = /t\s*=\s*"(\d+)"/i.exec(s);
        if (timeAttr) t = Number(timeAttr[1]);
        const segDur = d ? Number(d[1]) : 0;
        const repeat = r ? Number(r[1]) : 0;
        for (let i = 0; i <= repeat; i++) {
          times.push(t);
          t += segDur;
        }
      }
    }

    // Init segment
    if (initTmpl) {
      const initUrl = substitute(initTmpl[1], { number: sn, time: 0, repId: representationId, bandwidth: bw });
      result.initUri = abs(initUrl, repBaseUrl);
    }

    // Media segments
    if (mediaTmpl && times.length) {
      for (let i = 0; i < times.length; i++) {
        const segUrl = substitute(mediaTmpl[1], { number: sn + i, time: times[i], repId: representationId, bandwidth: bw });
        result.segments.push({ url: abs(segUrl, repBaseUrl), index: i });
      }
    } else if (mediaTmpl && segDuration > 0 && result.duration > 0) {
      // Duration-based: compute number of segments.
      const totalSegments = Math.ceil((result.duration * ts) / segDuration);
      for (let i = 0; i < totalSegments; i++) {
        const time = i * segDuration;
        const segUrl = substitute(mediaTmpl[1], { number: sn + i, time, repId: representationId, bandwidth: bw });
        result.segments.push({ url: abs(segUrl, repBaseUrl), index: i });
      }
    }
  }

  // SegmentList
  const segList = bestRep.match(/<SegmentList\b[^>]*>[\s\S]*?<\/SegmentList>/i) ||
                  bestSet.match(/<SegmentList\b[^>]*>[\s\S]*?<\/SegmentList>/i);
  if (segList && !result.segments.length) {
    const initMatch = segList[0].match(/<Initialization\b[^>]*sourceURL\s*=\s*"([^"]+)"/i);
    if (initMatch) result.initUri = abs(initMatch[1], repBaseUrl);

    const segUrls = segList[0].match(/<SegmentURL\b[^>]*media\s*=\s*"([^"]+)"/gi) || [];
    for (const su of segUrls) {
      const m = /media\s*=\s*"([^"]+)"/i.exec(su);
      if (m) result.segments.push({ url: abs(m[1], repBaseUrl), index: result.segments.length });
    }
  }

  // SegmentBase (single file with byte ranges) - treat as single segment
  const segBase = bestRep.match(/<SegmentBase\b[^>]*>/i);
  if (segBase && !result.segments.length) {
    const indexRange = /indexRange\s*=\s*"([^"]+)"/i.exec(segBase[0]);
    // For SegmentBase, the whole file is the media; just download it as HTTP.
    result.segments.push({ url: repBaseUrl, index: 0, isWhole: true });
  }

  return result;
}

function substitute(tmpl, vars) {
  return tmpl
    .replace(/\$RepresentationID\$/g, vars.repId)
    .replace(/\$Bandwidth\$/g, String(vars.bandwidth))
    .replace(/\$Number(\%0(\d+)d)?\$/g, (_, fmt, width) => {
      const w = width ? Number(width) : 1;
      return String(vars.number).padStart(w, '0');
    })
    .replace(/\$Time\$/g, String(vars.time))
    .replace(/\$\$/g, '$');
}

function parseIsoDuration(s) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i.exec(s || '');
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

class DashDownload extends EventEmitter {
  constructor(spec) {
    super();
    this.url = spec.url;
    this.filePath = spec.filePath;
    this.partPath = spec.filePath + '.fletchpart';
    this.headers = spec.headers || {};
    this.connections = Math.max(1, Math.min(24, spec.connections || 8));
    this.meter = new (require('./util').SpeedMeter)();

    this.state = 'idle';
    this.downloaded = 0;
    this.size = null;
    this.speed = 0;
    this.total = 0;
    this.completed = 0;
    this.duration = 0;
    this._stop = null;
    this._tick = null;
  }

  get progress() { return this.total ? this.completed / this.total : 0; }
  get eta() {
    if (!this.total || !this.completed || this.speed <= 0) return null;
    const perSeg = this.downloaded / this.completed;
    return ((this.total - this.completed) * perSeg) / this.speed;
  }

  pause() { this._stop = 'paused'; this.state = 'paused'; }
  cancel() { this._stop = 'cancelled'; this.state = 'cancelled'; }

  async _fetchSegment(url) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this._stop) throw new Error('stopped');
      try {
        const buf = await (require('./net').fetchBuffer)(url, {
          headers: this.headers,
          maxBytes: 256 * 1024 * 1024,
        });
        return buf;
      } catch (err) {
        lastErr = err;
        await (require('./util').sleep)(400 * 2 ** attempt);
      }
    }
    throw lastErr || new Error('Segment failed');
  }

  async start() {
    this.state = 'running';
    this._stop = null;

    const mpd = await (require('./net').fetchText)(this.url, { headers: this.headers });
    const mediaUrl = mpd.finalUrl || this.url;
    const parsed = parseMpd(mpd.body, mediaUrl);

    if (!parsed.segments.length && !parsed.initUri) {
      throw new Error('The DASH manifest contained no media segments.');
    }

    this.total = parsed.segments.length || 1;
    this.duration = parsed.duration;

    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const sink = fs.createWriteStream(this.partPath);
    this._tick = setInterval(() => this._emit(), 500);

    try {
      if (parsed.initUri) {
        const init = await this._fetchSegment(parsed.initUri);
        sink.write(init);
        this.downloaded += init.length;
        this.completed = 0;
      }

      // Download segments with bounded concurrency.
      const concurrency = this.connections;
      let nextIndex = 0;
      const writeQueue = [];
      let writePos = 0; // segments must be written in order

      const segmentBuffers = new Array(parsed.segments.length);

      async function worker() {
        while (true) {
          if (this._stop) throw new Error('stopped');
          const idx = nextIndex++;
          if (idx >= parsed.segments.length) break;
          const seg = parsed.segments[idx];
          const buf = await this._fetchSegment(seg.url);
          segmentBuffers[idx] = buf;
          // Write in order.
          while (writePos < parsed.segments.length && segmentBuffers[writePos]) {
            sink.write(segmentBuffers[writePos]);
            this.downloaded += segmentBuffers[writePos].length;
            this.completed++;
            segmentBuffers[writePos] = null;
            writePos++;
          }
        }
      }

      const workers = [];
      for (let i = 0; i < concurrency; i++) {
        workers.push(worker.call(this));
      }
      await Promise.all(workers);

      // Write any remaining (shouldn't happen, but safety).
      while (writePos < parsed.segments.length) {
        if (segmentBuffers[writePos]) {
          sink.write(segmentBuffers[writePos]);
          this.downloaded += segmentBuffers[writePos].length;
          this.completed++;
          segmentBuffers[writePos] = null;
        }
        writePos++;
      }
    } finally {
      if (this._tick) { clearInterval(this._tick); this._tick = null; }
    }

    await new Promise((resolve, reject) => {
      sink.end(() => resolve());
      sink.on('error', reject);
    });

    // Replace part file with final file.
    await fsp.rename(this.partPath, this.filePath).catch(async () => {
      await fsp.copyFile(this.partPath, this.filePath);
      await fsp.rm(this.partPath, { force: true });
    });

    this.size = this.downloaded;
    this.progress = 1;
    this.state = 'done';
    this._emit();
    return { filePath: this.filePath, size: this.downloaded };
  }

  _emit() {
    this.speed = this.meter ? this.meter.rate() : 0;
    this.emit('progress', {
      downloaded: this.downloaded,
      size: this.size || this.downloaded,
      speed: this.speed,
      progress: this.progress,
      eta: this.eta,
      connections: this.connections,
      segments: [],
      note: `${this.completed}/${this.total} segments`,
    });
  }

  async _teardown(destroyStore) {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    try { await fsp.rm(this.partPath, { force: true }); } catch { /* gone */ }
  }
}

module.exports = { DashDownload, parseMpd };