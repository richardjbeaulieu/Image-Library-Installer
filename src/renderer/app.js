/* global Search */
const api = window.api;
const $ = (sel) => document.querySelector(sel);

// ---------- state ----------
let items = [];
let byPath = new Map();
let dirs = [];
let roots = [];
let collections = { groups: [], albums: [], smart: [] };
// Collections as last received from the main process; saves send (base, edited) so only the edit is applied.
let collectionsBase = structuredClone(collections);
let settings = {};
let source = { type: 'all' };
let visible = [];
let selected = new Set();
let anchorIndex = -1;
let focusPath = null;
let rendered = 0;
const PAGE = 240;
const logLines = [];

const prefs = loadPrefs();
let chips = [];
let statusFilter = '';
let detailOpen = prefs.detailOpen !== false;
let sidebarOpen = prefs.sidebarOpen !== false;
const RECENT_DAYS = 14;

// Thumbnail aspect ratios, learned as images load, so the justified grid lays out without jumping next time.
const ratios = new Map(Object.entries(loadJson('ratios')));
let ratiosTimer;
function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
}
function saveRatios() {
  clearTimeout(ratiosTimer);
  ratiosTimer = setTimeout(() => {
    try {
      localStorage.setItem('ratios', JSON.stringify(Object.fromEntries(ratios)));
    } catch {
      /* storage unavailable */
    }
  }, 1000);
}
const expandedDirs = new Set(prefs.expandedDirs || []);
const collapsedGroups = new Set(prefs.collapsedGroups || []);

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem('prefs') || '{}');
  } catch {
    return {};
  }
}
function savePrefs() {
  try {
    localStorage.setItem('prefs', JSON.stringify({
      zoom: $('#zoom').value,
      sort: $('#sort').value,
      expandedDirs: [...expandedDirs],
      collapsedGroups: [...collapsedGroups],
      detailOpen,
      sidebarOpen,
    }));
  } catch {
    /* storage unavailable */
  }
}

// ---------- small helpers ----------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}
const uid = () => crypto.randomUUID();
const mediaUrl = (kind, p) => `media://${kind}/${encodeURIComponent(p)}`;
const sep = (p) => (p.includes('\\') ? '\\' : '/');
const dirname = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const basename = (p) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
const splitExt = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
};
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const isoDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function rootFor(p) {
  const lp = p.toLowerCase();
  return roots.find((r) => lp === r.toLowerCase() || lp.startsWith(r.toLowerCase() + sep(r))) || null;
}
function displayDir(d) {
  const r = rootFor(d);
  return r ? basename(r) + d.slice(r.length) : d;
}

function toast(message, isError = false) {
  const t = el('div', { class: `toast${isError ? ' error' : ''}`, text: message });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), isError ? 6000 : 2600);
}

async function attempt(fn, success) {
  try {
    const result = await fn();
    if (success) toast(typeof success === 'function' ? success(result) : success);
    return result;
  } catch (err) {
    toast(cleanError(err), true);
    return undefined;
  }
}
const cleanError = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function reportResults(results, verb) {
  if (!results) return;
  const failed = results.filter((r) => r.error);
  const ok = results.length - failed.length;
  if (ok) toast(`${verb} ${plural(ok, 'file')}`);
  if (failed.length) toast(`${failed.length} failed:\n${failed.slice(0, 3).map((f) => `${basename(f.from)}: ${f.error}`).join('\n')}`, true);
}

// ---------- ask / confirm dialog ----------
function ask({ title, text = '', input = null, options = null, okText = 'OK', danger = false }) {
  const dlg = $('#ask');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text;
  $('#ask-text').hidden = !text;
  const inp = $('#ask-input');
  const selEl = $('#ask-select');
  inp.hidden = input == null;
  inp.value = input ?? '';
  selEl.hidden = !options;
  selEl.replaceChildren(...(options || []).map((o) => el('option', { value: o.value, text: o.label })));
  const ok = $('#ask-ok');
  ok.textContent = okText;
  ok.className = danger ? 'danger' : 'primary';
  dlg.returnValue = '';
  dlg.showModal();
  if (input != null) {
    inp.focus();
    const [base] = splitExt(inp.value);
    inp.setSelectionRange(0, base.length);
  } else if (options) selEl.focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', function onClose() {
      dlg.removeEventListener('close', onClose);
      if (dlg.returnValue !== 'ok') return resolve(null);
      if (input != null) return resolve(inp.value.trim() || null);
      if (options) return resolve(selEl.value);
      resolve(true);
    });
  });
}

// Enter in a dialog text field presses that dialog's main button (not the first button, Cancel).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement) || e.target.type === 'checkbox') return;
  const dlg = e.target.closest('dialog');
  const main = dlg && dlg.querySelector('.dialog-actions button[value="ok"]');
  if (main) {
    e.preventDefault();
    main.click();
  }
});

// ---------- filtering and rendering ----------
const TOKEN_RE = /-?(?:\w+:)?(?:"[^"]*"|\S+)/g;
const getQuery = () => [...chips, $('#search').value].join(' ').trim();

function renderChips() {
  $('#chips').replaceChildren(...chips.map((c, i) => el('span', { class: `chip${c.startsWith('-') ? ' neg' : ''}`, title: c }, [
    el('span', { class: 't', text: c.replace(/"/g, '') }),
    el('button', { title: 'Remove', text: '×', onclick: (e) => {
      e.stopPropagation();
      chips.splice(i, 1);
      renderChips();
      refresh();
    } }),
  ])));
  $('#search').placeholder = chips.length ? '' : 'Search images, press Enter to add a term';
  $('#search-clear').hidden = !chips.length && !$('#search').value;
}

function commitSearchText() {
  const tokens = $('#search').value.match(TOKEN_RE) || [];
  if (!tokens.length) return false;
  for (const t of tokens) if (!chips.includes(t)) chips.push(t);
  $('#search').value = '';
  renderChips();
  return true;
}

function inSource(item) {
  switch (source.type) {
    case 'recent':
      return item.mtime >= Date.now() - RECENT_DAYS * 86400000;
    case 'unanalyzed':
      return item.status !== 'done';
    case 'folder':
      return Search.isUnder(item.path, source.path);
    case 'album': {
      const album = collections.albums.find((a) => a.id === source.id);
      return Boolean(album && album.pathSet.has(item.path));
    }
    case 'smart': {
      const smart = collections.smart.find((s) => s.id === source.id);
      return Boolean(smart && Search.matchesRules(item, smart.rules, smart.parsed));
    }
    default:
      return true;
  }
}

function prepareCollections() {
  for (const a of collections.albums) Object.defineProperty(a, 'pathSet', { value: new Set(a.paths), writable: true, configurable: true });
  for (const s of collections.smart) Object.defineProperty(s, 'parsed', { value: Search.parseQuery(s.rules.query), writable: true, configurable: true });
}

function refresh({ keepScroll = false } = {}) {
  const terms = Search.parseQuery(getQuery());
  const status = statusFilter;
  const sort = $('#sort').value;
  const scored = [];
  for (const item of items) {
    if (status && item.status !== status) continue;
    if (!inSource(item)) continue;
    const s = Search.score(item, terms);
    if (s < 0) continue;
    scored.push([item, s]);
  }
  const byName = (a, b) => a[0].name.localeCompare(b[0].name, undefined, { numeric: true });
  const sorters = {
    relevance: (a, b) => (terms.length ? b[1] - a[1] : 0) || b[0].mtime - a[0].mtime,
    newest: (a, b) => b[0].mtime - a[0].mtime,
    name: byName,
    folder: (a, b) => a[0].folder.localeCompare(b[0].folder) || byName(a, b),
    size: (a, b) => b[0].size - a[0].size,
  };
  scored.sort(sorters[sort] || sorters.relevance);
  visible = scored.map((x) => x[0]);

  const scrollTop = $('#scroller').scrollTop;
  $('#grid').replaceChildren();
  rendered = 0;
  appendPage();
  while (keepScroll && rendered < visible.length && $('#grid').scrollHeight < scrollTop + innerHeight) appendPage();
  if (keepScroll) $('#scroller').scrollTop = scrollTop;
  else $('#scroller').scrollTop = 0;

  $('#empty').hidden = roots.length > 0;
  $('#no-results').hidden = roots.length === 0 || visible.length > 0;
  $('#no-results-text').textContent = source.type === 'album' && !terms.length ? 'This album is empty. Select images and choose "Add to album", or drag them onto the album.' : 'No images match.';
  renderViewbar();
  updateCount();
}

function appendPage() {
  const frag = document.createDocumentFragment();
  const end = Math.min(visible.length, rendered + PAGE);
  for (let i = rendered; i < end; i++) frag.append(card(visible[i]));
  rendered = end;
  $('#grid').append(frag);
}

new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && rendered < visible.length) appendPage();
}, { root: $('#scroller'), rootMargin: '800px' }).observe($('#sentinel'));

