'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { request } = require('./net');
const { SpeedMeter, sleep } = require('./util');

const PART_SUFFIX = '.fletchpart';
const META_SUFFIX = '.fletchpart.meta';

// Below this, splitting a segment costs more in handshakes than it wins in
// parallelism. IDM-style dynamic splitting only pays off on sizeable tails.
const MIN_SPLIT_BYTES = 1024 * 1024;
const MAX_RETRIES = 8;

// Plenty of servers cap how many connections one address may hold open and
// answer the rest with 429 or 503. Hammering them is rude and gets nowhere, so
// Fletch treats that as a signal to use fewer sockets rather than as an error.
const THROTTLE_CODES = new Set([429, 503]);
const MAX_THROTTLE_HITS = 40;
// If every connection goes quiet for this long, stop waiting and say so.
const DEFAULT_STALL_MS = 90000;
// Room each connection has to keep receiving while the disk catches up. The
// stream default of 16 KB pauses the socket on almost every chunk, which on a
// slow or busy drive (an HDD download folder) costs real throughput.
const SINK_BUFFER = 1024 * 1024;
// How long a refused ranged request waits for another connection to prove
// ranges do work before concluding they do not.
const RANGE_PROOF_WAIT_MS = 3000;

function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(60000, Math.max(0, secs * 1000));
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.min(60000, Math.max(0, when - Date.now())) : 0;
}

/**
 * One file, many sockets.
 *
 * The file is laid out on disk at full size up front, then handed to N workers
 * that each own a byte range and write straight into their own offset. When a
 * worker runs out of range it does not go idle: it looks for whichever peer has
 * the most bytes left, takes the back half of that peer's range, and keeps
 * going. That re-balancing is what keeps the last stretch of a download from
 * being held hostage by one slow connection.
 */
class HttpDownload extends EventEmitter {
  /**
   * @param {object} spec  url, filePath, size, acceptRanges, headers, connections
   */
  constructor(spec) {
    super();
    this.url = spec.url;
    this.filePath = spec.filePath;
    this.partPath = spec.filePath + PART_SUFFIX;
    this.metaPath = spec.filePath + META_SUFFIX;
    this.size = Number.isFinite(spec.size) && spec.size > 0 ? spec.size : null;
    this.acceptRanges = Boolean(spec.acceptRanges && this.size);
    this.headers = spec.headers || {};
    this.maxConnections = Math.max(1, Math.min(32, spec.connections || 8));
    this.limiter = spec.limiter || null;
    this.insecure = Boolean(spec.insecure);
    // Largest byte range one request may ask for; 0 means "the whole segment".
    // Some CDNs (YouTube's among them) throttle long requests to playback
    // speed but serve short ones at full speed, so each worker walks its range
    // in chunks of this size over the same kept-alive socket.
    this.chunkSize = Number.isFinite(spec.chunkSize) && spec.chunkSize >= 256 * 1024 ? Math.floor(spec.chunkSize) : 0;
    // Set once any ranged request comes back 206. After that a refusal is the
    // server limiting connections, not a server that cannot do ranges.
    this._rangeProven = false;

    this.segments = [];
    this.downloaded = 0;
    this.meter = new SpeedMeter();
    this.speed = 0;
    this.state = 'idle'; // idle | running | paused | done | error | cancelled
    this.error = null;

    this.requestedConnections = this.maxConnections;
    this.throttleHits = 0;
    this.stallMs = spec.stallMs || DEFAULT_STALL_MS;
    this.lastByteAt = Date.now();

    this._active = new Set();
    this._stopReason = null;
    this._tick = null;
    this._flushAt = 0;
    this._resolve = null;
    this._reject = null;
  }

  get progress() {
    if (!this.size) return 0;
    return Math.min(1, this.downloaded / this.size);
  }

  get eta() {
    if (!this.size || this.speed <= 0) return null;
    const left = this.size - this.downloaded;
    return left <= 0 ? 0 : left / this.speed;
  }

  snapshotSegments() {
    return this.segments.map((s) => ({
      start: s.start,
      end: s.end,
      pos: s.pos,
      state: s.state,
      // fraction of this segment's current span that is on disk
      done: s.end >= s.start ? Math.min(1, (s.pos - s.start) / (s.end - s.start + 1)) : 1,
    }));
  }

  // ---- lifecycle -----------------------------------------------------------

