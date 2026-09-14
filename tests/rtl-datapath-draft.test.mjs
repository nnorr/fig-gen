// Register-transfer datapath draft (SPEC §4.10, CONVENTIONS §5.6, §10.1):
// register banks in the IR, the layout cut of a register-transfer loop at its
// banks, and `draft --style rtl-datapath` on a micro-sequenced fixture (loaded
// operands, a step-selected adder, write-back into temporary and output
// registers, a controller).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDatapath } from '../lib/checks/datapath.mjs';
import { draftResiduals } from '../lib/draft-check.mjs';
import { draftRtlDatapath } from '../lib/draft-rtl.mjs';
import { partitions, renderDatapath } from '../lib/render/datapath.mjs';
import verilator from '../lib/rtl/verilator.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detected = await verilator.detect();
const skip = !detected.available && 'verilator not installed';

const bankDoc = () => ({
  schema_version: 1, figure_type: 'datapath',
  meta: { title: 'bank', print: { profile: 'ieee' } },
  clock_domains: [{ id: 'sys', clock: 'clk' }],
  elements: [
    { id: 'p_a', kind: 'port', dir: 'in', width: 8, label: 'input a' },
    { id: 'p_b', kind: 'port', dir: 'in', width: 8, label: 'input b' },
    { id: 'p_load', kind: 'port', dir: 'in', width: 1, label: 'load', role: 'enable' },
    { id: 'p_sel', kind: 'port', dir: 'in', width: 2, label: 'select', role: 'select' },
    { id: 'p_wload', kind: 'port', dir: 'in', width: 2, label: 'write loads', role: 'enable' },
    { id: 'bank', kind: 'register', domain: 'sys', label: 'input registers', enable: true, lanes: [{ id: 'a', width: 8 }, { id: 'b', width: 8 }] },
    { id: 'temps', kind: 'register', domain: 'sys', label: 'temporary registers', enable: true, enable_width: 2, shared_d: true, lanes: [{ id: 't0', width: 8 }, { id: 't1', width: 8 }] },
    { id: 'm', kind: 'mux', inputs: 4, width: 8, encoding: 'binary' },
    { id: 'add', kind: 'comb', op: 'add', width: 8 },
    { id: 'p_o', kind: 'port', dir: 'out', width: 8, label: 'sum' },
  ],
  nets: [
    { id: 'n_a', width: 8, driver: 'p_a', sinks: ['bank.d_a'] },
    { id: 'n_b', width: 8, driver: 'p_b', sinks: ['bank.d_b'] },
    { id: 'n_load', width: 1, driver: 'p_load', sinks: ['bank.en'] },
    { id: 'n_wload', width: 2, driver: 'p_wload', sinks: ['temps.en'] },
    { id: 'n_qa', width: 8, label: 'operand a', driver: 'bank.q_a', sinks: ['m.in0', 'add.in1'] },
    { id: 'n_qb', width: 8, label: 'operand b', driver: 'bank.q_b', sinks: ['m.in1'] },
    { id: 'n_t0', width: 8, label: 'temporary 1', driver: 'temps.q_t0', sinks: ['m.in2'] },
    { id: 'n_t1', width: 8, label: 'temporary 2', driver: 'temps.q_t1', sinks: ['m.in3'] },
    { id: 'n_sel', width: 2, driver: 'p_sel', sinks: ['m.sel'] },
    { id: 'n_x', width: 8, driver: 'm.out', sinks: ['add.in0'] },
    { id: 'n_sum', width: 8, driver: 'add.out', sinks: ['temps.d', 'p_o'] },
  ],
});

test('register bank: lanes with one enable, a shared data input, schema and semantic checks pass', async () => {
  const doc = bankDoc();
  assert.deepEqual(await validateSchema('datapath', doc), []);
  assert.deepEqual(checkDatapath(doc).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message), []);
  // width is not given with lanes; a plain register still needs it
  const bad = bankDoc();
  bad.elements.find((e) => e.id === 'bank').width = 8;
  assert.ok((await validateSchema('datapath', bad)).length > 0);
  const plain = bankDoc();
  plain.elements.push({ id: 'r', kind: 'register', domain: 'sys' });
  assert.ok((await validateSchema('datapath', plain)).length > 0);
  // the enable pin carries one bit per independently loaded register
  const wide = bankDoc();
  wide.nets.find((n) => n.id === 'n_wload').width = 1;
  wide.elements.find((e) => e.id === 'p_wload').width = 1;
  assert.ok(checkDatapath(wide).diagnostics.some((d) => d.code === 'width/mismatch'));
});

