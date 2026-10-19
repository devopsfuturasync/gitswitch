// Draws build/icon.png (512x512): a git branch on a blue-violet tile.
// Run with `node build/make-icon.js`; electron-builder turns it into the .ico.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const N = 512;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;

function roundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function segment(x, y, ax, ay, bx, by, r) {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const h = clamp((px * dx + py * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - dx * h, py - dy * h) - r;
}

const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

// Branch curve as short segments of a cubic bezier.
const curve = [];
const P = [[340, 236], [340, 300], [180, 290], [180, 352]];
for (let i = 0; i <= 24; i++) {
  const t = i / 24;
  const u = 1 - t;
  curve.push([
    u ** 3 * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t ** 3 * P[3][0],
    u ** 3 * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t ** 3 * P[3][1],
  ]);
}

function glyph(x, y) {
  let d = segment(x, y, 180, 140, 180, 372, 20);
  for (let i = 1; i < curve.length; i++) {
    d = Math.min(d, segment(x, y, curve[i - 1][0], curve[i - 1][1], curve[i][0], curve[i][1], 20));
  }
  const nodes = [[180, 140], [180, 372], [340, 196]];
  // Ring nodes: outer discs, then holes cut through discs and lines alike.
  for (const [cx, cy] of nodes) d = Math.min(d, circle(x, y, cx, cy, 46));
  for (const [cx, cy] of nodes) d = Math.max(d, -circle(x, y, cx, cy, 22));
  return d;
}

const px = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const sx = x + 0.5;
    const sy = y + 0.5;
    const bg = clamp(0.5 - roundedRect(sx, sy, 16, 16, N - 16, N - 16, 112));
    const fg = clamp(0.5 - glyph(sx, sy));
    const t = clamp((sx + sy) / (2 * N));
    // #2f6feb -> #8250df
    let r = mix(0x2f, 0x82, t);
    let g = mix(0x6f, 0x50, t);
    let b = mix(0xeb, 0xdf, t);
    r = mix(r, 255, fg);
    g = mix(g, 255, fg);
    b = mix(b, 255, fg);
    const i = (y * N + x) * 4;
    px[i] = Math.round(r);
    px[i + 1] = Math.round(g);
    px[i + 2] = Math.round(b);
    px[i + 3] = Math.round(255 * bg);
  }
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('wrote build/icon.png');
