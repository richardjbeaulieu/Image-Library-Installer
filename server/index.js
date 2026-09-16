// Image Library web server: runs on the NAS (in Docker) and serves the same interface as the desktop app
// to any browser on the network. The image folders are read directly from the NAS's disks.
//
// Environment:
//   PORT               web port (default 8787)
//   LIBRARY_ROOT       folder inside the container that holds the image folders (default /library)
//   DATA_DIR           where descriptions, albums, settings, and thumbnails are kept (default /data)
//   PATH_MAP           how people see LIBRARY_ROOT from their PCs, e.g. "/library=X:\ETSY" (used by Copy path)
//   APP_PASSWORD       optional; when set, the browser asks for this password
//   ANTHROPIC_API_KEY  optional; the key can also be saved from Settings
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const archiver = require('archiver');

const { JsonFile } = require('../src/lib/store');
const { SharedLibrary } = require('../src/lib/shared');
const { scanFolders, fingerprint, ZIP_SETTLE_MS } = require('../src/lib/scanner');
const { createClient, describeImage, SkipError, Anthropic } = require('../src/lib/describe');
const fileops = require('../src/lib/fileops');
const { findDuplicates } = require('../src/lib/dupe-core');
const { Thumbnails, encodeForAi, dHash, imageSize } = require('./images');

process.umask(0); // files created on the share stay editable by everyone who uses it

const PORT = Number(process.env.PORT) || 8787;
const LIBRARY_ROOT = path.resolve(process.env.LIBRARY_ROOT || '/library');
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const TRASH_DIR_NAME = '.image-library-trash';
const TRASH_DAYS = 30;
const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
const WEB_DIR = path.join(__dirname, '..', 'web');

const [mapFrom, mapTo] = (process.env.PATH_MAP || '').split('=');

// ---------- stores ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
const settings = new JsonFile(path.join(DATA_DIR, 'settings.json'), {
  apiKey: null,
  autoAnalyze: true,
  extractZips: true,
  watchFolders: true,
  concurrency: 3,
});
const index = new JsonFile(path.join(DATA_DIR, 'index.json'), { files: {} });
const shared = new SharedLibrary(path.join(DATA_DIR, 'library')).load();
const thumbs = new Thumbnails(path.join(DATA_DIR, 'thumbs'));
let dirs = [];

// ---------- helpers ----------

const clients = new Set();
function send(channel, payload) {
  const msg = `data: ${JSON.stringify({ channel, payload })}\n\n`;
  for (const res of clients) res.write(msg);
}

function log(message, level = 'info') {
  console.log(`[${level}] ${message}`);
  send('log', { message, level, at: Date.now() });
}

const isInside = (p, dir) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// How a path looks from the PCs (e.g. X:\ETSY\...), for Copy path.
function displayPath(p) {
  if (!mapFrom || !mapTo || !isInside(p, mapFrom)) return p;
  const rel = path.relative(mapFrom, p);
  const winLike = /^[a-zA-Z]:|^\\\\/.test(mapTo);
  return rel ? (winLike ? `${mapTo.replace(/[\\/]+$/, '')}\\${rel.split('/').join('\\')}` : path.join(mapTo, rel)) : mapTo;
}

function toItem(rec) {
  const relDir = path.relative(rec.root, path.dirname(rec.path));
  return {
    path: rec.path,
    name: rec.name,
    folder: path.join(path.basename(rec.root), relDir),
    size: rec.size,
    mtime: rec.mtime,
    status: rec.status,
    error: rec.error || null,
    ai: shared.getAi(rec.fp),
    location: displayPath(path.dirname(rec.path)), // as seen from the PCs, e.g. X:\ETSY\Clipart
  };
}

const inLibrary = (p) => typeof p === 'string' && Object.prototype.hasOwnProperty.call(index.data.files, p);
const rootOf = (p) => shared.library.folders.find((r) => isInside(p, r)) || null;
const libraryPayload = () => ({ items: Object.values(index.data.files).map(toItem), dirs, roots: shared.library.folders });
const sendLibrary = () => send('library', libraryPayload());
const sendCollections = () => send('collections', shared.collections);

function editAlbums(edit) {
  try {
    if (shared.editAlbumPaths(edit)) sendCollections();
  } catch (err) {
    log(`Could not update albums: ${err.message}`, 'error');
  }
}

function relocate(from, to) {
  const rec = index.data.files[from];
  if (!rec) return;
  delete index.data.files[from];
  const root = rootOf(to);
  if (root) index.data.files[to] = { ...rec, path: to, name: path.basename(to), root };
  editAlbums((paths) => (root ? paths.map((p) => (p === from ? to : p)) : paths.filter((p) => p !== from)));
}

