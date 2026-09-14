// Mux fan-in ordering (SPEC §4.10): bank lanes, bank order and mux stacking are
// permuted to minimise crossings between bank outputs and mux inputs; a mux's
// input order (its select order) and every net stay unchanged.

import assert from 'node:assert/strict';
import test from 'node:test';
import { bestFanIn, fanIn, orderFanIn, twoColumnCrossings } from '../lib/lane-order.mjs';

const figure = () => ({
  schema_version: 1, figure_type: 'datapath',
  meta: { title: 'fan-in', print: { profile: 'ieee' } },
  clock_domains: [{ id: 'sys', clock: 'clk' }],
  elements: [
    { id: 'p_a', kind: 'port', dir: 'in', width: 8, label: 'input a' },
    { id: 'p_b', kind: 'port', dir: 'in', width: 8, label: 'input b' },
    { id: 'p_c', kind: 'port', dir: 'in', width: 8, label: 'input c' },
    // lanes deliberately in the order that crosses: c, b, a
    { id: 'bank', kind: 'register', domain: 'sys', label: 'input registers', enable: true, lanes: [{ id: 'c', width: 8 }, { id: 'b', width: 8 }, { id: 'a', width: 8 }] },
    { id: 'temps', kind: 'register', domain: 'sys', label: 'temporary registers', enable: true, enable_width: 2, lanes: [{ id: 't1', width: 8 }, { id: 't0', width: 8 }] },
    { id: 'mx', kind: 'mux', inputs: 3, width: 8, encoding: 'onehot' },
    { id: 'my', kind: 'mux', inputs: 3, width: 8, encoding: 'onehot' },
  ],
  nets: [
    { id: 'n_c', width: 8, driver: 'p_c', sinks: ['bank.d_c'] },
    { id: 'n_b', width: 8, driver: 'p_b', sinks: ['bank.d_b'] },
    { id: 'n_a', width: 8, driver: 'p_a', sinks: ['bank.d_a'] },
    { id: 'n_qa', width: 8, driver: 'bank.q_a', sinks: ['mx.in0'] },
    { id: 'n_qb', width: 8, driver: 'bank.q_b', sinks: ['mx.in1', 'my.in0'] },
    { id: 'n_t0', width: 8, driver: 'temps.q_t0', sinks: ['mx.in2'] },
    { id: 'n_qc', width: 8, driver: 'bank.q_c', sinks: ['my.in1'] },
    { id: 'n_t1', width: 8, driver: 'temps.q_t1', sinks: ['my.in2'] },
  ],
});

const muxInputs = (doc) => Object.fromEntries(doc.nets.flatMap((n) => n.sinks.filter((s) => /^m[xy]\.in\d$/.test(s)).map((s) => [s, n.id])));

test('two-column crossings count reversed pairs from different sources only', () => {
  assert.equal(twoColumnCrossings([[0, 1], [1, 0]]), 1);
  assert.equal(twoColumnCrossings([[0, 0], [0, 1], [1, 2]]), 0);
  assert.equal(twoColumnCrossings([[0, 2], [1, 0], [1, 1]]), 2);
});

test('fan-in ordering: lanes and bank order are permuted to the minimum, mux inputs never move', () => {
  const doc = figure();
  const group = fanIn(doc);
  assert.deepEqual(group.banks.map((b) => b.id), ['bank', 'temps']);
  assert.deepEqual(group.muxes.map((m) => m.id), ['mx', 'my']);
  const { doc: ordered, report } = orderFanIn(doc);
  assert.ok(report.changed && report.after < report.before, JSON.stringify(report));
  assert.equal(report.after, bestFanIn(fanIn(ordered)).before, 'the reported count is the count of the ordered figure');
  // mux input order (select order) and every net unchanged
  assert.deepEqual(muxInputs(ordered), muxInputs(doc));
  assert.deepEqual(ordered.nets, doc.nets);
  // lanes a, b, c now run top to bottom in the order their muxes read them
  assert.deepEqual(ordered.elements.find((e) => e.id === 'bank').lanes.map((l) => l.id).slice(0, 3), ['a', 'b', 'c']);
  // figure inputs follow the lane order they load
  assert.deepEqual(ordered.elements.filter((e) => e.kind === 'port').map((e) => e.id), ['p_a', 'p_b', 'p_c']);
  // the original is not modified
  assert.deepEqual(doc.elements.find((e) => e.id === 'bank').lanes.map((l) => l.id), ['c', 'b', 'a']);
});

test('fan-in ordering keeps an arrangement that is already minimal', () => {
  const { doc: once } = orderFanIn(figure());
  const again = orderFanIn(once);
  assert.equal(again.report.changed, false);
  assert.equal(again.doc, once);
});
