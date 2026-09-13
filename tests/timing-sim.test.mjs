// Timing grounding (SPEC §6.5–6.6): the streaming VCD reader, pre-edge
// sampling, vcd2wavejson, sim-compare semantics, verification levels, the BFM
// generator and Verilator simulation round trips on self-written fixtures.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { generateBfm, svLiteral, validatePortMap, writeBfm } from '../lib/bfm/generate.mjs';
import { detectSimulator, simulate } from '../lib/sim/verilator-sim.mjs';
import { compareTiming, drawnCycles, literalNumber } from '../lib/timing/compare.mjs';
import { edgesOf, globMatcher, normaliseValue, readVcd, valueBefore } from '../lib/timing/vcd.mjs';
import { lanesSha256, vcdToTiming } from '../lib/timing/vcd2wave.mjs';
import { claimedLevel, verifyTiming } from '../lib/timing/verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fx = path.join(here, 'fixtures', 'sim');
const cli = path.join(root, 'bin', 'fig-gen.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-timing-'));
const sim = detectSimulator();
const noSim = !sim.available && 'verilator not installed';

// A hand-written VCD: 10-unit clock period (edges at 5, 15, 25, ...), a 1-bit
// valid that changes exactly on an edge, a 4-bit bus with x and z values, a
// nested scope and a timescale.
function writeVcd(dir) {
  const file = path.join(dir, 'hand.vcd');
  fs.writeFileSync(file, [
    '$date today $end', '$version hand $end', '$timescale 1 ns $end',
    '$scope module tb $end', '$var wire 1 ! clk $end', '$var wire 1 " valid $end', '$var wire 4 # data [3:0] $end',
    '$scope module dut $end', '$var wire 1 ! clk $end', '$var reg 2 $ st [1:0] $end', '$upscope $end',
    '$upscope $end', '$enddefinitions $end',
    '#0', '$dumpvars', '0!', '0"', 'bx #', 'b0 $', '$end',
    '#5', '1!', '1"', 'b1010 #', // valid and data change AT the edge: the pre-edge sample of cycle 0 still shows the old values
    '#10', '0!',
    '#15', '1!', 'b1 $',
    '#20', '0!', 'bz #',
    '#25', '1!', '0"',
    '#30', '0!', 'b11 #',
    '#35', '1!',
    '#40', '0!',
    '#45', '1!',
    '#50', '0!',
    '',
  ].join('\n'));
  return file;
}

