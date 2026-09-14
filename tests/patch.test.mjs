// Authoring tools (SPEC §4.12): validated, atomic IR edit operations. Each op
// applies to a copy; an invalid op or a result with a new error rejects the
// whole patch and leaves the figure unchanged; reversible ops round-trip.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPatch, figureDiff, PATCH_OP_NAMES } from '../lib/patch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const figure = () => ({
  schema_version: 1, figure_type: 'datapath',
  meta: { title: 'patch sample', print: { profile: 'ieee' } },
  clock_domains: [{ id: 'sys', clock: 'clk' }],
  elements: [
    { id: 'p_xa', kind: 'port', dir: 'in', width: 8, label: 'x imaginary' },
    { id: 'p_xb', kind: 'port', dir: 'in', width: 8, label: 'x real' },
    { id: 'p_ya', kind: 'port', dir: 'in', width: 8, label: 'y imaginary' },
    { id: 'p_yb', kind: 'port', dir: 'in', width: 8, label: 'y real' },
    { id: 'p_load', kind: 'port', dir: 'in', width: 1, label: 'input load', role: 'enable' },
    { id: 'p_sel', kind: 'port', dir: 'in', width: 2, label: 'operand select', role: 'select' },
    { id: 'bank', kind: 'register', domain: 'sys', label: 'input registers', enable: true, enable_width: 1, lanes: [{ id: 'xa', width: 8 }, { id: 'xb', width: 8 }, { id: 'ya', width: 8 }, { id: 'yb', width: 8 }] },
    { id: 'm', kind: 'mux', inputs: 4, width: 8, encoding: 'binary' },
    { id: 'u', kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name: 'scaler' }, ports: [{ id: 'a', dir: 'in', width: 8 }, { id: 'q', dir: 'out', width: 8 }, { id: 'flag', dir: 'out', width: 1 }] },
    { id: 'v', kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name: 'mixer' }, ports: [{ id: 'q', dir: 'in', width: 8 }, { id: 'flag', dir: 'in', width: 1 }, { id: 'o', dir: 'out', width: 8 }] },
    { id: 'p_o', kind: 'port', dir: 'out', width: 8, label: 'result' },
  ],
  nets: [
    ...['xa', 'xb', 'ya', 'yb'].map((l) => ({ id: `n_${l}`, width: 8, driver: `p_${l}`, sinks: [`bank.d_${l}`] })),
    { id: 'n_load', width: 1, driver: 'p_load', sinks: ['bank.en'] },
    ...['xa', 'xb', 'ya', 'yb'].map((l, k) => ({ id: `n_q${l}`, width: 8, label: `${l} register`, driver: `bank.q_${l}`, sinks: [`m.in${k}`] })),
    { id: 'n_sel', width: 2, driver: 'p_sel', sinks: ['m.sel'] },
    { id: 'n_m', width: 8, label: 'operand', driver: 'm.out', sinks: ['u.a'] },
    { id: 'n_uq', width: 8, label: 'scaled', driver: 'u.q', sinks: ['v.q'] },
    { id: 'n_uflag', width: 1, label: 'scale flag', driver: 'u.flag', sinks: ['v.flag'] },
    { id: 'n_o', width: 8, driver: 'v.o', sinks: ['p_o'] },
  ],
});

const run = (doc, ops, opts = {}) => applyPatch(doc, ops, { figureDir: root, ...opts });

test('patch: the op set covers the authoring edits', () => {
  for (const op of ['rename', 'collapse', 'expand', 'bundle', 'unbundle', 'insert', 'split-bank', 'merge-banks', 'split-stage', 'merge-stages', 'reorder', 'label-placement', 'abstract-handshakes', 'omit', 'detail-ref', 'move-to-region', 'set-meta', 'set']) assert.ok(PATCH_OP_NAMES.includes(op), op);
});

