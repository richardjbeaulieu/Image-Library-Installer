const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, protocol, net, safeStorage } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const { openStores } = require('./lib/store');
const { SharedLibrary } = require('./lib/shared');
const { scanFolders, fingerprint, ZIP_SETTLE_MS } = require('./lib/scanner');
const { createClient, analyzeImage, classifyError, errorText, PAUSE_MESSAGES } = require('./lib/ai');
const fileops = require('./lib/fileops');
const { findDuplicates, imageSize } = require('./lib/duplicates');

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win;
let settings;
let index;
let legacyCollections;
let origins;
let shared; // library data shared with other PCs (folders, model, AI descriptions, collections)
let thumbDir;
let dirs = [];

// ---------- helpers ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function log(message, level = 'info') {
  send('log', { message, level, at: Date.now() });
}

function getApiKey() {
  const enc = settings.data.apiKeyEnc;
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

function toItem(rec) {
  const ai = shared.getAi(rec.fp);
  const relDir = path.relative(rec.root, path.dirname(rec.path));
  return {
    path: rec.path,
    name: rec.name,
    folder: path.join(path.basename(rec.root), relDir),
    size: rec.size,
    mtime: rec.mtime,
    status: rec.status,
    error: rec.error || null,
    sourceZip: (origins.data.files[rec.path] || {}).zip || null,
    sourcePack: (origins.data.files[rec.path] || {}).pack || null,
    ai,
  };
}

function inLibrary(p) {
  return Object.prototype.hasOwnProperty.call(index.data.files, p);
}

// The configured library folder that contains p, or null.
function rootOf(p) {
  const lp = p.toLowerCase();
  return shared.library.folders.find((r) => lp === r.toLowerCase() || lp.startsWith(r.toLowerCase() + path.sep)) || null;
}

function libraryPayload() {
  return { items: Object.values(index.data.files).map(toItem), dirs, roots: shared.library.folders };
}

function sendLibrary() {
  send('library', libraryPayload());
}

// Keep the index and albums in step when a file is moved or renamed on disk.
function relocate(from, to) {
  const rec = index.data.files[from];
  if (!rec) return;
  delete index.data.files[from];
  const root = rootOf(to);
  if (root) index.data.files[to] = { ...rec, path: to, name: path.basename(to), root };
  if (origins.data.files[from]) {
    if (root) origins.data.files[to] = origins.data.files[from];
    delete origins.data.files[from];
    origins.save();
  }
  editAlbums((paths) => (root ? paths.map((p) => (p === from ? to : p)) : paths.filter((p) => p !== from)));
}

function sendCollections() {
  send('collections', shared.collections);
}

function editAlbums(edit) {
  try {
    if (shared.editAlbumPaths(edit)) sendCollections();
  } catch (err) {
    log(`Could not update albums: ${err.message}`, 'error');
  }
}

// A file is "done" when a description for its content exists in the shared library (possibly written by another PC).
function reconcileStatuses() {
  for (const rec of Object.values(index.data.files)) {
    const described = Boolean(shared.getAi(rec.fp));
    if (described && rec.status !== 'done') {
      rec.status = 'done';
      delete rec.error;
    } else if (!described && rec.status === 'done') {
      rec.status = 'pending';
    }
  }
  index.save();
}

function onSharedChange(kind) {
  if (kind === 'collections') sendCollections();
  if (kind === 'library') {
    send('settings-changed');
    restartWatchers();
    scan();
  }
  if (kind === 'ai') {
    reconcileStatuses();
    sendLibrary();
    enqueuePending();
  }
}

// Remember which zip an extracted file came from (`pack` is the outermost zip, for zips inside zips).
function recordOrigin({ zipPath, files }) {
  const parent = origins.data.files[zipPath];
  const zip = path.basename(zipPath);
  const pack = parent ? parent.pack || parent.zip : zip;
  for (const f of files) origins.data.files[f] = { zip, pack, at: Date.now() };
  origins.save();
}

// Move an extracted zip into the archive folder. Returns where it landed.
async function archiveZipFile(zip) {
  const dir = settings.data.zipArchive;
  await fsp.mkdir(dir, { recursive: true });
  const [result] = await fileops.moveFiles([zip], dir);
  if (result.error) throw new Error(result.error);
  return result.to;
}

function forget(p) {
  delete index.data.files[p];
  delete origins.data.files[p];
  origins.save();
  editAlbums((paths) => paths.filter((x) => x !== p));
}

function afterFileOps() {
  index.save();
  sendLibrary();
  scan();
}

// ---------- scanning ----------

let scanning = false;
let rescanRequested = false;
let settleTimer = null;

async function scan() {
  if (scanning) {
    rescanRequested = true;
    return;
  }
  scanning = true;
  send('status', { scanning: true });
  try {
    const folders = shared.library.folders.filter((f) => fs.existsSync(f));
    const { images, dirs: foundDirs, zipsSettling } = await scanFolders(folders, {
      extractZipsEnabled: settings.data.extractZips,
      wrapLooseZips: settings.data.wrapLooseZips !== false,
      archiveZip: settings.data.zipArchive ? archiveZipFile : null,
      skipDirs: settings.data.zipArchive ? [settings.data.zipArchive] : [],
      toRecycleBin: settings.data.zipsToRecycleBin,
      trashItem: (p) => shell.trashItem(p),
      log,
      onZipProgress: (p) => send('status', { extracting: p }),
      onExtracted: recordOrigin,
    });

    const prevFiles = index.data.files;
    const files = {};
    for (const { path: p, root } of images) {
      let stat;
      try {
        stat = await fsp.stat(p);
      } catch {
        continue;
      }
      const prev = prevFiles[p];
      if (prev && prev.size === stat.size && prev.mtime === stat.mtimeMs) {
        files[p] = { ...prev, root };
        continue;
      }
      let fp = null;
      try {
        fp = await fingerprint(p, stat.size);
      } catch {
        continue;
      }
      files[p] = {
        path: p,
        name: path.basename(p),
        root,
        size: stat.size,
        mtime: stat.mtimeMs,
        fp,
        status: 'pending',
      };
    }
    index.data.files = files;
    // Forget where files came from once they are gone for good.
    let originsChanged = false;
    for (const p of Object.keys(origins.data.files)) {
      if (!files[p] && !fs.existsSync(p)) {
        delete origins.data.files[p];
        originsChanged = true;
      }
    }
    if (originsChanged) origins.save();
    reconcileStatuses();
    dirs = foundDirs;

    // Drop album entries for files that are really gone. Only judge folders this PC can reach right now,
    // so a PC with a disconnected drive never empties everyone's albums.
    const reachable = (p) => folders.some((r) => p.toLowerCase().startsWith(r.toLowerCase() + path.sep));
    editAlbums((paths) => paths.filter((p) => files[p] || !reachable(p) || fs.existsSync(p)));

    sendLibrary();
    if (zipsSettling > 0) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(scan, ZIP_SETTLE_MS + 2000);
    }
    enqueuePending();
  } catch (err) {
    log(`Scan failed: ${err.message}`, 'error');
  } finally {
    scanning = false;
    send('status', { scanning: false });
    if (rescanRequested) {
      rescanRequested = false;
      scan();
    }
  }
}

