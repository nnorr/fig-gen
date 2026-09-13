// Dependency resolution for check-rtl (SPEC §11.2): instead of a hand-made
// file list, scan search paths for HDL files, find the file that defines the
// top module, and close over the modules and interfaces it instantiates, the
// packages it imports or references (`pkg::x`) and the files it includes.
// Every duplicate definition is reported with all defining files; the choice
// is deterministic and recorded (--prefer and --exclude override it).

import fs from 'node:fs';
import path from 'node:path';

const HDL_EXT = new Set(['.sv', '.v', '.svh', '.vh', '.svi', '.vp', '.svp']);
const HEADER_EXT = new Set(['.svh', '.vh', '.svi']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.figgen-work']);
// A file (or directory on its path) named like a stand-in loses a tie.
const STAND_IN = /(^|[_.\-/])(stubs?|mocks?|fakes?|dummy|tb|testbench|bfm|sim)($|[_.\-/])/i;

const hasGlob = (p) => /[*?[]/.test(p);

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const toPosix = (p) => p.split(path.sep).join('/');

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, out); } else if (e.isFile()) out.push(full);
  }
  return out;
}

// A search path is a file, a directory (its files, not recursive) or a glob
// (`rtl/**` recursive, `rtl/*/*.sv`). Returns absolute HDL files and the
// base directory the pattern is rooted at.
export function expandSearchPath(pattern, { cwd = process.cwd() } = {}) {
  const abs = toPosix(path.resolve(cwd, pattern));
  if (!hasGlob(abs)) {
    if (!fs.existsSync(abs)) return { base: abs, files: [] };
    if (fs.statSync(abs).isFile()) return { base: path.dirname(abs), files: [abs] };
    const files = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => toPosix(path.join(abs, e.name)));
    return { base: abs, files: files.filter((f) => HDL_EXT.has(path.extname(f))).sort() };
  }
  const parts = abs.split('/');
  const firstGlob = parts.findIndex(hasGlob);
  const base = parts.slice(0, firstGlob).join('/') || '/';
  const re = globToRegExp(abs);
  const files = walk(base).map(toPosix).filter((f) => HDL_EXT.has(path.extname(f)) && (re.test(f) || re.test(path.dirname(f))));
  return { base, files: files.sort() };
}

// Comments removed, line structure kept (so offsets stay meaningful).
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

