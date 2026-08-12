// Generates the extension icons with no image dependencies.
// A frame outline with a gap in it: a frame that was not closed.

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size) {
  const bg = [17, 20, 24];
  const fg = [124, 214, 255];
  const accent = [255, 122, 122];

  const raw = Buffer.alloc(size * (size * 4 + 1));
  const t = Math.max(2, Math.round(size / 16)); // stroke
  const m = Math.round(size / 5); // margin
  const gapFrom = Math.round(size * 0.55);
  const gapTo = Math.round(size * 0.8);

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const onVertical = (x >= m && x < m + t) || (x >= size - m - t && x < size - m);
      const onHorizontal = (y >= m && y < m + t) || (y >= size - m - t && y < size - m);
      const inBox = x >= m && x < size - m && y >= m && y < size - m;
      let edge = inBox && (onVertical || onHorizontal);

      // The gap: the missing close().
      const inGap = y >= gapFrom && y < gapTo && x >= size - m - t && x < size - m;
      if (inGap) edge = false;

      // A dot marking where the leak escapes.
      const dx = x - (size - m);
      const dy = y - Math.round((gapFrom + gapTo) / 2);
      const isDot = dx * dx + dy * dy <= (t * 1.4) ** 2;

      const [r, g, b] = isDot ? accent : edge ? fg : bg;
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir('icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(`icons/icon${size}.png`, png(size));
}
console.log('icons written: 16, 32, 48, 128');
