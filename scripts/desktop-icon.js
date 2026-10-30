// The Hypernab mark: a capital "H" whose right stem ends in a download arrow. Flat, two colours, drawn on a 256 grid.
// Every size is rendered straight from the geometry (not scaled down from a big bitmap), so small icons stay crisp.
// Writes: desktop/icon.svg|png|ico, desktop/icon-32.png (tray), extension/icons/icon-*.png, public/icon.svg.
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';

const TILE = [0xb6, 0xf3, 0x6b], MARK = [0x14, 0x20, 0x10]; // the app's accent and ink colours
// A capital "H" whose right stem ends in the download arrow.
const DX = -12, DY = -2; // optical centring of the whole mark
export const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect x="8" y="8" width="240" height="240" rx="52" fill="#b6f36b"/>'
  + `<g fill="#142010" transform="translate(${DX} ${DY})"><rect x="70" y="58" width="30" height="140"/><rect x="100" y="113" width="56" height="30"/>`
  + '<rect x="156" y="58" width="30" height="92"/><path d="M131 148H211L171 202Z"/></g></svg>\n';

function inTile(x, y) {
  const r = 52, dx = Math.max(8 + r - x, x - (248 - r), 0), dy = Math.max(8 + r - y, y - (248 - r), 0);
  return x >= 8 && x <= 248 && y >= 8 && y <= 248 && dx * dx + dy * dy <= r * r;
}
function inMark(x, y) {
  x -= DX; y -= DY;
  if (x >= 70 && x <= 100 && y >= 58 && y <= 198) return true; // left stem
  if (x >= 100 && x <= 156 && y >= 113 && y <= 143) return true; // crossbar
  if (x >= 156 && x <= 186 && y >= 58 && y <= 150) return true; // right stem
  if (y >= 148 && y <= 202) { const half = 40 * (202 - y) / 54; return Math.abs(x - 171) <= half; } // arrow head
  return false;
}
export function render(size) {
  const n = size <= 48 ? 8 : 4, scale = 256 / size, row = size * 4 + 1, pixels = Buffer.alloc(row * size);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let tile = 0, mark = 0;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
      const x = (px + (sx + 0.5) / n) * scale, y = (py + (sy + 0.5) / n) * scale;
      if (inTile(x, y)) { tile++; if (inMark(x, y)) mark++; }
    }
    const alpha = tile / (n * n), ink = tile ? mark / tile : 0;
    const colour = TILE.map((c, i) => Math.round(c + (MARK[i] - c) * ink));
    pixels.set([...colour, Math.round(alpha * 255)], py * row + 1 + px * 4);
  }
  return png(size, pixels);
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, body, tail]);
}
function png(size, pixels) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(sizes) {
  const images = sizes.map(render), header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i; header[at] = size >= 256 ? 0 : size; header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(images[i].length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}
const out = name => new URL(`../${name}`, import.meta.url);
fs.mkdirSync(out('extension/icons'), { recursive: true });
fs.writeFileSync(out('desktop/icon.svg'), svg);
fs.writeFileSync(out('public/icon.svg'), svg);
fs.writeFileSync(out('desktop/icon.png'), render(256));
fs.writeFileSync(out('desktop/icon-32.png'), render(32));
fs.writeFileSync(out('desktop/icon.ico'), ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
for (const size of [16, 32, 48, 96, 128]) fs.writeFileSync(out(`extension/icons/icon-${size}.png`), render(size));
