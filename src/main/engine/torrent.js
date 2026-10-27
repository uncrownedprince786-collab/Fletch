'use strict';
const path = require('path');
const fsp = require('fs/promises');
const { EventEmitter } = require('events');

// WebTorrent ships as ESM, so it is pulled in with a dynamic import the first
// time a torrent is actually started. That keeps a fairly heavy dependency out
// of startup for the many people who never touch a magnet link.

let clientPromise = null;

async function getClient(opts = {}) {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { default: WebTorrent } = await import('webtorrent');
      return new WebTorrent({
        maxConns: Math.max(10, Math.min(200, opts.maxConns || 80)),
        dht: true,
        // Peer exchange and local discovery both widen the swarm, which is
        // most of what "as fast as possible" means for a torrent.
        lsd: true,
        utPex: true,
      });
    })();
  }
  return clientPromise;
}

async function destroyClient() {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = null;
  if (client) await new Promise((r) => client.destroy(() => r()));
}

function isTorrentSource(value) {
  const v = String(value || '').trim();
  if (/^magnet:\?/i.test(v)) return true;
  if (/^https?:\/\/\S+\.torrent(\?|$)/i.test(v)) return true;
  if (/\.torrent$/i.test(v) && !/^https?:/i.test(v)) return true;
  return false;
}

/** The display name a magnet carries, before any metadata arrives. */
function nameFromMagnet(uri) {
  const m = /[?&]dn=([^&]+)/i.exec(String(uri || ''));
  if (!m) return '';
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
}

// Extra trackers for magnets that arrive with none. All public and widely used;
// they only help peers find each other.
const FALLBACK_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'wss://tracker.openwebtorrent.com',
];

/**
 * One torrent, presented with the same shape as the HTTP and HLS downloaders
 * so the queue does not have to care which it is driving.
 */
class TorrentDownload extends EventEmitter {
  constructor(spec) {
    super();
    this.source = spec.url;
    this.dir = spec.dir;
    this.maxConns = spec.maxConns || 80;
    this.addPeers = spec.addPeers || [];
    this.announce = spec.announce;
    this.metadataTimeout = spec.metadataTimeout || 90000;

    this.state = 'idle';
    this.downloaded = 0;
    this.size = null;
    this.speed = 0;
    this.progressRatio = 0;
    this.peers = 0;
    this.filePath = '';

    this.torrent = null;
    this._stop = null;
    this._tick = null;
    this._settle = null;
  }

  get progress() { return this.progressRatio; }
  get eta() {
    if (!this.torrent || !this.size || this.speed <= 0) return null;
    const left = this.size - this.downloaded;
    return left <= 0 ? 0 : left / this.speed;
  }

  pause() {
    this._stop = 'paused';
    this.state = 'paused';
    if (this.torrent) try { this.torrent.pause(); } catch { /* going away */ }
    if (this._settle) this._settle({ paused: true });
  }

  cancel() {
    this._stop = 'cancelled';
    this.state = 'cancelled';
    this._teardown(true);
    if (this._settle) this._settle({ cancelled: true });
  }