  start() {
    if (this.state === 'running') return this._promise;
    this._stopReason = null;
    this.state = 'running';
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    this._run().catch((err) => this._fail(err));
    return this._promise;
  }

  pause() {
    if (this.state !== 'running') return;
    this._stopReason = 'paused';
    this.state = 'paused';
    this._abortAll();
  }

  cancel() {
    this._stopReason = 'cancelled';
    this.state = 'cancelled';
    this._abortAll();
  }

  _abortAll() {
    for (const w of [...this._active]) {
      try { w.req && w.req.destroy(); } catch { /* already gone */ }
      // Only a cancel may throw buffered bytes away. Anything else keeps the
      // file, and those bytes are already counted as fetched: dropping them
      // would leave a hole of zeros that a resume steps straight over. The
      // worker's own finish() ends the sink, which flushes them to disk.
      if (this._stopReason === 'cancelled') {
        try { w.sink && w.sink.destroy(); } catch { /* already gone */ }
      }
    }
  }

  // ---- main loop -----------------------------------------------------------

  async _run() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await this._prepareFile();

    this.lastByteAt = Date.now();
    this._tick = setInterval(() => this._emitProgress(), 500);

    try {
      await this._pump();

      // The server refused to serve byte ranges. Splitting the file was only
      // ever an optimisation, so start again as a single stream, which is the
      // one thing it will give us.
      if (this._stopReason === 'restart-single') {
        this.emit('warning',
          'This server will not serve the file in pieces, so Fletch is fetching it in one stream.');
        this._stopReason = null;
        this._needsSingleStream = false;
        this.acceptRanges = false;
        this.downloaded = 0;
        this.meter.reset();
        await this._cleanupPart();
        await this._prepareFile();
        this.lastByteAt = Date.now();
        await this._pump();
      }
    } finally {
      clearInterval(this._tick);
      this._tick = null;
    }

    if (this._stopReason === 'stalled') {
      await this._flushMeta(true);
      this.speed = 0;
      throw new Error(
        `Nothing arrived for ${Math.round(this.stallMs / 1000)}s, so Fletch stopped waiting. `
        + `${this.downloaded ? 'Progress was saved — resume to carry on.' : 'Check the link and try again.'}`
      );
    }

    if (this._stopReason === 'cancelled') {
      await this._cleanupPart();
      this._emitProgress();
      this.emit('cancelled');
      this._resolve && this._resolve({ cancelled: true });
      return;
    }
    if (this._stopReason === 'paused') {
      await this._flushMeta(true);
      this.speed = 0;
      this._emitProgress();
      this.emit('paused');
      this._resolve && this._resolve({ paused: true });
      return;
    }

    const failed = this.segments.find((s) => s.state === 'error');
    if (failed) {
      await this._flushMeta(true);
      throw failed.error || new Error('A connection failed and could not be recovered.');
    }

