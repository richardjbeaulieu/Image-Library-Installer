// Desktop app: prepares images with Electron's decoder, then describes them (see describe.js).
const fsp = require('fs/promises');
const path = require('path');
const { nativeImage } = require('electron');
const { MAX_EDGE, createClient, describeImage, SkipError, Anthropic, classifyError, errorText, PAUSE_MESSAGES } = require('./describe');

const MAX_RAW_BYTES = 3.5 * 1024 * 1024; // base64 must stay under the API's 5MB image limit
const RAW_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function hasTransparency(img) {
  const bitmap = img.toBitmap(); // BGRA
  for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] < 255) return true;
  return false;
}

// Returns { media_type, data } for the API, or null if the image can't be prepared.
async function encodeImage(file) {
  const ext = path.extname(file).toLowerCase();
  let img = nativeImage.createFromPath(file); // decodes PNG/JPEG
  if (img.isEmpty() && typeof nativeImage.createThumbnailFromPath === 'function') {
    // OS thumbnailer handles WebP, BMP, TIFF, etc.
    try {
      img = await nativeImage.createThumbnailFromPath(file, { width: MAX_EDGE, height: MAX_EDGE });
    } catch {
      img = nativeImage.createEmpty();
    }
  }
  if (!img.isEmpty()) {
    const { width, height } = img.getSize();
    if (Math.max(width, height) > MAX_EDGE) {
      img = width >= height ? img.resize({ width: MAX_EDGE, quality: 'good' }) : img.resize({ height: MAX_EDGE, quality: 'good' });
    }
    // Keep PNG for transparent images: JPEG would flatten them onto black and skew the color tags.
    if (hasTransparency(img)) return { media_type: 'image/png', data: img.toPNG().toString('base64') };
    return { media_type: 'image/jpeg', data: img.toJPEG(85).toString('base64') };
  }
  if (RAW_TYPES[ext]) {
    const buf = await fsp.readFile(file);
    if (buf.length <= MAX_RAW_BYTES) return { media_type: RAW_TYPES[ext], data: buf.toString('base64') };
  }
  return null;
}

async function analyzeImage(client, model, file, root) {
  return describeImage(client, model, await encodeImage(file), file, root);
}

module.exports = { createClient, analyzeImage, SkipError, Anthropic, classifyError, errorText, PAUSE_MESSAGES };