export function scanHdl(text) {
  const src = stripComments(text);
  const defs = [];
  for (const m of src.matchAll(/^[ \t]*(?:(?:extern|virtual)\s+)?(module|macromodule|interface|program|package|primitive)\s+(?:(?:automatic|static)\s+)?([A-Za-z_]\w*)/gm)) {
    defs.push({ kind: m[1] === 'macromodule' ? 'module' : m[1], name: m[2] });
  }
  const includes = [...src.matchAll(/`include\s+"([^"]+)"/g)].map((m) => m[1]);
  const scoped = new Set([...src.matchAll(/\b([A-Za-z_]\w*)\s*::/g)].map((m) => m[1]));
  // `Name #(`, `Name inst (`, `Name inst [N:0] (`, and interface ports `Name.modport x`.
  const instantiated = new Set([
    ...[...src.matchAll(/\b([A-Za-z_]\w*)\s*(?:#\s*\(|\s+[A-Za-z_]\w*\s*(?:\[[^\]]*\]\s*)*\()/g)].map((m) => m[1]),
    ...[...src.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]\w*\s+[A-Za-z_]\w*\s*[,;)]/g)].map((m) => m[1]),
  ]);
  return { defs, includes, scoped, instantiated };
}

const standIn = (file, bases) => {
  const base = bases.find((b) => file.startsWith(`${b}/`));
  const rel = base ? file.slice(base.length + 1) : path.basename(file);
  return STAND_IN.test(rel.replace(/\.[^./]+$/, ''));
};

export function resolveDependencies({ top, searchPaths = [], excludes = [], prefer = [], includeDirs = [], cwd = process.cwd() } = {}) {
  const diagnostics = [];
  const expanded = searchPaths.map((p) => expandSearchPath(p, { cwd }));
  const bases = [...new Set(expanded.map((e) => e.base))];
  const excludeRes = excludes.map((g) => globToRegExp(toPosix(path.resolve(cwd, g))));
  const excluded = (f) => excludeRes.some((re) => re.test(f) || re.test(path.dirname(f)));
  const all = [...new Set(expanded.flatMap((e) => e.files))].filter((f) => !excluded(f)).sort();
  const preferAbs = prefer.map((p) => toPosix(path.resolve(cwd, p)));

  const scans = new Map();
  const scan = (file) => {
    if (!scans.has(file)) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { /* unreadable: no definitions */ }
      scans.set(file, scanHdl(text));
    }
    return scans.get(file);
  };
  const defs = new Map();
  for (const f of all) {
    for (const d of scan(f).defs) {
      if (!defs.has(d.name)) defs.set(d.name, []);
      if (!defs.get(d.name).some((c) => c.file === f)) defs.get(d.name).push({ file: f, kind: d.kind });
    }
  }
  const known = (name, kinds) => (defs.get(name) || []).some((c) => kinds.includes(c.kind));

  const chosenFiles = [];
  const provided = new Map();
  const duplicates = [];
  const unresolved = [];
  const incDirs = includeDirs.map((d) => toPosix(path.resolve(cwd, d)));
  const headersUsed = new Set();

  const choose = (name) => {
    if (provided.has(name)) return provided.get(name);
    const candidates = (defs.get(name) || []).slice().sort((a, b) => a.file.localeCompare(b.file));
    if (!candidates.length) return null;
    let pick = candidates[0];
    let reason = 'only definition';
    if (candidates.length > 1) {
      const preferred = candidates.find((c) => preferAbs.includes(c.file));
      const real = candidates.filter((c) => !standIn(c.file, bases));
      if (preferred) { pick = preferred; reason = 'named by --prefer'; } else if (real.length && real.length < candidates.length) { pick = real[0]; reason = 'not a stub/mock/testbench file (first such by path)'; } else { pick = candidates[0]; reason = 'first by path'; }
      duplicates.push({ name, kind: pick.kind, candidates: candidates.map((c) => c.file), chosen: pick.file, reason });
      diagnostics.push({
        code: 'rtl/duplicate-definition', severity: 'warning',
        message: `${pick.kind} ${name} is defined in ${candidates.length} files (${candidates.map((c) => c.file).join(', ')}); using ${pick.file} (${reason})`,
        subject: { name, kind: pick.kind }, evidence: { candidates: candidates.map((c) => c.file), chosen: pick.file, reason },
        supportedFixes: ['pick another definition with --prefer <file>', 'drop the unwanted file with --exclude <glob>'],
      });
    }
    return pick.file;
  };

  const queue = [];
  const addFile = (file) => {
    if (chosenFiles.includes(file)) return;
    chosenFiles.push(file);
    for (const d of scan(file).defs) if (!provided.has(d.name)) provided.set(d.name, file);
    queue.push(file);
  };
  const resolveInclude = (inc, from) => {
    const candidates = [path.dirname(from), ...incDirs, ...bases].map((d) => toPosix(path.resolve(d, inc)));
    const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile())
      || all.find((f) => f.endsWith(`/${inc}`));
    return hit ? toPosix(hit) : null;
  };

  const topFile = choose(top);
  if (!topFile) {
    diagnostics.push({ code: 'rtl/top-not-found', severity: 'error', message: `top module ${top} is not defined in any file under ${searchPaths.join(', ')}`, subject: { module: top }, evidence: { scanned: all.length }, supportedFixes: ['add the directory that defines the top to --search-path', 'check the module name'] });
    return { files: [], includeDirs: incDirs, diagnostics, resolution: { top, search_paths: searchPaths, excludes, prefer, scanned: all.length, files: [], duplicates, unresolved: [{ kind: 'module', name: top }] } };
  }
  addFile(topFile);
  const seenHeaders = new Set();
  while (queue.length) {
    const file = queue.shift();
    const visitScan = (s, from) => {
      for (const name of [...s.instantiated].filter((n) => known(n, ['module', 'interface', 'program', 'primitive']))) {
        const f = choose(name);
        if (f) { provided.set(name, f); addFile(f); }
      }
      for (const name of [...s.scoped].filter((n) => known(n, ['package']))) {
        const f = choose(name);
        if (f) { provided.set(name, f); addFile(f); }
      }
      for (const inc of s.includes) {
        const hit = resolveInclude(inc, from);
        if (!hit) { unresolved.push({ kind: 'include', name: inc, referenced_by: from }); continue; }
        if (HEADER_EXT.has(path.extname(hit)) || !all.includes(hit)) headersUsed.add(hit);
        // The elaborator resolves includes through -I directories only (not
        // relative to the including file), so every header directory is added.
        const dir = toPosix(path.dirname(hit));
        if (!incDirs.includes(dir)) incDirs.push(dir);
        if (!seenHeaders.has(hit)) { seenHeaders.add(hit); visitScan(scan(hit), hit); }
      }
    };
    visitScan(scan(file), file);
  }
  for (const u of unresolved) {
    diagnostics.push({ code: 'rtl/include-unresolved', severity: 'warning', message: `${u.referenced_by}: include "${u.name}" not found in its directory, --include dirs or search paths`, subject: { include: u.name }, supportedFixes: ['add the include directory with --include <dir>'] });
  }

  // Compile units: headers only through include dirs; package files first in
  // dependency order (a package may use another), then the rest as found.
  const units = chosenFiles.filter((f) => !headersUsed.has(f) || !HEADER_EXT.has(path.extname(f)));
  const isPackageFile = (f) => scan(f).defs.some((d) => d.kind === 'package');
  const pkgFiles = units.filter(isPackageFile);
  const ordered = [];
  const visiting = new Set();
  const visitPkg = (f) => {
    if (ordered.includes(f) || visiting.has(f)) return;
    visiting.add(f);
    for (const name of scan(f).scoped) {
      const dep = provided.get(name);
      if (dep && dep !== f && pkgFiles.includes(dep)) visitPkg(dep);
    }
    ordered.push(f);
  };
  pkgFiles.forEach(visitPkg);
  const files = [...ordered, ...units.filter((f) => !ordered.includes(f))];
  return {
    files,
    includeDirs: incDirs,
    diagnostics,
    resolution: {
      top, search_paths: searchPaths, excludes, prefer, scanned: all.length,
      files: files.map((f) => ({ path: f, defines: scan(f).defs.map((d) => d.name) })),
      duplicates, unresolved,
    },
  };
}

