// Register-transfer layout rules (SPEC §4.10, §9.4): the controller shares the
// operator's partition (drawn in the column before it, above the selects), and
// a handshake lane of a pipeline bar is control, drawn dashed through the bar.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveNetClasses } from '../lib/checks/net-class.mjs';
import { draftRtlDatapath } from '../lib/draft-rtl.mjs';
import { buildModel } from '../lib/ir/datapath-model.mjs';
import { partitions, renderDatapath } from '../lib/render/datapath.mjs';
import verilator from '../lib/rtl/verilator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detected = await verilator.detect();
const skip = !detected.available && 'verilator not installed';

const controllerDoc = () => ({
  schema_version: 1, figure_type: 'datapath',
  meta: { title: 'controller', print: { profile: 'ieee' } },
  clock_domains: [{ id: 'sys', clock: 'clk' }],
  elements: [
    { id: 'p_a', kind: 'port', dir: 'in', width: 8, label: 'input a' },
    { id: 'p_b', kind: 'port', dir: 'in', width: 8, label: 'input b' },
    { id: 'bank', kind: 'register', domain: 'sys', label: 'input registers', enable: true, lanes: [{ id: 'a', width: 8 }, { id: 'b', width: 8 }] },
    { id: 'm', kind: 'mux', inputs: 2, width: 8, encoding: 'onehot' },
    { id: 'unit', kind: 'comb', op: 'custom', width: 8, function: { kind: 'arithmetic_unit' }, ports: [{ id: 'x', dir: 'in', width: 8 }, { id: 'op', dir: 'in', width: 2 }, { id: 'y', dir: 'out', width: 8 }] },
    { id: 'ctl', kind: 'comb', op: 'custom', width: 2, holds_state: true, function: { kind: 'controller' }, ports: [{ id: 'sel', dir: 'out', width: 2, latency: 'state' }, { id: 'load', dir: 'out', width: 1, latency: 'state' }, { id: 'op', dir: 'out', width: 2, latency: 'state' }] },
    { id: 'out', kind: 'register', domain: 'sys', label: 'output registers', enable: true, enable_width: 1, shared_d: true, lanes: [{ id: 'o', width: 8 }, { id: 'p', width: 8 }] },
    { id: 'p_o', kind: 'port', dir: 'out', width: 8, label: 'output o' },
    { id: 'p_p', kind: 'port', dir: 'out', width: 8, label: 'output p' },
  ],
  nets: [
    { id: 'n_a', width: 8, driver: 'p_a', sinks: ['bank.d_a'] },
    { id: 'n_b', width: 8, driver: 'p_b', sinks: ['bank.d_b'] },
    { id: 'n_qa', width: 8, label: 'operand a', driver: 'bank.q_a', sinks: ['m.in0'] },
    { id: 'n_qb', width: 8, label: 'operand b', driver: 'bank.q_b', sinks: ['m.in1'] },
    { id: 'n_x', width: 8, driver: 'm.out', sinks: ['unit.x'] },
    { id: 'n_sel', width: 2, label: 'select', driver: 'ctl.sel', sinks: ['m.sel'] },
    { id: 'n_load', width: 1, label: 'loads', driver: 'ctl.load', sinks: ['bank.en', 'out.en'] },
    { id: 'n_op', width: 2, label: 'operation', driver: 'ctl.op', sinks: ['unit.op'] },
    { id: 'n_y', width: 8, label: 'result', driver: 'unit.y', sinks: ['out.d'] },
    { id: 'n_o', width: 8, driver: 'out.q_o', sinks: ['p_o'] },
    { id: 'n_p', width: 8, driver: 'out.q_p', sinks: ['p_p'] },
  ],
});

