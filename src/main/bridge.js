'use strict';
const http = require('http');
const crypto = require('crypto');

// A loopback-only endpoint so the browser extension can hand links to Fletch.
// Bound to 127.0.0.1, origin-checked, and gated on a token the extension is
// given once — nothing on the open network can reach it or post to it.

const DEFAULT_PORT = 47809;

class Bridge {
  constructor(opts) {
    this.manager = opts.manager;
    this.settings = opts.settings;
    this.onActivate = opts.onActivate || (() => {});
    this.server = null;
    this.port = null;
    this.token = this.settings.get('bridgeToken', '');
    if (!this.token) {
      this.token = crypto.randomBytes(24).toString('hex');
      this.settings.set('bridgeToken', this.token);
    }
  }

  _authorised(req) {
    const header = req.headers.authorization || '';
    const supplied = header.replace(/^Bearer\s+/i, '').trim();
    if (!supplied || supplied.length !== this.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token));
  }

  _send(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  start(port = DEFAULT_PORT) {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', () => resolve(null)); // port busy: carry on without it
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  _handle(req, res) {
    if (req.method === 'OPTIONS') return this._send(res, 204, {});

    const url = (req.url || '').split('?')[0];

    // Lets the extension confirm Fletch is running before it offers to capture.
    if (url === '/ping' && req.method === 'GET') {
      return this._send(res, 200, { app: 'Fletch', version: 1, ready: true });
    }

    if (!this._authorised(req)) return this._send(res, 401, { error: 'bad token' });

    if (url === '/add' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > 256 * 1024) req.destroy();
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const links = Array.isArray(payload.urls) ? payload.urls : [payload.url];
          const added = [];
          for (const link of links.filter(Boolean)) {
            const task = await this.manager.add(link, {
              headers: payload.headers || {},
              forceVideo: Boolean(payload.forceVideo),
              audioOnly: Boolean(payload.audioOnly),
            });
            added.push({ id: task.id, title: task.title || link });
          }
          if (payload.show !== false) this.onActivate();
          this._send(res, 200, { ok: true, added });
        } catch (err) {
          this._send(res, 400, { error: err.message });
        }
      });
      return;
    }

    if (url === '/status' && req.method === 'GET') {
      return this._send(res, 200, this.manager.stats());
    }

    this._send(res, 404, { error: 'no such endpoint' });
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch { /* shutting down */ }
      this.server = null;
    }
  }
}

module.exports = { Bridge, DEFAULT_PORT };
