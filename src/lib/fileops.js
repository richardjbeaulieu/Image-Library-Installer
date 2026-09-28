// Disk operations: create folders, move, rename, and recycle files.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Characters Windows does not allow in file names, plus control characters.
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function validateName(name) {
  if (!name || !name.trim()) return 'Name is empty';
  if (ILLEGAL.test(name)) return 'Name contains a character that is not allowed: < > : " / \\ | ? *';
  if (RESERVED.test(name)) return 'That name is reserved by Windows';
  if (/[. ]$/.test(name)) return 'Name cannot end with a dot or space';
  if (name.length > 200) return 'Name is too long';
  return null;
}

// "photo.png" -> "photo (2).png" until the name is free.
function uniquePath(dir, fileName, taken = new Set()) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  for (let i = 2; fs.existsSync(candidate) || taken.has(candidate.toLowerCase()); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Different drive: copy, keep timestamps, then remove the original.
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    const st = await fsp.stat(from);
    await fsp.utimes(to, st.atime, st.mtime);
    await fsp.unlink(from);
  }
}

// Moves a whole folder (with everything inside it) into destParent, keeping the folder's own name.
// Unlike moving files, this never merges into an existing folder of the same name — it numbers instead,
// so nothing already at the destination is touched. Returns { from, to }.
async function moveFolder(fromDir, destParent) {
  const from = path.resolve(fromDir);
  const dest = path.resolve(destParent);
  const fromStat = await fsp.stat(from).catch(() => null);
  if (!fromStat || !fromStat.isDirectory()) throw new Error('That folder no longer exists');
  const destStat = await fsp.stat(dest).catch(() => null);
  if (!destStat || !destStat.isDirectory()) throw new Error('Destination folder not found');
  if (dest.toLowerCase() === from.toLowerCase() || (dest.toLowerCase() + path.sep).startsWith(from.toLowerCase() + path.sep)) {
    throw new Error('A folder cannot be moved into itself or one of its own subfolders');
  }
  if (path.dirname(from).toLowerCase() === dest.toLowerCase()) {
    return { from, to: from }; // already there
  }
  const base = path.basename(from);
  let to = path.join(dest, base);
  for (let i = 2; fs.existsSync(to); i++) to = path.join(dest, `${base} (${i})`);
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Different drive: copy the whole tree, then remove the original.
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
  return { from, to };
}

async function createFolder(parent, name) {
  const problem = validateName(name);
  if (problem) throw new Error(problem);
  const dir = path.join(parent, name.trim());
  if (fs.existsSync(dir)) throw new Error('A folder with that name already exists');
  await fsp.mkdir(dir);
  return dir;
}

// Returns [{ from, to, error }]
async function moveFiles(paths, destDir) {
  const results = [];
  for (const from of paths) {
    try {
      if (path.dirname(from).toLowerCase() === destDir.toLowerCase()) {
        results.push({ from, to: from });
        continue;
      }
      const to = uniquePath(destDir, path.basename(from));
      await moveFile(from, to);
      results.push({ from, to });
    } catch (err) {
      results.push({ from, error: err.message });
    }
  }
  return results;
}

// plan: [{ from, name }] where name is the new file name (with extension), same folder.
// Renames go through temporary names first so swaps like a->b, b->a work.
async function renameFiles(plan) {
  const targets = new Map();
  const problems = [];
  const sources = new Set(plan.map((p) => p.from.toLowerCase()));
  for (const { from, name } of plan) {
    const problem = validateName(name);
    const to = path.join(path.dirname(from), name);
    const key = to.toLowerCase();
    if (problem) problems.push(`${name}: ${problem}`);
    else if (targets.has(key)) problems.push(`${name}: two files would get this name`);
    else if (fs.existsSync(to) && !sources.has(key)) problems.push(`${name}: a file with this name already exists`);
    targets.set(key, to);
  }
  if (problems.length) throw new Error(problems.slice(0, 5).join('\n'));

  const changes = plan
    .map(({ from, name }) => ({ from, to: path.join(path.dirname(from), name) }))
    .filter((c) => c.from !== c.to);
  const staged = [];
  const results = [];
  for (const c of changes) {
    const tmp = path.join(path.dirname(c.from), `.renaming-${process.pid}-${staged.length}${path.extname(c.from)}`);
    try {
      await fsp.rename(c.from, tmp);
      staged.push({ ...c, tmp });
    } catch (err) {
      results.push({ from: c.from, error: err.message });
    }
  }
  for (const s of staged) {
    try {
      await fsp.rename(s.tmp, s.to);
      results.push({ from: s.from, to: s.to });
    } catch (err) {
      await fsp.rename(s.tmp, s.from).catch(() => {});
      results.push({ from: s.from, error: err.message });
    }
  }
  return results;
}

async function recycleFiles(paths, trashItem) {
  const results = [];
  for (const p of paths) {
    try {
      await trashItem(p);
      results.push({ from: p, deleted: true });
    } catch (err) {
      results.push({ from: p, error: err.message });
    }
  }
  return results;
}

module.exports = { createFolder, moveFolder, moveFiles, renameFiles, recycleFiles, validateName };