function card(item) {
  const ai = item.ai;
  let badge = null;
  if (item.status === 'pending') badge = el('span', { class: 'badge', text: 'AI…' });
  else if (item.status === 'error') badge = el('span', { class: 'badge error', text: 'AI failed', title: item.error });
  const key = `${item.path}|${item.mtime}`;
  const img = el('img', { src: mediaUrl('thumb', item.path), loading: 'lazy', draggable: 'false', alt: '' });
  const node = el('div', {
    class: `tile${selected.has(item.path) ? ' selected' : ''}${/\.(png|svg|gif|webp)$/i.test(item.name) ? ' checker' : ''}`,
    draggable: 'true',
    dataset: { path: item.path },
    title: ai ? `${ai.title}\n${item.name}` : item.name,
  }, [img, el('div', { class: 'cap', text: ai ? ai.title : item.name }), badge]);
  const known = ratios.get(key);
  if (known) node.style.setProperty('--r', known);
  img.addEventListener('load', () => {
    if (!img.naturalHeight) return;
    const r = Math.min(4, Math.max(0.25, img.naturalWidth / img.naturalHeight));
    if (known && Math.abs(known - r) < 0.01) return;
    node.style.setProperty('--r', r.toFixed(3));
    ratios.set(key, Number(r.toFixed(3)));
    saveRatios();
  });
  return node;
}

function cardFor(p) {
  return [...$('#grid').children].find((c) => c.dataset.path === p) || null;
}

function renderViewbar() {
  let title = 'All Images';
  if (source.type === 'recent') title = 'Recently Added';
  if (source.type === 'unanalyzed') title = 'Not Yet Described';
  if (source.type === 'folder') title = displayDir(source.path);
  if (source.type === 'album') title = collections.albums.find((a) => a.id === source.id)?.name || 'Album';
  if (source.type === 'smart') title = collections.smart.find((s) => s.id === source.id)?.name || 'Smart collection';
  const searching = Boolean(getQuery() || statusFilter);
  $('#view-title').replaceChildren(...(searching ? [el('em', { text: 'Results in ' }), title] : [title]));
  const total = items.filter(inSource).length;
  $('#view-sub').textContent = searching ? `${visible.length.toLocaleString()} of ${plural(total, 'image')}` : plural(visible.length, 'image');
  $('#edit-smart').hidden = source.type !== 'smart';
}

function updateCount() {
  const pending = items.filter((i) => i.status === 'pending').length;
  $('#count').textContent = `${pending ? `${pending.toLocaleString()} waiting for AI` : ''}`;
  $('#n-all').textContent = items.length.toLocaleString();
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  $('#n-recent').textContent = items.filter((i) => i.mtime >= cutoff).length.toLocaleString();
  $('#n-unanalyzed').textContent = items.filter((i) => i.status !== 'done').length.toLocaleString();
}

// ---------- selection ----------
function setSelection(paths, anchor) {
  selected = new Set(paths);
  if (anchor !== undefined) anchorIndex = anchor;
  for (const c of $('#grid').children) c.classList.toggle('selected', selected.has(c.dataset.path));
  renderSelbar();
}

function renderSelbar() {
  const n = selected.size;
  $('#selbar').hidden = n === 0;
  $('#sel-count').textContent = `${n.toLocaleString()} selected`;
  $('#selbar [data-action="remove-from-album"]').hidden = source.type !== 'album';
}

const selectedPaths = () => visible.filter((i) => selected.has(i.path)).map((i) => i.path);

$('#grid').addEventListener('click', (e) => {
  const c = e.target.closest('.tile');
  if (!c) return;
  const p = c.dataset.path;
  const idx = visible.findIndex((i) => i.path === p);
  if (e.shiftKey && anchorIndex >= 0) {
    const [a, b] = [Math.min(anchorIndex, idx), Math.max(anchorIndex, idx)];
    const range = visible.slice(a, b + 1).map((i) => i.path);
    setSelection(e.ctrlKey ? [...selected, ...range] : range);
  } else if (e.ctrlKey || e.metaKey) {
    const next = new Set(selected);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setSelection(next, idx);
  } else {
    setSelection([p], idx);
    showDetail(p);
  }
});
$('#scroller').addEventListener('click', (e) => {
  if (e.target === $('#scroller') || e.target === $('#grid')) setSelection([]);
});
$('#grid').addEventListener('dblclick', (e) => {
  const c = e.target.closest('.tile');
  if (c) api.openFile(c.dataset.path);
});
$('#grid').addEventListener('contextmenu', (e) => {
  const c = e.target.closest('.tile');
  if (!c) return;
  e.preventDefault();
  if (!selected.has(c.dataset.path)) {
    setSelection([c.dataset.path], visible.findIndex((i) => i.path === c.dataset.path));
    showDetail(c.dataset.path);
  }
  showItemMenu(e.clientX, e.clientY, selectedPaths());
});

