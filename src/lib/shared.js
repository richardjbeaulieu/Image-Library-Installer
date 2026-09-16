// Library data shared by every PC that points at the same folder (normally on the X: drive):
//   library.json      { folders, model }
//   collections.json  { groups, albums, smart }
//   ai/ai-<0-f>.json  AI descriptions keyed by content fingerprint, sharded by its first hex digit
//   claims.json       which PC is currently describing which image, so two PCs never pay for the same one
//
// Every write happens under a short lock file, re-reads the latest copy from disk, and applies only the
// change being made, so edits from different PCs merge instead of overwriting each other.
// Changes made by other PCs are picked up by polling file timestamps.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const SHARDS = '0123456789abcdef'.split('');
// Saves hold the lock for well under a second. A lock this PC has watched sit unchanged for this long was
// left by a PC that crashed or lost its connection. (Measured on our own clock: the file server's clock
// can be many seconds off from each PC's, so lock file timestamps can't be trusted.)
const LOCK_STALE_MS = 6_000;
const LOCK_WAIT_MS = 10_000;
const CLAIM_TTL_MS = 10 * 60_000;
const POLL_MS = 4_000;
const DEFAULT_LIBRARY = { folders: [], model: 'claude-opus-5' };
const EMPTY_COLLECTIONS = () => ({ groups: [], albums: [], smart: [] });

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sig = (st) => `${st.mtimeMs}:${st.size}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class SharedLibrary extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.me = os.hostname();
    this.known = new Map(); // file -> signature of the version we last read or wrote
    this.library = { ...DEFAULT_LIBRARY };
    this.collections = EMPTY_COLLECTIONS();
    this.ai = {};
    this.pendingAi = new Map();
    this.flushTimer = null;
    this.pollTimer = null;
    this.polling = false;
    fs.mkdirSync(path.join(dir, 'ai'), { recursive: true });
  }

  file(name) {
    return path.join(this.dir, name);
  }

  shardFile(key) {
    return path.join(this.dir, 'ai', `ai-${key}.json`);
  }

  // ---------- low-level file access ----------

  readJson(file, fallback) {
    try {
      const st = fs.statSync(file);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.known.set(file, sig(st));
      return data;
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.known.set(file, 'missing');
        return fallback;
      }
      throw err;
    }
  }

  writeJson(file, data) {
    const tmp = `${file}.${this.me}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (err) {
        // Another PC may be reading the file at this instant; network shares briefly refuse the replace.
        if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        sleepSync(50);
      }
    }
    this.known.set(file, sig(fs.statSync(file)));
  }

  withLock(fn) {
    const lock = this.file('.lock');
    const deadline = Date.now() + LOCK_WAIT_MS;
    const token = `${this.me} ${process.pid} ${Date.now()} ${Math.random()}`;
    let watched = null; // { id, since } for the lock currently in the way
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx');
        fs.writeSync(fd, token);
        fs.closeSync(fd);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          // Each holder writes a unique token, so an unchanged token means the same holder is still there.
          const id = fs.readFileSync(lock, 'utf8');
          if (!watched || watched.id !== id) watched = { id, since: Date.now() };
          else if (Date.now() - watched.since > LOCK_STALE_MS) {
            fs.unlinkSync(lock);
            watched = null;
            continue;
          }
        } catch {
          /* released or replaced meanwhile */
        }
        if (Date.now() > deadline) throw new Error('The shared library is busy (another PC is saving). Please try again.');
        sleepSync(60 + Math.random() * 60);
      }
    }
    try {
      return fn();
    } finally {
      try {
        // Only remove the lock if it is still ours (it could have been taken over after a long network stall).
        if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }

  // Read the latest copy under the lock, let `mutate` change it, write it back. Returns mutate's result.
  update(file, fallback, mutate) {
    return this.withLock(() => {
      const data = this.readJson(file, fallback);
      const result = mutate(data);
      this.writeJson(file, data);
      return { data, result };
    });
  }

  // ---------- loading ----------

  load() {
    this.library = { ...DEFAULT_LIBRARY, ...this.readJson(this.file('library.json'), {}) };
    this.collections = { ...EMPTY_COLLECTIONS(), ...this.readJson(this.file('collections.json'), {}) };
    this.ai = {};
    for (const key of SHARDS) Object.assign(this.ai, this.readJson(this.shardFile(key), {}));
    return this;
  }

  // ---------- library settings ----------

  setModel(model) {
    this.library = this.update(this.file('library.json'), { ...DEFAULT_LIBRARY }, (d) => {
      d.model = model;
    }).data;
  }

  addFolders(folders) {
    this.library = this.update(this.file('library.json'), { ...DEFAULT_LIBRARY }, (d) => {
      d.folders = d.folders || [];
      for (const f of folders) if (!d.folders.some((x) => x.toLowerCase() === f.toLowerCase())) d.folders.push(f);
    }).data;
  }

  removeFolder(folder) {
    this.library = this.update(this.file('library.json'), { ...DEFAULT_LIBRARY }, (d) => {
      d.folders = (d.folders || []).filter((f) => f !== folder);
    }).data;
  }

  // ---------- AI descriptions ----------

  getAi(fp) {
    return fp ? this.ai[fp] || null : null;
  }

  // Results are batched into one write per shard every couple of seconds.
  putAi(fp, result) {
    this.ai[fp] = result;
    this.pendingAi.set(fp, result);
    this.scheduleFlush(2000);
  }

  scheduleFlush(ms) {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      try {
        this.flushAi();
      } catch (err) {
        this.emit('error', err);
        this.scheduleFlush(5000); // network hiccup or busy lock: keep the results and try again
      }
    }, ms);
  }

  flushAi() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pendingAi.size) return;
    const byShard = new Map();
    for (const [fp, result] of this.pendingAi) {
      const key = fp[0];
      if (!byShard.has(key)) byShard.set(key, {});
      byShard.get(key)[fp] = result;
    }
    for (const [key, entries] of byShard) {
      const { data } = this.update(this.shardFile(key), {}, (d) => Object.assign(d, entries));
      this.replaceShard(key, data);
      for (const fp of Object.keys(entries)) this.pendingAi.delete(fp);
    }
    this.releaseClaims([...byShard.values()].flatMap((e) => Object.keys(e)));
  }

  deleteAi(fp) {
    delete this.ai[fp];
    this.pendingAi.delete(fp);
    const { data } = this.update(this.shardFile(fp[0]), {}, (d) => {
      delete d[fp];
    });
    this.replaceShard(fp[0], data);
  }

  replaceShard(key, data) {
    for (const fp of Object.keys(this.ai)) if (fp[0] === key && !this.pendingAi.has(fp)) delete this.ai[fp];
    Object.assign(this.ai, data);
    for (const [fp, result] of this.pendingAi) this.ai[fp] = result;
  }

  // ---------- claims ----------

  // True if this PC may describe the image now; false if another PC is already on it.
  claim(fp) {
    try {
      return this.update(this.file('claims.json'), {}, (d) => {
        const now = Date.now();
        for (const [k, c] of Object.entries(d)) if (now - c.at > CLAIM_TTL_MS) delete d[k];
        if (d[fp] && d[fp].pc !== this.me) return false;
        d[fp] = { pc: this.me, at: now };
        return true;
      }).result;
    } catch {
      return true; // if the claim can't be recorded, describing twice is better than never
    }
  }

  releaseClaims(fps) {
    if (!fps.length) return;
    try {
      this.update(this.file('claims.json'), {}, (d) => {
        for (const fp of fps) if (d[fp] && d[fp].pc === this.me) delete d[fp];
      });
    } catch {
      /* claims expire on their own */
    }
  }

  // ---------- collections ----------

  // Apply the edit the user made (base -> next, as seen by that window) onto the latest shared copy.
  saveCollections(base, next) {
    this.collections = this.update(this.file('collections.json'), EMPTY_COLLECTIONS(), (disk) => {
      for (const kind of ['groups', 'albums', 'smart']) {
        const before = new Map((base[kind] || []).map((x) => [x.id, x]));
        const after = new Map((next[kind] || []).map((x) => [x.id, x]));
        let list = (disk[kind] || []).filter((x) => !(before.has(x.id) && !after.has(x.id)));
        for (const item of next[kind] || []) {
          const old = before.get(item.id);
          const i = list.findIndex((x) => x.id === item.id);
          if (!old) {
            if (i === -1) list.push(item);
            continue;
          }
          if (same(old, item) || i === -1) continue; // unchanged here, or deleted on another PC meanwhile
          const merged = { ...list[i] };
          for (const key of Object.keys(item)) {
            if (key !== 'paths' && !same(item[key], old[key])) merged[key] = item[key];
          }
          if (kind === 'albums') {
            const oldPaths = new Set(old.paths);
            const newPaths = new Set(item.paths);
            const removed = new Set(old.paths.filter((p) => !newPaths.has(p)));
            const kept = (merged.paths || []).filter((p) => !removed.has(p));
            const keptSet = new Set(kept);
            merged.paths = [...kept, ...item.paths.filter((p) => !oldPaths.has(p) && !keptSet.has(p))];
          }
          list[i] = merged;
        }
        disk[kind] = list;
      }
    }).data;
    return this.collections;
  }

  // Direct edit of album paths (used when files are moved, renamed, or deleted).
  editAlbumPaths(edit) {
    // Check the copy in memory first so routine scans don't rewrite the shared file for nothing.
    if ((this.collections.albums || []).every((a) => same(edit(a.paths), a.paths))) return false;
    let changed = false;
    this.collections = this.update(this.file('collections.json'), EMPTY_COLLECTIONS(), (disk) => {
      for (const album of disk.albums || []) {
        const nextPaths = edit(album.paths);
        if (!same(nextPaths, album.paths)) {
          album.paths = nextPaths;
          changed = true;
        }
      }
    }).data;
    return changed;
  }

  // ---------- one-time import of data this PC kept locally before sharing existed ----------

  importLegacy({ folders = [], model, ai = {}, collections }) {
    const fallback = { ...DEFAULT_LIBRARY, folders: [] };
    this.update(this.file('library.json'), fallback, (d) => {
      const fresh = d === fallback; // decided under the lock: no other PC has created the library yet
      d.folders = d.folders || [];
      for (const f of folders) if (!d.folders.some((x) => x.toLowerCase() === f.toLowerCase())) d.folders.push(f);
      if (fresh && model) d.model = model;
    });
    const byShard = new Map();
    for (const [fp, result] of Object.entries(ai)) {
      if (!byShard.has(fp[0])) byShard.set(fp[0], {});
      byShard.get(fp[0])[fp] = result;
    }
    for (const [key, entries] of byShard) {
      this.update(this.shardFile(key), {}, (d) => {
        for (const [fp, result] of Object.entries(entries)) if (!d[fp]) d[fp] = result;
      });
    }
    if (collections) {
      this.update(this.file('collections.json'), EMPTY_COLLECTIONS(), (d) => {
        for (const kind of ['groups', 'albums', 'smart']) {
          d[kind] = d[kind] || [];
          for (const item of collections[kind] || []) if (!d[kind].some((x) => x.id === item.id)) d[kind].push(item);
        }
      });
    }
    return this.load();
  }

  // ---------- noticing other PCs' changes ----------

  startPolling() {
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const watched = [
        ['library', this.file('library.json')],
        ['collections', this.file('collections.json')],
        ...SHARDS.map((k) => [`ai:${k}`, this.shardFile(k)]),
      ];
      const changed = new Set();
      for (const [kind, file] of watched) {
        let current;
        try {
          current = sig(await fsp.stat(file));
        } catch {
          current = 'missing';
        }
        if (current === this.known.get(file)) continue;
        try {
          if (kind === 'library') this.library = { ...DEFAULT_LIBRARY, ...this.readJson(file, {}) };
          else if (kind === 'collections') this.collections = { ...EMPTY_COLLECTIONS(), ...this.readJson(file, {}) };
          else this.replaceShard(kind.slice(3), this.readJson(file, {}));
          changed.add(kind.startsWith('ai:') ? 'ai' : kind);
        } catch {
          /* caught mid-write; try again next poll */
        }
      }
      for (const kind of changed) this.emit('change', kind);
    } finally {
      this.polling = false;
    }
  }

  close() {
    clearInterval(this.pollTimer);
    try {
      this.flushAi();
    } catch {
      /* best effort on exit */
    }
  }
}

module.exports = { SharedLibrary };
