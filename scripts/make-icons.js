'use strict';
/*
 * Draws the Fletch mark straight into pixels and writes PNG and ICO files.
 *
 * Rasterising an SVG would mean pulling in a rendering library just to produce
 * four small images, so the mark is described here as signed-distance fields
 * instead: a rounded square and three thick polylines. Coverage is sampled
 * analytically from the distance, which gives clean antialiasing at every size
 * including the 16px tray icon.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');

// ---- geometry, in the 64x64 space the SVG uses --------------------------

const CHEVRONS = [
  [[13, 18], [32, 30], [51, 18]],
  [[19, 30], [32, 40], [45, 30]],
  [[25, 41], [32, 48], [39, 41]],
];
const STROKE = 5 / 2; // half-width; round caps and joins come free with SDF

function sdRoundRect(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - (w / 2 - r);
  const qy = Math.abs(py - h / 2) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return Math.sqrt(dx * dx + dy * dy);
}

function sdChevrons(px, py) {
  let d = Infinity;
  for (const pts of CHEVRONS) {
    for (let i = 0; i < pts.length - 1; i++) {
      d = Math.min(d, sdSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
    }
  }
  return d - STROKE;
}

// The badge gradient, matching assets/icon.svg.
const G0 = [0xFF, 0xC2, 0x4B];
const G1 = [0xFF, 0x9A, 0x2E];
const G2 = [0xFF, 0x5F, 0x3D];
const INK = [0x1A, 0x10, 0x05];

function gradient(t) {
  t = Math.max(0, Math.min(1, t));
  const [a, b, lo, hi] = t < 0.55 ? [G0, G1, 0, 0.55] : [G1, G2, 0.55, 1];
  const k = (t - lo) / (hi - lo);
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k));
}

/** Coverage from a distance field: 1 inside, 0 outside, smooth across one pixel. */
function cover(d, px) {
  return Math.max(0, Math.min(1, 0.5 - d / px));
}

/**
 * The menu-bar mark for macOS: the chevrons alone, in black on transparent.
 * macOS recolours a "template" image itself to suit light/dark menu bars and
 * highlight state, so a coloured badge would look wrong up there.
 */
function renderTrayTemplate(size) {
  const scale = size / 64;
  const pixel = 1 / scale;
  const buf = Buffer.alloc(size * size * 4);
  // The badge is dropped, so lift the glyph to fill the square instead.
  const inset = 6;
  const span = 64 - inset * 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = ((x + 0.5) / scale - inset) * (64 / span);
      const sy = ((y + 0.5) / scale - inset) * (64 / span);
      const a = cover(sdChevrons(sx, sy), pixel * (64 / span));
      if (a <= 0) continue;
      const i = (y * size + x) * 4;
      buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0;
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

function renderRGBA(size) {
  const scale = size / 64;
  const pixel = 1 / scale; // one output pixel, measured in SVG units
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = (x + 0.5) / scale;
      const sy = (y + 0.5) / scale;

      const badge = cover(sdRoundRect(sx, sy, 64, 64, 16), pixel);
      if (badge <= 0) continue;

      const [r, g, b] = gradient((sx / 64) * 0.5 + (sy / 64) * 0.5);
      const ink = cover(sdChevrons(sx, sy), pixel) * 0.92;

      const i = (y * size + x) * 4;
      buf[i] = Math.round(r + (INK[0] - r) * ink);
      buf[i + 1] = Math.round(g + (INK[1] - g) * ink);
      buf[i + 2] = Math.round(b + (INK[2] - b) * ink);
      buf[i + 3] = Math.round(badge * 255);
    }
  }
  return buf;
}

// ---- PNG encoding -------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const stride = size * 4;
  // One filter byte per scanline; filter 0 (none) keeps this simple and the
  // images are tiny, so the extra bytes cost nothing.
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * ICNS for macOS. Same idea as ICO: a flat container of PNGs, each tagged with
 * a four-character type that tells macOS which slot it fills.
 */
const ICNS_TYPES = {
  16: 'icp4', 32: 'icp5', 64: 'icp6',
  128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10',
};

function encodeIcns(pngs) {
  const entries = [];
  for (const { size, data } of pngs) {
    const type = ICNS_TYPES[size];
    if (!type) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    entries.push(head, data);
  }
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/** ICO, with each entry stored as an embedded PNG (allowed since Vista). */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;      // 0 means 256
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0;                        // palette
    dir[o + 3] = 0;                        // reserved
    dir.writeUInt16LE(1, o + 4);           // colour planes
    dir.writeUInt16LE(32, o + 6);          // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

// ---- go -----------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pngs = sizes.map((size) => ({ size, data: encodePng(renderRGBA(size), size) }));
const by = Object.fromEntries(pngs.map((p) => [p.size, p.data]));

fs.writeFileSync(path.join(OUT, 'icon.png'), by[512]);       // Linux wants 512
fs.writeFileSync(path.join(OUT, 'tray.png'), by[32]);
fs.writeFileSync(path.join(OUT, 'icon@2x.png'), by[128]);
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(pngs.filter((p) => p.size <= 256)));
fs.writeFileSync(path.join(OUT, 'icon.icns'), encodeIcns(pngs));

// Electron treats any image whose filename ends in "Template" as a macOS
// template image, so the name here is load-bearing.
fs.writeFileSync(path.join(OUT, 'trayTemplate.png'), encodePng(renderTrayTemplate(16), 16));
fs.writeFileSync(path.join(OUT, 'trayTemplate@2x.png'), encodePng(renderTrayTemplate(32), 32));

const kb = (f) => `${Math.round(fs.statSync(path.join(OUT, f)).size / 1024)} KB`;
console.log(`wrote icon.png 512 (${kb('icon.png')}), icon@2x.png 128, tray.png 32,`);
console.log(`      icon.ico 7 sizes (${kb('icon.ico')}), icon.icns 7 sizes (${kb('icon.icns')})`);