// Native OS drag so the files can be dropped into Canva, Photoshop, Explorer, or onto a sidebar folder/album.
$('#grid').addEventListener('dragstart', (e) => {
  const c = e.target.closest('.tile');
  if (!c) return;
  e.preventDefault();
  if (!selected.has(c.dataset.path)) setSelection([c.dataset.path], visible.findIndex((i) => i.path === c.dataset.path));
  api.startDrag(selectedPaths());
});
$('#detail-preview').addEventListener('dragstart', (e) => {
  e.preventDefault();
  if (focusPath) api.startDrag([focusPath]);
});

// ---------- detail panel ----------
function showDetail(p) {
  focusPath = p;
  const item = byPath.get(p);
  $('#detail').hidden = !detailOpen;
  $('#rail-info').classList.toggle('on', detailOpen);
  $('#detail-empty').hidden = Boolean(item);
  $('#detail-body').hidden = !item;
  if (!item) return;
  const img = $('#detail-preview');
  const src = mediaUrl('full', p);
  if (img.getAttribute('src') !== src) img.src = src;
  const ai = item.ai;
  $('#detail-title').textContent = ai ? ai.title : item.name;
  $('#detail-desc').textContent = ai ? ai.description : item.status === 'pending' ? 'Waiting for AI analysis…' : '';
  $('#detail-tags').replaceChildren(...(ai ? ai.tags : []).map((t) => el('span', { class: 'tag', text: t, title: 'Search for this tag', onclick: () => searchFor(`tag:"${t}"`) })));

  const meta = [];
  const add = (k, v, cls) => v && meta.push(el('dt', { text: k }), el('dd', { text: v, class: cls }));
  add('File', item.name);
  add('Folder', dirname(item.path));
  add('Size', fmtSize(item.size));
  add('Modified', fmtDate(item.mtime));
  if (ai) {
    add('Category', ai.category);
    add('Style', ai.style);
    add('Colors', ai.colors.join(', '));
    add('Mood', ai.mood);
    add('Text', ai.text_in_image);
  }
  if (item.status === 'error' || item.status === 'skipped') add(item.status === 'error' ? 'AI error' : 'AI', item.error, 'err');
  $('#detail-meta').replaceChildren(...meta);

  const inAlbums = collections.albums.filter((a) => a.pathSet.has(p));
  $('#detail-albums-wrap').hidden = inAlbums.length === 0;
  $('#detail-albums').replaceChildren(...inAlbums.map((a) => el('span', { class: 'tag album', text: `▣ ${a.name}`, title: 'Open album', onclick: () => setSource({ type: 'album', id: a.id }) })));
}

function searchFor(q) {
  chips = q.match(TOKEN_RE) || [];
  $('#search').value = '';
  renderChips();
  refresh();
}

function setDetailOpen(open) {
  detailOpen = open;
  savePrefs();
  showDetail(focusPath);
}
$('#detail-close').addEventListener('click', () => setDetailOpen(false));
$('#rail-info').addEventListener('click', () => setDetailOpen(!detailOpen));
$('#rail-add').addEventListener('click', () => addRootFolder());
function setSidebarOpen(open) {
  sidebarOpen = open;
  $('#sidebar').hidden = !open;
  $('#rail-library').classList.toggle('on', open);
  savePrefs();
}
$('#rail-library').addEventListener('click', () => setSidebarOpen(!sidebarOpen));
$('#detail').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-action]');
  if (b && focusPath) runAction(b.dataset.action, [focusPath]);
});

// ---------- actions ----------
async function runAction(action, paths) {
  if (!paths.length && !['select-all', 'clear-selection'].includes(action)) return;
  switch (action) {
    case 'copy-file':
      return attempt(() => api.copyFiles(paths), paths.length > 1 ? `Copied ${paths.length} files` : 'Copied file. Paste it anywhere.');
    case 'copy-image':
      return attempt(() => api.copyImage(paths[0]), 'Copied image. Paste into Photoshop, Canva, etc.');
    case 'copy-path':
      return attempt(() => api.copyPaths(paths), 'Copied path');
    case 'show':
      return api.showInFolder(paths[0]);
    case 'open':
      return api.openFile(paths[0]);
    case 'reanalyze':
      return attempt(() => api.reanalyze(paths), `Re-analyzing ${plural(paths.length, 'image')}`);
    case 'add-to-album': {
      const r = $('#selbar [data-action="add-to-album"]').getBoundingClientRect();
      return showAlbumMenu(r.left, r.bottom + 4, paths);
    }
    case 'remove-from-album':
      return removeFromAlbum(source.id, paths);
    case 'move':
      return moveFlow(paths);
    case 'rename':
      return openRename(paths);
    case 'trash':
      return trashFlow(paths);
    case 'select-all':
      return setSelection(visible.map((i) => i.path));
    case 'clear-selection':
      return setSelection([]);
  }
}

$('#selbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-action]');
  if (b) runAction(b.dataset.action, selectedPaths());
});

async function trashFlow(paths) {
  const ok = await ask({
    title: `Delete ${plural(paths.length, 'image')}?`,
    text: 'They will be moved to the Recycle Bin, so you can restore them if needed.',
    okText: 'Move to Recycle Bin',
    danger: true,
  });
  if (!ok) return;
  const results = await attempt(() => api.trashFiles(paths));
  reportResults(results, 'Moved to Recycle Bin:');
}

// Returns { dest } where dest is null for "choose with the system dialog", or undefined if cancelled.
async function chooseFolder(title) {
  const folders = [...roots, ...dirs.filter((d) => !roots.includes(d))].sort((a, b) => displayDir(a).localeCompare(displayDir(b)));
  const choice = await ask({
    title,
    options: [...folders.map((d) => ({ value: d, label: displayDir(d) })), { value: '__other', label: 'Somewhere else…' }],
    okText: 'Choose',
  });
  if (choice == null) return undefined;
  return { dest: choice === '__other' ? null : choice };
}

async function moveFlow(paths) {
  const picked = await chooseFolder(`Move ${plural(paths.length, 'image')} to`);
  if (!picked) return null;
  const results = await attempt(() => api.moveFiles(paths, picked.dest));
  reportResults(results, 'Moved');
  return results;
}

