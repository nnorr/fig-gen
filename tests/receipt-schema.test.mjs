import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSchema } from '../lib/validate.mjs';

const H = (c) => c.repeat(64);
const SCOPE = 'Simulation evidence covers only the recorded stimulus and cycle window.';

function baseReceipt(verification, evidence = []) {
  const artifact = (ext) => ({ path: `fig.1col.${ext}`, sha256: H('a'), bytes: 100, width_pt: 252, height_pt: 120 });
  return {
    schema_version: 1,
    kind: 'fig-gen-receipt',
    figure: { type: 'timing', spec_sha256: H('b'), spec_bytes: 900 },
    tool: { version: '0.1.0', node: 'v20.0.0' },
    variants: [{ id: '1col', svg: artifact('svg'), pdf: { ...artifact('pdf'), fonts_present: false }, min_font_pt: 7, min_stroke_pt: 0.5, svg_lint: 'pass' }],
    checks: { codes_run: ['timing/latency-mismatch'], errors: 0, warnings: 0 },
    evidence,
    verification,
  };
}

const simulation = {
  simulator: { id: 'verilator', version: '5.052' },
  top: 'tb',
  stimulus: { kind: 'bfm-script', files: [{ path: 'stim.json', sha256: H('c') }] },
  rtl_files: [{ path: 'rtl/top.sv', sha256: H('d') }],
  vcd_sha256: H('e'),
  clock: { path: 'tb.dut.clk', edge: 'pos' },
  window: { first_cycle: 0, cycles: 21 },
  signals: [{ lane: 'busy', rtl_path: 'tb.dut.busy_q' }],
};
const vcdRegion = [{ id: 'figure', kind: 'figure', level: 'simulated', grounding: 'vcd' }];

test('a complete simulated receipt validates', async () => {
  const receipt = baseReceipt({ level: 'simulated', regions: vcdRegion, scope_note: SCOPE, simulation: { ...simulation, generated_wavejson_sha256: H('f') } });
  assert.deepEqual(await validateSchema('receipt', receipt), []);
});

test('simulated level without generator hash or stimulus is rejected', async () => {
  assert.ok((await validateSchema('receipt', baseReceipt({ level: 'simulated', regions: vcdRegion, scope_note: SCOPE, simulation }))).length > 0);
  const { stimulus, ...noStimulus } = simulation;
  assert.ok((await validateSchema('receipt', baseReceipt({ level: 'simulated', regions: vcdRegion, scope_note: SCOPE, simulation: { ...noStimulus, generated_wavejson_sha256: H('f') } }))).length > 0);
});

test('sim-compared with mismatches cannot be claimed', async () => {
  const compare = { compared_cells: 80, dont_care_cells: 4, skipped_symbolic_values: 2, mismatches: [{ lane: 'out_valid', cycle: 4, drawn: '1', simulated: '0' }] };
  const overclaim = baseReceipt({ level: 'sim-compared', regions: [{ id: 'figure', kind: 'figure', level: 'sim-compared', grounding: 'vcd' }], scope_note: SCOPE, simulation, compare });
  assert.ok((await validateSchema('receipt', overclaim)).length > 0);
  const honest = baseReceipt({ level: 'unverified', reason: 'sim-compare found 1 mismatch', regions: [{ id: 'figure', kind: 'figure', level: 'unverified', grounding: 'none', reason: 'mismatch' }], failed: { compare } });
  assert.deepEqual(await validateSchema('receipt', honest), []);
});

test('structural-only requires a passing netlist cross-check and rtl grounding', async () => {
  const region = [{ id: 'figure', kind: 'figure', level: 'structural-only', grounding: 'rtl' }];
  assert.ok((await validateSchema('receipt', baseReceipt({ level: 'structural-only', regions: region, structural: { netlist_sha256: H('9'), crosscheck: 'fail' } }))).length > 0);
  assert.deepEqual(await validateSchema('receipt', baseReceipt({ level: 'structural-only', regions: region, structural: { netlist_sha256: H('9'), crosscheck: 'pass', latencies_checked: 1 } })), []);
  const docClaim = [{ id: 'cpu', kind: 'block', level: 'structural-only', grounding: 'doc' }];
  assert.ok((await validateSchema('receipt', baseReceipt({ level: 'structural-only', regions: docClaim, structural: { netlist_sha256: H('9'), crosscheck: 'pass' } }))).length > 0);
});

test('mixed receipts carry per-region levels; doc/stub regions stay unverified with a reason', async () => {
  const regions = [
    { id: 'acc', kind: 'block', level: 'structural-only', grounding: 'rtl' },
    { id: 'cpu', kind: 'block', level: 'unverified', grounding: 'doc', reason: 'only documented; no RTL in the repository' },
    { id: 'stub:mem', kind: 'stub', level: 'unverified', grounding: 'stub', reason: 'auto stub' },
  ];
  assert.deepEqual(await validateSchema('receipt', baseReceipt({ level: 'mixed', regions })), []);
  const stubClaim = [{ id: 'stub:mem', kind: 'stub', level: 'structural-only', grounding: 'stub' }];
  assert.ok((await validateSchema('receipt', baseReceipt({ level: 'mixed', regions: stubClaim }))).length > 0);
  assert.ok((await validateSchema('receipt', baseReceipt({ level: 'mixed', regions: [] }))).length > 0);
});

test('stubs and stimulus are recorded but never count as evidence', async () => {
  const region = [{ id: 'figure', kind: 'figure', level: 'unverified', grounding: 'none', reason: 'x' }];
  const ok = baseReceipt({ level: 'unverified', reason: 'x', regions: region }, [{ role: 'stub-auto', path: 'auto.stubs.v', sha256: H('1'), repository: null, counts_as_evidence: false }]);
  assert.deepEqual(await validateSchema('receipt', ok), []);
  const bad = baseReceipt({ level: 'unverified', reason: 'x', regions: region }, [{ role: 'stub-auto', path: 'auto.stubs.v', sha256: H('1'), repository: null, counts_as_evidence: true }]);
  assert.ok((await validateSchema('receipt', bad)).length > 0);
});

test('PDFs with fonts cannot be receipted', async () => {
  const receipt = baseReceipt({ level: 'unverified', reason: 'no RTL', regions: [{ id: 'figure', kind: 'figure', level: 'unverified', grounding: 'none', reason: 'no RTL' }] });
  receipt.variants[0].pdf.fonts_present = true;
  assert.ok((await validateSchema('receipt', receipt)).length > 0);
});
