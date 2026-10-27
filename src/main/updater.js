'use strict';
const { EventEmitter } = require('events');
const https = require('https');
const http = require('http');

// Updates come from GitHub Releases. Push a release with the installer attached
// and every copy of Fletch notices within a few hours, or on next launch.
//
// Nothing is installed behind the user's back: Fletch downloads the update and
// then asks. Declining leaves the current version exactly as it was.

const SIX_HOURS = 6 * 60 * 60 * 1000;

// Most updates are an offer. A few cannot be: when a published version turns
// out to do harm, leaving the choice to the user means everyone who never
// opens the window keeps running it. This file names the versions that are no
// longer fit to run. It is fetched rather than built in, so a copy already out
// in the world can be told after the fact.
const POLICY_URL = 'https://raw.githubusercontent.com/uncrownedprince786-collab/Fletch/main/release-policy.json';
const POLICY_TIMEOUT = 8000;
const POLICY_MAX = 16 * 1024;

/** -1, 0 or 1 over dotted versions. Anything unreadable sorts as 0.0.0. */
function compareVersions(a, b) {
  const parts = (v) => String(v || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function olderThan(version, floor) {
  return Boolean(floor) && compareVersions(version, floor) < 0;
}

/**
 * Read the policy file. Never throws and never waits long: a check that does
 * not come back is simply a check that did not happen, and the app carries on
 * as it was.
 */
function fetchPolicy(url = POLICY_URL) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const client = String(url).startsWith('http://') ? http : https;
      const req = client.get(url, { headers: { Accept: 'application/json' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(null); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > POLICY_MAX) { req.destroy(); done(null); }
        });
        res.on('end', () => {
          try { done(JSON.parse(body)); } catch { done(null); }
        });
        return undefined;
      });
      req.setTimeout(POLICY_TIMEOUT, () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
    } catch {
      done(null);
    }
  });
}

class Updater extends EventEmitter {
  constructor({ app, settings, logger, policyUrl }) {
    super();
    this.app = app;
    this.settings = settings;
    this.log = logger || (() => {});
    // Overridable so the policy can be served from somewhere else in a test
    // or a staging build. Production passes nothing and uses the real file.
    this.policyUrl = policyUrl || POLICY_URL;
    this.state = 'idle';     // idle | checking | available | downloading | ready | error
    this.info = null;
    this.progress = 0;
    this.error = '';
    this.timer = null;
    this._api = null;
    this.policy = null;
    this.extensionVersion = '';
    this.installerState = '';  // '' | 'fetching' | 'failed'
    this.installerError = '';
  }

  get currentVersion() { return this.app.getVersion(); }

  /**
   * How the replacement installer is getting on.
   *
   * Held here rather than in the window, because the screen is redrawn from
   * this status on every event: a note kept only in the renderer would be
   * wiped by the next one, and the user would be looking at a button that
   * offered to start a download already running.
   */
  markInstaller(state, error = '') {
    this.installerState = state;
    this.installerError = error;
    this._announce();
  }

  /** The installer to fetch when this copy cannot replace itself. */
  get installerUrl() { return (this.policy && this.policy.installerUrl) || ''; }

  /** This copy is one the policy says must be replaced. */
  get required() {
    return olderThan(this.currentVersion, this.policy && this.policy.minimumVersion);
  }

  /** The browser is still running an extension older than this app expects. */
  get extensionOutdated() {
    if (!this.extensionVersion) return false; // not seen yet; nothing to claim
    return olderThan(this.extensionVersion, this.policy && this.policy.minimumExtensionVersion);
  }

  /** What the extension last said its version was, on any call it made. */
  noteExtension(version) {
    const seen = String(version || '0.0.0').trim();
    if (!seen || seen === this.extensionVersion) return;
    this.extensionVersion = seen;
    this._announce();
  }

  /**
   * Read the policy and act on it.
   *
   * A version held back for a reason does not wait to be noticed: it fetches
   * its replacement at once, so the only thing left to ask for is the restart.
   */
  async checkPolicy() {
    const policy = await fetchPolicy(this.policyUrl);
    if (policy && typeof policy === 'object') this.policy = policy;
    this._announce();
    if (!this.required || !this.usable) return this.policy;
    if (this.state === 'downloading' || this.state === 'ready') return this.policy;
    try {
      const api = this._load();
      api.autoDownload = true; // there is nothing worth asking: this copy must go
      this.check(true).catch(() => {});
    } catch { /* no feed reachable; the window still says what is wrong */ }
    return this.policy;
  }

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
      required: this.required,
      reason: (this.policy && this.policy.reason) || '',
      minimumVersion: (this.policy && this.policy.minimumVersion) || '',
      downloadUrl: (this.policy && this.policy.downloadUrl) || '',
      installerUrl: (this.policy && this.policy.installerUrl) || '',
      installerState: this.installerState,
      installerError: this.installerError,
      extensionVersion: this.extensionVersion,
      extensionOutdated: this.extensionOutdated,
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
    const refresh = () => { this.checkPolicy().catch(() => {}); };
    const run = () => {
      if (!this.usable) return;
      // A required update is not subject to the preference. Switching updates
      // off is a choice about convenience, not a licence to keep running a
      // version that was withdrawn.
      if (!this.settings.get('autoUpdate', true) && !this.required) return;
      this.check(true).catch(() => {});
    };
    // The policy is read straight away. A copy that should not be running does
    // not get to wait six hours to find out.
    refresh();
    setTimeout(run, 20000).unref?.();
    this.timer = setInterval(() => { refresh(); run(); }, SIX_HOURS);
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

module.exports = { Updater, compareVersions, olderThan, fetchPolicy };
