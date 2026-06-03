// make-store-assets.js — generate Chrome Web Store assets for RecapTube AI.
//
// Outputs into store-assets/:
//   - icon-128.png            store icon (128x128, transparent)
//   - screenshot-1.png        1280x800 — the provided promo image, letterboxed on brand bg
//   - small-tile-440x280.png  small promo tile
//   - marquee-1400x560.png    marquee promo tile
//   - (also a 640x400 screenshot variant)
//
// Run: node make-store-assets.js
import sharp from 'sharp';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = 'C:\\Users\\Giovanni Guarino\\Desktop\\Nuova cartella';
const OUT = join(__dirname, 'store-assets');
mkdirSync(OUT, { recursive: true });

const LOGO = join(__dirname, 'src', 'logo.png');             // transparent square mark
const PROMO = join(SRC_DIR, 'riquadro promozionale.png');     // rich promo image

// Brand palette sampled from the logo card.
const BG_A = '#1c2330';
const BG_B = '#0f1420';
const ACCENT = '#3ea6ff';
const TEXT = '#f1f1f1';
const TEXT2 = '#aab2c0';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A rounded-rect brand-gradient background as a PNG buffer. */
function bgSvg(w, h, radius = 0) {
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
       <defs>
         <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
           <stop offset="0" stop-color="${BG_A}"/>
           <stop offset="1" stop-color="${BG_B}"/>
         </linearGradient>
       </defs>
       <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="url(#g)"/>
     </svg>`
  );
}

/** Text overlay SVG (title + tagline), left-aligned at x. */
function textSvg(w, h, opts) {
  const { title, titleSize, accentWord, tagline, taglineSize, x, titleY, taglineY } = opts;
  // Split title so the accent word can be colored.
  let titleMarkup;
  if (accentWord && title.includes(accentWord)) {
    const [before, after] = title.split(accentWord);
    titleMarkup = `${esc(before)}<tspan fill="${ACCENT}">${esc(accentWord)}</tspan>${esc(after)}`;
  } else {
    titleMarkup = esc(title);
  }
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
       <style>
         .t { font-family: 'Roboto','Arial',sans-serif; font-weight: 700; fill: ${TEXT}; }
         .s { font-family: 'Roboto','Arial',sans-serif; font-weight: 400; fill: ${TEXT2}; }
       </style>
       <text x="${x}" y="${titleY}" class="t" font-size="${titleSize}">${titleMarkup}</text>
       ${tagline ? `<text x="${x}" y="${taglineY}" class="s" font-size="${taglineSize}">${esc(tagline)}</text>` : ''}
     </svg>`
  );
}

async function composeTile({ w, h, file, title, titleSize, tagline, taglineSize, logoSize }) {
  const bg = await sharp(bgSvg(w, h)).png().toBuffer();
  const logo = await sharp(LOGO).resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

  const pad = Math.round(h * 0.12);
  const logoX = pad;
  const logoY = Math.round((h - logoSize) / 2);
  const textX = logoX + logoSize + Math.round(w * 0.04);
  const textBlockH = h;
  const titleY = Math.round(h / 2) - (tagline ? Math.round(titleSize * 0.15) : -Math.round(titleSize * 0.35));
  const taglineY = titleY + Math.round(titleSize * 0.9);

  const text = await sharp(textSvg(w, textBlockH, {
    title, titleSize, accentWord: 'AI', tagline, taglineSize,
    x: textX, titleY, taglineY
  })).png().toBuffer();

  await sharp(bg)
    .composite([
      { input: logo, left: logoX, top: logoY },
      { input: text, left: 0, top: 0 }
    ])
    .png()
    .toFile(join(OUT, file));
  console.log(`✓ ${file} (${w}x${h})`);
}

/** Letterbox the promo image onto a brand background at the given size. */
async function screenshot(w, h, file) {
  const bg = await sharp(bgSvg(w, h)).png().toBuffer();
  // Fit the promo fully inside with a small margin.
  const inner = await sharp(PROMO)
    .resize(Math.round(w * 0.96), Math.round(h * 0.96), { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();
  const meta = await sharp(inner).metadata();
  const left = Math.round((w - meta.width) / 2);
  const top = Math.round((h - meta.height) / 2);
  await sharp(bg).composite([{ input: inner, left, top }]).png().toFile(join(OUT, file));
  console.log(`✓ ${file} (${w}x${h})`);
}

async function run() {
  // Store icon
  await sharp(LOGO).resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(join(OUT, 'icon-128.png'));
  console.log('✓ icon-128.png (128x128)');

  // Screenshots (promo image letterboxed)
  await screenshot(1280, 800, 'screenshot-1-1280x800.png');
  await screenshot(640, 400, 'screenshot-1-640x400.png');

  // Promo tiles (clean, logo + text)
  await composeTile({
    w: 440, h: 280, file: 'small-tile-440x280.png',
    title: 'RecapTube AI', titleSize: 34,
    tagline: 'Summarize · Translate · Chapters', taglineSize: 17,
    logoSize: 120
  });
  await composeTile({
    w: 1400, h: 560, file: 'marquee-1400x560.png',
    title: 'RecapTube AI', titleSize: 92,
    tagline: 'AI summaries, translation & smart chapters', taglineSize: 32,
    logoSize: 300
  });

  console.log('Done →', OUT);
}

run().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