// ---------- context menus ----------
function showMenu(x, y, entries) {
  const menu = $('#menu');
  menu.replaceChildren(
    ...entries.map((e) => {
      if (e === 'sep') return el('hr');
      if (e.heading) return el('div', { class: 'label-row', text: e.heading });
      return el('button', {
        class: e.danger ? 'danger' : null,
        onclick: (ev) => {
          ev.stopPropagation();
          if (!e.keepOpen) hideMenu();
          e.run(ev);
        },
      }, [el('span', { text: e.label }), e.kbd ? el('kbd', { text: e.kbd }) : null]);
    }),
  );
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - height - 8)}px`;
}
function hideMenu() {
  $('#menu').hidden = true;
}
// mousedown, not click: the click that opens a menu must not also close it.
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#menu')) hideMenu();
});
window.addEventListener('blur', hideMenu);

function showItemMenu(x, y, paths) {
  const one = paths.length === 1;
  showMenu(x, y, [
    { label: one ? 'Copy file' : `Copy ${paths.length} files`, kbd: 'Ctrl+C', run: () => runAction('copy-file', paths) },
    one && { label: 'Copy image', run: () => runAction('copy-image', paths) },
    { label: one ? 'Copy path' : 'Copy paths', run: () => runAction('copy-path', paths) },
    'sep',
    { label: 'Add to album…', keepOpen: true, run: () => showAlbumMenu(x, y, paths) },
    source.type === 'album' && { label: 'Remove from this album', run: () => removeFromAlbum(source.id, paths) },
    { label: 'Move to…', run: () => moveFlow(paths) },
    { label: one ? 'Rename…' : 'Batch rename…', kbd: 'F2', run: () => openRename(paths) },
    { label: 'Re-analyze with AI', run: () => runAction('reanalyze', paths) },
    'sep',
    one && { label: 'Show in folder', run: () => runAction('show', paths) },
    one && { label: 'Open with default app', run: () => runAction('open', paths) },
    one && 'sep',
    { label: 'Delete', kbd: 'Del', danger: true, run: () => trashFlow(paths) },
  ].filter(Boolean));
}

function showAlbumMenu(x, y, paths) {
  showMenu(x, y, [
    { heading: `Add ${plural(paths.length, 'image')} to` },
    ...collections.albums.map((a) => ({ label: a.name, run: () => addToAlbum(a.id, paths) })),
    collections.albums.length ? 'sep' : null,
    { label: 'New album…', run: async () => {
      const album = await createAlbum(null);
      if (album) addToAlbum(album.id, paths);
    } },
  ].filter(Boolean));
}

// ---------- collections ----------
async function saveCollections() {
  const plain = {
    groups: collections.groups,
    albums: collections.albums.map(({ id, name, groupId, paths }) => ({ id, name, groupId, paths })),
    smart: collections.smart.map(({ id, name, groupId, rules }) => ({ id, name, groupId, rules })),
  };
  collections = await attempt(() => api.saveCollections(collectionsBase, plain)) || structuredClone(collectionsBase);
  collectionsBase = structuredClone(collections);
  prepareCollections();
  renderSidebar();
  if (source.type === 'album' || source.type === 'smart') refresh({ keepScroll: true });
  if (focusPath) showDetail(focusPath);
}

async function createAlbum(groupId) {
  const name = await ask({ title: 'New album', input: '', okText: 'Create' });
  if (!name) return null;
  const album = { id: uid(), name, groupId, paths: [] };
  collections.albums.push(album);
  await saveCollections();
  return album;
}

async function addToAlbum(id, paths) {
  const album = collections.albums.find((a) => a.id === id);
  if (!album) return;
  const before = album.paths.length;
  album.paths = [...new Set([...album.paths, ...paths.filter((p) => byPath.has(p))])];
  await saveCollections();
  const added = album.paths.length - before;
  toast(added ? `Added ${plural(added, 'image')} to “${album.name}”` : `Already in “${album.name}”`);
}

async function removeFromAlbum(id, paths) {
  const album = collections.albums.find((a) => a.id === id);
  if (!album) return;
  const drop = new Set(paths);
  album.paths = album.paths.filter((p) => !drop.has(p));
  setSelection([]);
  await saveCollections();
  toast(`Removed ${plural(paths.length, 'image')} from “${album.name}”`);
}

async function createGroup() {
  const name = await ask({ title: 'New collection group', text: 'Groups organize albums and smart collections.', input: '', okText: 'Create' });
  if (!name) return;
  collections.groups.push({ id: uid(), name });
  await saveCollections();
}

async function renameEntry(list, id, title) {
  const entry = list.find((x) => x.id === id);
  if (!entry) return;
  const name = await ask({ title, input: entry.name, okText: 'Rename' });
  if (!name) return;
  entry.name = name;
  await saveCollections();
  renderViewbar();
}

async function moveToGroup(entry) {
  const choice = await ask({
    title: `Move “${entry.name}” to group`,
    options: [{ value: '', label: '(No group)' }, ...collections.groups.map((g) => ({ value: g.id, label: g.name }))],
    okText: 'Move',
  });
  if (choice == null) return;
  entry.groupId = choice || null;
  await saveCollections();
}

// ---------- smart collection editor ----------
const SMART_EXTS = ['jpg', 'png', 'webp', 'gif', 'svg', 'bmp', 'tiff', 'avif'];

async function openSmartEditor(existing, groupId = null) {
  const dlg = $('#smart');
  const rules = existing ? existing.rules : {};
  $('#smart-heading').textContent = existing ? 'Edit smart collection' : 'New smart collection';
  $('#smart-name').value = existing ? existing.name : '';
  $('#smart-query').value = rules.query || '';
  $('#smart-style').value = rules.style || '';
  $('#smart-color').value = rules.color || '';
  $('#smart-days').value = rules.days || '';
  $('#smart-status').value = rules.status || '';

  const cats = [...new Set(items.map((i) => i.ai?.category?.toLowerCase()).filter(Boolean))].sort();
  if (rules.category && !cats.includes(rules.category)) cats.push(rules.category);
  $('#smart-category').replaceChildren(el('option', { value: '', text: 'Any' }), ...cats.map((c) => el('option', { value: c, text: c })));
  $('#smart-category').value = rules.category || '';

  const folders = [...roots, ...dirs.filter((d) => !roots.includes(d))].sort((a, b) => displayDir(a).localeCompare(displayDir(b)));
  $('#smart-folder').replaceChildren(el('option', { value: '', text: 'Anywhere' }), ...folders.map((d) => el('option', { value: d, text: displayDir(d) })));
  $('#smart-folder').value = rules.folder || '';

  $('#smart-group').replaceChildren(el('option', { value: '', text: '(No group)' }), ...collections.groups.map((g) => el('option', { value: g.id, text: g.name })));
  $('#smart-group').value = existing ? existing.groupId || '' : groupId || '';

  $('#smart-exts').replaceChildren(...SMART_EXTS.map((x) => el('label', {}, [el('input', { type: 'checkbox', value: x, checked: (rules.exts || []).includes(x) }), x.toUpperCase()])));

  const read = () => ({
    query: $('#smart-query').value.trim(),
    category: $('#smart-category').value,
    style: $('#smart-style').value.trim(),
    color: $('#smart-color').value.trim(),
    folder: $('#smart-folder').value,
    days: Number($('#smart-days').value) || 0,
    status: $('#smart-status').value,
    exts: [...$('#smart-exts').querySelectorAll('input:checked')].map((c) => c.value),
  });
  const preview = () => {
    const r = read();
    const parsed = Search.parseQuery(r.query);
    const n = items.reduce((acc, i) => acc + (Search.matchesRules(i, r, parsed) ? 1 : 0), 0);
    $('#smart-preview').textContent = `Currently matches ${plural(n, 'image')}.`;
  };
  dlg.oninput = preview;
  dlg.onchange = preview;
  preview();

  dlg.returnValue = '';
  dlg.showModal();
  $('#smart-name').focus();
  const result = await new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
  if (result !== 'ok') return;
  const name = $('#smart-name').value.trim() || 'Smart collection';
  const entry = { id: existing ? existing.id : uid(), name, groupId: $('#smart-group').value || null, rules: read() };
  if (existing) collections.smart[collections.smart.findIndex((s) => s.id === existing.id)] = entry;
  else collections.smart.push(entry);
  await saveCollections();
  setSource({ type: 'smart', id: entry.id });
}

$('#edit-smart').addEventListener('click', () => {
  const s = collections.smart.find((x) => x.id === source.id);
  if (s) openSmartEditor(s);
});

// ---------- sidebar ----------
function setSource(next) {
  source = next;
  setSelection([]);
  renderSidebar();
  refresh();
}

function sideItem({ icon, label, count, active, depth = 0, twisty, onclick, oncontextmenu, drop, title }) {
  const node = el('button', { class: `side-item${active ? ' active' : ''}`, title: title || label, onclick, oncontextmenu }, [
    twisty !== undefined ? twisty : null,
    el('span', { class: 'ico', text: icon }),
    el('span', { class: 'label', text: label }),
    count != null ? el('span', { class: 'n', text: count.toLocaleString() }) : null,
  ]);
  node.style.paddingLeft = `${8 + depth * 14}px`; // CSSOM, since the CSP blocks inline style attributes
  if (drop) makeDropTarget(node, drop);
  return node;
}

function makeDropTarget(node, onDrop) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    node.classList.add('drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop-target');
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) onDrop(paths);
  });
}

async function dropOnFolder(dir, paths) {
  const inLib = paths.filter((p) => byPath.has(p));
  const outside = paths.filter((p) => !byPath.has(p));
  if (inLib.length) reportResults(await attempt(() => api.moveFiles(inLib, dir)), 'Moved');
  if (outside.length) reportResults(await attempt(() => api.importFiles(outside, dir)), 'Copied in');
}

function renderSidebar() {
  document.querySelectorAll('.sidebar [data-source]').forEach((b) => b.classList.toggle('active', source.type === b.dataset.source));

  // Folder tree with recursive image counts.
  const counts = new Map();
  for (const item of items) {
    const root = rootFor(item.path);
    let d = dirname(item.path);
    while (d && root && d.length >= root.length) {
      counts.set(d, (counts.get(d) || 0) + 1);
      if (d.toLowerCase() === root.toLowerCase()) break;
      d = dirname(d);
    }
  }
  const children = new Map();
  for (const d of dirs) {
    if (roots.includes(d)) continue;
    const parent = dirname(d);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(d);
  }
  for (const list of children.values()) list.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }));

  const tree = [];
  const addDir = (d, depth, isRoot) => {
    const kids = children.get(d) || [];
    const open = isRoot ? !expandedDirs.has('closed:' + d) : expandedDirs.has(d);
    const twisty = el('span', {
      class: 'twisty',
      text: kids.length ? (open ? '▾' : '▸') : '',
      onclick: (e) => {
        e.stopPropagation();
        if (isRoot) expandedDirs.has('closed:' + d) ? expandedDirs.delete('closed:' + d) : expandedDirs.add('closed:' + d);
        else expandedDirs.has(d) ? expandedDirs.delete(d) : expandedDirs.add(d);
        savePrefs();
        renderSidebar();
      },
    });
    tree.push(sideItem({
      icon: isRoot ? '◧' : '▭',
      label: basename(d) || d,
      title: d,
      count: counts.get(d) || 0,
      depth,
      twisty,
      active: source.type === 'folder' && source.path === d,
      onclick: () => setSource({ type: 'folder', path: d }),
      oncontextmenu: (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'New folder inside…', run: () => newFolder(d) },
          { label: 'Open in Explorer', run: () => api.openFolder(d) },
          isRoot && 'sep',
          isRoot && { label: 'Remove from library', danger: true, run: () => removeRoot(d) },
        ].filter(Boolean));
      },
      drop: (paths) => dropOnFolder(d, paths),
    }));
    if (open) for (const k of kids) addDir(k, depth + 1, false);
  };
  for (const r of roots) addDir(r, 0, true);
  $('#folder-tree').replaceChildren(...tree);

  // Collections: ungrouped first, then groups.
  const nodes = [];
  const renderEntries = (groupId, depth) => {
    for (const a of collections.albums.filter((x) => (x.groupId || null) === groupId)) {
      nodes.push(sideItem({
        icon: '▣', label: a.name, count: a.paths.length, depth,
        active: source.type === 'album' && source.id === a.id,
        onclick: () => setSource({ type: 'album', id: a.id }),
        oncontextmenu: (e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: 'Rename album…', run: () => renameEntry(collections.albums, a.id, 'Rename album') },
            { label: 'Move to group…', run: () => moveToGroup(a) },
            'sep',
            { label: 'Delete album', danger: true, run: () => deleteAlbum(a) },
          ]);
        },
        drop: (paths) => addToAlbum(a.id, paths),
      }));
    }
    for (const s of collections.smart.filter((x) => (x.groupId || null) === groupId)) {
      const n = items.reduce((acc, i) => acc + (Search.matchesRules(i, s.rules, s.parsed) ? 1 : 0), 0);
      nodes.push(sideItem({
        icon: '✦', label: s.name, count: n, depth,
        active: source.type === 'smart' && source.id === s.id,
        onclick: () => setSource({ type: 'smart', id: s.id }),
        oncontextmenu: (e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: 'Edit rules…', run: () => openSmartEditor(s) },
            { label: 'Rename…', run: () => renameEntry(collections.smart, s.id, 'Rename smart collection') },
            { label: 'Move to group…', run: () => moveToGroup(s) },
            'sep',
            { label: 'Delete smart collection', danger: true, run: () => deleteSmart(s) },
          ]);
        },
      }));
    }
  };
  renderEntries(null, 0);
  for (const g of collections.groups) {
    const open = !collapsedGroups.has(g.id);
    nodes.push(el('button', {
      class: 'side-item group-name',
      onclick: () => {
        open ? collapsedGroups.add(g.id) : collapsedGroups.delete(g.id);
        savePrefs();
        renderSidebar();
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'New album in group…', run: () => createAlbum(g.id) },
          { label: 'New smart collection in group…', run: () => openSmartEditor(null, g.id) },
          { label: 'Rename group…', run: () => renameEntry(collections.groups, g.id, 'Rename group') },
          'sep',
          { label: 'Delete group', danger: true, run: () => deleteGroup(g) },
        ]);
      },
    }, [el('span', { class: 'twisty', text: open ? '▾' : '▸' }), el('span', { class: 'label', text: g.name })]));
    if (open) renderEntries(g.id, 1);
  }
  $('#collection-tree').replaceChildren(...nodes);
  $('#collections-hint').hidden = nodes.length > 0;
}

async function newFolder(parent) {
  const name = await ask({ title: 'New folder', text: `Inside ${displayDir(parent)}`, input: '', okText: 'Create' });
  if (!name) return;
  const dir = await attempt(() => api.createFolder(parent, name));
  if (dir) {
    expandedDirs.add(parent);
    expandedDirs.delete('closed:' + parent);
    savePrefs();
    toast(`Created folder “${name}”`);
  }
}

async function removeRoot(dir) {
  const ok = await ask({ title: 'Remove folder from library?', text: `${dir}\n\nNothing is deleted from disk.`, okText: 'Remove' });
  if (!ok) return;
  settings = await api.removeFolder(dir);
  if (source.type === 'folder' && rootFor(source.path) === dir) setSource({ type: 'all' });
}

async function deleteAlbum(a) {
  const ok = await ask({ title: `Delete album “${a.name}”?`, text: 'The images themselves are not deleted.', okText: 'Delete album', danger: true });
  if (!ok) return;
  collections.albums = collections.albums.filter((x) => x.id !== a.id);
  if (source.type === 'album' && source.id === a.id) source = { type: 'all' };
  await saveCollections();
  refresh();
}

async function deleteSmart(s) {
  const ok = await ask({ title: `Delete smart collection “${s.name}”?`, text: 'The images themselves are not deleted.', okText: 'Delete', danger: true });
  if (!ok) return;
  collections.smart = collections.smart.filter((x) => x.id !== s.id);
  if (source.type === 'smart' && source.id === s.id) source = { type: 'all' };
  await saveCollections();
  refresh();
}

async function deleteGroup(g) {
  const ok = await ask({ title: `Delete group “${g.name}”?`, text: 'Albums and smart collections inside it are kept and moved out of the group.', okText: 'Delete group', danger: true });
  if (!ok) return;
  collections.groups = collections.groups.filter((x) => x.id !== g.id);
  for (const x of [...collections.albums, ...collections.smart]) if (x.groupId === g.id) x.groupId = null;
  await saveCollections();
}

document.querySelectorAll('.sidebar [data-source]').forEach((b) => b.addEventListener('click', () => setSource({ type: b.dataset.source })));
$('#add-root').addEventListener('click', addRootFolder);
$('#new-collection').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    { label: 'New album…', run: () => createAlbum(null) },
    { label: 'New smart collection…', run: () => openSmartEditor(null) },
    { label: 'New group…', run: createGroup },
  ]);
});

// ---------- batch rename ----------
async function openRename(paths) {
  const list = paths.map((p) => byPath.get(p)).filter(Boolean);
  if (!list.length) return;
  const dlg = $('#rename');
  $('#rename-count').textContent = plural(list.length, 'file');
  if (list.length === 1) $('#rename-pattern').value = splitExt(list[0].name)[0];
  else if (!$('#rename-pattern').value.includes('{')) $('#rename-pattern').value = '{name}';

  const clean = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ');
  const compute = () => {
    const pattern = $('#rename-pattern').value;
    const start = Number($('#rename-start').value) || 0;
    const pad = Math.min(6, Math.max(1, Number($('#rename-pad').value) || 1));
    const find = $('#rename-find').value;
    const replace = $('#rename-replace').value;
    const kase = $('#rename-case').value;
    const spaces = $('#rename-spaces').value;
    return list.map((item, i) => {
      const [base, ext] = splitExt(item.name);
      let s = pattern.replace(/\{(name|title|category|folder|n|date)\}/g, (_, t) => {
        switch (t) {
          case 'name': return base;
          case 'title': return item.ai?.title || base;
          case 'category': return item.ai?.category || '';
          case 'folder': return basename(dirname(item.path));
          case 'n': return String(start + i).padStart(pad, '0');
          case 'date': return isoDate(item.mtime);
        }
        return '';
      });
      if (find) s = s.split(find).join(replace);
      if (kase === 'lower') s = s.toLowerCase();
      if (kase === 'upper') s = s.toUpperCase();
      if (kase === 'title') s = s.toLowerCase().replace(/(^|[\s\-_])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
      s = clean(s).trim();
      if (spaces === 'remove') s = s.replace(/ /g, '');
      else if (spaces) s = s.replace(/ /g, spaces);
      s = s.replace(/[. ]+$/, '');
      return { from: item.path, oldName: item.name, name: s ? s + ext : '' };
    });
  };

  const render = () => {
    const plan = compute();
    const seen = new Map();
    const sources = new Set(plan.map((p) => p.from.toLowerCase()));
    const problems = [];
    const bad = new Set();
    for (const p of plan) {
      const target = (dirname(p.from) + sep(p.from) + p.name).toLowerCase();
      if (!p.name) {
        bad.add(p.from);
        problems.push(`${p.oldName}: new name is empty`);
      } else if (seen.has(target)) {
        bad.add(p.from);
        problems.push(`${p.name}: more than one file would get this name. Add {n} to the pattern.`);
      } else if (byPath.has(dirname(p.from) + sep(p.from) + p.name) && !sources.has(target)) {
        bad.add(p.from);
        problems.push(`${p.name}: a file with this name already exists`);
      }
      seen.set(target, true);
    }
    const rows = plan.slice(0, 500).map((p) => el('tr', { class: bad.has(p.from) ? 'bad' : null }, [
      el('td', { text: p.oldName }),
      el('td', { text: p.name || '(empty)', class: p.name === p.oldName ? 'same' : null }),
    ]));
    if (plan.length > 500) rows.push(el('tr', {}, [el('td', { text: `…and ${plan.length - 500} more`, colspan: '2' })]));
    $('#rename-rows').replaceChildren(...rows);
    $('#rename-problems').textContent = [...new Set(problems)].slice(0, 4).join('\n');
    const changes = plan.filter((p) => p.name !== p.oldName).length;
    $('#rename-apply').disabled = problems.length > 0 || changes === 0;
    $('#rename-apply').textContent = changes ? `Rename ${plural(changes, 'file')}` : 'Rename';
    return problems.length ? null : plan;
  };
  dlg.oninput = render;
  dlg.onchange = render;
  render();

  dlg.returnValue = '';
  dlg.showModal();
  $('#rename-pattern').focus();
  const result = await new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
  if (result !== 'ok') return;
  const plan = render();
  if (!plan) return;
  const changes = plan.filter((p) => p.name !== p.oldName).map(({ from, name }) => ({ from, name }));
  const results = await attempt(() => api.renameFiles(changes));
  reportResults(results, 'Renamed');
}

// ---------- duplicates ----------
let dupeGroups = [];
let marked = new Set();

$('#open-duplicates').addEventListener('click', () => {
  $('#dupes').showModal();
  if (!dupeGroups.length) $('#dupes-list').replaceChildren(el('div', { class: 'empty' }, [
    el('p', { text: 'Find images that exist more than once in your library. Exact duplicates are byte-for-byte identical; similar images are the same picture at a different size or quality.' }),
  ]));
});
$('#dupes-close').addEventListener('click', () => $('#dupes').close());

api.onDuplicatesProgress((p) => {
  $('#dupes-progress .bar span').style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`;
  $('#dupes-progress small').textContent = `${p.phase}… ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`;
});

