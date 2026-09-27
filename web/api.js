// Web adapter: gives the shared interface (src/renderer/app.js) the same `window.api` the desktop app's
// preload provides, backed by the Image Library server instead of Electron.
(() => {
  document.body.classList.add('web');

  const DRAG_TYPE = 'application/x-image-library-paths';
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif' };
  const baseName = (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  const mimeOf = (p) => MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const mediaUrl = (kind, p) => `media/${kind}?p=${encodeURIComponent(p)}`;
  const absolute = (url) => new URL(url, location.href).href;

  async function rpc(name, ...args) {
    const res = await fetch(`api/rpc/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body.result;
  }

  // ---------- live updates from the server ----------
  const listeners = new Map();
  const on = (channel) => (fn) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel).delete(fn);
  };
  const emit = (channel, payload) => (listeners.get(channel) || []).forEach((fn) => fn(payload));

  let lostConnection = false;
  const events = new EventSource('api/events');
  events.onmessage = (e) => {
    const { channel, payload } = JSON.parse(e.data);
    emit(channel, payload);
  };
  events.onerror = () => {
    if (!lostConnection) emit('log', { message: 'Lost connection to the Image Library server. Reconnecting…', level: 'error', at: Date.now() });
    lostConnection = true;
  };
  events.onopen = async () => {
    if (!lostConnection) return;
    lostConnection = false;
    // Catch up on anything that changed while disconnected.
    emit('library', await rpc('library:get'));
    emit('collections', await rpc('collections:get'));
  };

  // ---------- browser helpers ----------
  function download(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function copyText(text) {
    if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
    // Plain http:// pages can't use the clipboard API; the older copy command still works for text.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Could not copy to the clipboard');
  }

  async function copyImage(p) {
    if (!window.isSecureContext || !navigator.clipboard || !window.ClipboardItem) {
      throw new Error('Copy image needs the secure (https://) address of Image Library. For now, use Download or drag the image.');
    }
    // Browsers only accept PNG image data on the clipboard, so convert whatever the file is.
    const png = (async () => {
      const blob = await (await fetch(mediaUrl('full', p))).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert image'))), 'image/png'));
    })();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }

  // ---------- folder picker (replaces the desktop folder dialog) ----------
  function pickFolder(title) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'dialog picker';
      dlg.innerHTML = `
        <h2></h2>
        <div class="picker-path"><button type="button" class="picker-up" title="Up one level">↑</button><span class="picker-current"></span></div>
        <ul class="picker-list"></ul>
        <div class="dialog-actions"><button type="button" class="picker-cancel">Cancel</button><button type="button" class="primary picker-ok">Add this folder</button></div>`;
      dlg.querySelector('h2').textContent = title;
      document.body.append(dlg);
      let current = null;
      const finish = (value) => {
        dlg.close();
        dlg.remove();
        resolve(value);
      };
      const load = async (dir) => {
        try {
          const listing = await rpc('folders:list', dir);
          current = listing;
          dlg.querySelector('.picker-current').textContent = listing.display;
          dlg.querySelector('.picker-up').disabled = !listing.parent;
          const list = dlg.querySelector('.picker-list');
          list.replaceChildren(
            ...listing.dirs.map((name) => {
              const li = document.createElement('li');
              const b = document.createElement('button');
              b.type = 'button';
              b.textContent = `▭  ${name}`;
              b.onclick = () => load(`${listing.dir}/${name}`);
              li.append(b);
              return li;
            }),
          );
          if (!listing.dirs.length) list.innerHTML = '<li class="picker-empty">No subfolders</li>';
        } catch (err) {
          emit('log', { message: err.message, level: 'error', at: Date.now() });
        }
      };
      dlg.querySelector('.picker-up').onclick = () => current && current.parent && load(current.parent);
      dlg.querySelector('.picker-cancel').onclick = () => finish(null);
      dlg.querySelector('.picker-ok').onclick = () => finish(current && current.dir);
      dlg.addEventListener('cancel', () => finish(null));
      dlg.showModal();
      load(null);
    });
  }

  // ---------- the api the interface calls ----------
  window.api = {
    web: true,
    dragType: DRAG_TYPE,
    mediaUrl,

    getLibrary: () => rpc('library:get'),
    rescan: () => rpc('library:rescan'),

    getSettings: () => rpc('settings:get'),
    setSettings: (patch) => rpc('settings:set', patch),
    setApiKey: (key) => rpc('settings:set-api-key', key),
    addFolder: async () => {
      const dir = await pickFolder('Add a folder to the library');
      return dir ? rpc('settings:add-folder', dir) : rpc('settings:get');
    },
    removeFolder: (folder) => rpc('settings:remove-folder', folder),
    changeDataDir: async () => null,
    pickFolder: (title) => pickFolder(title),

    pauseAi: (paused) => rpc('ai:pause', paused),
    reanalyze: (paths) => rpc('ai:reanalyze', paths),
    retryFailed: () => rpc('ai:retry-failed'),

    getCollections: () => rpc('collections:get'),
    saveCollections: (base, next) => rpc('collections:save', base, next),

    createFolder: (parent, name) => rpc('folder:create', parent, name),
    moveFiles: (paths, destDir) => rpc('files:move', paths, destDir),
    renameFiles: (plan) => rpc('files:rename', plan),
    trashFiles: (paths) => rpc('files:trash', paths),
    findDuplicates: (opts) => rpc('duplicates:find', opts),
    removeBackground: (paths, opts) => rpc('images:remove-background', paths, opts),
    // Returns { url, percent }: a picture of the result, and how much of it would be cleared.
    removeBackgroundPreview: async (p, opts) => {
      const url = `media/remove-bg-preview?p=${encodeURIComponent(p)}&tolerance=${opts.tolerance}&feather=${opts.feather ? 1 : 0}&inside=${opts.insideToo ? 1 : 0}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      return { url: URL.createObjectURL(await res.blob()), percent: Number(res.headers.get('X-Cleared-Percent')) };
    },

    // Files dropped in from the PC are uploaded into the folder.
    uploadFiles: async (files, dir) => {
      const results = [];
      for (const file of files) {
        try {
          const res = await fetch(`api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, { method: 'PUT', body: file });
          const body = await res.json().catch(() => ({ error: res.statusText }));
          if (!res.ok) throw new Error(body.error);
          results.push({ from: file.name, to: body.result.to });
        } catch (err) {
          results.push({ from: file.name, error: err.message });
        }
      }
      rpc('library:rescan');
      return results;
    },
    pathForFile: () => '',

    // Dragging out of the browser: Chrome and Edge turn DownloadURL into a real file when dropped on
    // the desktop or a folder; web apps like Canva receive the image itself.
    prepareDrag: (dataTransfer, paths, img) => {
      dataTransfer.effectAllowed = 'copyMove';
      dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
      if (paths.length === 1) {
        const p = paths[0];
        const safeName = baseName(p).replace(/:/g, '_');
        dataTransfer.setData('DownloadURL', `${mimeOf(p)}:${safeName}:${absolute(mediaUrl('download', p))}`);
        dataTransfer.setData('text/uri-list', absolute(mediaUrl('full', p)));
        dataTransfer.setData('text/plain', absolute(mediaUrl('full', p)));
      } else {
        const zipUrl = absolute(`media/zip?${paths.map((p) => `p=${encodeURIComponent(p)}`).join('&')}`);
        dataTransfer.setData('DownloadURL', `application/zip:images.zip:${zipUrl}`);
      }
      if (img) dataTransfer.setDragImage(img, 16, 16);
    },
    startDrag: () => {},

    copyFiles: async (paths) => {
      if (paths.length === 1) download(mediaUrl('download', paths[0]));
      else download(`media/zip?${paths.map((p) => `p=${encodeURIComponent(p)}`).join('&')}`);
    },
    copyImage,
    copyPaths: async (paths) => copyText((await rpc('file:display-paths', paths)).join('\r\n')),
    showInFolder: async (p) => {
      const [shown] = await rpc('file:display-paths', [p]);
      await copyText(shown.slice(0, Math.max(shown.lastIndexOf('\\'), shown.lastIndexOf('/'))));
    },
    openFolder: async (dir) => copyText((await rpc('file:display-paths', [dir]))[0]),
    openFile: async (p) => {
      window.open(mediaUrl('full', p), '_blank', 'noopener');
    },

    onLibrary: on('library'),
    onItem: on('item'),
    onStatus: on('status'),
    onLog: on('log'),
    onAuthError: on('auth-error'),
    onDuplicatesProgress: on('duplicates-progress'),
    onCollections: on('collections'),
    onSettingsChanged: on('settings-changed'),
  };
})();
