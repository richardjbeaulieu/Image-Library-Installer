// Image work for the web server (Linux, no desktop framework): thumbnails, AI upload encoding,
// duplicate hashes, and dimensions, all through sharp (libvips).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { MAX_EDGE } = require('../src/lib/describe');
const { dHashFromGray } = require('../src/lib/dupe-core');
const { removeBackground } = require('../src/lib/remove-bg');

sharp.cache(false); // files on the share change underneath us; don't hold decoded copies
sharp.concurrency(2);

const THUMB_EDGE = 480; // justified rows go up to ~340px tall
const MAX_INPUT_PIXELS = 400_000_000; // allow very large print files, but not decompression bombs

const open = (file) => sharp(file, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS, animated: false });

function thumbKey(rec) {
  return crypto.createHash('sha1').update(`${rec.path}|${rec.size}|${rec.mtime}`).digest('hex');
}

class Thumbnails {
  constructor(dir) {
    this.dir = dir;
    this.inflight = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  pathFor(rec) {
    const key = thumbKey(rec);
    return path.join(this.dir, key.slice(0, 2), `${key}.webp`);
  }

  // WebP keeps transparency (clipart) at a fraction of PNG's size.
  async get(rec) {
    const out = this.pathFor(rec);
    if (fs.existsSync(out)) return out;
    if (this.inflight.has(out)) return this.inflight.get(out);
    const job = (async () => {
      await fsp.mkdir(path.dirname(out), { recursive: true });
      const tmp = `${out}.${process.pid}.tmp`;
      await open(rec.path)
        .rotate()
        .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(tmp);
      await fsp.rename(tmp, out);
      return out;
    })().finally(() => this.inflight.delete(out));
    this.inflight.set(out, job);
    return job;
  }
}

// { media_type, data } for the Claude API, or null if sharp can't read the file.
async function encodeForAi(file) {
  try {
    const img = open(file).rotate().resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true });
    const { hasAlpha } = await open(file).metadata();
    // Keep PNG for transparent images: JPEG would flatten them onto black and skew the color tags.
    if (hasAlpha) return { media_type: 'image/png', data: (await img.png().toBuffer()).toString('base64') };
    return { media_type: 'image/jpeg', data: (await img.jpeg({ quality: 85 }).toBuffer()).toString('base64') };
  } catch {
    return null;
  }
}

async function dHash(file) {
  const { data, info } = await open(file)
    .flatten({ background: '#ffffff' }) // transparent clipart hashes by its visible shape
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || info.channels !== 1) return null;
  return dHashFromGray(Array.from(data));
}

// Reads only the file header.
async function imageSize(file) {
  try {
    const m = await open(file).metadata();
    if (!m.width || !m.height) return null;
    const swap = m.orientation >= 5; // EXIF rotated 90/270 degrees
    return swap ? { width: m.height, height: m.width } : { width: m.width, height: m.height };
  } catch {
    return null;
  }
}

const MAX_REMOVE_BG_PIXELS = 60_000_000; // ~7750x7750; bigger than any clipart, and keeps memory sane

// Writes a copy of `file` with its solid background made transparent. Returns what was cleared.
async function writeWithoutBackground(file, out, opts = {}) {
  const { data, info } = await open(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width * info.height > MAX_REMOVE_BG_PIXELS) throw new Error('Image is too large to process');
  const result = removeBackground(data, info.width, info.height, opts);
  if (!result) throw new Error('Could not read the background colour');
  // A picture with no solid background (a photo, a full-bleed pattern) clears only a sliver; a copy of it
  // would be pointless, so say so instead of writing one.
  if (result.cleared / result.total < 0.02) throw new Error('No solid background found around the edges');
  const tmp = `${out}.${process.pid}.tmp`;
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(tmp);
  await fsp.rename(tmp, out);
  return result;
}

// Small PNG showing what the current settings would clear, for the preview in the dialog.
async function previewWithoutBackground(file, opts = {}) {
  const { data, info } = await open(file)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = removeBackground(data, info.width, info.height, opts);
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return { png, cleared: result ? result.cleared / result.total : 0 };
}