// ---------- folder watching ----------

let watchers = [];
let watchTimer = null;

function restartWatchers() {
  for (const w of watchers) w.close();
  watchers = [];
  if (!settings.data.watchFolders) return;
  for (const folder of shared.library.folders) {
    try {
      const w = fs.watch(folder, { recursive: true }, (_event, filename) => {
        if (filename && /\.(tmp|crdownload|part|partial)$/i.test(filename)) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(scan, 2500);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch (err) {
      log(`Cannot watch ${folder}: ${err.message}`, 'error');
    }
  }
}

// ---------- AI analysis queue ----------

const queue = [];
const queued = new Set();
let active = 0;
let paused = false;
let client = null;
let doneThisRun = 0;
let retryTimer = null; // set while waiting out a temporary Claude or network problem
let claimRetryTimer = null;

function queueStatus() {
  send('status', { analyzing: { queued: queue.length, active, done: doneThisRun, paused, enabled: settings.data.autoAnalyze } });
}

function enqueuePending() {
  for (const rec of Object.values(index.data.files)) {
    if (rec.status === 'pending' && !queued.has(rec.path)) {
      queue.push(rec.path);
      queued.add(rec.path);
    }
  }
  pump();
}

function setStatus(rec, status, error) {
  rec.status = status;
  if (error) rec.error = error;
  else delete rec.error;
  index.save();
  send('item', toItem(rec));
}

function hasCredentials() {
  return Boolean(getApiKey() || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function pump() {
  queueStatus();
  if (paused || retryTimer || !settings.data.autoAnalyze) return;
  if (queue.length && !hasCredentials()) {
    paused = true;
    queueStatus();
    log('Add a Claude API key in Settings to start describing images.', 'error');
    send('auth-error');
    return;
  }
  while (active < Math.max(1, settings.data.concurrency) && queue.length) {
    const p = queue.shift();
    queued.delete(p);
    const rec = index.data.files[p];
    if (!rec || rec.status !== 'pending') continue;
    if (shared.getAi(rec.fp)) {
      setStatus(rec, 'done'); // an identical file was described meanwhile, here or on another PC
      continue;
    }
    if (!shared.claim(rec.fp)) {
      // Another PC is describing this image right now; check back later.
      if (!claimRetryTimer) {
        claimRetryTimer = setTimeout(() => {
          claimRetryTimer = null;
          enqueuePending();
        }, 60_000);
      }
      continue;
    }
    active++;
    runOne(rec).finally(() => {
      active--;
      pump();
    });
  }
}

async function runOne(rec) {
  if (!client) client = createClient(getApiKey());
  try {
    const result = await analyzeImage(client, shared.library.model, rec.path, rec.root, (origins.data.files[rec.path] || {}).pack);
    shared.putAi(rec.fp, result);
    doneThisRun++;
    // Apply to every file sharing this content.
    for (const other of Object.values(index.data.files)) {
      if (other.fp === rec.fp) setStatus(other, 'done');
    }
  } catch (err) {
    const kind = classifyError(err);
    if (kind === 'skip') return setStatus(rec, 'skipped', err.message);
    if (kind === 'fail') return setStatus(rec, 'error', errorText(err));
    // Not this image's fault: keep it waiting, and let other PCs pick it up meanwhile.
    shared.releaseClaims([rec.fp]);
    if (!queued.has(rec.path)) {
      queue.unshift(rec.path);
      queued.add(rec.path);
    }
    if (kind === 'retry') {
      if (!retryTimer) {
        log(`Claude is busy or unreachable (${errorText(err)}). Trying again in a minute.`, 'error');
        retryTimer = setTimeout(() => {
          retryTimer = null;
          pump();
        }, 60000);
      }
      return;
    }
    if (!paused) {
      log(PAUSE_MESSAGES[kind], 'error');
      send('auth-error');
    }
    paused = true;
    queueStatus();
  }
}

// ---------- thumbnails ----------

const THUMB_SIZE = 480; // justified rows go up to ~340px tall
const inflight = new Map();

async function makeThumb(rec) {
  const key = crypto.createHash('sha1').update(`${rec.path}|${rec.size}|${rec.mtime}`).digest('hex');
  const out = path.join(thumbDir, key + '.png');
  if (fs.existsSync(out)) return out;
  if (inflight.has(out)) return inflight.get(out);
  const job = (async () => {
    let img = nativeImage.createEmpty();
    if (typeof nativeImage.createThumbnailFromPath === 'function') {
      try {
        img = await nativeImage.createThumbnailFromPath(rec.path, { width: THUMB_SIZE, height: THUMB_SIZE });
      } catch {
        /* fall through */
      }
    }
    if (img.isEmpty()) {
      img = nativeImage.createFromPath(rec.path);
      if (!img.isEmpty()) {
        const { width, height } = img.getSize();
        if (Math.max(width, height) > THUMB_SIZE) {
          img = width >= height ? img.resize({ width: THUMB_SIZE }) : img.resize({ height: THUMB_SIZE });
        }
      }
    }
    if (img.isEmpty()) return null;
    await fsp.writeFile(out, img.toPNG());
    return out;
  })().finally(() => inflight.delete(out));
  inflight.set(out, job);
  return job;
}

// Formats Chromium renders natively and that don't benefit from (or break) OS thumbnailing.
const SERVE_ORIGINAL_AS_THUMB = new Set(['.svg', '.gif']);

function registerMediaProtocol() {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname.slice(1));
    if (!inLibrary(p)) return new Response('Not found', { status: 404 });
    const fileUrl = pathToFileURL(p).toString();
    if (url.host === 'thumb' && !SERVE_ORIGINAL_AS_THUMB.has(path.extname(p).toLowerCase())) {
      try {
        const thumb = await makeThumb(index.data.files[p]);
        if (thumb) return net.fetch(pathToFileURL(thumb).toString());
      } catch {
        /* serve original */
      }
    }
    return net.fetch(fileUrl);
  });
}

// ---------- drag, copy, open ----------

function dragIcon(paths) {
  for (const p of paths) {
    const rec = index.data.files[p];
    const key = rec && crypto.createHash('sha1').update(`${rec.path}|${rec.size}|${rec.mtime}`).digest('hex');
    const thumb = key && path.join(thumbDir, key + '.png');
    if (thumb && fs.existsSync(thumb)) {
      const img = nativeImage.createFromPath(thumb);
      if (!img.isEmpty()) return img.resize({ width: 96 });
    }
  }
  // Plain square placeholder (startDrag requires a non-empty icon).
  const size = 48;
  const buf = Buffer.alloc(size * size * 4, 0);
  for (let i = 0; i < buf.length; i += 4) buf.set([0xd0, 0x8a, 0x4f, 0xff], i);
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function copyFilesToClipboard(paths) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Set-Clipboard -LiteralPath puts a real file drop list on the clipboard (paste into Explorer, upload dialogs, etc.).
      // Paths are passed through an environment variable so they're never parsed as script.
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath ($env:IMGLIB_PATHS -split "`n")'],
        { env: { ...process.env, IMGLIB_PATHS: paths.join('\n') }, windowsHide: true },
        (err) => (err ? reject(err) : resolve()),
      );
    } else if (process.platform === 'darwin') {
      clipboard.writeBuffer('public.file-url', Buffer.from(pathToFileURL(paths[0]).toString()));
      resolve();
    } else {
      clipboard.writeBuffer('text/uri-list', Buffer.from(paths.map((p) => pathToFileURL(p).toString()).join('\r\n')));
      resolve();
    }
  });
}