$('#dupes-find').addEventListener('click', async () => {
  $('#dupes-find').disabled = true;
  $('#dupes-progress').hidden = false;
  $('#dupes-progress small').textContent = 'Starting…';
  $('#dupes-progress .bar span').style.width = '0%';
  const groups = await attempt(() => api.findDuplicates({ similar: $('#dupes-similar').checked }));
  $('#dupes-find').disabled = false;
  $('#dupes-progress').hidden = true;
  if (!groups) return;
  dupeGroups = groups;
  marked = new Set();
  renderDupes();
});

function keeperOf(group, rule) {
  const px = (i) => (i.dimensions ? i.dimensions.width * i.dimensions.height : 0);
  const pick = {
    resolution: (a, b) => px(b) - px(a) || b.size - a.size,
    largest: (a, b) => b.size - a.size,
    oldest: (a, b) => a.mtime - b.mtime,
    newest: (a, b) => b.mtime - a.mtime,
    shortest: (a, b) => a.path.length - b.path.length,
  }[rule];
  return [...group.items].sort(pick)[0];
}

function renderDupes() {
  const list = $('#dupes-list');
  $('#dupes-toolbar').hidden = dupeGroups.length === 0;
  if (!dupeGroups.length) {
    list.replaceChildren(el('div', { class: 'empty' }, [el('h2', { text: 'No duplicates found' }), el('p', { text: 'Every image in the library is unique.' })]));
    return;
  }
  const extra = dupeGroups.reduce((n, g) => n + g.items.length - 1, 0);
  const markedBytes = dupeGroups.flatMap((g) => g.items).filter((i) => marked.has(i.path)).reduce((n, i) => n + i.size, 0);
  $('#dupes-summary').textContent = `${plural(dupeGroups.length, 'group')} · ${plural(extra, 'extra copy').replace('copys', 'copies')} · ${marked.size} marked (${fmtSize(markedBytes)})`;
  $('#dupes-trash').disabled = marked.size === 0;
  $('#dupes-move').disabled = marked.size === 0;

  list.replaceChildren(...dupeGroups.map((g, gi) => el('section', { class: 'dupe-group' }, [
    el('header', {}, [
      el('span', { class: `pill-tag${g.kind === 'similar' ? ' similar' : ''}`, text: g.kind === 'exact' ? 'Exact copies' : 'Look similar' }),
      el('span', { text: `${g.items.length} files · ${fmtSize(g.items[0].size)}${g.kind === 'similar' ? ' (sizes vary)' : ' each'}` }),
    ]),
    ...g.items.map((item) => {
      const isMarked = marked.has(item.path);
      const dims = item.dimensions ? `${item.dimensions.width}×${item.dimensions.height}` : null;
      return el('div', { class: `dupe-row${isMarked ? ' marked' : ''}` }, [
        el('input', { type: 'checkbox', title: 'Mark for removal', checked: isMarked, onchange: (e) => {
          e.target.checked ? marked.add(item.path) : marked.delete(item.path);
          renderDupes();
        } }),
        el('div', { class: 'thumb checker' }, el('img', { src: mediaUrl('thumb', item.path), loading: 'lazy', alt: '' })),
        el('div', {}, [
          el('div', {}, [el('span', { class: 'dname', text: item.name }), isMarked ? null : el('span', { class: 'keep-label', text: 'KEEP' })]),
          el('div', { class: 'dpath', text: dirname(item.path) }),
          el('div', { class: 'dmeta', text: [fmtSize(item.size), dims, `modified ${fmtDate(item.mtime)}`].filter(Boolean).join(' · ') }),
        ]),
        el('div', { class: 'dactions' }, [
          el('button', { text: 'Show', title: 'Show in Explorer', onclick: () => api.showInFolder(item.path) }),
          el('button', { text: 'Keep only this', onclick: () => {
            for (const other of g.items) other.path === item.path ? marked.delete(other.path) : marked.add(other.path);
            renderDupes();
          } }),
          el('button', { text: 'Move…', onclick: () => moveDupes([item.path]) }),
          el('button', { text: 'Delete', class: 'danger', onclick: () => trashDupes([item.path], gi) }),
        ]),
      ]);
    }),
  ])));
}

