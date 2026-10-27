'use strict';
const { EventEmitter } = require('events');

// Updates come from GitHub Releases. Push a release with the installer attached
// and every copy of Fletch notices within a few hours, or on next launch.
//
// Nothing is installed behind the user's back: Fletch downloads the update and
// then asks. Declining leaves the current version exactly as it was.

const SIX_HOURS = 6 * 60 * 60 * 1000;

class Updater extends EventEmitter {
  constructor({ app, settings, logger }) {
    super();
    this.app = app;
    this.settings = settings;
    this.log = logger || (() => {});
    this.state = 'idle';     // idle | checking | available | downloading | ready | error
    this.info = null;
    this.progress = 0;
    this.error = '';
    this.timer = null;
    this._api = null;
  }

  get currentVersion() { return this.app.getVersion(); }

  /** Whether an update check could possibly work from here. */
  get usable() {
    // electron-updater needs a packaged app with an update feed beside it.
    return this.app.isPackaged;
  }

  _load() {
    if (this._api) return this._api;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;          // ask before using someone's bandwidth
    autoUpdater.autoInstallOnAppQuit = false;  // and before replacing their app
    autoUpdater.allowPrerelease = Boolean(this.settings.get('updatePrerelease', false));

    autoUpdater.on('checking-for-update', () => {
      this.state = 'checking';
      this._announce();
    });
    autoUpdater.on('update-available', (info) => {
      this.state = 'available';
      this.info = { version: info.version, notes: trimNotes(info.releaseNotes), date: info.releaseDate };
      this._announce();
    });
    autoUpdater.on('update-not-available', () => {
      this.state = 'idle';
      this.info = null;
      this._announce();
    });
    autoUpdater.on('download-progress', (p) => {
      this.state = 'downloading';
      this.progress = (p.percent || 0) / 100;
      this.bytesPerSecond = p.bytesPerSecond || 0;
      this._announce();
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.state = 'ready';
      this.progress = 1;
      this.info = { version: info.version, notes: trimNotes(info.releaseNotes), date: info.releaseDate };
      this._announce();
    });
    autoUpdater.on('error', (err) => {
      this.state = 'error';
      // A missing feed is the normal case before the first release is published,
      // and is not worth shouting about.
      this.error = String((err && err.message) || err);
      this._announce();
    });

    this._api = autoUpdater;
    return autoUpdater;
  }

  _announce() {
    this.emit('status', this.status());
  }

  status() {
    return {
      state: this.state,
      usable: this.usable,
      current: this.currentVersion,
      info: this.info,
      progress: this.progress,
      bytesPerSecond: this.bytesPerSecond || 0,
      error: this.error,
      enabled: this.settings.get('autoUpdate', true),
    };
  }

  /** Check once. `silent` keeps a failure out of the user's face. */
  async check(silent = true) {
    if (!this.usable) {
      if (!silent) {
        this.state = 'error';
        this.error = 'Update checks only work in an installed copy of Fletch, not when run from source.';
        this._announce();
      }
      return null;
    }
    try {
      const api = this._load();
      const result = await api.checkForUpdates();
      return result ? result.updateInfo : null;
    } catch (err) {
      this.state = silent ? 'idle' : 'error';
      this.error = String((err && err.message) || err);
      this._announce();
      return null;
    }
  }

  async download() {
    if (!this.usable) throw new Error('Nothing to download: this is not an installed copy.');
    const api = this._load();
    this.state = 'downloading';
    this.progress = 0;
    this._announce();
    await api.downloadUpdate();
  }

  /** Replace this version and come back. Only ever called from a user click. */
  install() {
    if (this.state !== 'ready') throw new Error('No update has finished downloading yet.');
    const api = this._load();
    setImmediate(() => api.quitAndInstall(false, true));
  }

  /** Check shortly after launch, then quietly every few hours. */
  startBackgroundChecks() {
    if (!this.usable) return;
    const run = () => {
      if (!this.settings.get('autoUpdate', true)) return;
      this.check(true).catch(() => {});
    };
    setTimeout(run, 20000).unref?.();
    this.timer = setInterval(run, SIX_HOURS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Release notes arrive as HTML or as an array; reduce them to short plain text. */
function trimNotes(notes) {
  if (!notes) return '';
  const text = Array.isArray(notes)
    ? notes.map((n) => (typeof n === 'string' ? n : n.note || '')).join('\n')
    : String(notes);
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

module.exports = { Updater };
