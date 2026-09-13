// Guards the neutrality rule (SPEC §13): no license-server addresses, host
// names, or absolute tool install paths in shipped files. Deliberately
// pattern-based so this file itself names no vendor or tool.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'local', '.figgen-work', 'out', '.claude']);
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.sv', '.v', '.svg', '.yaml', '.yml', '']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (TEXT_EXT.has(path.extname(entry.name))) {
      yield path.join(dir, entry.name);
    }
  }
}

const RULES = [
  { name: 'port@host license address', re: /\b\d{2,5}@[A-Za-z][\w.-]+\b/ },
  { name: 'absolute tool install path', re: /(?:^|["'\s])\/(?:opt|usr\/local|tools|eda|cad)\/[\w.-]+\/(?:bin|lib|linux)/m },
  { name: 'user home path', re: /\/(?:Users|home)\/[a-z][\w.-]*\//i },
  { name: 'license environment variable', re: /\b[A-Z]{2,}_LICENSE_FILE\b/ },
];

test('shipped files contain no license servers, hosts, or absolute tool paths', () => {
  const offenders = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const rule of RULES) if (rule.re.test(text)) offenders.push(`${rel}: ${rule.name}`);
  }
  assert.deepEqual(offenders, []);
});
