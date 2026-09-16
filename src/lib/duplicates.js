// Finds exact duplicates (identical bytes) and, optionally, visually similar images
// (same picture resized, re-saved, or converted) using a 64-bit difference hash.
const fs = require('fs');
const crypto = require('crypto');
const { nativeImage } = require('electron');

function fullHash(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// dHash: shrink to 9x8 grayscale, compare each pixel to its right neighbour.
// Returned as two unsigned 32-bit halves so comparisons stay fast in JS.
function dHash(img) {
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
  let hi = 0;
  let lo = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0;
      const n = y * 8 + x;
      if (n < 32) hi = ((hi << 1) | bit) >>> 0;
      else lo = ((lo << 1) | bit) >>> 0;
    }
  }
  return [hi, lo];
}

function popcount(n) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

class UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
    return i;
  }
  union(a, b) {
    this.p[this.find(a)] = this.find(b);
  }
}

/**
 * records: index file records. Cached hashes are written back onto them (fullHash, dhash, width, height).
 * getThumb(rec) -> path of a small cached thumbnail (or null).
 * Returns [{ kind: 'exact' | 'similar', paths: [...] }]
 */
async function findDuplicates(records, { similar, threshold = 5, getThumb, progress }) {
  const groups = [];
  const inExactGroup = new Set();

  // 1. Exact: bucket by the cheap fingerprint, confirm with a full hash.
  const byFp = new Map();
  for (const r of records) {
    if (!byFp.has(r.fp)) byFp.set(r.fp, []);
    byFp.get(r.fp).push(r);
  }
  const candidates = [...byFp.values()].filter((g) => g.length > 1);
  let done = 0;
  for (const bucket of candidates) {
    const byHash = new Map();
    for (const r of bucket) {
      try {
        if (!r.fullHash) r.fullHash = await fullHash(r.path);
      } catch {
        continue;
      }
      if (!byHash.has(r.fullHash)) byHash.set(r.fullHash, []);
      byHash.get(r.fullHash).push(r);
    }
    for (const g of byHash.values()) {
      if (g.length > 1) {
        groups.push({ kind: 'exact', paths: g.map((r) => r.path) });
        g.forEach((r) => inExactGroup.add(r.path));
      }
    }
    progress({ phase: 'Comparing file contents', done: ++done, total: candidates.length });
  }

  if (!similar) return groups;

  // 2. Similar: perceptual hash of every image (one representative per exact group).
  const seenFullHash = new Set();
  const hashed = [];
  done = 0;
  for (const r of records) {
    progress({ phase: 'Looking at images', done: ++done, total: records.length });
    if (inExactGroup.has(r.path)) {
      if (seenFullHash.has(r.fullHash)) continue;
      seenFullHash.add(r.fullHash);
    }
    if (!r.dhash) {
      try {
        const thumb = await getThumb(r);
        const img = thumb ? nativeImage.createFromPath(thumb) : nativeImage.createEmpty();
        if (img.isEmpty()) continue;
        r.dhash = dHash(img);
      } catch {
        continue;
      }
    }
    if (r.dhash) hashed.push(r);
  }

  const uf = new UnionFind(hashed.length);
  for (let i = 0; i < hashed.length; i++) {
    const [ahi, alo] = hashed[i].dhash;
    for (let j = i + 1; j < hashed.length; j++) {
      const [bhi, blo] = hashed[j].dhash;
      if (popcount(ahi ^ bhi) + popcount(alo ^ blo) <= threshold) uf.union(i, j);
    }
  }
  const clusters = new Map();
  hashed.forEach((r, i) => {
    const root = uf.find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(r);
  });

  const exactByHash = new Map();
  for (const g of groups) exactByHash.set(records.find((r) => r.path === g.paths[0]).fullHash, g.paths);
  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue;
    // Expand representatives back to all their exact copies.
    const paths = cluster.flatMap((r) => (inExactGroup.has(r.path) ? exactByHash.get(r.fullHash) : [r.path]));
    groups.push({ kind: 'similar', paths });
  }
  // An exact group that is part of a larger similar group is shown only once, in the similar group.
  const inSimilar = new Set(groups.filter((g) => g.kind === 'similar').flatMap((g) => g.paths));
  return groups.filter((g) => g.kind === 'similar' || !inSimilar.has(g.paths[0]));
}

// Dimensions help decide which copy to keep.
function imageSize(file) {
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? null : img.getSize();
}

module.exports = { findDuplicates, imageSize };