test('register bank: drawn as one storage box with its role name inside and a clock wedge', async () => {
  const r = await renderDatapath(bankDoc(), { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'bank' });
  assert.match(r.svg, /id="reg-bank-body"/);
  assert.match(r.svg, />input registers</);
  assert.match(r.svg, />temporary registers</);
  // the symbol itself is clean (routing of this toy figure is not under test)
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error' && !/^route\//.test(d.code) && /bank|temps|reg-/.test(d.message)).map((d) => d.message), []);
});

test('layout: a register-transfer loop is cut at its register bank, so the bank precedes the select and operator', () => {
  const doc = bankDoc();
  const p = partitions(doc);
  assert.ok(p.backEdges.has('add>temps'), [...p.backEdges].join(' '));
  assert.ok(p.get('temps') < p.get('m') && p.get('m') < p.get('add'), JSON.stringify(Object.fromEntries(p)));
  assert.equal(p.get('bank'), p.get('temps'));
});

test('draft --style rtl-datapath: banks by role, operand selects, operator, controller, from the netlist alone', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-rtl-draft-'));
  try {
    // The RTL is copied out of tests/fixtures first: the evidence guard rejects fixtures as evidence.
    const rtl = path.join(dir, 'rtl');
    fs.mkdirSync(rtl);
    fs.copyFileSync(path.join(root, 'tests/fixtures/rtl/rtl-datapath/iter_unit.sv'), path.join(rtl, 'iter_unit.sv'));
    const { spawnSync } = await import('node:child_process');
    const out = path.join(dir, 'netlist.json');
    const r = spawnSync(process.execPath, [path.join(root, 'bin/fig-gen.mjs'), 'check-rtl', '--top', 'iter_unit', '--files', path.join(rtl, 'iter_unit.sv'), '--work-dir', path.join(dir, 'work'), '--source-root', dir, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const netlist = JSON.parse(fs.readFileSync(out, 'utf8'));
    const { doc, notes } = draftRtlDatapath(netlist, { scope: '' });
    const byId = new Map(doc.elements.map((e) => [e.id, e]));
    const bank = (role) => doc.elements.find((e) => e.kind === 'register' && e.label === `${role} registers`);
    assert.deepEqual(bank('input')?.lanes.map((l) => l.rtl.signal).sort(), ['c_a', 'c_b'], notes.join('\n'));
    assert.equal(bank('input').enable_width, 1, 'operands load together on accept');
    // one register of a role is a plain register with an enable (a bank needs two or more)
    for (const sig of ['c_t', 'c_r']) {
      const reg = doc.elements.find((e) => e.kind === 'register' && e.rtl?.signal === sig);
      assert.ok(reg && reg.enable && !reg.lanes, `${sig} drawn as a register with an enable`);
    }
    const muxes = doc.elements.filter((e) => e.kind === 'mux');
    assert.equal(muxes.length, 2, 'operand x and operand y selects');
    assert.ok(doc.elements.some((e) => e.kind === 'comb' && e.op === 'add'), 'the adder');
    const controller = byId.get('controller');
    assert.equal(controller?.function.kind, 'controller');
    assert.ok(controller.rtl.covers.includes('c_step') && controller.rtl.covers.includes('c_busy'));
    // selects and loads are drawn from the controller, never hidden
    assert.ok(doc.nets.some((n) => n.driver.startsWith('controller.') && n.sinks.some((s) => /\.sel$/.test(s))));
    assert.ok(doc.nets.some((n) => n.driver.startsWith('controller.') && n.sinks.some((s) => /\.en$/.test(s))));
    // the draft passes its own checks: schema, semantics, labels, view, RTL cross-check, coverage, latency
    const residual = await draftResiduals(structuredClone(doc), netlist, { quality: 'paper', figureDir: dir });
    assert.deepEqual(residual.map((d) => `${d.code}: ${d.message}`), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