    await this._finalize();
  }

  async _pump() {
    // Prime the pool, then keep it full until every segment is accounted for.
    while (true) {
      if (this._stopReason) break;

      const pending = this._ready();
      while (pending.length && this._active.size < this.maxConnections) {
        this._spawn(pending.shift());
      }

      if (!this._active.size) {
        const stillPending = this.segments.some((s) => s.state === 'pending');
        if (!stillPending) break;
      }

      // Wake on any worker finishing, or every 250ms to re-check for splits.
      await this._waitForSettle(250);

      // Everything is still connected but nothing is arriving: stop waiting.
      // Progress is checkpointed, so this is resumable rather than lost.
      if (!this._stopReason && this._active.size && Date.now() - this.lastByteAt > this.stallMs) {
        this._stopReason = 'stalled';
        this._abortAll();
        break;
      }

      if (!this._stopReason) this._rebalance();
    }

    // Drain anything still in flight after a stop request.
    while (this._active.size) await this._waitForSettle(200);
  }

  /** Resolve on the next settled worker or after `ms`, without leaking listeners. */
  _waitForSettle(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('_worker-settled', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.once('_worker-settled', done);
    });
  }

  /** Pending segments that may go out now, i.e. not waiting out a refusal. */
  _ready() {
    const now = Date.now();
    return this.segments.filter((s) => s.state === 'pending' && !(s.notBefore > now));
  }

  /** Steal the back half of the slowest-to-finish segment for an idle slot. */
  _rebalance() {
    // Work already queued comes first; the next pass of the pump starts it.
    if (this._ready().length) return;
    while (this._active.size < this.maxConnections) {
      if (!this.acceptRanges) return;
      let victim = null;
      let most = 0;
      for (const s of this.segments) {
        if (s.state !== 'active') continue;
        const left = s.end - s.pos + 1;
        if (left > most) { most = left; victim = s; }
      }
      if (!victim || most < MIN_SPLIT_BYTES * 2) return;

      const mid = victim.pos + Math.floor(most / 2);
      const tail = {
        id: this.segments.length,
        start: mid,
        end: victim.end,
        pos: mid,
        disk: mid,
        state: 'pending',
        retries: 0,
        error: null,
      };
      // Shrinking `end` on a live segment is observed by its worker on the next
      // chunk, which then stops cleanly at the new boundary.
      victim.end = mid - 1;
      this.segments.push(tail);
      this._spawn(tail);
    }
  }

  _spawn(seg) {
    if (this._stopReason) return;
    seg.state = 'active';
    const worker = { seg, req: null, sink: null };
    this._active.add(worker);

    this._runSegment(worker)
      .catch((err) => { seg.state = 'error'; seg.error = err; })
      .finally(() => {
        this._active.delete(worker);
        this.emit('_worker-settled');
      });
  }

  async _runSegment(worker) {
    const seg = worker.seg;

    while (true) {
      if (this._stopReason) { seg.state = 'pending'; return; }
      if (seg.pos > seg.end) { seg.state = 'done'; return; }

      try {
        await this._attempt(worker);
        if (this._stopReason) { seg.state = 'pending'; return; }
        if (seg.pos > seg.end) { seg.state = 'done'; return; }
        // Finished one chunk of a chunked range: ask for the next one.
        if (worker.chunkComplete) continue;
        // Short read without an error: treat as a dropped connection and retry.
        throw new Error('Connection closed before the range was complete');
      } catch (err) {
        if (this._stopReason) { seg.state = 'pending'; return; }

        if (err.rangeRefused && this.acceptRanges) {
          // All the connections go out at once, so a refusal can land before
          // any sibling has shown that ranges work. Give them a moment: a
          // server that serves some ranged requests and refuses others is
          // capping connections, and that calls for fewer sockets, not one.
          if (!this._rangeProven && this._active.size > 1) await this._waitForRangeProof();
          if (this._stopReason) { seg.state = 'pending'; return; }
          if (this._rangeProven && err.statusCode === 403) {
            err.throttle = true;
          } else if (!this._rangeProven) {
            // Stop the whole pool; _run restarts the download in one stream.
            this._needsSingleStream = true;
            this._stopReason = 'restart-single';
            this._abortAll();
            seg.state = 'pending';
            return;
          }
        }

        if (err.throttle) {
          // Give the slot back rather than retrying into the same wall: the
          // range returns to the queue and the pool runs one socket narrower.
          this.throttleHits++;
          if (this.throttleHits > MAX_THROTTLE_HITS) {
            seg.state = 'error';
            seg.error = new Error(
              `The server keeps refusing extra connections (HTTP ${err.statusCode || 429}). `
              + 'Lower the connection count in Settings, or try again later.'
            );
            throw seg.error;
          }
          const narrower = Math.max(1, this.maxConnections - 1);
          if (narrower !== this.maxConnections) {
            this.maxConnections = narrower;
            this.emit('throttled', { connections: narrower, requested: this.requestedConnections });
          }
          // The range waits its turn in the queue rather than in this slot,
          // so the connections the server does accept keep working meanwhile.
          // Backing off only makes sense when nothing is getting through; while
          // other connections are being served, the narrower pool is already
          // the server's answer, and the range can go as soon as a slot frees.
          // A Retry-After is the server's own instruction and always stands.
          const served = [...this._active].some((w) => w !== worker && w.sink);
          const delay = err.retryAfter || (served ? 0 : Math.min(20000, 750 * this.throttleHits));
          seg.state = 'pending';
          seg.notBefore = Date.now() + delay;
          return;
        }

        seg.retries++;
        if (err.fatal || seg.retries > MAX_RETRIES) {
          seg.state = 'error';
          seg.error = err;
          // The download cannot finish now; stop the rest of the pool rather
          // than let it fetch the remainder of a file that will be reported
          // as failed. What it has so far is checkpointed for a retry.
          if (!this._stopReason) {
            this._stopReason = 'failed';
            this._abortAll();
          }
          throw err;
        }
        this.emit('retry', { segment: seg.id, attempt: seg.retries, message: err.message });
        await sleep(Math.min(15000, 500 * 2 ** (seg.retries - 1)));
      }
    }
  }

  /** Wait until a sibling connection gets a 206, everything settles, or time runs out. */
  async _waitForRangeProof() {
    const until = Date.now() + RANGE_PROOF_WAIT_MS;
    while (!this._rangeProven && !this._stopReason && Date.now() < until && this._active.size > 1) {
      await sleep(100);
    }
  }

  /**
   * The server just told us how big the file is, which the probe could not.
   * Lay the file out at that size and, if the server takes byte ranges, turn
   * this one stream into a pool: the next rebalance hands the back halves of
   * the file to fresh connections while this one carries on from the front.
   */
  _learnSize(res, code) {
    const h = res.headers || {};
    // A compressed body's length is not the file's length.
    if (h['content-encoding'] && !/^identity$/i.test(String(h['content-encoding']).trim())) return;
    let total = null;
    if (code === 206) {
      const m = /\/(\d+)\s*$/.exec(String(h['content-range'] || ''));
      if (m) total = Number(m[1]);
    } else if (code === 200) {
      const len = Number(h['content-length']);
      if (Number.isFinite(len) && len > 0) total = len;
    }
    if (!total || this.segments.length !== 1) return;

    this.size = total;
    this.segments[0].end = total - 1;
    try { fs.truncateSync(this.partPath, total); } catch { /* grows as it is written instead */ }

    const ranges = code === 206 || /bytes/i.test(String(h['accept-ranges'] || ''));
    if (ranges && total >= MIN_SPLIT_BYTES * 2) {
      this.acceptRanges = true;
      this.emit('upgraded', { size: total, connections: this.maxConnections });
    }
  }

  /** One connection covering [seg.pos, seg.end]. Resolves when the socket ends. */
  _attempt(worker) {
    const seg = worker.seg;
    // A sink that failed part-way leaves bytes counted that never reached the
    // disk. Step back to the last byte known to be there and fetch from it.
    if (typeof seg.disk !== 'number') seg.disk = seg.pos;
    if (seg.disk < seg.pos) {
      this.downloaded -= seg.pos - seg.disk;
      seg.pos = seg.disk;
    }
    const headers = { ...this.headers };
    // The last byte this request asks for. With a chunk ceiling it is short of
    // the segment's end, and the worker comes back for the rest.
    let reqEnd = seg.end;
    if (this.acceptRanges) {
      if (this.chunkSize) reqEnd = Math.min(seg.end, seg.pos + this.chunkSize - 1);
      headers.Range = `bytes=${seg.pos}-${reqEnd}`;
    } else if (seg.pos > 0) headers.Range = `bytes=${seg.pos}-`;
    worker.chunkComplete = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      let sinkError = null;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        try { worker.req && worker.req.destroy(); } catch { /* already gone */ }
        const sink = worker.sink;
        worker.req = null;
        worker.sink = null;
        const done = () => {
          const failure = err || sinkError;
          failure ? reject(failure) : resolve();
        };
        // Settle only once the sink has written everything it was handed, so
        // that by the time a worker is idle — and a checkpoint or a resume
        // reads its position — every byte it counted is really on disk.
        if (sink && !sink.destroyed) {
          sink.once('close', done);
          sink.end();
        } else {
          done();
        }
      };

      request(this.url, { headers, timeout: 45000, insecure: this.insecure })
        .then((res) => {
          if (this._stopReason) { res.destroy(); return finish(); }

          const code = res.statusCode || 0;
          const wantsRange = Boolean(headers.Range);
          if (wantsRange && code === 200 && seg.pos > 0) {
            res.destroy();
            return finish(new Error('Server ignored the byte range on resume'));
          }
          // Some hosts advertise Accept-Ranges and then refuse an actual
          // ranged request, often because the link is tied to one IP or a
          // signature that does not cover the Range header. Splitting the
          // file is an optimisation, not a requirement, so say so and let the
          // download fall back to a single stream rather than failing.
          if ((code === 403 || code === 416) && wantsRange) {
            res.resume();
            res.destroy();
            const err = new Error(`HTTP ${code} on a ranged request`);
            err.rangeRefused = true;
            err.statusCode = code;
            return finish(err);
          }

          if (THROTTLE_CODES.has(code)) {
            const retryAfter = parseRetryAfter(res.headers['retry-after']);
            res.resume();
            res.destroy();
            const err = new Error(`Server is limiting connections (HTTP ${code})`);
            err.throttle = true;
            err.statusCode = code;
            err.retryAfter = retryAfter;
            return finish(err);
          }
          if (code !== 200 && code !== 206) {
            res.destroy();
            let err;
            if (code === 401 || code === 403) {
              err = new Error(`The server refused the download (HTTP ${code}). The link may have expired, or need you signed in.`);
            } else if (code === 404 || code === 410) {
              err = new Error(`The file is no longer at that address (HTTP ${code}).`);
            } else {
              err = new Error(`HTTP ${code} on segment ${seg.id}`);
            }
            // These answers do not change on asking again; eight retries with
            // back-off would only make the user wait a minute to hear it.
            err.fatal = [400, 401, 403, 404, 410, 451].includes(code);
            err.statusCode = code;
            return finish(err);
          }
          if (code === 206) this._rangeProven = true;
          if (res.transport === 'chromium') this.viaChromium = true;
          if (!this.size) this._learnSize(res, code);

          const sink = fs.createWriteStream(this.partPath, { flags: 'r+', start: seg.pos, highWaterMark: SINK_BUFFER });
          worker.req = res.request || res;
          worker.sink = sink;

          sink.on('error', (e) => {
            sinkError = sinkError || e;
            try { res.destroy(); } catch { /* ignore */ }
            finish(e);
          });

          res.on('data', (chunk) => {
            if (this._stopReason) { res.destroy(); return; }

            // Where this response should stop: the end of the chunk asked
            // for, or sooner if a sibling has since taken the back of the range.
            const stopAt = Math.min(seg.end, reqEnd);
            let buf = chunk;
            if (this.acceptRanges) {
              const room = stopAt - seg.pos + 1;
              if (room <= 0) { res.destroy(); return finish(); }
              if (buf.length > room) buf = buf.subarray(0, room);
            }

            // seg.disk trails seg.pos by whatever the sink still holds. It is
            // what checkpoints record, so a crash never skips unwritten bytes.
            const landed = seg.pos + buf.length;
            const ok = sink.write(buf, (e) => { if (!e && landed > seg.disk) seg.disk = landed; });
            seg.pos += buf.length;
            this.downloaded += buf.length;
            this.meter.add(buf.length);
            this.lastByteAt = Date.now();
            seg.retries = 0;

            // Charge the speed budget before the early exit below, so the last
            // chunk of a segment still counts against the global cap.
            const wait = this.limiter ? this.limiter.consume(buf.length) : null;

            if (this.acceptRanges && seg.pos > stopAt) {
              if (seg.pos <= seg.end) {
                // One chunk of a longer range is in. Let the response end by
                // itself so the socket goes back to the pool and the next
                // chunk goes out on it without a fresh handshake.
                worker.chunkComplete = true;
                return;
              }
              // The range is complete, or a sibling took the rest of it.
              res.destroy();
              return finish();
            }

            // One resume point for both brakes: the disk and the speed cap.
            if (!ok || wait) {
              res.pause();
              Promise.all([
                ok ? null : new Promise((r) => sink.once('drain', r)),
                wait,
              ]).then(() => {
                if (!this._stopReason && !settled) res.resume();
              });
            }
          });

          res.on('end', () => {
            // No length was ever given, so the server ending the body is the
            // only word on where the file ends.
            if (!this.size && !this.acceptRanges) seg.end = seg.pos - 1;
            finish();
          });
          res.on('aborted', () => finish(this._stopReason ? null : new Error('Connection aborted')));
          res.on('error', (e) => finish(this._stopReason ? null : e));
        })
        .catch((err) => finish(this._stopReason ? null : err));
    });
  }

  // ---- file + metadata -----------------------------------------------------

  async _prepareFile() {
    const resumed = await this._loadMeta();
    if (resumed) return;

    // Lay the file out at its final size so segment writes never collide.
    const fh = await fsp.open(this.partPath, 'w');
    try { if (this.size) await fh.truncate(this.size); }
    finally { await fh.close(); }

    if (this.acceptRanges && this.size) {
      const n = Math.max(1, Math.min(this.maxConnections, Math.ceil(this.size / MIN_SPLIT_BYTES)));
      const chunk = Math.floor(this.size / n);
      this.segments = Array.from({ length: n }, (_, i) => ({
        id: i,
        start: i * chunk,
        end: i === n - 1 ? this.size - 1 : (i + 1) * chunk - 1,
        pos: i * chunk,
        disk: i * chunk,
        state: 'pending',
        retries: 0,
        error: null,
      }));
    } else {
      this.segments = [{
        id: 0,
        start: 0,
        end: this.size ? this.size - 1 : Number.MAX_SAFE_INTEGER,
        pos: 0,
        disk: 0,
        state: 'pending',
        retries: 0,
        error: null,
      }];
    }
    this.downloaded = 0;
    await this._flushMeta(true);
  }

  async _loadMeta() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.metaPath, 'utf8'));
      const stat = await fsp.stat(this.partPath);
      // Only trust the sidecar if the server still reports the same file.
      if (raw.url !== this.url || raw.size !== this.size) return false;
      if (this.size && stat.size !== this.size) return false;
      if (!Array.isArray(raw.segments) || !raw.segments.length) return false;

      this.segments = raw.segments.map((s, i) => ({
        id: i,
        start: s.start,
        end: s.end,
        pos: s.pos,
        disk: s.pos,
        state: s.pos > s.end ? 'done' : 'pending',
        retries: 0,
        error: null,
      }));
      // A download split into pieces must resume as pieces: without ranges,
      // each piece would be refetched from its offset to the end of the file
      // and write straight over its neighbours.
      if (raw.acceptRanges && this.size) this.acceptRanges = true;
      this.downloaded = this.segments.reduce((a, s) => a + (s.pos - s.start), 0);
      this.emit('resumed', { downloaded: this.downloaded });
      return true;
    } catch {
      return false;
    }
  }

  async _flushMeta(force = false) {
    const now = Date.now();
    if (!force && now - this._flushAt < 1000) return;
    this._flushAt = now;
    const payload = {
      url: this.url,
      size: this.size,
      acceptRanges: this.acceptRanges,
      updated: now,
      // Only what is confirmed on disk: a checkpoint ahead of the data would
      // have a resume skip over bytes that never landed.
      segments: this.segments.map((s) => ({
        start: s.start,
        end: s.end,
        pos: typeof s.disk === 'number' ? Math.min(s.pos, s.disk) : s.pos,
      })),
    };
    try { await fsp.writeFile(this.metaPath, JSON.stringify(payload)); }
    catch { /* a lost checkpoint only costs us a restart */ }
  }

  async _cleanupPart() {
    await fsp.rm(this.partPath, { force: true }).catch(() => {});
    await fsp.rm(this.metaPath, { force: true }).catch(() => {});
  }

  async _finalize() {
    if (this.size) {
      const stat = await fsp.stat(this.partPath).catch(() => null);
      if (stat && stat.size !== this.size) {
        await fsp.truncate(this.partPath, this.size).catch(() => {});
      }
    } else {
      // Unknown length: the file was grown as it came, so trim nothing.
      const stat = await fsp.stat(this.partPath).catch(() => null);
      if (stat) this.size = stat.size;
    }

    await fsp.rm(this.metaPath, { force: true }).catch(() => {});
    await fsp.rm(this.filePath, { force: true }).catch(() => {});
    await fsp.rename(this.partPath, this.filePath);

    this.state = 'done';
    this.speed = 0;
    this.downloaded = this.size || this.downloaded;
    this._emitProgress();
    this.emit('done', { filePath: this.filePath, size: this.size });
    this._resolve && this._resolve({ filePath: this.filePath, size: this.size });
  }

  _fail(err) {
    if (this._stopReason === 'cancelled') return;
    this.state = 'error';
    this.error = err;
    this.speed = 0;
    this._emitProgress();
    // Node throws if an 'error' event is emitted with nobody listening, which
    // would turn any failed download into a crash. The rejected promise below
    // is the real channel; the event is a convenience for callers that want it.
    if (this.listenerCount('error') > 0) this.emit('error', err);
    this._reject && this._reject(err);
  }

  _emitProgress() {
    this.speed = this.state === 'running' ? this.meter.sample() : 0;
    if (this.state === 'running') this._flushMeta();
    this.emit('progress', {
      downloaded: this.downloaded,
      size: this.size,
      speed: this.speed,
      progress: this.progress,
      eta: this.eta,
      connections: this._active.size,
      segments: this.snapshotSegments(),
      // Worth saying: it explains why a site that "blocks downloaders" works.
      note: this.viaChromium ? 'through Chrome’s network stack' : '',
    });
  }
}

module.exports = { HttpDownload, PART_SUFFIX, META_SUFFIX };
