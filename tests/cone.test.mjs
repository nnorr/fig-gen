import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDatapath } from '../lib/checks/datapath.mjs';
import { checkRegionEquivalence } from '../lib/checks/equivalence.mjs';
import { evalTree, expandToGates, findModule, resolveCone } from '../lib/rtl/cone.mjs';
import verilator from '../lib/rtl/verilator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detected = await verilator.detect();
const skip = !detected.available && 'verilator not installed';

let netlistPromise;
const netlist = () => {
  netlistPromise ??= (async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-cone-'));
    try {
      return await verilator.extract({ files: [path.join(root, 'tests/fixtures/rtl/cone/cone_top.sv')], top: 'cone_top', work_dir: work });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  })();
  return netlistPromise;
};

// Build a datapath figure whose single gate region is the expansion of `output`.
function regionFigure(expansion, output, inputMap) {
  const elements = expansion.elements;
  const nets = expansion.nets.map((n) => {
    const inPort = expansion.inputs.find((i) => i.id === n.driver);
    if (inPort) return { ...n, rtl: inputMap(inPort.key) };
    if (n.sinks.includes(expansion.output)) return { ...n, rtl: { signal: output } };
    return n;
  });
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 't', print: { profile: 'ieee' } },
    clock_domains: [], elements, nets,
    regions: [{ id: 'r', level: 'gate', members: elements.filter((e) => e.kind !== 'port').map((e) => e.id) }],
  };
}
const asRtl = (key) => {
  const m = /^(\w+)(?:\[(\d+)(?::(\d+))?\])?$/.exec(key);
  return m[3] !== undefined ? { signal: m[1], slice: `${m[2]}:${m[3]}` } : m[2] !== undefined ? { signal: m[1], index: Number(m[2]) } : { signal: m[1] };
};

test('continuous assignments are extracted as expression trees', { skip }, async () => {
  const mod = findModule(await netlist());
  const targets = mod.exprs.map((e) => e.target).sort();
  for (const t of ['any', 'cor', 'det', 'hit', 'no_err', 'par', 'unc']) assert.ok(targets.includes(t), t);
  const cone = resolveCone(mod, { output: 'unc', stopAt: [] });
  assert.deepEqual(cone.inputs.map((i) => i.key).sort(), ['pm', 's1z', 's2z']);
  // both syndromes zero: no error detected, so not uncorrectable
  const env = new Map([['pm', 0n], ['s1z', 1n], ['s2z', 1n]]);
  assert.equal(evalTree(cone.tree, env), 0n);
  // one syndrome zero: detected but not correctable
  env.set('s2z', 0n);
  assert.equal(evalTree(cone.tree, env), 1n);
});

test('a gate expansion of unc is exhaustively equivalent to the RTL (8 input bits)', { skip }, async () => {
  const mod = findModule(await netlist());
  const exp = expandToGates(resolveCone(mod, { output: 'unc' }), { prefix: 'u', outputLabel: 'unc' });
  assert.deepEqual(exp.diagnostics, []);
  assert.ok(exp.elements.some((e) => e.op === 'nand' || e.invert_inputs), 'bubbles or NAND folding expected');
  const fig = regionFigure(exp, 'unc', asRtl);
  assert.deepEqual(checkDatapath(fig).diagnostics.filter((d) => d.severity === 'error'), []);
  const r = checkRegionEquivalence(fig, fig.regions[0], await netlist());
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual({ method: r.result.method, vectors: r.result.vectors, input_bits: r.result.input_bits }, { method: 'exhaustive', vectors: 256, input_bits: 8 });
});

test('a wrong gate is caught with a counterexample', { skip }, async () => {
  const mod = findModule(await netlist());
  const exp = expandToGates(resolveCone(mod, { output: 'cor' }), { prefix: 'c', outputLabel: 'cor' });
  const fig = regionFigure(exp, 'cor', asRtl);
  const g = fig.elements.find((e) => e.kind === 'comb' && e.op === 'and');
  g.op = 'or';
  const r = checkRegionEquivalence(fig, fig.regions[0], await netlist());
  const mismatch = r.diagnostics.find((d) => d.code === 'equiv/mismatch');
  assert.ok(mismatch, JSON.stringify(r.diagnostics));
  assert.match(mismatch.message, /drawn 0x[01], RTL 0x[01]/);
  assert.ok(Object.keys(mismatch.evidence.counterexample).length >= 3);
});

test('compare against a constant is bit-blasted into one AND with bubbles', { skip }, async () => {
  const mod = findModule(await netlist());
  const exp = expandToGates(resolveCone(mod, { output: 'hit' }), { prefix: 'h', outputLabel: 'hit' });
  const and = exp.elements.find((e) => e.op === 'and');
  assert.equal(and.inputs, 8);
  assert.deepEqual(and.invert_inputs, [0, 1, 2, 3, 4, 5, 7]);
  const fig = regionFigure(exp, 'hit', asRtl);
  const r = checkRegionEquivalence(fig, fig.regions[0], await netlist());
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.result.method, 'exhaustive');
});

test('wide cones are checked with seeded samples; mapping gaps and gate caps are reported', { skip }, async () => {
  const mod = findModule(await netlist());
  const exp = expandToGates(resolveCone(mod, { output: 'par' }), { prefix: 'p', outputLabel: 'par' });
  const fig = regionFigure(exp, 'par', asRtl);
  fig.regions[0].equivalence = { vectors: 512, seed: 7 };
  const r = checkRegionEquivalence(fig, fig.regions[0], await netlist());
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual({ method: r.result.method, vectors: r.result.vectors, seed: r.result.seed, input_bits: r.result.input_bits }, { method: 'sampled', vectors: 512, seed: 7, input_bits: 24 });

  const unmapped = regionFigure(exp, 'par', asRtl);
  delete unmapped.nets.find((n) => n.rtl && n.rtl.signal === 'y').rtl;
  assert.ok(checkRegionEquivalence(unmapped, unmapped.regions[0], await netlist()).diagnostics.some((d) => d.code === 'equiv/input-unmapped'));

  const capped = expandToGates(resolveCone(mod, { output: 'unc' }), { maxGates: 2, prefix: 'x' });
  assert.ok(capped.diagnostics.some((d) => d.code === 'gate/too-many'));
});
