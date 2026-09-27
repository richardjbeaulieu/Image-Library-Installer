// Persists settings and the image index as JSON files in the app's userData folder.
const fs = require('fs');
const path = require('path');

// Settings that belong to this PC only. The folder list and model are shared (see shared.js);
// `folders` and `model` here are only read once, to import them into the shared library.
const DEFAULT_SETTINGS = {
  dataDir: null, // shared library data folder; null means "library-data" next to the app
  migratedTo: null, // shared folder this PC's older local data was already imported into
  apiKeyEnc: null, // API key encrypted with Electron safeStorage (base64), valid only for this Windows user
  autoAnalyze: true,
  extractZips: true,
  zipsToRecycleBin: true, // delete zips by moving them to the Recycle Bin (recoverable)
  watchFolders: true,
  concurrency: 3,
};

class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.data = defaults;
    this.timer = null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      this.data = { ...defaults, ...JSON.parse(raw) };
    } catch {
      // First run or unreadable file: start from defaults.
    }
  }

  // Coalesce frequent updates into one write; write via temp file + rename so a crash never corrupts it.
  save(delay = 1000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

function openStores(userDataDir) {
  const settings = new JsonFile(path.join(userDataDir, 'settings.json'), { ...DEFAULT_SETTINGS });
  // files: { [absPath]: FileRecord } is this PC's scan cache. (`ai` and collections.json are pre-sharing leftovers,
  // imported once into the shared library.)
  const index = new JsonFile(path.join(userDataDir, 'index.json'), { files: {}, ai: {} });
  const legacyCollections = new JsonFile(path.join(userDataDir, 'collections.json'), { groups: [], albums: [], smart: [] });
  // Which zip each extracted file came from: { [path]: { zip, pack, at } }.
  const origins = new JsonFile(path.join(userDataDir, 'origins.json'), { files: {} });
  return { settings, index, legacyCollections, origins };
}

module.exports = { openStores, JsonFile };