function forget(p) {
  delete index.data.files[p];
  editAlbums((paths) => paths.filter((x) => x !== p));
}

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

function afterFileOps() {
  index.save();
  sendLibrary();
  scan();
}

// ---------- trash (the NAS has no Windows Recycle Bin) ----------

// Deleted files are moved to <library folder>/.image-library-trash/<time>/<original subfolders>/ and
// removed for good after TRASH_DAYS. The scanner skips folders starting with a dot.
async function moveToTrash(p) {
  const root = rootOf(p);
  if (!root) throw new Error('Not in a library folder');
  const dest = path.join(root, TRASH_DIR_NAME, String(Date.now()), path.relative(root, p));
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const [moved] = await fileops.moveFiles([p], path.dirname(dest));
  if (moved.error) throw new Error(moved.error);
}

async function emptyOldTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
  for (const root of shared.library.folders) {
    const trash = path.join(root, TRASH_DIR_NAME);
    let entries = [];
    try {
      entries = await fsp.readdir(trash);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (/^\d+$/.test(name) && Number(name) < cutoff) {
        await fsp.rm(path.join(trash, name), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
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
      toRecycleBin: true,
      trashItem: moveToTrash,
      log,
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
      let fp;
      try {
        fp = await fingerprint(p, stat.size);
      } catch {
        continue;
      }
      files[p] = { path: p, name: path.basename(p), root, size: stat.size, mtime: stat.mtimeMs, fp, status: 'pending' };
    }
    index.data.files = files;
    reconcileStatuses();
    dirs = foundDirs;

    const reachable = (p) => folders.some((r) => isInside(p, r));
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
        if (filename && (filename.includes(TRASH_DIR_NAME) || /\.(tmp|crdownload|part|partial)$/i.test(filename))) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(scan, 2500);
      });
      w.on('error', (err) => log(`Stopped watching ${path.basename(folder)}: ${err.message}. Periodic rescans continue.`, 'error'));
      watchers.push(w);
    } catch (err) {
      log(`Cannot watch ${folder}: ${err.message}`, 'error');
    }
  }
}

// ---------- AI queue ----------

const queue = [];
const queued = new Set();
let active = 0;
let paused = false;
let client = null;

const apiKey = () => settings.data.apiKey || process.env.ANTHROPIC_API_KEY || null;

