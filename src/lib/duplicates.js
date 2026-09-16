// Desktop app: duplicate finding with Electron's image decoder (see dupe-core.js for the logic).
const { nativeImage } = require('electron');
const { findDuplicates: findCore, dHashFromGray } = require('./dupe-core');

function grayPixels(img) {
  const small = img.resize({ width: 9, height: 8, quality: 'good' });
  const { width, height } = small.getSize();
  if (width !== 9 || height !== 8) return null;
  const px = small.toBitmap(); // BGRA
  const gray = new Array(72);
  for (let i = 0; i < 72; i++) {
    const o = i * 4;
    const a = px[o + 3] / 255;
    // Composite onto white so transparent clipart hashes by its visible shape.
    const lum = 0.114 * px[o] + 0.587 * px[o + 1] + 0.299 * px[o + 2];
    gray[i] = lum * a + 255 * (1 - a);
  }
  return gray;
}

// getThumb(rec) -> path of a small cached thumbnail (or null).
function findDuplicates(records, { similar, threshold, getThumb, progress }) {
  return findCore(records, {
    similar,
    threshold,
    progress,
    computeDhash: async (rec) => {
      const thumb = await getThumb(rec);
      const img = thumb ? nativeImage.createFromPath(thumb) : nativeImage.createEmpty();
      if (img.isEmpty()) return null;
      const gray = grayPixels(img);
      return gray ? dHashFromGray(gray) : null;
    },
  });
}

// Dimensions help decide which copy to keep.
function imageSize(file) {
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? null : img.getSize();
}

module.exports = { findDuplicates, imageSize };