test('patch: rename, label placement and meta apply to a copy; the input is untouched', async () => {
  const doc = figure();
  const r = await run(doc, [
    { op: 'rename', id: 'u', label: 'scale unit', note: 'from the RTL comment' },
    { op: 'rename', id: 'bank.xa', label: 'x imaginary part' },
    { op: 'rename', id: 'n_m', label: 'operand A', short_label: 'operand' },
    { op: 'label-placement', net: 'n_m', placement: 'auto' },
    { op: 'set-meta', title: 'scaled operands', print: { max_height_in: { '2col': 6 } } },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.doc.elements.find((e) => e.id === 'u').label, 'scale unit');
  assert.equal(r.doc.elements.find((e) => e.id === 'bank').lanes[0].label, 'x imaginary part');
  assert.equal(r.doc.nets.find((n) => n.id === 'n_m').label_placement, 'auto');
  assert.deepEqual(r.doc.meta.print.max_height_in, { '2col': 6 });
  assert.equal(r.applied[0].note, 'from the RTL comment');
  assert.equal(doc.elements.find((e) => e.id === 'u').label, undefined, 'input figure unchanged');
});

test('patch: an invalid op rejects the whole patch, nothing applied', async () => {
  const doc = figure();
  const r = await run(doc, [{ op: 'rename', id: 'u', label: 'scale unit' }, { op: 'rename', id: 'nope', label: 'x' }]);
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, 'patch/invalid-op');
  assert.equal(r.doc, doc);
  const unknown = await run(doc, [{ op: 'teleport' }]);
  assert.equal(unknown.diagnostics[0].code, 'patch/unknown-op');
});

test('patch: a result with a new error (a dangling endpoint) is rejected by re-validation', async () => {
  const r = await run(figure(), [{ op: 'remove-net', id: 'n_sel' }]);
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.every((d) => d.code === 'patch/validation'));
  assert.ok(r.diagnostics.some((d) => /sel/.test(d.message)), JSON.stringify(r.diagnostics));
});

test('patch: split-bank into pairs and merge-banks back reproduce the figure', async () => {
  const doc = figure();
  const split = await run(doc, [{ op: 'split-bank', id: 'bank', groups: [{ id: 'reg_x', label: 'x registers', lanes: ['xa', 'xb'] }, { id: 'reg_y', label: 'y registers', lanes: ['ya', 'yb'] }] }]);
  assert.equal(split.ok, true, JSON.stringify(split.diagnostics));
  assert.deepEqual(split.doc.nets.find((n) => n.id === 'n_load').sinks, ['reg_x.en', 'reg_y.en']);
  assert.equal(split.doc.nets.find((n) => n.id === 'n_qyb').driver, 'reg_y.q_yb');
  const merged = await run(split.doc, [{ op: 'merge-banks', ids: ['reg_x', 'reg_y'], id: 'bank', label: 'input registers' }]);
  assert.equal(merged.ok, true, JSON.stringify(merged.diagnostics));
  assert.deepEqual(figureDiff(doc, merged.doc).filter((d) => d.kind !== 'order'), []);
});

test('patch: collapse into a named block and expand from the edits record reproduce the figure', async () => {
  const doc = figure();
  const c = await run(doc, [{ op: 'collapse', ids: ['u', 'v'], id: 'blk', label: 'scale and mix' }]);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  const blk = c.doc.elements.find((e) => e.id === 'blk');
  assert.deepEqual(blk.ports.map((p) => [p.id, p.dir]).sort(), [['i_a', 'in'], ['o_o', 'out']]);
  assert.ok(!c.doc.nets.some((n) => n.id === 'n_uq'), 'internal nets are absorbed');
  assert.equal(c.records.length, 1);
  const e = await run(c.doc, [{ op: 'expand', id: 'blk' }], { history: c.records });
  assert.equal(e.ok, true, JSON.stringify(e.diagnostics));
  assert.deepEqual(figureDiff(doc, e.doc).filter((d) => d.kind !== 'order'), []);
  const missing = await run(c.doc, [{ op: 'expand', id: 'blk' }]);
  assert.match(missing.diagnostics[0].message, /no collapse record/);
});