function queueStatus() {
  send('status', { analyzing: { queued: queue.length, active, paused, enabled: settings.data.autoAnalyze } });
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

function pump() {
  queueStatus();
  if (paused || !settings.data.autoAnalyze) return;
  if (queue.length && !apiKey()) {
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
      setStatus(rec, 'done');
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
  if (!client) client = createClient(apiKey());
  try {
    const result = await describeImage(client, shared.library.model, await encodeForAi(rec.path), rec.path, rec.root);
    shared.putAi(rec.fp, result);
    for (const other of Object.values(index.data.files)) if (other.fp === rec.fp) setStatus(other, 'done');
  } catch (err) {
    if (err instanceof SkipError) {
      setStatus(rec, 'skipped', err.message);
    } else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      if (!queued.has(rec.path)) {
        queue.unshift(rec.path);
        queued.add(rec.path);
      }
      if (!paused) {
        // Several requests can fail at once; tell people only once.
        log('Claude API key missing or invalid. Add a key in Settings, then press Resume.', 'error');
        send('auth-error');
      }
      paused = true;
    } else if (err instanceof Anthropic.APIError) {
      setStatus(rec, 'error', `API error ${err.status ?? ''}: ${err.message}`);
    } else {
      setStatus(rec, 'error', err.message);
    }
  }
}

// ---------- RPC handlers (same names the desktop app uses) ----------

function publicSettings() {
  return {
    folders: shared.library.folders,
    folderLabels: Object.fromEntries(shared.library.folders.map((f) => [f, displayPath(f)])),
    model: shared.library.model,
    autoAnalyze: settings.data.autoAnalyze,
    extractZips: settings.data.extractZips,
    zipsToRecycleBin: true,
    watchFolders: settings.data.watchFolders,
    concurrency: settings.data.concurrency,
    hasSavedKey: Boolean(settings.data.apiKey),
    hasEnvKey: Boolean(process.env.ANTHROPIC_API_KEY),
    libraryRoot: LIBRARY_ROOT,
    trashDays: TRASH_DAYS,
  };
}

function requireLibraryDir(dir) {
  if (typeof dir !== 'string' || !isInside(path.resolve(dir), LIBRARY_ROOT)) throw new Error('Choose a folder inside the library');
  return path.resolve(dir);
}

let findingDuplicates = false;

const handlers = {
  'library:get': () => libraryPayload(),
  'library:rescan': () => {
    scan();
  },

  'settings:get': () => publicSettings(),
  'settings:set': (patch = {}) => {
    for (const k of ['autoAnalyze', 'extractZips', 'watchFolders', 'concurrency']) if (k in patch) settings.data[k] = patch[k];
    settings.flush();
    if (patch.model && patch.model !== shared.library.model) shared.setModel(patch.model);
    restartWatchers();
    if (patch.extractZips) scan();
    pump();
    return publicSettings();
  },
  'settings:set-api-key': (key) => {
    settings.data.apiKey = String(key || '').trim() || null;
    settings.flush();
    fs.chmodSync(settings.file, 0o600);
    client = null;
    return publicSettings();
  },
  // Folder picker: list subfolders of a folder inside LIBRARY_ROOT.
  'folders:list': async (dir) => {
    const current = dir ? requireLibraryDir(dir) : LIBRARY_ROOT;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    return {
      dir: current,
      display: displayPath(current),
      parent: current === LIBRARY_ROOT ? null : path.dirname(current),
      dirs: entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('@') && e.name !== '#recycle')
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    };
  },
  'settings:add-folder': (dir) => {
    shared.addFolders([requireLibraryDir(dir)]);
    restartWatchers();
    scan();
    return publicSettings();
  },
  'settings:remove-folder': (folder) => {
    shared.removeFolder(folder);
    restartWatchers();
    scan();
    return publicSettings();
  },

  'ai:pause': (value) => {
    paused = Boolean(value);
    if (!paused) client = null;
    pump();
  },
  'ai:reanalyze': (paths = []) => {
    for (const p of paths) {
      const rec = index.data.files[p];
      if (!rec) continue;
      if (shared.getAi(rec.fp)) shared.deleteAi(rec.fp);
      for (const other of Object.values(index.data.files)) if (other.fp === rec.fp) setStatus(other, 'pending');
      if (!queued.has(p)) {
        queue.unshift(p);
        queued.add(p);
      }
    }
    pump();
  },
  'ai:retry-failed': () => {
    for (const rec of Object.values(index.data.files)) if (rec.status === 'error') setStatus(rec, 'pending');
    enqueuePending();
  },

  'collections:get': () => shared.collections,
  'collections:save': (base, next) => {
    const result = shared.saveCollections(base, next);
    sendCollections(); // other open browsers
    return result;
  },

  'folder:create': async (parent, name) => {
    if (!rootOf(parent)) throw new Error('Folders can only be created inside library folders');
    const dir = await fileops.createFolder(parent, name);
    dirs.push(dir);
    sendLibrary();
    return dir;
  },
  'files:move': async (paths = [], destDir) => {
    if (!destDir || !rootOf(destDir)) throw new Error('Choose a folder inside the library');
    const results = await fileops.moveFiles(paths.filter(inLibrary), destDir);
    for (const r of results) if (r.to && r.to !== r.from) relocate(r.from, r.to);
    afterFileOps();
    return results;
  },
  'files:rename': async (plan = []) => {
    const results = await fileops.renameFiles(plan.filter((p) => inLibrary(p.from)));
    for (const r of results) if (r.to) relocate(r.from, r.to);
    afterFileOps();
    return results;
  },
  'files:trash': async (paths = []) => {
    const results = await fileops.recycleFiles(paths.filter(inLibrary), moveToTrash);
    for (const r of results) if (r.deleted) forget(r.from);
    afterFileOps();
    return results;
  },

  'duplicates:find': async ({ similar } = {}) => {
    if (findingDuplicates) throw new Error('Already searching for duplicates');
    findingDuplicates = true;
    let last = 0;
    try {
      const groups = await findDuplicates(Object.values(index.data.files), {
        similar,
        computeDhash: async (rec) => dHash(await thumbs.get(rec)),
        progress: (p) => {
          const now = Date.now();
          if (now - last > 150 || p.done === p.total) {
            last = now;
            send('duplicates-progress', p);
          }
        },
      });
      index.save();
      const out = [];
      for (const g of groups) {
        const items = [];
        for (const p of g.paths.filter(inLibrary)) items.push({ ...toItem(index.data.files[p]), dimensions: await imageSize(p) });
        if (items.length > 1) out.push({ kind: g.kind, items });
      }
      return out;
    } finally {
      findingDuplicates = false;
    }
  },

  'file:display-paths': (paths = []) => paths.filter((p) => inLibrary(p) || rootOf(p)).map(displayPath),
};

// ---------- HTTP ----------

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => res.send('ok')); // before the password check, for Docker's health check