test('VCD reader: timescale, nested scopes, vectors left-extended, x and z, only selected signals kept', () => {
  const dir = tmp();
  try {
    const file = writeVcd(dir);
    const all = readVcd(file);
    assert.equal(all.timescale.unit, 'ns');
    assert.equal(all.timescale.fs, 1e6);
    assert.deepEqual(all.signals.map((s) => s.path), ['tb.clk', 'tb.valid', 'tb.data', 'tb.dut.clk', 'tb.dut.st']);
    assert.deepEqual(all.signals.find((s) => s.path === 'tb.data'), { path: 'tb.data', id: '#', width: 4, kind: 'wire', msb: 3, lsb: 0 });
    assert.deepEqual(all.changes.get('tb.data').map((c) => c.v), ['xxxx', '1010', 'zzzz', '0011']);
    assert.deepEqual(all.changes.get('tb.dut.st').map((c) => c.v), ['00', '01']);
    assert.equal(normaliseValue('b1', 4), '0001');
    assert.equal(normaliseValue('bx1', 4), 'xxx1');
    assert.equal(all.end, 50);
    const some = readVcd(file, { select: globMatcher(['tb.dut.*']) });
    assert.deepEqual([...some.changes.keys()], ['tb.dut.clk', 'tb.dut.st']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-edge sampling: cycle k shows the value held just before edge k+1, never a same-edge change', () => {
  const dir = tmp();
  try {
    const file = writeVcd(dir);
    const d = readVcd(file);
    const edges = edgesOf(d.changes.get('tb.clk'), 'pos');
    assert.deepEqual(edges, [5, 15, 25, 35, 45]);
    assert.equal(valueBefore(d.changes.get('tb.valid'), 5), '0', 'the change at the edge is not visible before it');
    assert.equal(valueBefore(d.changes.get('tb.valid'), 15), '1');
    const { doc, diagnostics } = vcdToTiming(file, { clock: 'tb.clk', signals: ['tb.valid', 'tb.data'], cycles: 4 });
    assert.deepEqual(diagnostics.filter((x) => x.severity === 'error'), []);
    const lanes = doc.wavejson.signal;
    assert.deepEqual(lanes.map((l) => l.name), ['clock', 'valid', 'data']);
    assert.equal(lanes[0].wave, 'p...');
    // samples before edges 15, 25, 35, 45: valid 1,1,0,0; data 0xA, z, 0x3, 0x3
    assert.equal(lanes[1].wave, '1.0.');
    assert.equal(lanes[2].wave, '=z=.');
    assert.deepEqual(lanes[2].data, ['0xA', '0x3']);
    assert.equal(doc.provenance.sample, 'pre_edge');
    assert.equal(doc.provenance.generator.lanes_sha256, lanesSha256(doc.wavejson));
    assert.deepEqual(doc.provenance.rtl_map, { clock: 'tb.clk', valid: 'tb.valid', data: 'tb.data' });
    // an event-aligned window starts at the first cycle whose sample shows the
    // event: st changes at t=15, so the sample before edge 25 (cycle 1) shows it
    const aligned = vcdToTiming(file, { clock: 'tb.clk', signals: ['tb.valid'], alignOn: { path: 'tb.dut.st', event: 'change' }, cycles: 2 });
    assert.equal(aligned.doc.provenance.first_cycle, 1);
    // a signal that is not in the dump is an error, not a silent empty lane
    assert.equal(vcdToTiming(file, { clock: 'tb.clk', signals: ['tb.nope'], cycles: 2 }).diagnostics[0].code, 'timing/vcd-signal-missing');
    assert.equal(vcdToTiming(file, { clock: 'tb.clk', signals: ['tb.valid'], cycles: 9 }).diagnostics[0].code, 'timing/vcd-window');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sim-compare semantics: x is don\'t-care, . holds, | skips, bus literals compare numerically, symbolic values check changes only', () => {
  const dir = tmp();
  try {
    const file = writeVcd(dir);
    const hand = (lanes, extra = {}) => ({
      schema_version: 1, figure_type: 'timing', meta: { title: 't', print: { profile: 'ieee' } },
      wavejson: { signal: [{ name: 'clk', wave: 'p...' }, ...lanes] },
      clock: { name: 'clk', edge: 'pos' },
      provenance: { kind: 'hand', rtl_map: { clk: 'tb.clk', valid: 'tb.valid', data: 'tb.data' }, first_cycle: 0, ...extra },
    });
    assert.deepEqual(drawnCycles({ wave: '1.x|0', data: [] }).map((c) => c.kind), ['level', 'level', 'x', 'skip', 'level']);
    assert.equal(literalNumber("4'hA"), 10n);
    assert.equal(literalNumber('0x1F'), 31n);
    assert.equal(literalNumber('D0'), null);

    const good = compareTiming(hand([{ name: 'valid', wave: '1.0.' }, { name: 'data', wave: '=x=.', data: ['0xA', '3'] }]), file);
    assert.deepEqual(good.diagnostics, []);
    assert.equal(good.report.dont_care_cells, 1);
    assert.equal(good.report.compared_cells, 7);

    const gaps = compareTiming(hand([{ name: 'valid', wave: '1|0.' }]), file);
    assert.equal(gaps.report.skipped_cells, 1);
    assert.deepEqual(gaps.report.mismatches, []);

    const bad = compareTiming(hand([{ name: 'valid', wave: '10..' }]), file);
    assert.deepEqual(bad.report.mismatches, [{ lane: 'valid', cycle: 1, drawn: '0', simulated: '1' }]);
    assert.equal(bad.diagnostics.find((d) => d.code === 'timing/sim-mismatch').message, 'valid @ cycle 1: drawn 0, simulated 1');
    assert.ok(bad.diagnostics.some((d) => d.code === 'timing/diverges-from-simulation'));

    // symbolic labels: skipped as values, but a drawn change where the simulation holds is a mismatch
    const sym = compareTiming(hand([{ name: 'data', wave: '=x==', data: ['A', 'B', 'C'] }]), file);
    assert.equal(sym.report.skipped_symbolic_values, 3);
    assert.equal(sym.report.mismatches.length, 1);
    assert.equal(sym.report.mismatches[0].cycle, 3);
    const mapped = compareTiming(hand([{ name: 'data', wave: '=x=.', data: ['A', 'B'] }], { compare: { values: { data: { A: '0xA', B: '0x3' } } } }), file);
    assert.equal(mapped.report.value_map_used, true);
    assert.deepEqual(mapped.report.mismatches, []);

    const unmapped = compareTiming({ ...hand([{ name: 'ghost', wave: '0...' }]) }, file);
    assert.equal(unmapped.diagnostics[0].code, 'timing/compare-unmapped');
    const ignored = compareTiming(hand([{ name: 'ghost', wave: '0...' }], { compare: { ignore: ['ghost'] } }), file);
    assert.deepEqual(ignored.diagnostics, []);

    // align_on: the drawn fall of valid lines up with the simulated one
    const shifted = compareTiming(hand([{ name: 'valid', wave: '11.0' }], { first_cycle: undefined, compare: { align_on: { lane: 'valid', event: 'fall' } } }), file);
    assert.equal(shifted.report.offset, -1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function simulationFixture(dir) {
  const file = writeVcd(dir);
  const rtl = path.join(dir, 'dut.sv');
  const tb = path.join(dir, 'tb.sv');
  fs.writeFileSync(rtl, 'module dut; endmodule\n');
  fs.writeFileSync(tb, 'module tb; endmodule\n');
  const sha = (f) => spawnSync('shasum', ['-a', '256', f], { encoding: 'utf8' }).stdout.split(' ')[0];
  const simulation = { simulator: { id: 'verilator', version: '5' }, top: 'tb', stimulus: { kind: 'sv-testbench', files: [{ path: tb, sha256: sha(tb) }] }, rtl_files: [{ path: rtl, sha256: sha(rtl) }] };
  return { file, simulation };
}

test('verification levels: simulated only for untouched generated lanes; sim-compared with 0 mismatches; failures are unverified; overclaims are errors', async () => {
  const dir = tmp();
  try {
    const { file, simulation } = simulationFixture(dir);
    const { doc } = vcdToTiming(file, { clock: 'tb.clk', signals: ['tb.valid', 'tb.data'], cycles: 4, simulation });
    const simulated = await verifyTiming(doc, { figureDir: dir });
    assert.equal(simulated.level, 'simulated');
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const n of ['common', 'receipt']) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(root, 'schemas', `${n}.schema.json`), 'utf8')));
    const receiptSim = ajv.compile({ $ref: 'https://fig-gen.local/schemas/receipt.schema.json#/$defs/simulation' });
    assert.ok(receiptSim(simulated.evidence.simulation), JSON.stringify(receiptSim.errors));
    const timingSchema = new Ajv2020({ allErrors: true, strict: false });
    for (const n of ['common', 'timing']) timingSchema.addSchema(JSON.parse(fs.readFileSync(path.join(root, 'schemas', `${n}.schema.json`), 'utf8')));
    assert.ok(timingSchema.getSchema('https://fig-gen.local/schemas/timing.schema.json')(doc));

    const edited = structuredClone(doc);
    edited.wavejson.signal[1].wave = '110.';
    const e = await verifyTiming(edited, { figureDir: dir });
    assert.equal(e.level, 'unverified');
    assert.match(e.reason, /edited/);

    const compared = structuredClone(edited);
    compared.wavejson.signal[1].wave = '1.0.';
    compared.provenance = { ...compared.provenance, kind: 'hand', compare_vcd: file };
    delete compared.provenance.generator;
    const c = await verifyTiming(compared, { figureDir: dir });
    assert.equal(c.level, 'sim-compared');
    assert.equal(c.evidence.compare.mismatches.length, 0);

    const failing = structuredClone(compared);
    failing.wavejson.signal[1].wave = '0...';
    const f = await verifyTiming(failing, { figureDir: dir });
    assert.equal(f.level, 'unverified', 'a failing compare is never structural-only');
    assert.ok(f.evidence.failed.compare.mismatches.length > 0);

    const over = structuredClone(edited);
    over.meta.caption = 'Simulated handshake of the pipeline.';
    assert.equal(claimedLevel(over), 'simulated');
    const o = await verifyTiming(over, { figureDir: dir });
    assert.ok(o.diagnostics.some((d) => d.code === 'receipt/level-overclaim'));

    const drawnOnly = await verifyTiming({ ...structuredClone(doc), provenance: { kind: 'hand' } }, { figureDir: dir });
    assert.equal(drawnOnly.level, 'unverified');

    // a recorded stimulus file that changed on disk is no longer the simulated scenario
    fs.appendFileSync(simulation.stimulus.files[0].path, '// changed\n');
    assert.equal((await verifyTiming(doc, { figureDir: dir })).level, 'unverified');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BFM generator: port maps are validated; the wrapper drives the mapped ports with protocol tasks and dumps a VCD', () => {
  const pm = JSON.parse(fs.readFileSync(path.join(fx, 'ahb_reg.portmap.json'), 'utf8'));
  const sc = JSON.parse(fs.readFileSync(path.join(fx, 'ahb_reg.scenario.json'), 'utf8'));
  assert.deepEqual(validatePortMap(pm, sc), []);
  const broken = structuredClone(pm);
  delete broken.interfaces[0].signals.hwrite;
  assert.match(validatePortMap(broken, sc).join(';'), /hwrite/);
  assert.match(validatePortMap(pm, { steps: [{ op: 'write', if: 'nobus', addr: '0', data: '0' }] }).join(';'), /no interface named nobus/);
  assert.throws(() => generateBfm(broken, sc), /hwrite/);
  const { top, source } = generateBfm(pm, sc, { vcd: 'wave.vcd' });
  assert.equal(top, 'tb_ahb_reg');
  assert.match(source, /Generated by fig-gen bfm: stimulus only/);
  assert.match(source, /task automatic bus_write/);
  assert.match(source, /\$dumpfile\("wave.vcd"\)/);
  assert.match(source, /ahb_reg dut \(/);
  assert.match(source, /\.hsel\(hsel\)/);
  assert.equal(svLiteral('0x1F'), "'h1F");
  assert.equal(svLiteral("4'b0101"), "4'b0101");
  assert.throws(() => svLiteral('ten'), /not a number/);
  for (const name of ['apb_reg', 'axil_reg', 'vr_pipe']) {
    const p = JSON.parse(fs.readFileSync(path.join(fx, `${name}.portmap.json`), 'utf8'));
    const s = JSON.parse(fs.readFileSync(path.join(fx, `${name}.scenario.json`), 'utf8'));
    assert.deepEqual(validatePortMap(p, s), []);
    assert.match(generateBfm(p, s).source, /\$finish/);
  }
});

test('simulation: a user testbench runs, and vcd2wave shows the counter counting', { skip: noSim }, () => {
  const dir = tmp();
  try {
    const r = simulate({ rtlFiles: [path.join(fx, 'counter.sv')], stimulusFiles: [path.join(fx, 'tb_counter.sv')], top: 'tb_counter', workDir: dir, allowFixtureEvidence: true });
    assert.equal(r.ok, true, r.diagnostics.map((d) => d.message).join('; '));
    assert.equal(r.evidence.simulator.id, 'verilator');
    assert.equal(r.evidence.stimulus.kind, 'sv-testbench');
    assert.equal(r.evidence.rtl_files.length, 1);
    assert.match(r.evidence.vcd_sha256, /^[0-9a-f]{64}$/);
    const { doc } = vcdToTiming(r.vcd, { clock: 'tb_counter.clk', signals: ['tb_counter.count', 'tb_counter.wrap'], from: 2, cycles: 17 });
    const count = doc.wavejson.signal.find((l) => l.name === 'count');
    assert.deepEqual(count.data.slice(0, 4), ['0x0', '0x1', '0x2', '0x3']);
    assert.match(doc.wavejson.signal.find((l) => l.name === 'wrap').wave, /10/);
    // RTL inside the fig-gen tree is never evidence outside fig-gen's own tests
    const refused = simulate({ rtlFiles: [path.join(fx, 'counter.sv')], stimulusFiles: [path.join(fx, 'tb_counter.sv')], top: 'tb_counter', workDir: path.join(dir, 'again') });
    assert.equal(refused.diagnostics[0].code, 'evidence/self-authored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: generated BFMs drive AHB-Lite, APB, AXI4-Lite and valid/ready fixtures through their scenarios', { skip: noSim }, () => {
  const dir = tmp();
  try {
    const run = (name) => {
      const pm = JSON.parse(fs.readFileSync(path.join(fx, `${name}.portmap.json`), 'utf8'));
      const sc = JSON.parse(fs.readFileSync(path.join(fx, `${name}.scenario.json`), 'utf8'));
      const work = path.join(dir, name);
      const gen = writeBfm(pm, sc, path.join(work, 'bfm'));
      const r = simulate({ rtlFiles: [path.join(fx, `${name}.sv`)], stimulusFiles: [gen.file], stimulusKind: 'bfm-script', top: gen.top, workDir: work, allowFixtureEvidence: true });
      assert.equal(r.ok, true, `${name}: ${r.diagnostics.map((d) => d.message).join('; ')}`);
      assert.match(fs.readFileSync(path.join(work, 'run.log'), 'utf8'), /BFM RESULT: pass/);
      assert.equal(r.evidence.stimulus.kind, 'bfm-script');
      return { r, top: gen.top };
    };
    const ahb = run('ahb_reg');
    const ahbRun = vcdToTiming(ahb.r.vcd, { clock: `${ahb.top}.hclk`, signals: [`${ahb.top}.dut.htrans`, `${ahb.top}.dut.hwrite`, `${ahb.top}.dut.hrdata`], from: 3, cycles: 12 });
    assert.deepEqual(ahbRun.diagnostics.filter((d) => d.severity === 'error'), []);
    const ahbLanes = ahbRun.doc.wavejson.signal;
    assert.ok(ahbLanes.find((l) => l.name === 'hrdata').data.includes('0x12345678'), JSON.stringify(ahbLanes));
    assert.match(ahbLanes.find((l) => l.name === 'hwrite').wave, /1/);
    run('apb_reg');
    run('axil_reg');
    const vr = run('vr_pipe');
    const vrRun = vcdToTiming(vr.r.vcd, { clock: `${vr.top}.clk`, signals: [`${vr.top}.dut.out_valid`, `${vr.top}.dut.out_ready`, `${vr.top}.dut.out_data`], from: 2, cycles: 8 });
    assert.deepEqual(vrRun.diagnostics.filter((d) => d.severity === 'error'), []);
    const vrLanes = vrRun.doc.wavejson.signal;
    const outValid = vrLanes.find((l) => l.name === 'out valid').wave;
    const outReady = vrLanes.find((l) => l.name === 'out ready').wave;
    // backpressure: valid rises and stays high before ready accepts it
    assert.ok(outValid.indexOf('1') >= 0 && outValid.indexOf('1') < outReady.indexOf('1'), `${outValid} / ${outReady}`);
    assert.ok(vrLanes.find((l) => l.name === 'out data').data.includes('0x42'));

    // an expectation the design does not meet fails the scenario
    const pm = JSON.parse(fs.readFileSync(path.join(fx, 'apb_reg.portmap.json'), 'utf8'));
    const wrong = { name: 'wrong expectation', max_cycles: 100, steps: [{ op: 'reset' }, { op: 'write', if: 'cfg', addr: '0x0', data: '0x1' }, { op: 'read', if: 'cfg', addr: '0x0', expect: '0x2' }] };
    const gen = writeBfm(pm, wrong, path.join(dir, 'wrong', 'bfm'));
    const failed = simulate({ rtlFiles: [path.join(fx, 'apb_reg.sv')], stimulusFiles: [gen.file], stimulusKind: 'bfm-script', top: gen.top, workDir: path.join(dir, 'wrong'), allowFixtureEvidence: true });
    assert.equal(failed.ok, false);
    assert.ok(failed.diagnostics.some((d) => d.code === 'sim/scenario-failed'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('simulation: a module defined nowhere stops with sim/blackbox-without-model; fig-gen never supplies a model', { skip: noSim }, () => {
  const dir = tmp();
  try {
    const r = simulate({ rtlFiles: [path.join(fx, 'uses_macro.sv')], top: 'uses_macro', workDir: dir, allowFixtureEvidence: true });
    assert.equal(r.ok, false);
    assert.equal(r.diagnostics[0].code, 'sim/blackbox-without-model');
    assert.deepEqual(r.diagnostics[0].evidence.modules, ['vendor_ram_macro']);
    assert.match(r.diagnostics[0].message, /must come from the user/);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.s?v$/.test(f)), [], 'no model file is written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: bfm writes the wrapper, vcd2wave writes a timing IR, sim-compare exits 1 on a mismatch', () => {
  const dir = tmp();
  try {
    const node = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root });
    const b = node(['bfm', '--portmap', path.join(fx, 'vr_pipe.portmap.json'), '--scenario', path.join(fx, 'vr_pipe.scenario.json'), '--out-dir', path.join(dir, 'bfm')]);
    assert.equal(b.status, 0, b.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'bfm', 'tb_vr_pipe.sv')));
    const vcd = writeVcd(dir);
    const out = path.join(dir, 't.json');
    const v = node(['vcd2wave', '--vcd', vcd, '--clock', 'tb.clk', '--signals', 'tb.valid', 'tb.data', '--cycles', '4', '--alias', 'tb.valid=in valid', '--out', out]);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(doc.wavejson.signal[1].name, 'in valid');
    doc.wavejson.signal[1].wave = '0...';
    doc.provenance.rtl_map['in valid'] = 'tb.valid';
    fs.writeFileSync(out, JSON.stringify(doc));
    const c = node(['sim-compare', out, '--vcd', vcd]);
    assert.equal(c.status, 1);
    assert.match(c.stdout, /in valid @ cycle 0: drawn 0, simulated 1/);
    assert.equal(node(['simulate']).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
