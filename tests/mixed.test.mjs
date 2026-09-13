// Mixed abstraction (SPEC §4.6): gate symbols, blackbox hatch, region frames,
// level legend, and delivery with an equivalence-checked gate region. The RTL
// is copied out of tests/fixtures into a temp "user" directory first, because
// the evidence guard (SPEC §12.2) rejects fixtures as evidence.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deliver } from '../lib/deliver.mjs';
import { renderDatapath } from '../lib/render/datapath.mjs';
import { expandToGates, findModule, resolveCone } from '../lib/rtl/cone.mjs';
import verilator from '../lib/rtl/verilator.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detected = await verilator.detect();
const skip = !detected.available && 'verilator not installed';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'bin', 'fig-gen.mjs'), ...args], { encoding: 'utf8' });
const errors = (diags) => diags.filter((d) => d.severity === 'error');

test('gate regions draw IEEE gates, blackboxes are hatched (unframed by default), gate regions framed, legend shown for >2 levels', async () => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'datapath-mixed-gates.json'), 'utf8'));
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'mixed' });
  assert.deepEqual(errors(r.diagnostics), []);
  for (const id of ['nand-g_det', 'and-g_cor', 'region-cls-frame', 'instance-mem-hatch']) {
    assert.match(r.svg, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(r.svg, /id="region-bb-frame"/, 'the hatch already marks a blackbox; no frame unless frame: true');
  assert.doesNotMatch(r.svg, /id="legend-levels"/, 'two levels (gate, blackbox): no legend');

  const three = structuredClone(doc);
  three.elements.push(
    { id: 'cmp', kind: 'comb', op: 'custom', width: 4, function: { kind: 'comparator' }, pin_labels: false, ports: [{ id: 'a', dir: 'in', width: 4 }, { id: 'y', dir: 'out', width: 1, class: 'control' }] },
    { id: 'hit', kind: 'port', dir: 'out', width: 1, class: 'control', label: 'address hit' },
  );
  three.nets.find((n) => n.id === 'n_addr').sinks.push('cmp.a');
  three.nets.push({ id: 'n_hit', width: 1, class: 'control', driver: 'cmp.y', sinks: ['hit'] });
  const r3 = await renderDatapath(three, { variant: '2col', widthPt: 515.5, name: 'mixed' });
  assert.deepEqual(errors(r3.diagnostics), []);
  assert.match(r3.svg, /id="legend-levels"/, 'three levels (gate, blackbox, block): legend');
  assert.match(r.svg, /stroke-dasharray="2 2"/);
  assert.deepEqual(lintFigmaSafe(r.svg), []);
  assert.equal(r.route.data_jogs_redundant, 0);

  const framed = structuredClone(doc);
  framed.regions.find((x) => x.id === 'bb').frame = true;
  const rf = await renderDatapath(framed, { variant: '2col', widthPt: 515.5, name: 'mixed' });
  assert.match(rf.svg, /id="region-bb-frame"/);
  assert.equal(rf.diagnostics.filter((d) => d.code.startsWith('region/frame')).length, 0, 'a frame encloses exactly its members');

  const two = structuredClone(doc);
  two.regions = two.regions.filter((x) => x.level === 'gate');
  const r2 = await renderDatapath(two, { variant: '2col', widthPt: 515.5, name: 'mixed' });
  assert.doesNotMatch(r2.svg, /id="legend-levels"/, 'gate + block only: no legend');
});

async function userNetlist(user, work) {
  fs.copyFileSync(path.join(root, 'tests', 'fixtures', 'rtl', 'cone', 'cone_top.sv'), path.join(user, 'cone_top.sv'));
  const run = cli('check-rtl', '--top', 'cone_top', '--files', path.join(user, 'cone_top.sv'), '--work-dir', work, '--out', path.join(user, 'netlist.json'), '--quiet');
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(fs.readFileSync(path.join(user, 'netlist.json'), 'utf8'));
}

function gateFigure(netlist, output) {
  const cone = resolveCone(findModule(netlist), { output, stopAt: [] });
  const x = expandToGates(cone, { prefix: 'g_' });
  const inputs = new Map(x.inputs.map((i) => [i.id ?? i.port, i.key]));
  const nets = x.nets.map((n) => (inputs.has(n.driver) ? { ...n, rtl: { signal: inputs.get(n.driver) } } : n.sinks.includes(x.output) ? { ...n, rtl: { signal: output } } : n));
  // The figure draws one cone, so its declared scope is that cone (coverage/dropped-hardware).
  return {
    schema_version: 1, figure_type: 'datapath',
    meta: { title: `cone ${output}`, print: { profile: 'ieee', variants: ['2col'] }, scope: { cone: { outputs: [output], inputs: cone.inputs.map((i) => i.name) } } },
    clock_domains: [], elements: x.elements, nets,
    regions: [{ id: 'cls', label: 'gates', level: 'gate', members: x.elements.filter((e) => e.kind !== 'port').map((e) => e.id) }],
  };
}

test('delivery records an exhaustive equivalence pass for a gate region drawn from user RTL', { skip }, async () => {
  const user = tmp('figgen-user-');
  const work = tmp('figgen-work-');
  try {
    const netlist = await userNetlist(user, work);
    const figure = path.join(user, 'unc.datapath.json');
    fs.writeFileSync(figure, JSON.stringify(gateFigure(netlist, 'unc')));
    const r = await deliver({ type: 'datapath', figurePath: figure, outDir: path.join(user, 'out'), netlistPath: path.join(user, 'netlist.json') });
    assert.deepEqual(errors(r.diagnostics), []);
    assert.equal(r.ok, true);
    const receiptPath = r.written.find((f) => f.endsWith('.receipt.json'));
    const receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), 'utf8'));
    assert.deepEqual(await validateSchema('receipt', receipt), []);
    const region = receipt.verification.regions.find((x) => x.kind === 'gate-region');
    assert.equal(region.level, 'structural-only');
    assert.equal(region.grounding, 'rtl');
    assert.equal(region.equivalence.method, 'exhaustive');
    assert.equal(region.equivalence.result, 'pass');
  } finally {
    fs.rmSync(user, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a gate drawn wrong fails delivery with a counterexample', { skip }, async () => {
  const user = tmp('figgen-user-');
  const work = tmp('figgen-work-');
  try {
    const netlist = await userNetlist(user, work);
    const doc = gateFigure(netlist, 'unc');
    const gate = doc.elements.find((e) => ['and', 'nand'].includes(e.op));
    gate.op = gate.op === 'and' ? 'or' : 'nor';
    const figure = path.join(user, 'bad.datapath.json');
    fs.writeFileSync(figure, JSON.stringify(doc));
    const out = path.join(user, 'out');
    const r = await deliver({ type: 'datapath', figurePath: figure, outDir: out, netlistPath: path.join(user, 'netlist.json') });
    assert.equal(r.ok, false);
    const mismatch = r.diagnostics.find((d) => d.code === 'equiv/mismatch');
    assert.ok(mismatch, JSON.stringify(r.diagnostics));
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(user, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});