  async _teardown(destroyStore) {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this._peerTimer) { clearInterval(this._peerTimer); this._peerTimer = null; }
    const t = this.torrent;
    this.torrent = null;
    if (!t) return;
    try {
      const client = await getClient({ maxConns: this.maxConns });
      await new Promise((r) => client.remove(t, { destroyStore }, () => r()));
    } catch { /* already gone */ }
  }

  async start() {
    this.state = 'running';
    this._stop = null;
    await fsp.mkdir(this.dir, { recursive: true });

    const client = await getClient({ maxConns: this.maxConns });

    const existing = client.torrents.find((t) => t.magnetURI === this.source || t.infoHash === this.source);
    const torrent = existing || client.add(this.source, {
      path: this.dir,
      announce: this.announce || FALLBACK_TRACKERS,
    });
    this.torrent = torrent;

    // Manually supplied peers have to be offered once the torrent has an
    // infoHash and a swarm to put them in; offering them earlier is a no-op.
    // They are re-offered until one sticks, since a refused connection during
    // startup is common and silent.
    if (this.addPeers.length) {
      const offer = () => {
        for (const peer of this.addPeers) {
          try { torrent.addPeer(peer); } catch { /* bad address, carry on */ }
        }
      };
      if (torrent.infoHash) offer();
      else torrent.once('infoHash', offer);
      this._peerTimer = setInterval(() => {
        if (!this.torrent || this.torrent.numPeers > 0 || this._stop) {
          clearInterval(this._peerTimer);
          this._peerTimer = null;
          return;
        }
        offer();
      }, 2000);
    }

    this._tick = setInterval(() => this._emit(), 500);

    const result = await new Promise((resolve, reject) => {
      this._settle = resolve;
      let gotMetadata = false;

      // A magnet with no reachable peers would otherwise hang indefinitely.
      const metaTimer = setTimeout(() => {
        if (!gotMetadata && !this._stop) {
          reject(new Error(
            'No peers answered within '
            + `${Math.round(this.metadataTimeout / 1000)}s, so the torrent details never arrived. `
            + 'The link may be dead, or your network may be blocking peer traffic.'
          ));
        }
      }, this.metadataTimeout);

      const onMetadata = () => {
        gotMetadata = true;
        clearTimeout(metaTimer);
        this.size = torrent.length;
        this.emit('stage', '');
        this.emit('meta', {
          name: torrent.name,
          size: torrent.length,
          files: torrent.files.map((f) => ({ name: f.name, size: f.length })),
        });
      };

      if (torrent.metadata || torrent.files.length) onMetadata();
      else {
        this.emit('stage', 'Finding peers…');
        torrent.once('metadata', onMetadata);
      }

      torrent.once('done', () => {
        clearTimeout(metaTimer);
        resolve({ done: true });
      });
      torrent.once('error', (err) => {
        clearTimeout(metaTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    }).finally(() => { this._settle = null; });

    if (this._tick) { clearInterval(this._tick); this._tick = null; }

    if (result && result.cancelled) return { cancelled: true };
    if (result && result.paused) { this.speed = 0; this._emit(); return { paused: true }; }

    // Where the finished data actually landed.
    const biggest = torrent.files.slice().sort((a, b) => b.length - a.length)[0];
    this.filePath = torrent.files.length > 1
      ? path.join(this.dir, torrent.name)
      : path.join(this.dir, biggest ? biggest.path : torrent.name);

    this.size = torrent.length;
    this.downloaded = torrent.length;
    this.progressRatio = 1;
    this.state = 'done';
    this.speed = 0;
    this._emit();

    // Keep seeding until the queue tells us otherwise; the manager decides.
    this.emit('done', {
      filePath: this.filePath,
      size: torrent.length,
      name: torrent.name,
      files: torrent.files.length,
    });
    return { filePath: this.filePath, size: torrent.length };
  }

  /** Stop sharing and release the torrent, keeping the downloaded files. */
  async stopSeeding() {
    await this._teardown(false);
  }

  /** The piece bitfield, folded into blocks the progress bar can draw. */
  _pieceBlocks(buckets = 36) {
    const t = this.torrent;
    if (!t || !t.pieces || !t.bitfield) return [];
    const total = t.pieces.length;
    if (!total) return [];
    const per = Math.max(1, Math.ceil(total / buckets));
    const out = [];
    for (let start = 0; start < total; start += per) {
      const end = Math.min(total, start + per);
      let have = 0;
      for (let i = start; i < end; i++) if (t.bitfield.get(i)) have++;
      out.push({ start, end: end - 1, pos: start + have, done: have / (end - start), state: 'active' });
    }
    return out;
  }

  _emit() {
    const t = this.torrent;
    if (t) {
      this.downloaded = t.downloaded;
      this.size = t.length || this.size;
      this.speed = t.downloadSpeed || 0;
      this.progressRatio = t.progress || 0;
      this.peers = t.numPeers || 0;
    }
    this.emit('progress', {
      downloaded: this.downloaded,
      size: this.size,
      speed: this.speed,
      progress: this.progressRatio,
      eta: this.eta,
      connections: this.peers,
      segments: this._pieceBlocks(),
      note: this.peers
        ? `${this.peers} peer${this.peers === 1 ? '' : 's'}`
        : 'looking for peers',
    });
  }
}

module.exports = { TorrentDownload, isTorrentSource, nameFromMagnet, destroyClient, FALLBACK_TRACKERS };