test('patch: bundle parallel nets and unbundle them back', async () => {
  const doc = figure();
  const b = await run(doc, [{ op: 'bundle', nets: ['n_uq', 'n_uflag'], id: 'n_scaled', label: 'scaled value' }]);
  assert.equal(b.ok, true, JSON.stringify(b.diagnostics));
  const bn = b.doc.nets.find((n) => n.id === 'n_scaled');
  assert.equal(bn.width, 9);
  assert.deepEqual(bn.bundle_of, ['n_uq', 'n_uflag']);
  assert.deepEqual(b.doc.elements.find((e) => e.id === 'u').ports.find((p) => p.bundle)?.bundle, ['q', 'flag']);
  const u = await run(b.doc, [{ op: 'unbundle', id: 'n_scaled' }], { history: b.records });
  assert.equal(u.ok, true, JSON.stringify(u.diagnostics));
  assert.deepEqual(figureDiff(doc, u.doc).filter((d) => d.kind !== 'order'), []);
});

test('patch: insert a register with a named load, reorder lanes, move to a region, detail_ref', async () => {
  const r = await run(figure(), [
    { op: 'insert', kind: 'register', net: 'n_o', id: 'reg_o', label: 'output register', enable: { from: 'p_load' } },
    { op: 'reorder', id: 'bank', lanes: ['ya', 'yb', 'xa', 'xb'] },
    { op: 'move-to-region', ids: ['u', 'v'], region: 'r_scale', level: 'block', label: 'scale path' },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.doc.nets.find((n) => n.id === 'n_o').sinks[0], 'reg_o.d');
  assert.deepEqual(r.doc.nets.find((n) => n.id === 'n_o_reg_o').sinks, ['p_o']);
  assert.deepEqual(r.doc.elements.find((e) => e.id === 'bank').lanes.map((l) => l.id), ['ya', 'yb', 'xa', 'xb']);
  assert.deepEqual(r.doc.regions, [{ id: 'r_scale', level: 'block', members: ['u', 'v'], label: 'scale path' }]);
  const missingFigure = await run(figure(), [{ op: 'detail-ref', id: 'u', figure: 'no-such-figure.datapath.json' }]);
  assert.equal(missingFigure.ok, false, 'an unresolved detail figure is a new error');
});

test('patch: split a function into stages and merge them back', async () => {
  const doc = figure();
  const s = await run(doc, [{ op: 'split-stage', id: 'u', stages: [{ id: 'u1', ports: ['a'] }, { id: 'u2', ports: ['q', 'flag'] }], links: [{ id: 'n_u_mid', from: 'u1', to: 'u2', width: 8, label: 'partial' }] }]);
  assert.equal(s.ok, true, JSON.stringify(s.diagnostics));
  assert.deepEqual(s.doc.elements.filter((e) => /^u\d$/.test(e.id)).map((e) => e.function.stage), ['1/2', '2/2']);
  const m = await run(s.doc, [{ op: 'merge-stages', ids: ['u1', 'u2'], id: 'u' }]);
  assert.equal(m.ok, true, JSON.stringify(m.diagnostics));
  assert.deepEqual(figureDiff(doc, m.doc).filter((d) => d.kind !== 'order'), []);
});

test('fig-gen patch: CLI applies a script, logs it, and writes nothing on rejection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-patch-'));
  try {
    const file = path.join(dir, 'f.datapath.json');
    fs.writeFileSync(file, JSON.stringify(figure(), null, 2));
    const script = path.join(dir, 'edits.json');
    fs.writeFileSync(script, JSON.stringify({ note: 'names from the RTL', ops: [{ op: 'rename', id: 'u', label: 'scale unit' }] }));
    const ok = spawnSync(process.execPath, [path.join(root, 'bin/fig-gen.mjs'), 'patch', file, '--script', script, '--author', 'tester'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).elements.find((e) => e.id === 'u').label, 'scale unit');
    const log = JSON.parse(fs.readFileSync(path.join(dir, 'f.datapath.edits.json'), 'utf8'));
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].note, 'names from the RTL');
    assert.match(fs.readFileSync(path.join(dir, 'f.datapath.edits.md'), 'utf8'), /rename/);
    const before = fs.readFileSync(file, 'utf8');
    const bad = spawnSync(process.execPath, [path.join(root, 'bin/fig-gen.mjs'), 'patch', file, '--op', '{"op":"remove-net","id":"n_sel"}'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /patch rejected: nothing written/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'f.datapath.edits.json'), 'utf8')).entries.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