test('layout: the controller shares the partition of the operator it feeds, so the registers it loads get the column after the operator', () => {
  const p = partitions(controllerDoc());
  assert.equal(p.get('ctl'), p.get('unit'), JSON.stringify(Object.fromEntries(p)));
  assert.ok(p.get('m') < p.get('unit') && p.get('unit') < p.get('out'), JSON.stringify(Object.fromEntries(p)));
  // an authored layer still wins
  const authored = controllerDoc();
  authored.elements.find((e) => e.id === 'ctl').layout = { layer: 5 };
  assert.equal(partitions(authored).get('ctl'), 5);
});

const barDoc = () => ({
  schema_version: 1, figure_type: 'datapath',
  meta: { title: 'bar', print: { profile: 'ieee' } },
  clock_domains: [{ id: 'sys', clock: 'clk' }],
  elements: [
    { id: 'p_d', kind: 'port', dir: 'in', width: 8, label: 'data in' },
    { id: 'p_v', kind: 'port', dir: 'in', width: 1, label: 'valid in', role: 'handshake' },
    { id: 'bar', kind: 'pipeline_register', domain: 'sys', stage: 1, label: 'S0|S1', lanes: [{ id: 'd', width: 8 }, { id: 'v', width: 1, class: 'control' }] },
    { id: 'q_d', kind: 'port', dir: 'out', width: 8, label: 'data out' },
    { id: 'q_v', kind: 'port', dir: 'out', width: 1, label: 'valid out', role: 'handshake' },
  ],
  nets: [
    { id: 'n_d', width: 8, driver: 'p_d', sinks: ['bar.d_d'] },
    { id: 'n_v', width: 1, driver: 'p_v', sinks: ['bar.d_v'] },
    { id: 'n_qd', width: 8, driver: 'bar.q_d', sinks: ['q_d'] },
    { id: 'n_qv', width: 1, driver: 'bar.q_v', sinks: ['q_v'] },
  ],
});

test('pipeline bar: a control lane is control on both sides and dashed through the bar', async () => {
  const doc = barDoc();
  const classes = deriveNetClasses(buildModel(doc));
  assert.equal(classes.get('n_v').drawn, 'control');
  assert.equal(classes.get('n_qv').drawn, 'control');
  assert.equal(classes.get('n_d').drawn, 'data');
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'bar' });
  const dashedPath = (id) => new RegExp(`<path[^>]*id="net-${id}-seg\\d+"[^>]*stroke-dasharray|<path[^>]*stroke-dasharray[^>]*id="net-${id}-seg\\d+"`).test(r.svg);
  assert.ok(dashedPath('n_v') && dashedPath('n_qv'), 'valid wires dashed on both sides of the bar');
  assert.ok(!dashedPath('n_d') && !dashedPath('n_qd'), 'data wires solid');
});

test('draft --style rtl-datapath: a valid bit loaded every cycle is a control lane of its pipeline bar', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-pipe-valid-'));
  try {
    const rtl = path.join(dir, 'rtl');
    fs.mkdirSync(rtl);
    fs.copyFileSync(path.join(root, 'tests/fixtures/rtl/rtl-datapath/pipe_valid.sv'), path.join(rtl, 'pipe_valid.sv'));
    const { spawnSync } = await import('node:child_process');
    const out = path.join(dir, 'netlist.json');
    const r = spawnSync(process.execPath, [path.join(root, 'bin/fig-gen.mjs'), 'check-rtl', '--top', 'pipe_valid', '--files', path.join(rtl, 'pipe_valid.sv'), '--work-dir', path.join(dir, 'work'), '--source-root', rtl, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const { doc, notes } = draftRtlDatapath(JSON.parse(fs.readFileSync(out, 'utf8')), { scope: '' });
    const bars = doc.elements.filter((e) => e.kind === 'pipeline_register');
    assert.ok(bars.length >= 1, notes.join('\n'));
    const lanes = bars.flatMap((b) => b.lanes);
    const valid = lanes.find((l) => /valid/.test(l.id));
    const data = lanes.find((l) => /data/.test(l.id));
    assert.equal(valid?.class, 'control', JSON.stringify(lanes));
    assert.equal(data?.class, undefined, JSON.stringify(lanes));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
