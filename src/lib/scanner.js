// Walks the library folders, extracts zip files in place, and returns every image found.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const extractZip = require('extract-zip');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.svg', '.avif']);
const SKIP_DIRS = new Set(['__MACOSX', '$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git']);
// Zips touched this recently may still be downloading or copying; the next scan picks them up.
const ZIP_SETTLE_MS = 10_000;
const MAX_ZIP_PASSES = 5; // zips inside zips

// Zips that couldn't be opened, keyed by path + size + modified time. They are not retried (or reported again)
// until the file changes, e.g. a download is replaced with a good copy.
const brokenZips = new Set();
const zipKey = (zip, stat) => `${zip}|${stat.size}|${stat.mtimeMs}`;

async function walk(root, onImage, onZip, onDir = () => {}) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return; // unreadable or vanished folder
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        onDir(full);
        await walk(full, onImage, onZip, onDir);
      }
    } else if (entry.isFile() && !entry.name.startsWith('._')) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.zip') onZip(full);
      else if (IMAGE_EXTS.has(ext)) onImage(full);
    }
  }
}

// Extract each zip into the folder that contains it, then remove the zip.
// The zip is only removed after a fully successful extraction.
// progress: { done, total, failed } shared across passes.
async function extractZips(zips, { toRecycleBin, trashItem, log, onZipProgress = () => {}, progress }) {
  let extracted = 0;
  let settling = 0;
  const ready = [];
  for (const zip of zips) {
    try {
      const stat = await fsp.stat(zip);
      if (brokenZips.has(zipKey(zip, stat))) continue;
      // Copies keep the source's modified time, so also look at when the file was created/changed here.
      if (Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs) < ZIP_SETTLE_MS) settling++;
      else ready.push({ zip, stat });
    } catch {
      /* vanished */
    }
  }
  progress.total += ready.length;
  for (const { zip, stat } of ready) {
    onZipProgress({ done: progress.done, total: progress.total, current: path.basename(zip) });
    try {
      // Open permissions so files extracted on the NAS stay editable by everyone using the share.
      await extractZip(zip, { dir: path.dirname(path.resolve(zip)), defaultDirMode: 0o777, defaultFileMode: 0o666 });
      if (toRecycleBin) {
        try {
          await trashItem(zip);
        } catch {
          await fsp.unlink(zip);
        }
      } else {
        await fsp.unlink(zip);
      }
      extracted++;
      log(`Extracted ${path.basename(zip)}`);
    } catch (err) {
      brokenZips.add(zipKey(zip, stat));
      progress.failed++;
      log(`Could not extract ${path.basename(zip)}: ${err.message}`, 'error');
    }
    progress.done++;
    onZipProgress({ done: progress.done, total: progress.total, current: null });
  }
  return { extracted, settling };
}

// Cheap content fingerprint: size + hash of the first and last 64KB.
async function fingerprint(file, size) {
  const CHUNK = 64 * 1024;
  const fh = await fsp.open(file, 'r');
  try {
    const hash = crypto.createHash('sha1');
    hash.update(String(size));
    const head = Buffer.alloc(Math.min(CHUNK, size));
    await fh.read(head, 0, head.length, 0);
    hash.update(head);
    if (size > CHUNK) {
      const tail = Buffer.alloc(Math.min(CHUNK, size - CHUNK));
      await fh.read(tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

async function scanFolders(folders, opts) {
  const { extractZipsEnabled, log } = opts;

  let zipsSettling = 0;
  if (extractZipsEnabled) {
    const progress = { done: 0, total: 0, failed: 0 };
    for (let pass = 0; pass < MAX_ZIP_PASSES; pass++) {
      const zips = [];
      for (const folder of folders) await walk(folder, () => {}, (z) => zips.push(z));
      if (zips.length === 0) break;
      const { extracted, settling } = await extractZips(zips, { ...opts, progress });
      zipsSettling = settling;
      if (extracted === 0) break; // remaining zips failed or are still settling
    }
    // Done: { finished, total, failed } if any zips were handled, null if there were none.
    if (opts.onZipProgress) opts.onZipProgress(progress.total ? { finished: true, total: progress.total, failed: progress.failed } : null);
  }

  const images = [];
  const dirs = [];
  for (const root of folders) {
    dirs.push(root);
    await walk(root, (f) => images.push({ path: f, root }), () => {}, (d) => dirs.push(d));
  }
  return { images, dirs, zipsSettling };
}

module.exports = { scanFolders, fingerprint, ZIP_SETTLE_MS };