// ---------- resize copy ----------
// Keeps each image's own format (so a JPEG photo doesn't balloon into a lossless PNG), and re-encodes at a
// quality high enough that the size drop comes from the pixel count, not visible compression artifacts.
const RESIZE_QUALITY = 92;
const RESIZE_FORMATS = {
  '.jpg': { ext: '.jpg', mime: 'image/jpeg', encode: (img) => img.jpeg({ quality: RESIZE_QUALITY }) },
  '.jpeg': { ext: '.jpeg', mime: 'image/jpeg', encode: (img) => img.jpeg({ quality: RESIZE_QUALITY }) },
  '.webp': { ext: '.webp', mime: 'image/webp', encode: (img) => img.webp({ quality: RESIZE_QUALITY }) },
  '.avif': { ext: '.avif', mime: 'image/avif', encode: (img) => img.avif({ quality: RESIZE_QUALITY }) },
};
// Anything sharp can't re-encode as itself (png, bmp, tiff, ...) comes out as lossless PNG.
const PNG_FORMAT = { ext: '.png', mime: 'image/png', encode: (img) => img.png({ compressionLevel: 9 }) };
function formatFor(ext) {
  return RESIZE_FORMATS[ext.toLowerCase()] || PNG_FORMAT;
}

// What resizing `file` to fit within maxDim x maxDim would produce, without doing the (slower) encode.
// `fits: true` means the image already fits and there is nothing to shrink.
async function planResize(file, maxDim) {
  const meta = await open(file).metadata();
  const rotated = (meta.orientation || 1) >= 5; // EXIF-rotated 90/270 degrees: width and height are swapped
  const w = rotated ? meta.height : meta.width;
  const h = rotated ? meta.width : meta.height;
  if (!w || !h) throw new Error('Could not read this image');
  const fits = w <= maxDim && h <= maxDim;
  const scale = fits ? 1 : Math.min(maxDim / w, maxDim / h);
  return {
    fits,
    sourceWidth: w,
    sourceHeight: h,
    width: fits ? w : Math.max(1, Math.round(w * scale)),
    height: fits ? h : Math.max(1, Math.round(h * scale)),
  };
}

function tooSmallError(plan, maxDim) {
  return new Error(`Already ${plan.sourceWidth}×${plan.sourceHeight} pixels — at or under ${maxDim}×${maxDim}, nothing to shrink`);
}

// Writes a copy of `file` resized to fit within maxDim x maxDim - same aspect ratio, never enlarged.
// `rotate()` bakes in the EXIF orientation so the copy displays correctly everywhere, including apps that
// ignore that tag. Returns the real output size.
async function writeResized(file, out, maxDim) {
  const plan = await planResize(file, maxDim);
  if (plan.fits) throw tooSmallError(plan, maxDim);
  const fmt = formatFor(path.extname(file));
  const img = open(file).rotate().resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
  const tmp = `${out}.${process.pid}.tmp`;
  const info = await fmt.encode(img).toFile(tmp);
  await fsp.rename(tmp, out);
  return { width: info.width, height: info.height };
}

// The resized image itself, for the dialog's live preview. These are the real output bytes (resizing a
// still-huge source down to a few hundred pixels is fast in sharp), so the size shown is exact, not a guess.
async function previewResized(file, maxDim) {
  const plan = await planResize(file, maxDim);
  if (plan.fits) throw tooSmallError(plan, maxDim);
  const fmt = formatFor(path.extname(file));
  const img = open(file).rotate().resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
  const buffer = await fmt.encode(img).toBuffer();
  return { buffer, width: plan.width, height: plan.height, mime: fmt.mime, ext: fmt.ext };
}

module.exports = {
  Thumbnails,
  encodeForAi,
  dHash,
  imageSize,
  writeWithoutBackground,
  previewWithoutBackground,
  formatFor,
  planResize,
  writeResized,
  previewResized,
};
