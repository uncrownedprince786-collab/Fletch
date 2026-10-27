'use strict';
const http = require('http');
const crypto = require('crypto');

// A loopback-only endpoint so the browser extension can hand links to Fletch.
// Bound to 127.0.0.1, origin-checked, and gated on a token the extension is
// given once — nothing on the open network can reach it or post to it.

const DEFAULT_PORT = 47809;

// The extension's identity is fixed by the public key in its manifest, so the
// browser always gives it this id. Pairing can therefore happen by itself:
// the app hands the token to a caller the browser vouches for, and the user
// never has to copy anything.
//
// A web page cannot forge an Origin header — the browser sets it — so this
// does not open the endpoint up to the internet. A malicious program already
// running on the machine could claim the origin, but it would not need Fletch
// to do anything it could not already do itself.
const TRUSTED_EXTENSIONS = new Set([
  'lmaaeoobpbmcgnaelmpakgnhbhaoejim', // Fletch Capture
]);

function extensionIdFrom(origin) {
  const m = /^chrome-extension:\/\/([a-p]{32})$/i.exec(String(origin || '').trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Decide whether a request really came from the Fletch extension.
 *
 * Chrome does not reliably put an Origin on a fetch made from an extension's
 * service worker — with host permissions there is no CORS to satisfy, so the
 * header is often simply absent. Requiring it meant the extension could never
 * pair, while curl, which sends it, worked perfectly.
 *
 * The rule that holds either way: a browser ALWAYS sets Origin on a page's
 * cross-origin request. So an Origin naming a web site is a page and is
 * refused outright, and a request with no Origin cannot be a page at all —
 * for those, the extension names itself in a header instead.
 */
function identifyCaller(req) {
  const origin = String(req.headers.origin || '').trim();

  if (origin) {
    const id = extensionIdFrom(origin);
    if (id) return { kind: 'extension', id, origin };
    return { kind: 'web', origin }; // a page; never trusted
  }

  const claimed = String(req.headers['x-fletch-extension'] || '').trim().toLowerCase();
  if (/^[a-p]{32}$/.test(claimed)) return { kind: 'extension', id: claimed, origin: '' };
  return { kind: 'unknown', origin: '' };
}

class Bridge {
  constructor(opts) {
    this.manager = opts.manager;
    this.settings = opts.settings;
    this.onActivate = opts.onActivate || (() => {});
    this.onPaired = opts.onPaired || (() => {});
    this.server = null;
    this.port = null;
    this.token = this.settings.get('bridgeToken', '');
    if (!this.token) {
      this.token = crypto.randomBytes(24).toString('hex');
      this.settings.set('bridgeToken', this.token);
    }
  }

  /** True when the caller is the paired extension, by token or by identity. */
  _authorised(req) {
    const header = req.headers.authorization || '';
    const supplied = header.replace(/^Bearer\s+/i, '').trim();
    if (supplied && supplied.length === this.token.length
      && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) {
      return true;
    }
    // A request the browser itself stamps as coming from our extension is as
    // good as the token, and is what lets pairing happen without the user.
    return this._trustedExtension(req);
  }

  _trustedExtension(req) {
    const who = identifyCaller(req);
    return who.kind === 'extension' && TRUSTED_EXTENSIONS.has(who.id);
  }

  _send(res, code, payload, origin) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': origin || '*',
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
    const origin = req.headers.origin;
    const echo = this._trustedExtension(req) ? origin : undefined;

    if (req.method === 'OPTIONS') return this._send(res, 204, {}, echo);

    const url = (req.url || '').split('?')[0];

    // Lets the extension confirm Fletch is running before it offers to capture.
    if (url === '/ping' && req.method === 'GET') {
      return this._send(res, 200, { app: 'Fletch', version: 1, ready: true }, echo);
    }

    // Automatic pairing. The extension asks once and gets the token, so the
    // user never has to copy it across by hand.
    if (url === '/pair' && req.method === 'GET') {
      if (!this._trustedExtension(req)) {
        return this._send(res, 403, {
          error: 'Pairing is only offered to the Fletch browser extension.',
        }, echo);
      }
      this.onPaired();
      return this._send(res, 200, { token: this.token, port: this.port }, echo);
    }

    if (!this._authorised(req)) return this._send(res, 401, { error: 'bad token' }, echo);

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
              // The browser's session for this one site, so Fletch is not
              // turned away while the browser is signed in.
              cookies: Array.isArray(payload.cookies) ? payload.cookies : null,
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
