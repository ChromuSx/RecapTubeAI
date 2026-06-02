// process-logos.js — take the user-provided RecapTube logos, remove the white
// background (flood-fill from the edges so white *inside* the logo is kept),
// then emit a transparent logo.png + extension icons.
//
// Usage: node process-logos.js
import sharp from 'sharp';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = 'C:\\Users\\Giovanni Guarino\\Desktop\\Nuova cartella';
const OUT_ICONS = join(__dirname, 'src', 'icons');
const OUT_LOGO = join(__dirname, 'src', 'logo.png');
const OUT_WORDMARK = join(__dirname, 'src', 'logo-wordmark.png');

/**
 * Remove the white background by flood-filling inward from every edge.
 * Only white pixels connected to the border become transparent, so white
 * details enclosed by the dark logo body are preserved.
 * Soft edges: pixels near the white→dark transition get partial alpha.
 * @returns {Promise<Buffer>} PNG buffer (RGBA, transparent background)
 */
async function removeWhiteBg(inputPath) {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info; // channels = 4
  const N = width * height;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const o = i * channels;
    // perceived luminance
    lum[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }

  const HARD = 244; // >= this = definitely background white
  const SOFT = 200; // [SOFT, HARD) = transition band (anti-alias edge)
  const isBgCandidate = (i) => lum[i] >= SOFT;

  const bg = new Uint8Array(N); // 1 = background (flood-reached)
  const stack = [];
  const pushIf = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (!bg[i] && isBgCandidate(i)) { bg[i] = 1; stack.push(i); }
  };
  // Seed from all four borders
  for (let x = 0; x < width; x++) { pushIf(x, 0); pushIf(x, height - 1); }
  for (let y = 0; y < height; y++) { pushIf(0, y); pushIf(width - 1, y); }
  // 4-neighbour flood
  while (stack.length) {
    const i = stack.pop();
    const x = i % width, y = (i / width) | 0;
    pushIf(x + 1, y); pushIf(x - 1, y); pushIf(x, y + 1); pushIf(x, y - 1);
  }

  // Apply alpha: background → transparent, with a soft transition band.
  for (let i = 0; i < N; i++) {
    if (!bg[i]) continue;
    const o = i * channels;
    if (lum[i] >= HARD) {
      data[o + 3] = 0;
    } else {
      // closer to dark → more opaque, for a clean anti-aliased rounded edge
      const t = (lum[i] - SOFT) / (HARD - SOFT); // 0..1
      data[o + 3] = Math.round((1 - t) * 255);
    }
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

async function run() {
  // 1) Square logo → transparent
  const logoBuf = await removeWhiteBg(join(SRC_DIR, 'logo.png'));
  await sharp(logoBuf).png().toFile(OUT_LOGO);
  console.log('✓ src/logo.png (transparent)');

  // 2) Icons from the transparent square logo
  for (const size of [16, 32, 48, 128]) {
    await sharp(logoBuf)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(join(OUT_ICONS, `icon${size}.png`));
    console.log(`✓ src/icons/icon${size}.png`);
  }

  // 3) Wordmark → transparent (asset, e.g. for the welcome hero on light bg)
  const wordBuf = await removeWhiteBg(join(SRC_DIR, 'logo con scritta.png'));
  await sharp(wordBuf).trim().png().toFile(OUT_WORDMARK);
  console.log('✓ src/logo-wordmark.png (transparent, trimmed)');

  console.log('Done.');
}

run().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