// A resolved file list in the .f form check-rtl --filelist reads back.
export function formatFilelist({ files, includeDirs = [] }) {
  return `${['// generated by fig-gen check-rtl --emit-filelist', ...includeDirs.map((d) => `+incdir+${d}`), ...files].join('\n')}\n`;
}

// Parse a .f file: file paths, +incdir+dir, -I dir / -Idir, // comments.
export function parseFilelist(text, base) {
  const files = [];
  const includeDirs = [];
  const lines = text.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.startsWith('+incdir+')) includeDirs.push(...l.slice(8).split('+').filter(Boolean).map((d) => path.resolve(base, d)));
    else if (l === '-I' && lines[i + 1]) includeDirs.push(path.resolve(base, lines[++i]));
    else if (l.startsWith('-I')) includeDirs.push(path.resolve(base, l.slice(2)));
    else if (!l.startsWith('-') && !l.startsWith('+')) files.push(path.resolve(base, l));
  }
  return { files, includeDirs };
}

// True when `target` lies inside one of `roots` (tool output must never be
// written into the user's RTL tree).
export function insideAny(target, roots) {
  const t = toPosix(path.resolve(target));
  return roots.map((r) => toPosix(path.resolve(r))).find((r) => t === r || t.startsWith(`${r}/`)) || null;
}
