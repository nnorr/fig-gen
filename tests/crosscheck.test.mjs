import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import verilator from '../lib/rtl/verilator.mjs';
import { crosscheckDatapath, crosscheckSoc } from '../lib/rtl/crosscheck.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detected = await verilator.detect();
const skip = !detected.available && 'verilator not installed';
const errors = (r) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

async function extract(files, top) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-cc-'));
  try {
    return await verilator.extract({ files, top, work_dir: work });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

test('tiny datapath figure cross-checks against its RTL', { skip }, async () => {
  const netlist = await extract([path.join(root, 'tests/fixtures/rtl/tiny/tiny_top.sv')], 'tiny_top');
  const load = () => JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/rtl/tiny/tiny.datapath.json'), 'utf8'));
  const ok = crosscheckDatapath(load(), netlist);
  assert.deepEqual(errors(ok), []);
  assert.equal(ok.stats.registersMatched, 1);
  assert.equal(ok.stats.muxOrderChecked, 1);
  assert.equal(ok.stats.latenciesChecked, 1);

  const swapped = load();
  swapped.nets.find((n) => n.id === 'n_a').sinks = ['m0.in0'];
  swapped.nets.find((n) => n.id === 'n_b').sinks = ['m0.in1'];
  assert.ok(errors(crosscheckDatapath(swapped, netlist)).includes('rtl/mux-order'));

  const wrong = load();
  wrong.nets.find((n) => n.id === 'n_q').rtl.signal = 'm';
  wrong.annotations[0].cycles = 2;
  const found = errors(crosscheckDatapath(wrong, netlist));
  assert.ok(found.includes('rtl/not-a-register'));

  const late = load();
  late.annotations[0].cycles = 2;
  assert.ok(errors(crosscheckDatapath(late, netlist)).includes('rtl/latency-mismatch'));
});

test('SoC figure cross-checks instances, base addresses, bus ports and IRQs', { skip }, async () => {
  const netlist = await extract([path.join(root, 'tests/fixtures/soc/rtl/soc_min.sv')], 'soc_min_top');
  const load = () => JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/soc/soc-min.microarch.json'), 'utf8'));
  const ok = crosscheckSoc(load(), netlist);
  assert.deepEqual(errors(ok), []);
  assert.equal(ok.stats.irqChecked, 2);
  assert.ok(ok.stats.paramsChecked >= 3);

  const moved = load();
  moved.attachments.find((a) => a.id === 'at_acc').address = { base: '0x5B00_0000', size: '0x1000' };
  assert.ok(errors(crosscheckSoc(moved, netlist)).includes('rtl/param-mismatch'));

  const missing = load();
  missing.blocks.find((b) => b.id === 'acc').rtl.instance = 'u_nope';
  assert.ok(errors(crosscheckSoc(missing, netlist)).includes('rtl/instance-missing'));

  const irq = load();
  irq.links.push({ id: 'irq_timer', from: 'timer', to: 'cpu', class: 'interrupt', irq: 3 });
  assert.ok(errors(crosscheckSoc(irq, netlist)).includes('rtl/irq-unconnected'));
});