function dropFromDupes(paths) {
  const gone = new Set(paths);
  for (const g of dupeGroups) g.items = g.items.filter((i) => !gone.has(i.path));
  dupeGroups = dupeGroups.filter((g) => g.items.length > 1);
  for (const p of paths) marked.delete(p);
  renderDupes();
}

async function trashDupes(paths) {
  const wiped = dupeGroups.filter((g) => g.items.every((i) => paths.includes(i.path))).length;
  const ok = await ask({
    title: `Delete ${plural(paths.length, 'file')}?`,
    text: `They will be moved to the Recycle Bin.${wiped ? `\n\nWarning: ${plural(wiped, 'group')} would have no copy left.` : ''}`,
    okText: 'Move to Recycle Bin',
    danger: true,
  });
  if (!ok) return;
  const results = await attempt(() => api.trashFiles(paths));
  if (!results) return;
  reportResults(results, 'Moved to Recycle Bin:');
  dropFromDupes(results.filter((r) => r.deleted).map((r) => r.from));
}

async function moveDupes(paths) {
  const results = await moveFlow(paths);
  if (results) dropFromDupes(results.filter((r) => r.to).map((r) => r.from));
}

$('#dupes-auto').addEventListener('click', () => {
  const rule = $('#dupes-rule').value;
  marked = new Set();
  for (const g of dupeGroups) {
    const keep = keeperOf(g, rule);
    for (const i of g.items) if (i.path !== keep.path) marked.add(i.path);
  }
  renderDupes();
});
$('#dupes-trash').addEventListener('click', () => trashDupes([...marked]));
$('#dupes-move').addEventListener('click', () => moveDupes([...marked]));

