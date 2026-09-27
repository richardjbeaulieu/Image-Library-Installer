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

module.exports = { Thumbnails, encodeForAi, dHash, imageSize, writeWithoutBackground, previewWithoutBackground };
