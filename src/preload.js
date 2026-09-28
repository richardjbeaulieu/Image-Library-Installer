const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  rescan: () => ipcRenderer.invoke('library:rescan'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setApiKey: (key) => ipcRenderer.invoke('settings:set-api-key', key),
  addFolder: () => ipcRenderer.invoke('settings:add-folder'),
  removeFolder: (folder) => ipcRenderer.invoke('settings:remove-folder', folder),

  pauseAi: (paused) => ipcRenderer.invoke('ai:pause', paused),
  reanalyze: (paths) => ipcRenderer.invoke('ai:reanalyze', paths),
  retryFailed: () => ipcRenderer.invoke('ai:retry-failed'),

  getCollections: () => ipcRenderer.invoke('collections:get'),
  saveCollections: (base, next) => ipcRenderer.invoke('collections:save', base, next),
  changeDataDir: () => ipcRenderer.invoke('settings:change-data-dir'),

  createFolder: (parent, name) => ipcRenderer.invoke('folder:create', parent, name),
  moveFiles: (paths, destDir) => ipcRenderer.invoke('files:move', paths, destDir),
  moveFolder: (fromDir, destDir) => ipcRenderer.invoke('folder:move', fromDir, destDir),
  importFiles: (paths, destDir) => ipcRenderer.invoke('files:import', paths, destDir),
  renameFiles: (plan) => ipcRenderer.invoke('files:rename', plan),
  trashFiles: (paths) => ipcRenderer.invoke('files:trash', paths),
  findDuplicates: (opts) => ipcRenderer.invoke('duplicates:find', opts),
  // Files dropped onto the window (from this app or Explorer) -> absolute paths.
  pathForFile: (file) => webUtils.getPathForFile(file),

  startDrag: (paths) => ipcRenderer.send('file:drag', paths),
  copyFiles: (paths) => ipcRenderer.invoke('file:copy', paths),
  copyImage: (path) => ipcRenderer.invoke('file:copy-image', path),
  copyPaths: (paths) => ipcRenderer.invoke('file:copy-path', paths),
  showInFolder: (path) => ipcRenderer.invoke('file:show', path),
  openFile: (path) => ipcRenderer.invoke('file:open', path),
  openFolder: (dir) => ipcRenderer.invoke('folder:show', dir),
  chooseFolder: (title) => ipcRenderer.invoke('folder:choose', title),

  onLibrary: on('library'),
  onItem: on('item'),
  onStatus: on('status'),
  onLog: on('log'),
  onAuthError: on('auth-error'),
  onDuplicatesProgress: on('duplicates-progress'),
  onCollections: on('collections'),
  onSettingsChanged: on('settings-changed'),
});