// ---------- settings ----------
async function addRootFolder() {
  settings = await api.addFolder();
  renderSettings();
}

function renderSettings() {
  $('#folder-list').replaceChildren(...settings.folders.map((f) => el('li', {}, [
    el('span', { text: f }),
    el('button', { type: 'button', class: 'link', text: 'Remove', onclick: () => removeRoot(f).then(renderSettings) }),
  ])));
  $('#model').value = settings.model;
  $('#concurrency').value = settings.concurrency;
  $('#auto-analyze').checked = settings.autoAnalyze;
  $('#extract-zips').checked = settings.extractZips;
  $('#zips-recycle').checked = settings.zipsToRecycleBin;
  $('#watch-folders').checked = settings.watchFolders;
  $('#data-dir').value = settings.dataDir || '';
  $('#key-state').textContent = settings.hasSavedKey
    ? 'A key is saved (encrypted on this computer).'
    : settings.hasEnvKey
      ? 'Using the ANTHROPIC_API_KEY environment variable.'
      : 'No key yet. Get one at console.anthropic.com.';
}

function renderLog() {
  $('#log').replaceChildren(...logLines.slice().reverse().map((l) => el('li', { class: l.level, text: `${new Date(l.at).toLocaleTimeString()}  ${l.message}` })));
}

