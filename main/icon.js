'use strict';
// Draws the tray / menu-bar icon at runtime, so the app ships no image files.
// A speech bubble, black with alpha: macOS treats it as a template image and
// recolors it for light and dark menu bars; Windows gets a white version.
const zlib = require('node:zlib');
const { nativeImage } = require('electron');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distance to a rounded rectangle, used for anti-aliased edges.
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - hw + r, dy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

function bubble(size, color) {
  const s = size, out = Buffer.alloc(s * s * 4);
  const cx = s * 0.5, cy = s * 0.44, hw = s * 0.40, hh = s * 0.30, r = s * 0.16;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const px = x + 0.5, py = y + 0.5;
    let d = sdRoundRect(px, py, cx, cy, hw, hh, r);
    // tail: a small triangle under the lower-left
    const tx = px - s * 0.30, ty = py - (cy + hh);
    if (ty >= -1 && ty <= s * 0.18 && tx >= 0 && tx <= s * 0.18 - ty) d = Math.min(d, 0.0 - Math.min(tx, (s * 0.18 - ty) - tx, 1));
    let a = Math.max(0, Math.min(1, 0.5 - d));
    // three dots cut out
    for (let i = -1; i <= 1; i++) {
      const dd = Math.hypot(px - (cx + i * s * 0.2), py - cy) - s * 0.055;
      a *= Math.max(0, Math.min(1, dd + 0.5));
    }
    const o = (y * s + x) * 4;
    out[o] = color[0]; out[o + 1] = color[1]; out[o + 2] = color[2]; out[o + 3] = Math.round(a * 255);
  }
  return out;
}

function trayIcon(platform) {
  const color = platform === 'darwin' ? [0, 0, 0] : [255, 255, 255];
  const img = nativeImage.createEmpty();
  for (const [scale, size] of [[1, 22], [2, 44]]) img.addRepresentation({ scaleFactor: scale, buffer: png(size, size, bubble(size, color)) });
  if (platform === 'darwin') img.setTemplateImage(true);
  return img;
}

module.exports = { trayIcon };
