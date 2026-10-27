'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * A tiny atomic JSON store. Writes go to a temp file and are renamed into
 * place, so a crash mid-save leaves the previous good copy rather than a
 * half-written one.
 */
class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = { ...defaults };
    this._queued = null;
    this._writing = false;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = { ...this.defaults, ...raw };
    } catch {
      this.data = { ...this.defaults };
    }
    return this.data;
  }

  get(key, fallback) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  merge(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  /** Coalesces bursts of writes; never runs two saves at once. */
  save() {
    if (this._writing) { this._queued = true; return; }
    this._writing = true;
    setTimeout(async () => {
      const snapshot = JSON.stringify(this.data, null, 2);
      const tmp = `${this.filePath}.tmp`;
      try {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await fsp.writeFile(tmp, snapshot);
        await fsp.rename(tmp, this.filePath);
      } catch {
        /* a dropped save costs at most the last few seconds of state */
      } finally {
        this._writing = false;
        if (this._queued) { this._queued = false; this.save(); }
      }
    }, 150);
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch { /* nothing useful to do on shutdown */ }
  }
}

module.exports = { JsonStore };