async function copyImageToClipboard(p) {
  let img = nativeImage.createFromPath(p);
  if (img.isEmpty() && typeof nativeImage.createThumbnailFromPath === 'function') {
    img = await nativeImage.createThumbnailFromPath(p, { width: 4096, height: 4096 });
  }
  if (img.isEmpty()) throw new Error('This format cannot be copied as image data; use Copy file instead.');
  clipboard.writeImage(img);
}

// ---------- IPC ----------

function publicSettings() {
  const { apiKeyEnc, folders: _legacyFolders, model: _legacyModel, migratedTo: _migratedTo, ...rest } = settings.data;
  return {
    ...rest,
    folders: shared.library.folders,
    model: shared.library.model,
    dataDir: shared.dir,
    hasSavedKey: Boolean(apiKeyEnc),
    hasEnvKey: Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

function registerIpc() {
  ipcMain.handle('library:get', () => libraryPayload());
  ipcMain.handle('library:rescan', () => scan());

  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = ['autoAnalyze', 'extractZips', 'wrapLooseZips', 'zipsToRecycleBin', 'watchFolders', 'concurrency'];
    for (const k of allowed) if (k in patch) settings.data[k] = patch[k];
    if ('zipArchive' in patch) {
      const dir = String(patch.zipArchive || '').trim();
      if (dir) fs.mkdirSync(dir, { recursive: true });
      settings.data.zipArchive = dir || null;
    }
    if (patch.model && patch.model !== shared.library.model) shared.setModel(patch.model);
    settings.flush();
    restartWatchers();
    if (patch.extractZips) scan();
    pump();
    return publicSettings();
  });
  ipcMain.handle('settings:set-api-key', (_e, key) => {
    key = (key || '').trim();
    if (key && !safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system.');
    settings.data.apiKeyEnc = key ? safeStorage.encryptString(key).toString('base64') : null;
    settings.flush();
    client = null;
    return publicSettings();
  });
  ipcMain.handle('settings:add-folder', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
    if (res.canceled) return publicSettings();
    shared.addFolders(res.filePaths);
    restartWatchers();
    scan();
    return publicSettings();
  });
  ipcMain.handle('settings:remove-folder', (_e, folder) => {
    shared.removeFolder(folder);
    restartWatchers();
    scan();
    return publicSettings();
  });

  ipcMain.handle('ai:pause', (_e, value) => {
    paused = Boolean(value);
    if (!paused) {
      client = null; // pick up a newly saved key
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    pump();
  });
  ipcMain.handle('ai:reanalyze', (_e, paths) => {
    for (const p of paths) {
      const rec = index.data.files[p];
      if (!rec) continue;
      if (shared.getAi(rec.fp)) shared.deleteAi(rec.fp);
      for (const other of Object.values(index.data.files)) {
        if (other.fp === rec.fp) setStatus(other, 'pending');
      }
      if (!queued.has(p)) {
        queue.unshift(p);
        queued.add(p);
      }
    }
    pump();
  });
  ipcMain.handle('ai:retry-failed', () => {
    for (const rec of Object.values(index.data.files)) if (rec.status === 'error') setStatus(rec, 'pending');
    enqueuePending();
  });

  // ----- collections -----
  ipcMain.handle('collections:get', () => shared.collections);
  // base = collections as the window last received them, next = after the user's edit.
  // Only the difference is applied, so edits made meanwhile on other PCs are kept.
  ipcMain.handle('collections:save', (_e, base, next) => shared.saveCollections(base, next));

  ipcMain.handle('settings:change-data-dir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the shared library data folder',
      defaultPath: shared.dir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths[0] === shared.dir) return null;
    const target = res.filePaths[0];
    const hasLibrary = fs.existsSync(path.join(target, 'library.json'));
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Switch and restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: hasLibrary ? 'Use the library data in this folder?' : 'Start a shared library in this folder?',
      detail: hasLibrary
        ? target + '\n\nThis PC will use the descriptions, albums, and collections stored there. Anything only in the current folder is added to it.'
        : target + '\n\nThe current descriptions, albums, and collections are copied there. Point other PCs at this folder to share them.',
    });
    if (response !== 0) return null;
    shared.flushAi();
    const incoming = new SharedLibrary(target).load();
    incoming.importLegacy({ folders: shared.library.folders, model: shared.library.model, ai: shared.ai, collections: shared.collections });
    settings.data.dataDir = target;
    settings.data.migratedTo = target;
    settings.flush();
    index.flush();
    app.relaunch();
    app.exit(0);
    return target;
  });

  // ----- folders and file management -----
  ipcMain.handle('folder:create', async (_e, parent, name) => {
    if (!rootOf(parent)) throw new Error('Folders can only be created inside library folders');
    const dir = await fileops.createFolder(parent, name);
    dirs.push(dir);
    sendLibrary();
    return dir;
  });
  ipcMain.handle('files:move', async (_e, paths, destDir) => {
    if (!destDir) {
      const res = await dialog.showOpenDialog(win, { title: 'Move to folder', properties: ['openDirectory', 'createDirectory'] });
      if (res.canceled) return null;
      destDir = res.filePaths[0];
    }
    const results = await fileops.moveFiles(paths.filter(inLibrary), destDir);
    for (const r of results) if (r.to && r.to !== r.from) relocate(r.from, r.to);
    afterFileOps();
    return results;
  });
  // Files dropped in from outside the library (e.g. Explorer) are copied, not moved.
  ipcMain.handle('files:import', async (_e, paths, destDir) => {
    if (!rootOf(destDir)) throw new Error('Choose a folder inside the library');
    const results = [];
    for (const from of paths) {
      try {
        const st = await fsp.stat(from);
        if (!st.isFile()) continue;
        const ext = path.extname(from);
        let to = path.join(destDir, path.basename(from));
        for (let i = 2; fs.existsSync(to); i++) to = path.join(destDir, path.basename(from, ext) + ' (' + i + ')' + ext);
        await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        results.push({ from, to });
      } catch (err) {
        results.push({ from, error: err.message });
      }
    }
    scan();
    return results;
  });
  ipcMain.handle('files:rename', async (_e, plan) => {
    plan = plan.filter((p) => inLibrary(p.from));
    const results = await fileops.renameFiles(plan);
    for (const r of results) if (r.to) relocate(r.from, r.to);
    afterFileOps();
    return results;
  });
  ipcMain.handle('files:trash', async (_e, paths) => {
    const results = await fileops.recycleFiles(paths.filter(inLibrary), (p) => shell.trashItem(p));
    for (const r of results) if (r.deleted) forget(r.from);
    afterFileOps();
    return results;
  });

  // ----- duplicates -----
  let findingDuplicates = false;
  ipcMain.handle('duplicates:find', async (_e, { similar }) => {
    if (findingDuplicates) throw new Error('Already searching for duplicates');
    findingDuplicates = true;
    let last = 0;
    try {
      const groups = await findDuplicates(Object.values(index.data.files), {
        similar,
        getThumb: (rec) => makeThumb(rec),
        progress: (p) => {
          const now = Date.now();
          if (now - last > 150 || p.done === p.total) {
            last = now;
            send('duplicates-progress', p);
          }
        },
      });
      index.save();
      return groups
        .map((g) => ({
          kind: g.kind,
          items: g.paths.filter(inLibrary).map((p) => ({ ...toItem(index.data.files[p]), dimensions: imageSize(p) })),
        }))
        .filter((g) => g.items.length > 1);
    } finally {
      findingDuplicates = false;
    }
  });

  ipcMain.on('file:drag', (e, paths) => {
    paths = paths.filter(inLibrary);
    if (!paths.length) return;
    e.sender.startDrag({ file: paths[0], files: paths, icon: dragIcon(paths) });
  });
  ipcMain.handle('file:copy', (_e, paths) => copyFilesToClipboard(paths.filter(inLibrary)));
  ipcMain.handle('file:copy-image', (_e, p) => (inLibrary(p) ? copyImageToClipboard(p) : null));
  ipcMain.handle('file:copy-path', (_e, paths) => clipboard.writeText(paths.filter(inLibrary).join('\r\n')));
  ipcMain.handle('file:show', (_e, p) => inLibrary(p) && shell.showItemInFolder(p));
  ipcMain.handle('file:open', (_e, p) => (inLibrary(p) ? shell.openPath(p) : null));
  ipcMain.handle('folder:show', (_e, dir) => (rootOf(dir) ? shell.openPath(dir) : null));
  ipcMain.handle('folder:choose', async (_e, title) => {
    const res = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
}

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  const stores = openStores(app.getPath('userData'));
  settings = stores.settings;
  index = stores.index;
  legacyCollections = stores.legacyCollections;
  origins = stores.origins;
  if (!openSharedLibrary()) return;
  thumbDir = path.join(app.getPath('userData'), 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });

  registerMediaProtocol();
  registerIpc();

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#16161a',
    title: 'Image Library',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    restartWatchers();
    scan();
  });
});