$('#open-settings').addEventListener('click', () => {
  renderSettings();
  renderLog();
  $('#settings').showModal();
});
$('#add-folder').addEventListener('click', addRootFolder);
$('#change-data-dir').addEventListener('click', () => attempt(() => api.changeDataDir()));
$('#empty-add').addEventListener('click', addRootFolder);
$('#api-key').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#save-key').click();
  }
});
$('#save-key').addEventListener('click', async () => {
  const next = await attempt(() => api.setApiKey($('#api-key').value), 'API key saved');
  if (!next) return;
  settings = next;
  $('#api-key').value = '';
  renderSettings();
  api.pauseAi(false);
});
const bindSetting = (sel, key, read) => $(sel).addEventListener('change', async () => {
  settings = await api.setSettings({ [key]: read($(sel)) });
});
bindSetting('#model', 'model', (e) => e.value);
bindSetting('#concurrency', 'concurrency', (e) => Math.min(8, Math.max(1, Number(e.value) || 1)));
bindSetting('#auto-analyze', 'autoAnalyze', (e) => e.checked);
bindSetting('#extract-zips', 'extractZips', (e) => e.checked);
bindSetting('#zips-recycle', 'zipsToRecycleBin', (e) => e.checked);
bindSetting('#watch-folders', 'watchFolders', (e) => e.checked);
$('#retry-failed').addEventListener('click', () => attempt(() => api.retryFailed(), 'Retrying failed images'));

// ---------- top bar ----------
let searchTimer;
$('#search').addEventListener('input', () => {
  $('#search-clear').hidden = !chips.length && !$('#search').value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh(), 120);
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (commitSearchText()) refresh();
  } else if (e.key === 'Backspace' && !$('#search').value && chips.length) {
    chips.pop();
    renderChips();
    refresh();
  }
});
$('#search-box').addEventListener('click', () => $('#search').focus());
$('#search-clear').addEventListener('click', (e) => {
  e.stopPropagation();
  chips = [];
  $('#search').value = '';
  renderChips();
  refresh();
});
$('#filter-btn').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const opt = (value, label) => ({ label: `${statusFilter === value ? '✓ ' : '\u2003'}${label}`, run: () => {
    statusFilter = value;
    $('#filter-btn').classList.toggle('active', Boolean(value));
    refresh();
  } });
  showMenu(r.left, r.bottom + 6, [
    { heading: 'AI description' },
    opt('', 'Any'),
    opt('done', 'Described'),
    opt('pending', 'Waiting for AI'),
    opt('error', 'Failed'),
    opt('skipped', 'Not describable'),
    'sep',
    { heading: 'Search tips' },
    { label: 'tag:  color:  style:  ext:png  -exclude', run: () => $('#search').focus() },
  ]);
});
$('#sort').addEventListener('change', () => {
  savePrefs();
  refresh();
});
$('#zoom').addEventListener('input', () => {
  document.documentElement.style.setProperty('--row', `${$('#zoom').value}px`);
  savePrefs();
});
$('#rescan').addEventListener('click', () => api.rescan());

let aiPaused = false;
$('#ai-toggle').addEventListener('click', () => api.pauseAi(!aiPaused));

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    hideMenu();
    if (typing) return e.target.blur();
    return setSelection([]);
  }
  if (typing) return;
  const paths = selectedPaths();
  if (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'f')) {
    e.preventDefault();
    $('#search').focus();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    setSelection(visible.map((i) => i.path));
  } else if (e.ctrlKey && e.key.toLowerCase() === 'c' && paths.length) {
    e.preventDefault();
    runAction('copy-file', paths);
  } else if (e.key === 'Delete' && paths.length) {
    trashFlow(paths);
  } else if (e.key === 'F2' && paths.length) {
    openRename(paths);
  } else if (e.key === 'Enter' && paths.length === 1) {
    api.openFile(paths[0]);
  }
});

// ---------- events from the main process ----------
function applyLibrary({ items: next, dirs: nextDirs, roots: nextRoots }) {
  items = next;
  byPath = new Map(items.map((i) => [i.path, i]));
  dirs = nextDirs;
  roots = nextRoots;
  selected = new Set([...selected].filter((p) => byPath.has(p)));
  if (source.type === 'folder' && !rootFor(source.path)) source = { type: 'all' };
  renderSelbar();
  renderSidebar();
  refresh({ keepScroll: true });
  if (focusPath && !byPath.has(focusPath)) focusPath = null;
  showDetail(focusPath);
}

api.onLibrary(applyLibrary);

let sidebarTimer;
api.onItem((item) => {
  const i = items.findIndex((x) => x.path === item.path);
  if (i === -1) return;
  items[i] = item;
  byPath.set(item.path, item);
  const old = cardFor(item.path);
  if (old) old.replaceWith(card(item));
  const vi = visible.findIndex((x) => x.path === item.path);
  if (vi !== -1) visible[vi] = item;
  if (focusPath === item.path) showDetail(item.path);
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(() => {
    updateCount();
    renderSidebar();
  }, 1000);
});

api.onStatus((s) => {
  if ('scanning' in s) $('#scan-state').textContent = s.scanning ? 'Scanning folders…' : '';
  if (s.analyzing) {
    const a = s.analyzing;
    aiPaused = a.paused;
    const left = a.queued + a.active;
    const box = $('#ai-status');
    box.hidden = left === 0 || !a.enabled;
    box.classList.toggle('paused', a.paused);
    $('#ai-text').textContent = a.paused ? `AI paused · ${left.toLocaleString()} waiting` : `Analyzing images · ${left.toLocaleString()} left`;
    $('#ai-toggle').textContent = a.paused ? 'Resume' : 'Pause';
  }
});

api.onLog((entry) => {
  logLines.push(entry);
  if (logLines.length > 300) logLines.shift();
  if (entry.level === 'error') toast(entry.message, true);
  if ($('#settings').open) renderLog();
});

// Another PC changed albums, collections, or groups.
api.onCollections((data) => {
  collections = data;
  collectionsBase = structuredClone(data);
  prepareCollections();
  renderSidebar();
  if (source.type === 'album' || source.type === 'smart') {
    const exists = (source.type === 'album' ? collections.albums : collections.smart).some((x) => x.id === source.id);
    if (!exists) source = { type: 'all' };
    refresh({ keepScroll: true });
  }
  if (focusPath) showDetail(focusPath);
});

// Another PC changed the shared folder list or model.
api.onSettingsChanged(async () => {
  settings = await api.getSettings();
  if ($('#settings').open) renderSettings();
});

api.onAuthError(() => {
  renderSettings();
  renderLog();
  if (!$('#settings').open) $('#settings').showModal();
  $('#api-key').focus();
});

// ---------- start ----------
(async function init() {
  if (prefs.zoom) {
    $('#zoom').value = prefs.zoom;
    document.documentElement.style.setProperty('--row', `${prefs.zoom}px`);
  }
  setSidebarOpen(sidebarOpen);
  renderChips();
  if (prefs.sort) $('#sort').value = prefs.sort;
  settings = await api.getSettings();
  collections = await api.getCollections();
  collectionsBase = structuredClone(collections);
  prepareCollections();
  applyLibrary(await api.getLibrary());
})();