// Optional password (any user name). The browser remembers it for the session.
if (APP_PASSWORD) {
  const expected = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().replace(/^[^:]*:/, '') : '';
    if (crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Image Library", charset="UTF-8"').status(401).send('Password required');
  });
}

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(': connected\n\n');
  clients.add(res);
  queueStatus();
  req.on('close', () => clients.delete(res));
});
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25_000);

app.post('/api/rpc/:name', express.json({ limit: '20mb' }), async (req, res) => {
  const handler = handlers[req.params.name];
  if (!handler) return res.status(404).json({ error: 'Unknown action' });
  try {
    const result = await handler(...(Array.isArray(req.body) ? req.body : []));
    res.json({ result: result === undefined ? null : result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Upload files dropped onto a folder from a PC.
app.put('/api/upload', async (req, res) => {
  const dir = String(req.query.dir || '');
  const name = String(req.query.name || '');
  try {
    if (!rootOf(dir)) throw new Error('Choose a folder inside the library');
    const problem = fileops.validateName(name);
    if (problem) throw new Error(problem);
    let target = path.join(dir, name);
    const ext = path.extname(name);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${path.basename(name, ext)} (${i})${ext}`);
    const tmp = path.join(dir, `.upload-${crypto.randomUUID()}.tmp`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });
    await fsp.rename(tmp, target);
    res.json({ result: { to: target } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Served files are never allowed to run scripts in this site (SVGs can contain them).
function mediaHeaders(res) {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
}

app.get('/media/thumb', async (req, res) => {
  const p = String(req.query.p || '');
  if (!inLibrary(p)) return res.sendStatus(404);
  mediaHeaders(res);
  res.set('Cache-Control', 'no-cache'); // revalidate (cheap 304) so edited images never show a stale thumbnail
  if (/\.(svg|gif)$/i.test(p)) return res.sendFile(p, { dotfiles: 'allow' });
  try {
    res.sendFile(await thumbs.get(index.data.files[p]), { dotfiles: 'allow' });
  } catch {
    res.sendFile(p, { dotfiles: 'allow' });
  }
});

app.get('/media/full', (req, res) => {
  const p = String(req.query.p || '');
  if (!inLibrary(p)) return res.sendStatus(404);
  mediaHeaders(res);
  res.sendFile(p, { dotfiles: 'allow' });
});

app.get('/media/download', (req, res) => {
  const p = String(req.query.p || '');
  if (!inLibrary(p)) return res.sendStatus(404);
  mediaHeaders(res);
  res.download(p, path.basename(p), { dotfiles: 'allow' });
});

// Several files at once, as one zip.
app.get('/media/zip', (req, res) => {
  const paths = [].concat(req.query.p || []).map(String).filter(inLibrary);
  if (!paths.length) return res.sendStatus(404);
  res.attachment(`images-${new Date().toISOString().slice(0, 10)}.zip`);
  const zip = archiver('zip', { store: true }); // images are already compressed
  zip.on('error', () => res.destroy());
  zip.pipe(res);
  const used = new Set();
  for (const p of paths) {
    let name = path.basename(p);
    const ext = path.extname(name);
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${path.basename(p, ext)} (${i})${ext}`;
    used.add(name.toLowerCase());
    zip.file(p, { name });
  }
  zip.finalize();
});

// The desktop interface, with the web adapter in place of the desktop bridge.
app.get(['/', '/index.html'], (_req, res) => {
  const html = fs
    .readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8')
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'" />`)
    .replace('<link rel="stylesheet" href="styles.css" />', '<link rel="stylesheet" href="styles.css" />\n  <link rel="stylesheet" href="web/web.css" />')
    .replace('<script src="search.js"></script>', '<script src="web/api.js"></script>\n  <script src="search.js"></script>');
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});
app.use('/web', express.static(WEB_DIR, { cacheControl: true, maxAge: 0 }));
app.use(express.static(RENDERER_DIR, { index: false, maxAge: 0 }));

// ---------- start ----------

shared.on('error', (err) => log(`Saving descriptions failed, will retry: ${err.message}`, 'error'));
process.on('SIGTERM', () => {
  shared.close();
  settings.flush();
  index.flush();
  process.exit(0);
});

http.createServer(app).listen(PORT, () => {
  console.log(`Image Library listening on port ${PORT} (library: ${LIBRARY_ROOT}, data: ${DATA_DIR})`);
  restartWatchers();
  scan();
  emptyOldTrash();
  setInterval(scan, 15 * 60_000); // safety net if a folder change was missed
  setInterval(emptyOldTrash, 24 * 60 * 60_000);
});
