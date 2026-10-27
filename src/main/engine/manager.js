'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { HttpDownload } = require('./http-download');
const { HlsDownload, inspect: inspectHls } = require('./hls');
const { TorrentDownload, isTorrentSource, nameFromMagnet } = require('./torrent');
const { probe } = require('./probe');
const ytdlp = require('./ytdlp');
const merge = require('./merge');
const {
  RateLimiter, sanitizeFilename, uniquePath, categoryFor, newId, isHttpUrl,
  looksLikeFileUrl, UA_DESKTOP,
} = require('./util');
const { filenameFromUrl } = require('./probe');
const { scrapePage } = require('./scrape');
const cookieJar = require('./cookies');

const TERMINAL = new Set(['done', 'error', 'cancelled']);

/** Headers minus anything that carries a live session. */
function stripSession(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(cookie|authorization|x-csrf-token)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The queue.
 *
 * Owns every download's lifecycle: works out what a URL actually is, picks the
 * engine that can fetch it, respects the concurrency and speed limits, keeps
 * the on-disk record in step, and tells the UI what changed.
 */
class DownloadManager extends EventEmitter {
  constructor(opts) {
    super();
    this.store = opts.store;                 // JsonStore for tasks
    this.settings = opts.settings;           // JsonStore for settings
    this.binaries = opts.binaries;
    this.limiter = new RateLimiter(0);
    // Working files live well away from the user's download folder. Nobody
    // wants a .fletch-tmp sitting next to their video.
    this.tmpDir = opts.tmpDir || path.join(os.tmpdir(), 'fletch-work');

    this.tasks = new Map();
    this._live = new Map();   // task id -> active downloader
    // Live session cookies, kept in memory only. These are as sensitive as a
    // password and have no business sitting in a plain JSON file, so they are
    // never persisted; after a restart the browser supplies them again.
    this._cookies = new Map();
    this._analysing = 0;
    this._dirty = false;
    this._flushTimer = null;

    this._restore();
    this.applySettings();

    // The UI only needs a steady pulse, not an event per chunk.
    this._pulse = setInterval(() => this._flush(), 400);

    this.sweep().catch(() => { /* tidying is never worth failing startup over */ });
  }

  // ---- settings ------------------------------------------------------------

  get maxConcurrent() { return Math.max(1, this.settings.get('maxConcurrent', 3)); }
  get connections() { return Math.max(1, Math.min(32, this.settings.get('connections', 8))); }
  get downloadDir() {
    return this.settings.get('downloadDir') || path.join(os.homedir(), 'Downloads', 'Fletch');
  }

  applySettings() {
    const kbps = Number(this.settings.get('speedLimitKbps', 0)) || 0;
    this.limiter.setLimit(kbps > 0 ? kbps * 1024 : 0);
    this.binaries.setOverrides({
      'yt-dlp': this.settings.get('ytdlpPath', ''),
      ffmpeg: this.settings.get('ffmpegPath', ''),
    });
  }

  targetFolder(category) {
    const base = this.downloadDir;
    if (!this.settings.get('sortIntoCategories', true)) return base;
    const folders = {
      video: 'Video', audio: 'Audio', documents: 'Documents',
      archives: 'Archives', programs: 'Programs', images: 'Images',
      torrents: 'Torrents', other: 'Other',
    };
    return path.join(base, folders[category] || 'Other');
  }

  // ---- persistence ---------------------------------------------------------

  _restore() {
    const saved = this.store.get('tasks', []);
    for (const raw of saved) {
      const task = { ...raw };
      // Anything that was mid-flight when we closed comes back paused, not lying.
      if (!TERMINAL.has(task.state)) {
        task.state = task.state === 'queued' ? 'queued' : 'paused';
        task.speed = 0;
        task.connections = 0;
      }
      this.tasks.set(task.id, task);
    }
  }

  _persist() {
    const list = [...this.tasks.values()].map((t) => {
      const { segments, ...rest } = t;
      return {
        ...rest,
        speed: 0,
        connections: 0,
        // A Cookie header is a live session. It is wanted in memory for the
        // duration of the download and has no business being written to a
        // plain file that survives it.
        headers: stripSession(rest.headers),
        parts: (rest.parts || []).map((p) => ({ ...p, headers: stripSession(p.headers) })),
      };
    });
    this.store.set('tasks', list);
  }

  _touch(task) {
    this._dirty = true;
    if (task) task.updatedAt = Date.now();
  }

  _flush() {
    if (!this._dirty) return;
    this._dirty = false;
    this.emit('tasks', this.list());
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) { return this.tasks.get(id) || null; }

  stats() {
    let speed = 0;
    let active = 0;
    let queued = 0;
    for (const t of this.tasks.values()) {
      if (t.state === 'running') { speed += t.speed || 0; active++; }
      else if (t.state === 'queued' || t.state === 'analyzing') queued++;
    }
    return { speed, active, queued, total: this.tasks.size, limitKbps: Number(this.settings.get('speedLimitKbps', 0)) || 0 };
  }

  /**
   * Clear away working files nobody owns any more: scratch folders belonging to
   * tasks that are gone, half-written merges, and the `.fletch-tmp` folders
   * that earlier versions left inside the download folder.
   */
  async sweep() {
    const live = new Set([...this.tasks.keys()]);

    const entries = await fsp.readdir(this.tmpDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (live.has(entry.name)) continue;
      await fsp.rm(path.join(this.tmpDir, entry.name), { recursive: true, force: true }).catch(() => {});
    }

    const roots = new Set([this.downloadDir]);
    for (const t of this.tasks.values()) if (t.folder) roots.add(t.folder);
    for (const root of roots) {
      const kids = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const kid of kids) {
        if (kid.isDirectory() && kid.name === '.fletch-tmp') {
          await fsp.rm(path.join(root, kid.name), { recursive: true, force: true }).catch(() => {});
        } else if (kid.isDirectory()) {
          const grandkids = await fsp.readdir(path.join(root, kid.name), { withFileTypes: true }).catch(() => []);
          for (const g of grandkids) {
            if (g.isDirectory() && g.name === '.fletch-tmp') {
              await fsp.rm(path.join(root, kid.name, g.name), { recursive: true, force: true }).catch(() => {});
            }
          }
        }
      }
    }
  }

  // ---- adding --------------------------------------------------------------

  /**
   * Take a URL and make a task out of it. Returns immediately; the slow part
   * (asking the server or yt-dlp what this actually is) runs in the background
   * and fills the details in as they arrive.
   */
  async add(url, opts = {}) {
    url = String(url || '').trim();
    const torrentish = isTorrentSource(url);
    if (!isHttpUrl(url) && !torrentish) {
      throw new Error('That is not a link Fletch can take — use http, https or a magnet link.');
    }

    if (!opts.allowDuplicate) {
      const existing = [...this.tasks.values()].find(
        (t) => (t.sourceUrl === url || t.url === url) && !TERMINAL.has(t.state)
      );
      if (existing) return existing;
    }

    const task = {
      id: newId(),
      sourceUrl: url,
      url,
      title: '',
      filename: '',
      filePath: '',
      folder: '',
      category: 'other',
      kind: 'file',
      engine: 'http',
      state: 'analyzing',
      stage: 'Looking at the link…',
      size: null,
      downloaded: 0,
      speed: 0,
      progress: 0,
      eta: null,
      connections: 0,
      segments: [],
      error: '',
      thumbnail: '',
      duration: 0,
      uploader: '',
      formatLabel: '',
      parts: [],
      partIndex: 0,
      headers: opts.headers || {},
      maxHeight: opts.maxHeight || Number(this.settings.get('maxHeight', 0)) || 0,
      audioOnly: Boolean(opts.audioOnly),
      autoStart: opts.autoStart !== false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: 0,
    };

    if (Array.isArray(opts.cookies) && opts.cookies.length) {
      this._cookies.set(task.id, opts.cookies);
      task.hasCookies = true;
    }

    this.tasks.set(task.id, task);
    this._touch(task);
    this._persist();

    this._analyse(task, opts).catch((err) => this._fail(task, err));
    return task;
  }

  async _analyse(task, opts) {
    // A couple at a time: analysis is cheap but yt-dlp startup is not.
    while (this._analysing >= 3) await new Promise((r) => setTimeout(r, 120));
    this._analysing++;
    try {
      if (isTorrentSource(task.sourceUrl)) {
        this._setupTorrent(task);
        task.state = 'queued';
        task.stage = '';
        this._touch(task);
        this._persist();
        this._drain();
        return;
      }

      // Present the browser's session from the first request onwards: some
      // hosts answer a probe quite differently to a stranger.
      const jar = this._cookies.get(task.id);
      if (jar) {
        const header = cookieJar.toHeader(cookieJar.forUrl(jar, task.url));
        if (header) task.headers = { ...task.headers, Cookie: header };
      }

      let info = null;
      if (!opts.forceVideo) {
        try { info = await probe(task.url, { headers: task.headers }); }
        catch (err) { task.probeError = err.message; }
      }

      // When the server answers, its content type decides. When it refuses to
      // answer at all — which plenty of file hosts do for links tied to one
      // IP and a short window — the shape of the URL decides instead. Sending
      // a perfectly good .mp4 link to the video extractor because a probe was
      // rejected is how a working download becomes "unsupported URL".
      const fileish = looksLikeFileUrl(task.url);
      const looksLikePage = info
        ? /text\/html|application\/xhtml/.test(info.mime || '')
        : !fileish;

      if (info && info.isPlaylist) {
        await this._setupHls(task, info);
      } else if (opts.forceVideo || looksLikePage) {
        await this._setupVideo(task, opts);
      } else if (info) {
        await this._setupFile(task, info);
      } else {
        this._setupUnprobedFile(task);
      }

      task.state = 'queued';
      task.stage = '';
      this._touch(task);
      this._persist();
      this._drain();
    } finally {
      this._analysing--;
    }
  }

  async _setupFile(task, info) {
    task.kind = 'file';
    task.engine = 'http';
    task.url = info.url;
    task.title = task.title || info.filename;
    task.size = info.size;
    task.acceptRanges = info.acceptRanges;
    if (info.cookies) task.headers = { ...task.headers, Cookie: info.cookies };
    this._assignPath(task, info.filename);
  }

  async _setupHls(task, info) {
    task.kind = 'video';
    task.url = info.url;
    const base = sanitizeFilename((task.title || info.filename || 'stream').replace(/\.(m3u8|mpd)$/i, ''));
    task.title = task.title || base;

    let plan = null;
    try {
      plan = await inspectHls(info.url, { headers: task.headers, preferHeight: task.maxHeight });
    } catch {
      // Could not read the master playlist; let the HLS engine try it directly.
    }

    if (!plan) {
      task.engine = 'hls';
      task.formatLabel = 'HLS stream';
      this._assignPath(task, `${base}.ts`);
      return;
    }

    const quality = plan.height ? `${plan.height}p` : 'HLS';
    const ffmpeg = await this.binaries.resolve('ffmpeg');

    if (plan.audioUrl && ffmpeg) {
      // Picture and sound live in separate playlists: fetch both, then join.
      task.engine = 'merge';
      task.formatLabel = `${quality} stream + separate audio, merged`;
      task.parts = [
        { role: 'video', url: plan.videoUrl, engine: 'hls', ext: plan.container, headers: task.headers, size: null, filePath: '', done: false },
        { role: 'audio', url: plan.audioUrl, engine: 'hls', ext: plan.container, headers: task.headers, size: null, filePath: '', done: false },
      ];
      this._assignPath(task, `${base}.mp4`);
      return;
    }

    task.engine = 'hls';
    task.url = plan.videoUrl;
    task.formatLabel = plan.audioUrl
      ? `${quality} stream — install ffmpeg to get the sound track too`
      : `${quality} stream`;
    this._assignPath(task, `${base}.${plan.container === 'mp4' ? 'mp4' : 'ts'}`);
  }

  /**
   * A link that plainly names a file, from a server that would not describe
   * it. The downloader finds out the size and whether ranges work when it
   * actually connects, so nothing is lost by not knowing yet.
   */
  _setupUnprobedFile(task) {
    task.kind = 'file';
    task.engine = 'http';
    task.size = null;
    task.acceptRanges = undefined;
    const name = sanitizeFilename(filenameFromUrl(task.url) || 'download');
    task.title = task.title || name;
    task.formatLabel = '';
    this._assignPath(task, name);
  }

  /**
   * Media found by reading the page rather than by an extractor. The page URL
   * becomes the Referer, which many hosts insist on before serving the file.
   */
  async _setupFromScrape(task, found) {
    task.kind = 'video';
    task.pageUrl = found.pageUrl;
    task.headers = { ...task.headers, Referer: found.pageUrl };
    task.foundOnPage = found.alternatives;
    const pageTitle = found.title ? sanitizeFilename(found.title) : '';

    if (/\.m3u8(\?|#|$)/i.test(found.url) || /\.mpd(\?|#|$)/i.test(found.url)) {
      task.title = pageTitle || task.title;
      await this._setupHls(task, { url: found.url, filename: pageTitle || 'stream' });
      task.formatLabel = `${task.formatLabel} · found on the page`;
      return;
    }

    const info = await probe(found.url, { headers: task.headers }).catch(() => null);
    if (info) {
      await this._setupFile(task, info);
      if (pageTitle) {
        // The page's own title beats a CDN's filename, but keep the extension.
        const ext = path.extname(task.filename) || path.extname(info.filename) || '.mp4';
        task.title = pageTitle;
        this._assignPath(task, `${pageTitle}${ext}`);
      }
    } else {
      task.url = found.url;
      this._setupUnprobedFile(task);
      if (pageTitle) task.title = pageTitle;
    }
    // _setupFile and _setupUnprobedFile both call this a plain file. It came
    // off a video page, and the UI should keep treating it as one.
    task.kind = 'video';
    task.formatLabel = 'Found on the page';
  }

  _setupTorrent(task) {
    task.kind = 'torrent';
    task.engine = 'torrent';
    // A torrent may be a whole folder, so it gets its own place rather than
    // being filed by the extension of a name we do not know yet.
    task.category = 'torrents';
    task.folder = this.settings.get('sortIntoCategories', true)
      ? path.join(this.downloadDir, 'Torrents')
      : this.downloadDir;
    fs.mkdirSync(task.folder, { recursive: true });
    task.title = task.title || nameFromMagnet(task.sourceUrl) || 'Torrent';
    task.filename = task.title;
    task.filePath = path.join(task.folder, task.filename);
    task.formatLabel = 'Torrent';
    task.parts = [];
  }

  async _setupVideo(task, opts) {
    const bin = await this.binaries.resolve('yt-dlp');
    let info = null;
    let extractError = null;

    if (bin) {
      task.stage = 'Reading the page…';
      this._touch(task);

      // yt-dlp takes cookies as a file, not a header. The extension's are
      // preferred over reading the browser's own store, which current Chrome
      // encrypts specifically to stop other programs doing that.
      const jar = this._cookies.get(task.id);
      let cookieFile = null;
      try {
        cookieFile = await cookieJar.writeCookieFile(jar, path.join(this.tmpDir, task.id), 'session');
      } catch { /* carry on without them */ }

      try {
        info = await ytdlp.extract(bin, task.url, {
          cookieFile: cookieFile || undefined,
          cookiesFromBrowser: cookieFile
            ? undefined
            : (this.settings.get('cookiesFromBrowser', '') || undefined),
          proxy: this.settings.get('proxy', '') || undefined,
        });
      } catch (err) {
        extractError = err;
      } finally {
        if (cookieFile) await fsp.rm(cookieFile, { force: true }).catch(() => {});
      }
    }

    // yt-dlp covers the sites it knows. For the rest — embed pages, file
    // lockers, one-off hosts — read the page and find the player's source.
    if (!info || !(info.formats || []).length) {
      task.stage = 'Looking for media on the page…';
      this._touch(task);
      const found = await scrapePage(task.url, { headers: task.headers }).catch(() => null);
      if (found) return this._setupFromScrape(task, found);

      if (!bin) {
        throw new Error('This link is a web page. Fletch found no media on it, and the yt-dlp helper is not installed — add it from Settings to cover far more sites.');
      }

      // Being bounced to a sign-in or onboarding page is a specific, common
      // failure, and "Unsupported URL" is a misleading way to report it.
      const message = (extractError && extractError.message) || '';
      if (/login|signin|sign-in|onboarding|redirect_after_login|consent|age.?gate|private/i.test(message)) {
        const using = this.settings.get('cookiesFromBrowser', '');
        throw new Error(
          using
            ? `That page wants you signed in, and the ${using} cookies Fletch is using were not accepted. Close ${using} and try again, or open the post directly rather than from a feed.`
            : 'That page wants you signed in. Turn on Settings → Browser → "Sign in as you, using your browser’s cookies", then try again.'
        );
      }
      if (/unsupported url/i.test(message)) {
        throw new Error(
          `No video was found at that address. ${/\/(home|explore|feed)\b/i.test(task.url)
            ? 'It points at a feed rather than a particular post — open the post itself and try again.'
            : 'The site may need you signed in, or may not expose a downloadable stream.'}`
        );
      }
      throw extractError || new Error('No downloadable video was found on that page.');
    }

    task.kind = 'video';
    task.title = info.title;
    task.thumbnail = info.thumbnail;
    task.duration = info.duration;
    task.uploader = info.uploader;
    task.extractor = info.extractor;
    task.pageUrl = info.webpageUrl || task.sourceUrl;
    task.availableFormats = info.formats
      .filter((f) => f.hasVideo || f.hasAudio)
      .map((f) => ({ id: f.id, label: f.label, height: f.height, size: f.size, hasAudio: f.hasAudio, hasVideo: f.hasVideo }));

    const ffmpeg = await this.binaries.resolve('ffmpeg');
    const choice = ytdlp.chooseFormats(info, {
      maxHeight: task.maxHeight,
      audioOnly: task.audioOnly,
      canMerge: Boolean(ffmpeg),
    });
    task.formatLabel = choice.reason;

    const main = choice.video || choice.audio;
    const container = task.audioOnly
      ? (choice.audio.ext || 'm4a')
      : (choice.needsMerge ? (main.ext === 'webm' ? 'webm' : 'mp4') : (main.ext || 'mp4'));
    const baseName = sanitizeFilename(info.title || 'video');
    this._assignPath(task, `${baseName}.${container}`);

    // A protocol our engine cannot speak means handing the whole job to yt-dlp.
    const engines = [choice.video, choice.audio].filter(Boolean).map(ytdlp.engineFor);
    if (engines.includes('ytdlp')) {
      task.engine = 'ytdlp';
      task.ytdlpFormat = choice.needsMerge
        ? `${choice.video.id}+${choice.audio.id}`
        : main.id;
      task.parts = [];
      return;
    }

    const mkPart = (f, role) => ({
      role,
      url: f.url,
      engine: ytdlp.engineFor(f),
      size: f.size,
      ext: f.ext,
      headers: { ...task.headers, ...(f.headers || {}) },
      filePath: '',
      done: false,
    });

    if (choice.needsMerge) {
      task.engine = 'merge';
      task.parts = [mkPart(choice.video, 'video'), mkPart(choice.audio, 'audio')];
    } else {
      task.engine = ytdlp.engineFor(main);
      task.url = main.url;
      task.headers = { ...task.headers, ...(main.headers || {}) };
      task.size = main.size;
      task.parts = [];
    }

    task.size = task.size || (task.parts.length
      ? task.parts.reduce((a, p) => a + (p.size || 0), 0) || null
      : null);
  }

  _assignPath(task, filename) {
    const name = sanitizeFilename(filename || 'download');
    task.category = categoryFor(name);
    task.folder = this.targetFolder(task.category);
    fs.mkdirSync(task.folder, { recursive: true });
    task.filePath = uniquePath(task.folder, name);
    task.filename = path.basename(task.filePath);
    if (!task.title) task.title = task.filename;
  }

  // ---- queue ---------------------------------------------------------------

  _drain() {
    if (this.settings.get('paused', false)) return;
    let running = [...this.tasks.values()].filter((t) => t.state === 'running').length;
    if (running >= this.maxConcurrent) return;

    const queued = [...this.tasks.values()]
      .filter((t) => t.state === 'queued' && t.autoStart !== false)
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const task of queued) {
      if (running >= this.maxConcurrent) break;
      running++;
      this._start(task);
    }
  }

  _start(task) {
    task.state = 'running';
    task.error = '';
    task.startedAt = task.startedAt || Date.now();
    this._touch(task);

    this._run(task)
      .then((res) => {
        if (res && res.cancelled) return;
        if (res && res.paused) { task.state = 'paused'; task.speed = 0; task.connections = 0; this._touch(task); return; }
        this._complete(task);
      })
      .catch((err) => this._fail(task, err))
      .finally(() => {
        this._live.delete(task.id);
        this._persist();
        this._drain();
      });
  }

  async _run(task) {
    switch (task.engine) {
      case 'torrent': return this._runTorrent(task);
      case 'merge': return this._runMerge(task);
      case 'hls': return this._runHls(task, task.url, task.filePath, true);
      case 'ytdlp': return this._runYtDlp(task);
      default: return this._runHttp(task, task.url, task.filePath, task.headers);
    }
  }

  _wire(task, dl, offset = 0, totalOverride = null) {
    dl.on('progress', (p) => {
      task.downloaded = offset + (p.downloaded || 0);
      task.speed = p.speed || 0;
      task.connections = p.connections || 0;
      task.segments = p.segments || [];
      task.note = p.note || '';
      const total = totalOverride || (p.size ? offset + p.size : null);
      if (total) task.size = total;
      task.progress = task.size ? Math.min(1, task.downloaded / task.size) : (p.progress || 0);
      task.eta = p.eta;
      this._touch(task);
    });
    dl.on('retry', (r) => { task.stage = `Reconnecting (attempt ${r.attempt})…`; this._touch(task); });
    dl.on('throttled', (t) => {
      task.warning = `This server only allows ${t.connections} connection${t.connections > 1 ? 's' : ''} at a time, so Fletch eased off from ${t.requested}.`;
      this._touch(task);
    });
    dl.on('stage', (s) => { task.stage = s; this._touch(task); });
    dl.on('warning', (w) => { task.warning = w; this._touch(task); });
    this._live.set(task.id, dl);
  }

  async _runHttp(task, url, filePath, headers, offset = 0, opts = {}) {
    let size = opts.size !== undefined ? opts.size : task.size;
    let acceptRanges = opts.acceptRanges !== undefined ? opts.acceptRanges : task.acceptRanges;
    if (size == null || acceptRanges === undefined) {
      const info = await probe(url, { headers }).catch(() => null);
      if (info) { size = size || info.size; acceptRanges = info.acceptRanges; }
    }
    const dl = new HttpDownload({
      url, filePath, size, acceptRanges,
      headers: { ...headers, 'User-Agent': headers['User-Agent'] || UA_DESKTOP },
      connections: task.connectionsOverride || this.connections,
      limiter: this.limiter,
      stallMs: Math.max(5, Number(this.settings.get('stallSeconds', 90)) || 90) * 1000,
    });
    this._wire(task, dl, offset);
    return dl.start();
  }

  async _runHls(task, url, filePath, remux, opts = {}) {
    const dl = new HlsDownload({
      url, filePath,
      headers: opts.headers || task.headers,
      connections: Math.min(16, (task.connectionsOverride || this.connections) * 2),
      preferHeight: task.maxHeight,
    });
    this._wire(task, dl, opts.offset || 0);
    const res = await dl.start();
    if (res && (res.cancelled || res.paused)) return res;

    if (remux && this.settings.get('remuxHls', true)) {
      const ffmpeg = await this.binaries.resolve('ffmpeg');
      if (ffmpeg) {
        task.stage = 'Repacking as MP4…';
        this._touch(task);
        const mp4 = task.filePath.replace(/\.ts$/i, '.mp4');
        // An fMP4 stream is already named .mp4, so remux through a temp file
        // rather than asking ffmpeg to read and write the same path.
        const scratch = `${mp4}.remux.mp4`;
        try {
          await merge.remuxToMp4(ffmpeg, task.filePath, scratch);
          await fsp.rm(task.filePath, { force: true });
          await merge.replace(scratch, mp4);
          task.filePath = mp4;
          task.filename = path.basename(mp4);
          const stat = await fsp.stat(mp4);
          task.size = stat.size;
        } catch {
          await fsp.rm(scratch, { force: true }).catch(() => {});
          // Keep the .ts: it plays fine, it just seeks poorly.
          task.warning = 'Saved as .ts — ffmpeg could not repack it as MP4.';
        }
        task.stage = '';
      }
    }
    return res;
  }

  async _runTorrent(task) {
    const dl = new TorrentDownload({
      url: task.sourceUrl,
      dir: task.folder,
      maxConns: Math.max(20, Number(this.settings.get('torrentMaxPeers', 80)) || 80),
      addPeers: task.addPeers || [],
      announce: task.announce,
      metadataTimeout: Math.max(10, Number(this.settings.get('torrentMetadataSeconds', 90)) || 90) * 1000,
    });

    // The real name only shows up once peers hand over the metadata.
    dl.on('meta', (meta) => {
      task.title = meta.name || task.title;
      task.filename = meta.name || task.filename;
      task.filePath = path.join(task.folder, meta.name || task.filename);
      task.size = meta.size;
      task.formatLabel = meta.files > 1 ? `Torrent · ${meta.files} files` : 'Torrent';
      // A torrent belongs under Torrents whatever it happens to contain.
      // Filing a single-file torrent of a .mkv under Video just loses it.
      task.category = 'torrents';
      this._touch(task);
      this._persist();
    });

    this._wire(task, dl);
    const res = await dl.start();

    // Seeding is opt-in: most people want the file, not an upload obligation.
    if (res && res.filePath && !this.settings.get('keepSeeding', false)) {
      await dl.stopSeeding().catch(() => {});
    }
    return res;
  }

  async _runYtDlp(task) {
    const bin = await this.binaries.resolve('yt-dlp');
    if (!bin) throw new Error('yt-dlp is needed for this link. Install it from Settings.');
    const ffmpeg = await this.binaries.resolve('ffmpeg');
    const jar = this._cookies.get(task.id);
    let cookieFile = null;
    try {
      cookieFile = await cookieJar.writeCookieFile(jar, path.join(this.tmpDir, task.id), 'session');
    } catch { /* carry on without them */ }

    const dl = new ytdlp.YtDlpDownload({
      ytdlpPath: bin,
      cookieFile: cookieFile || undefined,
      ffmpegPath: ffmpeg ? path.dirname(ffmpeg) : undefined,
      url: task.pageUrl || task.sourceUrl,
      filePath: task.filePath,
      formatId: task.ytdlpFormat,
      connections: this.connections,
      cookiesFromBrowser: this.settings.get('cookiesFromBrowser', '') || undefined,
      proxy: this.settings.get('proxy', '') || undefined,
    });
    this._wire(task, dl);
    try {
      return await dl.start();
    } finally {
      if (cookieFile) await fsp.rm(cookieFile, { force: true }).catch(() => {});
    }
  }

  /** Separate video and audio streams, fetched in turn then stitched together. */
  async _runMerge(task) {
    const ffmpeg = await this.binaries.resolve('ffmpeg');
    if (!ffmpeg) throw new Error('ffmpeg is needed to join the video and audio tracks. Set its location in Settings.');

    const tmpDir = path.join(this.tmpDir, task.id);
    await fsp.mkdir(tmpDir, { recursive: true });
    const stamp = task.id;

    // Both tracks count toward one progress bar, so each part reports against
    // the bytes already banked by the parts before it.
    const expected = task.parts.reduce((a, p) => a + (p.actualSize || p.size || 0), 0) || null;
    let offset = task.parts.slice(0, task.partIndex).reduce((a, p) => a + (p.actualSize || 0), 0);

    for (let i = task.partIndex; i < task.parts.length; i++) {
      const part = task.parts[i];
      task.partIndex = i;
      part.filePath = part.filePath || path.join(tmpDir, `${stamp}.${part.role}.${part.ext || 'bin'}`);
      task.stage = part.role === 'video' ? 'Fetching video track…' : 'Fetching audio track…';
      this._touch(task);

      const res = part.engine === 'hls'
        ? await this._runHls(task, part.url, part.filePath, false, { headers: part.headers, offset })
        : await this._runHttp(task, part.url, part.filePath, part.headers, offset,
          { size: part.size ?? null, acceptRanges: undefined });

      if (res && (res.cancelled || res.paused)) return res;
      part.done = true;
      const stat = await fsp.stat(part.filePath).catch(() => null);
      part.actualSize = stat ? stat.size : 0;
      offset += part.actualSize;
      if (expected) task.size = Math.max(expected, offset);
    }

    task.stage = 'Joining video and audio…';
    task.speed = 0;
    task.connections = 0;
    this._touch(task);

    const video = task.parts.find((p) => p.role === 'video');
    const audio = task.parts.find((p) => p.role === 'audio');
    // ffmpeg writes beside the destination so the final step is a rename on the
    // same volume rather than a copy across drives.
    const tmpOut = `${task.filePath}.merging${path.extname(task.filePath)}`;
    try {
      await merge.mergeTracks(ffmpeg, video.filePath, audio.filePath, tmpOut);
      await merge.replace(tmpOut, task.filePath);
    } catch (err) {
      await fsp.rm(tmpOut, { force: true }).catch(() => {});
      throw err;
    } finally {
      // Recursive: the parts bring their own sidecars, and a half-finished one
      // must not keep the folder alive.
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    const stat = await fsp.stat(task.filePath);
    task.size = stat.size;
    task.stage = '';
    return { filePath: task.filePath, size: stat.size };
  }

  _complete(task) {
    task.state = 'done';
    task.progress = 1;
    task.speed = 0;
    task.connections = 0;
    task.eta = 0;
    task.stage = '';
    task.segments = [];
    task.autoRetries = 0;
    task.finishedAt = Date.now();
    if (task.size) task.downloaded = task.size;
    this._touch(task);
    this._persist();
    this.emit('completed', task);
  }

  // Failures that usually mean "too many sockets for this server" rather than
  // "this link is broken". Worth one quiet retry at a gentler setting before
  // bothering the user, since the partial file is still on disk.
  static RECOVERABLE = /stopped waiting|refusing extra connections|ECONNRESET|socket hang up|timed out|ETIMEDOUT|EPIPE|aborted/i;

  _fail(task, err) {
    if (task.state === 'cancelled') return;
    const message = err && err.message ? err.message : String(err);

    if (DownloadManager.RECOVERABLE.test(message) && (task.autoRetries || 0) < 2) {
      task.autoRetries = (task.autoRetries || 0) + 1;
      const current = task.connectionsOverride || this.connections;
      task.connectionsOverride = Math.max(2, Math.floor(current / 2));
      task.warning = `That server stopped responding on ${current} connections, so Fletch is trying again on ${task.connectionsOverride}.`;
      task.state = 'queued';
      task.error = '';
      task.stage = 'Retrying more gently…';
      this._touch(task);
      this._persist();
      // _start's finally will drain the queue once this task is off the live list.
      return;
    }

    task.state = 'error';
    task.error = err && err.message ? err.message : String(err);
    task.speed = 0;
    task.connections = 0;
    task.stage = '';
    this._touch(task);
    this._persist();
    this.emit('failed', task);
  }

  // ---- controls ------------------------------------------------------------

  pause(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    const live = this._live.get(id);
    if (live) live.pause();
    else if (task.state === 'queued') { task.state = 'paused'; this._touch(task); this._persist(); }
  }

  resume(id) {
    const task = this.tasks.get(id);
    if (!task || task.state === 'running') return;
    task.state = 'queued';
    task.error = '';
    task.autoStart = true;
    this._touch(task);
    this._drain();
  }

  retry(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    task.error = '';
    task.partIndex = 0;
    // A deliberate retry starts from a clean slate, including the connection
    // count that any earlier automatic back-off reduced.
    task.autoRetries = 0;
    task.connectionsOverride = 0;
    task.warning = '';
    for (const p of task.parts || []) p.done = false;
    task.state = 'queued';
    task.autoStart = true;
    this._touch(task);
    this._drain();
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    const live = this._live.get(id);
    task.state = 'cancelled';
    task.speed = 0;
    task.connections = 0;
    if (live) live.cancel();
    this._touch(task);
    this._persist();
  }

  async remove(id, alsoDeleteFile = false) {
    const task = this.tasks.get(id);
    if (!task) return;
    const live = this._live.get(id);
    if (live) live.cancel();
    this.tasks.delete(id);
    this._cookies.delete(id);

    await fsp.rm(task.filePath + '.fletchpart', { force: true }).catch(() => {});
    await fsp.rm(task.filePath + '.fletchpart.meta', { force: true }).catch(() => {});
    for (const p of task.parts || []) {
      if (!p.filePath) continue;
      // Each part is itself a segmented download, so it has its own sidecars.
      for (const stray of [p.filePath, `${p.filePath}.fletchpart`, `${p.filePath}.fletchpart.meta`]) {
        await fsp.rm(stray, { force: true }).catch(() => {});
      }
    }
    await fsp.rm(path.join(this.tmpDir, task.id), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(`${task.filePath}.merging${path.extname(task.filePath || '')}`, { force: true }).catch(() => {});
    if (alsoDeleteFile && task.state === 'done' && task.filePath) {
      await fsp.rm(task.filePath, { force: true }).catch(() => {});
    }
    this._touch();
    this._persist();
  }

  pauseAll() {
    this.settings.set('paused', true);
    for (const t of this.tasks.values()) {
      if (t.state === 'running' || t.state === 'queued') this.pause(t.id);
    }
  }

  resumeAll() {
    this.settings.set('paused', false);
    for (const t of this.tasks.values()) {
      if (t.state === 'paused') { t.state = 'queued'; t.autoStart = true; }
    }
    this._touch();
    this._drain();
  }

  clearCompleted() {
    for (const t of [...this.tasks.values()]) {
      if (t.state === 'done' || t.state === 'cancelled') this.tasks.delete(t.id);
    }
    this._touch();
    this._persist();
  }

  /** Re-pick a format on an already-analysed video task and queue it again. */
  async chooseFormat(id, formatId) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('That download is no longer in the list.');
    const bin = await this.binaries.resolve('yt-dlp');
    if (!bin) throw new Error('yt-dlp is not installed.');

    this.cancel(id);
    task.ytdlpFormat = formatId;
    task.engine = 'ytdlp';
    task.state = 'queued';
    task.error = '';
    task.downloaded = 0;
    task.progress = 0;
    task.formatLabel = (task.availableFormats || []).find((f) => f.id === formatId)?.label || formatId;
    this._touch(task);
    this._drain();
    return task;
  }

  shutdown() {
    clearInterval(this._pulse);
    for (const [, live] of this._live) {
      try { live.pause(); } catch { /* going away anyway */ }
    }
    this._persist();
    this.store.saveNow();
  }
}

module.exports = { DownloadManager };
