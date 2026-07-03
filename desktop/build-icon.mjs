// Downscales the source artwork (Prismaxim-noname.png at the repo root) into a
// multi-resolution Windows icon (build/icon.ico) plus PNGs for the running window /
// other platforms. It only resizes — it never generates new art. Run: node build-icon.mjs
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, 'build');
mkdirSync(buildDir, { recursive: true });

const source = readFileSync(join(here, '..', 'Prismaxim-noname.png'));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// The full 1254px art has lots of empty space, so it turns muddy at tiny sizes.
// For small icons, crop tight to the prism (flare + rainbow) so it stays legible.
// Larger sizes keep the full framed composition.
const PRISM_CROP = { left: 265, top: 265, width: 700, height: 700 };
const CROP_AT_OR_BELOW = 32;

// Downscale the source to each icon size (high-quality Lanczos, no re-rendering).
const render = (size) => {
  const img = sharp(source);
  if (size <= CROP_AT_OR_BELOW) img.extract(PRISM_CROP);
  return img.resize(size, size, { fit: 'cover' }).png().toBuffer();
};

const pngs = await Promise.all(SIZES.map(render));

// Standalone PNGs (window icon / Linux / previews).
writeFileSync(join(buildDir, 'icon.png'), await render(512));
writeFileSync(join(buildDir, 'icon-256.png'), pngs[SIZES.indexOf(256)]);

// Pack PNG entries into an .ico container (Windows Vista+ supports PNG-compressed icons).
function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = [];
  const bodies = [];
  let offset = 6 + entries.length * 16;
  for (const { size, buf } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette colors
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8); // image byte size
    e.writeUInt32LE(offset, 12); // image byte offset
    dir.push(e);
    bodies.push(buf);
    offset += buf.length;
  }
  return Buffer.concat([header, ...dir, ...bodies]);
}

const ico = packIco(SIZES.map((size, i) => ({ size, buf: pngs[i] })));
writeFileSync(join(buildDir, 'icon.ico'), ico);
console.log(`icon.ico  ${ico.length} bytes  (${SIZES.join(', ')} px)`);
console.log('icon.png  512 px');
