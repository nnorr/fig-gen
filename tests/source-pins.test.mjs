import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifySourcePins } from '../lib/source-pins.mjs';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-pins-'));
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'rtl'));
  fs.writeFileSync(path.join(dir, 'rtl', 'x.sv'), 'module x;\n  logic a;\n  always_ff @(posedge clk) a <= b;\nendmodule\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { dir, revision: git('rev-parse', 'HEAD').stdout.trim() };
}

const doc = (r, source) => ({ meta: { repository: { root: r.dir, revision: r.revision } }, elements: [{ id: 'e', source }] });
const codes = (res) => res.diagnostics.map((d) => d.code);

test('pins resolve at the pinned revision, with drift and range checks', () => {
  const r = repo();
  try {
    assert.deepEqual(codes(verifySourcePins(doc(r, { file: 'rtl/x.sv', line: 3, match: 'always_ff' }))), []);
    assert.equal(verifySourcePins(doc(r, { file: 'rtl/x.sv', line: 3 })).verified, 1);
    assert.deepEqual(codes(verifySourcePins(doc(r, { file: 'rtl/x.sv', line: 2, match: 'always_ff' }))), ['source/drift']);
    assert.deepEqual(codes(verifySourcePins(doc(r, { file: 'rtl/x.sv', line: 9 }))), ['source/line-range']);
    assert.deepEqual(codes(verifySourcePins(doc(r, { file: 'rtl/nope.sv', line: 1 }))), ['source/file-missing']);
    const badRev = doc(r, { file: 'rtl/x.sv', line: 1 });
    badRev.meta.repository.revision = '0'.repeat(40);
    assert.deepEqual(codes(verifySourcePins(badRev)), ['source/revision-unknown']);
    assert.deepEqual(codes(verifySourcePins({ meta: {}, elements: [{ id: 'e', source: { file: 'a', line: 1 } }] })), ['source/repository-required']);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});
