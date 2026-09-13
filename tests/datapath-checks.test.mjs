import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDatapath } from '../lib/checks/datapath.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const codes = (doc) => checkDatapath(doc).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

for (const f of ['examples/datapath-pipelined-xor.json', 'examples/datapath-theme-sample.json', 'tests/fixtures/rtl/tiny/tiny.datapath.json']) {
  test(`${f} passes semantic checks`, () => assert.deepEqual(codes(load(f)), []));
}

test('mux select width must be clog2(inputs)', () => {
  const doc = load('examples/datapath-theme-sample.json');
  doc.nets.find((n) => n.id === 'n_sel').width = 3;
  doc.elements.find((e) => e.id === 'sel').width = 3;
  assert.ok(codes(doc).includes('mux/sel-width'));
});

test('width mismatch, unknown pin and multiple drivers are reported', () => {
  const doc = load('examples/datapath-pipelined-xor.json');
  doc.nets.find((n) => n.id === 'n_m').width = 16;
  doc.nets.push({ id: 'n_bad', width: 8, driver: 'm0.nope', sinks: ['s0.d'] });
  const found = codes(doc);
  for (const c of ['width/mismatch', 'endpoint/unknown', 'endpoint/multiple-drivers']) assert.ok(found.includes(c), c);
});

test('a missing select net is an error', () => {
  const doc = load('examples/datapath-theme-sample.json');
  doc.nets = doc.nets.filter((n) => n.id !== 'n_sel');
  assert.ok(checkDatapath(doc).diagnostics.some((d) => d.code === 'endpoint/unconnected' && d.severity === 'error'));
});

const base = () => ({
  schema_version: 1, figure_type: 'datapath', meta: { title: 't', print: { profile: 'ieee' } },
  clock_domains: [{ id: 'da', clock: 'clk_a' }, { id: 'db', clock: 'clk_b' }],
  elements: [], nets: [],
});

test('combinational loops are found; a register breaks them', () => {
  const doc = base();
  doc.elements.push({ id: 'i', kind: 'port', dir: 'in', width: 1 }, { id: 'g1', kind: 'comb', op: 'xor', width: 1 }, { id: 'g2', kind: 'comb', op: 'and', width: 1 });
  doc.nets.push(
    { id: 'n0', width: 1, driver: 'i', sinks: ['g1.in0', 'g2.in1'] },
    { id: 'n1', width: 1, driver: 'g1.out', sinks: ['g2.in0'] },
    { id: 'n2', width: 1, driver: 'g2.out', sinks: ['g1.in1'] },
  );
  assert.ok(codes(doc).includes('comb/loop'));
  doc.elements.push({ id: 'r', kind: 'register', width: 1, domain: 'da' });
  doc.nets[2] = { id: 'n2', width: 1, driver: 'g2.out', sinks: ['r.d'] };
  doc.nets.push({ id: 'n3', width: 1, driver: 'r.q', sinks: ['g1.in1'] });
  assert.ok(!codes(doc).includes('comb/loop'));
});

test('clock-domain crossings need a synchronizer', () => {
  const doc = base();
  doc.elements.push({ id: 'i', kind: 'port', dir: 'in', width: 1, domain: 'da' }, { id: 'ra', kind: 'register', width: 1, domain: 'da' }, { id: 'rb', kind: 'register', width: 1, domain: 'db' });
  doc.nets.push({ id: 'n0', width: 1, driver: 'i', sinks: ['ra.d'] }, { id: 'n1', width: 1, driver: 'ra.q', sinks: ['rb.d'] });
  assert.ok(codes(doc).includes('cdc/unsynchronized'));
  doc.elements.push({ id: 's', kind: 'synchronizer', from: 'da', to: 'db', style: 'ff2', width: 1 });
  doc.nets[1] = { id: 'n1', width: 1, driver: 'ra.q', sinks: ['s.in'] };
  doc.nets.push({ id: 'n2', width: 1, driver: 's.out', sinks: ['rb.d'] });
  assert.deepEqual(codes(doc), []);
});

test('latency annotations are counted against register stages', () => {
  const doc = load('examples/datapath-pipelined-xor.json');
  doc.annotations[0].cycles = 3;
  assert.ok(codes(doc).includes('latency/stage-count'));
});

test('concat widths must sum to the output', () => {
  const doc = base();
  doc.elements.push({ id: 'j', kind: 'comb', op: 'concat', width: 12, in_widths: [8, 8] });
  assert.ok(codes(doc).includes('width/concat-sum'));
});
