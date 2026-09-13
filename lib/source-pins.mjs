// Source-pin verification (SPEC §3.4): every `source` pin is resolved with
// `git show <revision>:<file>` in meta.repository.root (relative to the
// figure file), range-checked, and drift-checked with its `match` text.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { diagnostic } from './diagnostics.mjs';

function collectPins(node, where = '', out = []) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => collectPins(n, `${where}/${i}`, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'source' && v && typeof v === 'object' && typeof v.file === 'string' && Number.isInteger(v.line)) out.push({ path: `${where}/source`, pin: v });
      else collectPins(v, `${where}/${k}`, out);
    }
  }
  return out;
}

export function verifySourcePins(doc, { figureDir = process.cwd() } = {}) {
  const pins = collectPins(doc);
  const diagnostics = [];
  const add = (code, message, subject, evidence = {}, supportedFixes = []) => diagnostics.push(diagnostic({ code, message, subject, evidence, supportedFixes }));
  if (!pins.length) return { diagnostics, pins: 0, verified: 0 };
  const repo = doc.meta?.repository;
  if (!repo) {
    add('source/repository-required', `${pins.length} source pins but no meta.repository`, { path: '/meta' }, {}, ['add meta.repository {root, revision}', 'remove the source pins']);
    return { diagnostics, pins: pins.length, verified: 0 };
  }
  const root = path.resolve(figureDir, repo.root);
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rev = git(['cat-file', '-e', `${repo.revision}^{commit}`]);
  if (rev.error || rev.status !== 0) {
    add('source/revision-unknown', `revision ${repo.revision} not found in ${repo.root}`, { path: '/meta/repository' }, { root: repo.root }, ['pin an existing commit', 'fix meta.repository.root']);
    return { diagnostics, pins: pins.length, verified: 0, revision: repo.revision };
  }
  const files = new Map();
  const hashes = new Map();
  let verified = 0;
  for (const { path: where, pin } of pins) {
    if (!files.has(pin.file)) {
      const shown = git(['show', `${repo.revision}:${pin.file}`]);
      files.set(pin.file, shown.status === 0 ? shown.stdout.split(/\r?\n/) : null);
      if (shown.status === 0) hashes.set(pin.file, createHash('sha256').update(shown.stdout).digest('hex'));
    }
    const lines = files.get(pin.file);
    if (!lines) { add('source/file-missing', `${pin.file} does not exist at ${repo.revision.slice(0, 12)}`, { path: where }, { file: pin.file }, ['fix the file path']); continue; }
    const count = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
    const end = pin.end_line ?? pin.line;
    if (pin.line > count || end < pin.line || end > count) { add('source/line-range', `${pin.file}:${pin.line}${pin.end_line ? `-${pin.end_line}` : ''} is outside 1..${count}`, { path: where }, { lines: count }, ['fix line/end_line']); continue; }
    if (pin.match && !lines.slice(pin.line - 1, end).join('\n').includes(pin.match)) { add('source/drift', `'${pin.match}' not found in ${pin.file}:${pin.line}-${end} at ${repo.revision.slice(0, 12)}`, { path: where }, { match: pin.match }, ['update the line numbers', 'update match', 'pin the revision the figure was drawn from']); continue; }
    verified += 1;
  }
  return { diagnostics, pins: pins.length, verified, revision: repo.revision, root, files: [...hashes.entries()].map(([file, sha256]) => ({ file, sha256 })) };
}