app.on('before-quit', () => {
  settings?.flush();
  index?.flush();
  origins?.flush();
  shared?.close();
});

// Where the shared library lives unless this PC picked another folder in Settings.
// Run from the app folder: "library-data" next to it. Installed copy: the team folder named in package.json.
function defaultDataDir() {
  if (!app.isPackaged) return path.join(app.getAppPath(), 'library-data');
  return require('../package.json').imageLibrary.sharedDataDir;
}

function openSharedLibrary() {
  let dir = settings.data.dataDir || defaultDataDir();
  for (;;) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
      shared = new SharedLibrary(dir).load();
      break;
    } catch (err) {
      // Never fall back to a private copy silently: that would split the library between PCs.
      const choice = dialog.showMessageBoxSync({
        type: 'error',
        buttons: ['Try again', 'Choose another folder…', 'Quit'],
        defaultId: 0,
        cancelId: 2,
        message: 'Cannot reach the shared library data',
        detail: dir + '\n\n' + err.message + '\n\nCheck that the X: drive is connected, then try again.',
      });
      if (choice === 1) {
        const picked = dialog.showOpenDialogSync({ title: 'Choose the shared library data folder', properties: ['openDirectory', 'createDirectory'] });
        if (picked && picked[0]) {
          dir = picked[0];
          settings.data.dataDir = dir;
          settings.flush();
        }
      } else if (choice === 2) {
        app.exit(1);
        return false;
      }
    }
  }

  // Bring along anything this PC stored locally before the library was shared (runs once per shared folder).
  if (settings.data.migratedTo !== dir) {
    try {
      shared.importLegacy({
        folders: settings.data.folders || [],
        model: settings.data.model,
        ai: index.data.ai || {},
        collections: legacyCollections.data,
      });
      settings.data.migratedTo = dir;
      settings.flush();
    } catch (err) {
      dialog.showErrorBox('Could not set up the shared library', dir + '\n\n' + err.message);
    }
  }

  shared.on('change', onSharedChange);
  shared.on('error', (err) => log('Saving to the shared library failed, will retry: ' + err.message, 'error'));
  shared.startPolling();
  return true;
}

app.on('window-all-closed', () => app.quit());
