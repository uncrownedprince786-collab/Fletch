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
    this._timer = null;
    // Bumped by saveNow(). An async save that started under an older
    // generation has been overtaken and must not land.
    this._generation = 0;
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
    const generation = this._generation;
    this._timer = setTimeout(async () => {
      this._timer = null;
      const snapshot = JSON.stringify(this.data, null, 2);
      const tmp = `${this.filePath}.tmp`;
      try {
        if (generation !== this._generation) return;
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await fsp.writeFile(tmp, snapshot);
        // saveNow() ran while this was writing: its copy is newer, so this
        // one is thrown away rather than renamed over it.
        if (generation !== this._generation) await fsp.rm(tmp, { force: true });
        else await fsp.rename(tmp, this.filePath);
      } catch {
        /* a dropped save costs at most the last few seconds of state */
      } finally {
        this._writing = false;
        // saveNow() clears the queue, so anything queued now is a change
        // made after it, and is owed a save of its own.
        if (this._queued) { this._queued = false; this.save(); }
      }
    }, 150);
  }

  /**
   * Write now, synchronously, and make it the last word: any save still
   * waiting is cancelled, and one already writing is discarded. Without that,
   * a save queued just before shutdown would land after it — overwriting the
   * newer copy with an older one, or writing into a folder already let go of.
   */
  saveNow() {
    this._generation++;
    this._queued = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      this._writing = false;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Its own temp name, so it cannot collide with an async save mid-write.
      const tmp = `${this.filePath}.final.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch { /* nothing useful to do on shutdown */ }
  }
}

module.exports = { JsonStore };
