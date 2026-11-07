'use strict';
// Renders build/icon.png (1024x1024) from the same bubble the tray uses, on a
// rounded gradient tile, so the packaged app has an icon without any asset
// files checked in. electron-builder derives .icns and .ico from it.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const sd = (px, py, cx, cy, hw, hh, r) => { const dx = Math.abs(px - cx) - hw + r, dy = Math.abs(py - cy) - hh + r; return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r; };
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function render(S) {
  const out = Buffer.alloc(S * S * 4);
  const pad = S * 0.08, tileR = S * 0.22;                     // macOS-style rounded tile
  const bcx = S * 0.5, bcy = S * 0.46, bhw = S * 0.30, bhh = S * 0.21, br = S * 0.11;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const px = x + 0.5, py = y + 0.5;
    const tile = clamp01(0.5 - sd(px, py, S / 2, S / 2, S / 2 - pad, S / 2 - pad, tileR));
    // gradient: top-left #5b8cff -> bottom-right #6f6cff, slightly darker at the bottom
    const t = (px + py) / (2 * S), v = 1 - (py / S) * 0.18;
    let r = (91 + (111 - 91) * t) * v, g = (140 + (108 - 140) * t) * v, b = 255 * v;
    // bubble with tail, white
    let d = sd(px, py, bcx, bcy, bhw, bhh, br);
    const tx = px - S * 0.33, ty = py - (bcy + bhh);
    if (ty >= -1 && ty <= S * 0.11 && tx >= 0 && tx <= S * 0.11 - ty) d = Math.min(d, -Math.min(tx, (S * 0.11 - ty) - tx, 2) / 2);
    let a = clamp01(0.5 - d);
    for (let i = -1; i <= 1; i++) a *= clamp01(Math.hypot(px - (bcx + i * S * 0.14), py - bcy) - S * 0.04 + 0.5); // three dots cut out
    r = r + (255 - r) * a; g = g + (255 - g) * a; b = b + (255 - b) * a;
    const o = (y * S + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = Math.round(tile * 255);
  }
  return out;
}
const S = Number(process.argv[2]) || 1024;
const file = path.join(__dirname, 'icon.png');
fs.writeFileSync(file, png(S, S, render(S)));
console.log(`wrote ${file} (${S}x${S}, ${fs.statSync(file).size} bytes)`);
