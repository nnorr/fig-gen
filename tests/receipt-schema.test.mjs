import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSchema } from '../lib/validate.mjs';

const H = (c) => c.repeat(64);
const SCOPE = 'Simulation evidence covers only the recorded stimulus and cycle window.';

function baseReceipt(verification) {
  const artifact = (ext) => ({ path: `fig.1col.${ext}`, sha256: H('a'), bytes: 100, width_pt: 252, height_pt: 120 });
  return {
    schema_version: 1,
    kind: 'rtl-figures-receipt',
    figure: { type: 'timing', spec_sha256: H('b'), spec_bytes: 900 },
    tool: { version: '0.1.0', node: 'v20.0.0' },
    variants: [{ id: '1col', svg: artifact('svg'), pdf: { ...artifact('pdf'), fonts_present: false }, min_font_pt: 7, min_stroke_pt: 0.5, svg_lint: 'pass' }],
    checks: { codes_run: ['timing/latency-mismatch'], errors: 0, warnings: 0 },
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

test('a complete simulated receipt validates', async () => {
  const receipt = baseReceipt({ level: 'simulated', scope_note: SCOPE, simulation: { ...simulation, generated_wavejson_sha256: H('f') } });
  assert.deepEqual(await validateSchema('receipt', receipt), []);
});

test('simulated level without generator hash or stimulus is rejected', async () => {
  const noHash = baseReceipt({ level: 'simulated', scope_note: SCOPE, simulation });
  assert.ok((await validateSchema('receipt', noHash)).length > 0);
  const { stimulus, ...noStimulus } = simulation;
  const noStim = baseReceipt({ level: 'simulated', scope_note: SCOPE, simulation: { ...noStimulus, generated_wavejson_sha256: H('f') } });
  assert.ok((await validateSchema('receipt', noStim)).length > 0);
});

test('sim-compared with mismatches cannot be claimed', async () => {
  const compare = { compared_cells: 80, dont_care_cells: 4, skipped_symbolic_values: 2, mismatches: [{ lane: 'out_valid', cycle: 4, drawn: '1', simulated: '0' }] };
  const overclaim = baseReceipt({ level: 'sim-compared', scope_note: SCOPE, simulation, compare });
  assert.ok((await validateSchema('receipt', overclaim)).length > 0);
  const honest = baseReceipt({ level: 'unverified', reason: 'sim-compare found 1 mismatch', failed: { compare } });
  assert.deepEqual(await validateSchema('receipt', honest), []);
});

test('structural-only requires a passing netlist cross-check', async () => {
  const fail = baseReceipt({ level: 'structural-only', structural: { netlist_sha256: H('9'), crosscheck: 'fail' } });
  assert.ok((await validateSchema('receipt', fail)).length > 0);
  const pass = baseReceipt({ level: 'structural-only', structural: { netlist_sha256: H('9'), crosscheck: 'pass', latencies_checked: 1 } });
  assert.deepEqual(await validateSchema('receipt', pass), []);
});

test('PDFs with fonts and failing SVG lint cannot be receipted', async () => {
  const receipt = baseReceipt({ level: 'unverified', reason: 'no RTL' });
  receipt.variants[0].pdf.fonts_present = true;
  assert.ok((await validateSchema('receipt', receipt)).length > 0);
});
