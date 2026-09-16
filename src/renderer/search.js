// Search and smart-collection matching. Pure functions, no DOM.
//
// Query syntax:
//   red flower          every word must match somewhere (name, folder, AI title/description/tags/colors/style)
//   "wedding invite"    exact phrase
//   -tree               exclude
//   tag:x color:x style:x category:x folder:x name:x ext:png text:x   match one field only
(function () {
  const FIELDS = new Set(['tag', 'color', 'style', 'category', 'folder', 'name', 'ext', 'text']);

  function parseQuery(q) {
    const terms = [];
    const re = /(-)?(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
    let m;
    while ((m = re.exec(q || ''))) {
      let field = m[2] ? m[2].toLowerCase() : null;
      let value = (m[3] ?? m[4] ?? '').toLowerCase();
      if (field && !FIELDS.has(field)) {
        value = `${field}:${value}`;
        field = null;
      }
      if (field === 'ext') value = value.replace(/^\./, '');
      if (value) terms.push({ negate: Boolean(m[1]), field, value });
    }
    return terms;
  }

  // Lower-cased searchable text for an item, cached on the item object.
  function fieldsOf(item) {
    if (item._fields && item._fieldsFor === item.ai) return item._fields;
    const ai = item.ai || {};
    const dot = item.name.lastIndexOf('.');
    const f = {
      name: item.name.toLowerCase().replace(/[_\-.]+/g, ' '),
      ext: dot >= 0 ? item.name.slice(dot + 1).toLowerCase() : '',
      folder: (item.folder || '').toLowerCase().replace(/[_\-]+/g, ' '),
      title: (ai.title || '').toLowerCase(),
      description: (ai.description || '').toLowerCase(),
      tags: (ai.tags || []).map((t) => t.toLowerCase()),
      colors: (ai.colors || []).map((c) => c.toLowerCase()),
      style: (ai.style || '').toLowerCase(),
      mood: (ai.mood || '').toLowerCase(),
      category: (ai.category || '').toLowerCase(),
      text: (ai.text_in_image || '').toLowerCase(),
    };
    Object.defineProperty(item, '_fields', { value: f, writable: true, configurable: true });
    Object.defineProperty(item, '_fieldsFor', { value: item.ai, writable: true, configurable: true });
    return f;
  }

  const wordStart = (hay, needle) => hay.startsWith(needle) || hay.includes(' ' + needle);

  // Score one term against one item; 0 means no match.
  function termScore(f, { field, value }) {
    const inList = (list) => {
      let best = 0;
      for (const t of list) {
        if (t === value) return 6;
        if (wordStart(t, value)) best = Math.max(best, 4);
        else if (t.includes(value)) best = Math.max(best, 2);
      }
      return best;
    };
    const inText = (text, weight) => (text.includes(value) ? (wordStart(text, value) ? weight : weight / 2) : 0);

    switch (field) {
      case 'tag': return inList(f.tags);
      case 'color': return inList(f.colors);
      case 'style': return inText(f.style, 3);
      case 'category': return inText(f.category, 3);
      case 'folder': return inText(f.folder, 3);
      case 'name': return inText(f.name, 3);
      case 'text': return inText(f.text, 3);
      case 'ext': return f.ext === value || (value === 'jpg' && f.ext === 'jpeg') ? 3 : 0;
    }
    return Math.max(
      inList(f.tags),
      inText(f.title, 5),
      inText(f.name, 4),
      inList(f.colors) ? inList(f.colors) - 1 : 0,
      inText(f.style, 3),
      inText(f.category, 3),
      inText(f.folder, 2),
      inText(f.mood, 2),
      inText(f.text, 2),
      inText(f.description, 1.5),
    );
  }

  // Returns a relevance score, or -1 when the item does not match.
  function score(item, terms) {
    if (!terms.length) return 0;
    const f = fieldsOf(item);
    let total = 0;
    for (const t of terms) {
      const s = termScore(f, t);
      if (t.negate) {
        if (s > 0) return -1;
      } else if (s === 0) {
        return -1;
      } else {
        total += s;
      }
    }
    return total;
  }

  function isUnder(itemPath, dir) {
    const p = itemPath.toLowerCase();
    const d = dir.toLowerCase().replace(/[\\/]+$/, '');
    return p.startsWith(d + '\\') || p.startsWith(d + '/');
  }

  // rules: { query, category, style, color, folder, days, status, exts: [] }
  function matchesRules(item, rules, parsed) {
    if (!rules) return false;
    const f = fieldsOf(item);
    if (rules.category && f.category !== rules.category.toLowerCase()) return false;
    if (rules.style && !f.style.includes(rules.style.toLowerCase())) return false;
    if (rules.color && !f.colors.some((c) => c.includes(rules.color.toLowerCase()))) return false;
    if (rules.folder && !isUnder(item.path, rules.folder)) return false;
    if (rules.status && item.status !== rules.status) return false;
    if (rules.days > 0 && item.mtime < Date.now() - rules.days * 86400000) return false;
    if (rules.exts && rules.exts.length) {
      const ext = f.ext === 'jpeg' ? 'jpg' : f.ext === 'tif' ? 'tiff' : f.ext;
      if (!rules.exts.includes(ext)) return false;
    }
    if (rules.query && score(item, parsed || parseQuery(rules.query)) < 0) return false;
    return true;
  }

  window.Search = { parseQuery, score, matchesRules, isUnder };
})();
