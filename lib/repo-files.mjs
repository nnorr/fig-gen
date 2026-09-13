// Read files of the user's repository at the figure's pinned revision
// (meta.repository {root, revision}); shared by source pins, doc facts and
// function-evidence checks. Nothing is read from the working tree.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function repoReader(doc, figureDir = process.cwd()) {
  const repo = doc.meta?.repository;
  if (!repo) return null;
  const root = path.resolve(figureDir, repo.root);
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ok = git(['cat-file', '-e', `${repo.revision}^{commit}`]);
  if (ok.error || ok.status !== 0) return { root, revision: repo.revision, valid: false, lines: () => null, list: () => [] };
  const cache = new Map();
  return {
    root,
    revision: repo.revision,
    valid: true,
    lines(file) {
      if (!cache.has(file)) {
        const shown = git(['show', `${repo.revision}:${file}`]);
        cache.set(file, shown.status === 0 ? shown.stdout.split(/\r?\n/) : null);
      }
      return cache.get(file);
    },
    list() {
      const out = git(['ls-tree', '-r', '--name-only', repo.revision]);
      return out.status === 0 ? out.stdout.split('\n').filter(Boolean) : [];
    },
    pinText(pin) {
      const lines = this.lines(pin.file);
      if (!lines) return null;
      return lines.slice(pin.line - 1, pin.end_line ?? pin.line).join('\n');
    },
  };
}
