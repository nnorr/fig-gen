// Review round after the trial fixes: study drafts show structure (children
// expanded, controller apart from datapath), drafts are bounded by a budget,
// deep hierarchies draft without id collisions or endless renaming, combinational
// loops are found on pins, and the router's metrics stay exact while scaling.

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDatapath } from '../lib/checks/datapath.mjs';
import { crossingCounts, edgeHugging, segmentsOfPolyline } from '../lib/render/route-metrics.mjs';
import { straighten } from '../lib/render/straighten.mjs';
import { validateSchema } from '../lib/validate.mjs';

const port = (name, dir, width = 1) => ({ name, dir, width });
const net = (name, width = 1, kind = 'port') => ({ name, width, kind });
const conn = (port0, n, dir = 'in') => ({ port: port0, dir, expr: { kind: 'net', net: n } });
const ref = (name) => ({ op: 'ref', name });
const clocked = { clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true }, clock_root: 'clk' };

// top: a state machine (state_q, decoded busy) steers an accumulator (acc_q)
// in the top's own logic; one child u_leaf computes y = a ^ b.
function structureNetlist() {
  return {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'top', diagnostics: [],
    hierarchy: [{ path: 'top', module: 'top' }, { path: 'top.u_leaf', module: 'leaf' }],
    modules: [
      {
        name: 'top', orig_name: 'top',
        ports: [port('clk', 'in'), port('rst_n', 'in'), port('go', 'in'), port('a', 'in', 8), port('b', 'in', 8), port('sum', 'out', 8), port('flag', 'out'), port('y', 'out', 8)],
        nets: [net('clk'), net('rst_n'), net('go'), net('a', 8), net('b', 8), net('sum', 8), net('flag'), net('y', 8), net('state_q', 2, 'var'), net('busy', 1, 'var'), net('acc_q', 8, 'var')],
        registers: [
          { name: 'state_q', width: 2, ...clocked, enum: { type: 'state_e', width: 2, items: [{ name: 'Idle', value: 0 }, { name: 'Run', value: 1 }, { name: 'Done', value: 2 }] } },
          { name: 'acc_q', width: 8, ...clocked },
        ],
        instances: [{ name: 'u_leaf', module: 'leaf', connections: [conn('a', 'a'), conn('b', 'b'), conn('y', 'y', 'out')] }],
        deps: [
          { target: 'state_q', sources: ['go', 'state_q', 'rst_n'], kind: 'seq' },
          { target: 'busy', sources: ['state_q'], kind: 'comb' },
          { target: 'acc_q', sources: ['a', 'acc_q', 'busy', 'rst_n'], kind: 'seq' },
          { target: 'sum', sources: ['acc_q', 'a'], kind: 'comb' },
          { target: 'flag', sources: ['b'], kind: 'comb' },
        ],
        exprs: [
          { target: 'busy', expr: { op: 'eq', args: [ref('state_q'), { op: 'const', value: '1' }] } },
          { target: 'sum', expr: { op: 'add', args: [ref('acc_q'), ref('a')] } },
          { target: 'flag', expr: { op: 'redor', args: [ref('b')] } },
        ],
      },
      {
        name: 'leaf', orig_name: 'leaf',
        ports: [port('a', 'in', 8), port('b', 'in', 8), port('y', 'out', 8)],
        nets: [net('a', 8), net('b', 8), net('y', 8)], registers: [], instances: [],
        deps: [{ target: 'y', sources: ['a', 'b'], kind: 'comb' }],
        exprs: [{ target: 'y', expr: { op: 'xor', args: [ref('a'), ref('b')] } }],
      },
    ],
  };
}

test('study drafts show structure: detail view one level deep, the controller drawn apart from the datapath', async () => {
  const { draftFigure } = await import('../lib/draft.mjs');
  const nl = structureNetlist();
  for (const preset of [undefined, 'block']) {
    const { doc, notes } = draftFigure(nl, { format: 'study', preset, scope: '' });
    assert.deepEqual([doc.view.preset, doc.view.depth], ['detail', 1], `study ${preset ?? 'default'}: the whole design is a detail view, children expanded`);
    assert.ok(notes.some((n) => /^study format:/.test(n)));
    assert.ok(!doc.elements.some((e) => e.kind === 'instance' && e.rtl?.instance === 'u_leaf'), 'the child is expanded, not one box');
    const ctrl = doc.elements.find((e) => e.function?.kind === 'controller');
    assert.ok(ctrl, 'a controller block');
    assert.deepEqual([...ctrl.rtl.covers].sort(), ['busy', 'state_q'], 'state register and its decoded output');
    const datapath = doc.elements.filter((e) => e.kind === 'comb' && e.op === 'custom' && e !== ctrl && e.rtl?.covers?.includes('acc_q'));
    assert.equal(datapath.length, 1, 'the accumulator stays in a datapath block of its own');
    assert.deepEqual(await validateSchema('datapath', doc), []);
  }
  // Paper keeps the requested preset: a block view collapses the child.
  const paper = draftFigure(nl, { preset: 'block', scope: '' }).doc;
  assert.equal(paper.view.preset, 'block');
  assert.ok(paper.elements.some((e) => e.kind === 'instance' && e.rtl?.instance === 'u_leaf'));
});

test('a draft over its time or size budget stops with draft/budget-exceeded and names a narrower scope', async () => {
  const { draftFigure, DraftBudgetError } = await import('../lib/draft.mjs');
  const nl = structureNetlist();
  const stopped = (budget) => {
    try { draftFigure(nl, { preset: 'detail', scope: '', depth: 1, budget }); } catch (error) { return error; }
    return null;
  };
  const slow = stopped({ seconds: -1 });
  assert.ok(slow instanceof DraftBudgetError, 'time budget');
  assert.equal(slow.diagnostic.code, 'draft/budget-exceeded');
  assert.match(slow.diagnostic.message, /did not finish within -1 s \(while /);
  const large = stopped({ signals: 3 });
  assert.ok(large instanceof DraftBudgetError, 'size budget');
  assert.match(large.diagnostic.message, /more than 3 signals/);
  assert.deepEqual(large.diagnostic.evidence.largest_children.map((c) => c.path), ['u_leaf']);
  assert.ok(large.diagnostic.supportedFixes.some((f) => /narrow --scope to one child: u_leaf/.test(f)));
  assert.ok(draftFigure(nl, { preset: 'detail', scope: '', depth: 1 }).doc, 'the default budget leaves small designs alone');
});

// Two clients instantiate a stream block under the same long local name; the
// top reads both streams' outputs. Keys and ids truncate at 60 characters.
function deepNetlist() {
  const child = 'u_stream_client_with_a_long_instance_name_for_truncation';
  const out = 'client_valid_with_a_long_signal_name_o';
  const client = (name) => ({ name, orig_name: name, ports: [port('x', 'in'), port('v', 'out')], nets: [net('x'), net('v')], registers: [], instances: [{ name: child, module: 'stream', connections: [conn('x', 'x'), conn(out, 'v', 'out')] }], deps: [] });
  return {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'top', diagnostics: [],
    hierarchy: [{ path: 'top', module: 'top' }, { path: 'top.u_client_a', module: 'client_a' }, { path: `top.u_client_a.${child}`, module: 'stream' }, { path: 'top.u_client_b', module: 'client_b' }, { path: `top.u_client_b.${child}`, module: 'stream' }],
    modules: [
      {
        name: 'top', orig_name: 'top',
        ports: [port('x1', 'in'), port('x2', 'in'), port('both', 'out')],
        nets: [net('x1'), net('x2'), net('both'), net('va', 1, 'wire'), net('vb', 1, 'wire')],
        registers: [],
        instances: [
          { name: 'u_client_a', module: 'client_a', connections: [conn('x', 'x1'), conn('v', 'va', 'out')] },
          { name: 'u_client_b', module: 'client_b', connections: [conn('x', 'x2'), conn('v', 'vb', 'out')] },
        ],
        deps: [{ target: 'both', sources: ['va', 'vb'], kind: 'comb' }],
        exprs: [{ target: 'both', expr: { op: 'and', args: [ref('va'), ref('vb')] } }],
      },
      client('client_a'),
      client('client_b'),
      { name: 'stream', orig_name: 'stream', ports: [port('x', 'in'), port(out, 'out')], nets: [net('x'), net(out)], registers: [], instances: [], deps: [{ target: out, sources: ['x'], kind: 'comb' }] },
    ],
  };
}

test('deep hierarchies draft: signals of instances sharing a local name keep separate pins, and truncated ids get unique suffixes', async () => {
  const { draftFigure } = await import('../lib/draft.mjs');
  const { doc } = draftFigure(deepNetlist(), { preset: 'detail', scope: '', depth: 1 });
  const ids = doc.nets.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'unique net ids');
  assert.ok(ids.every((id) => id.length <= 60));
  const sinks = doc.nets.flatMap((n) => n.sinks);
  assert.equal(new Set(sinks).size, sinks.length, 'no block pin is driven by two nets');
  assert.deepEqual(checkDatapath(doc).diagnostics.filter((d) => d.code === 'endpoint/multiple-drivers'), []);
  for (const el of doc.elements.filter((e) => e.ports)) assert.equal(new Set(el.ports.map((p) => p.id)).size, el.ports.length, `${el.id}: unique pin ids`);
});

// c (controller) and b (datapath block) feed each other.
function loopFigure(latency) {
  return {
    schema_version: 1, figure_type: 'datapath',
    meta: { title: 'loop', caption: 'loop', print: { profile: 'ieee' } },
    clock_domains: [{ id: 'sys', clock: 'clk' }],
    elements: [
      { id: 'go', kind: 'port', dir: 'in', width: 1, label: 'go' },
      { id: 'c', kind: 'comb', op: 'custom', width: 1, function: { kind: 'controller' }, ports: [{ id: 'i_go', dir: 'in', width: 1 }, { id: 'i_ack', dir: 'in', width: 1 }, { id: 'o_req', dir: 'out', width: 1, latency }] },
      { id: 'b', kind: 'comb', op: 'custom', width: 1, function: { kind: 'custom', name: 'Worker' }, ports: [{ id: 'i_req', dir: 'in', width: 1 }, { id: 'o_ack', dir: 'out', width: 1 }] },
    ],
    nets: [
      { id: 'n_go', width: 1, driver: 'go', sinks: ['c.i_go'] },
      { id: 'n_req', width: 1, driver: 'c.o_req', sinks: ['b.i_req'] },
      { id: 'n_ack', width: 1, driver: 'b.o_ack', sinks: ['c.i_ack'] },
    ],
  };
}

test('comb/loop follows pins: a per-input latency opens a loop only through the inputs registered on the way to the output', () => {
  const loops = (latency) => checkDatapath(loopFigure(latency)).diagnostics.filter((d) => d.code === 'comb/loop');
  assert.equal(loops({ i_go: 0, i_ack: 1 }).length, 0, 'ack reaches req through a register: no loop');
  const closed = loops({ i_go: 1, i_ack: 0 });
  assert.equal(closed.length, 1, 'ack reaches req combinationally: a loop');
  assert.deepEqual(closed[0].subject.ids, ['b', 'c']);
  assert.deepEqual(closed[0].evidence.pins, ['b.i_req', 'b.o_ack', 'c.i_ack', 'c.o_req']);
  assert.equal(loops({ default: 1 }).length, 0, 'default applies to unnamed inputs');
});

test('comb_from makes pin paths exact: an output lists the inputs that reach it combinationally', () => {
  const withCombFrom = (combFrom) => {
    const doc = loopFigure({ i_go: 1, i_ack: 0 });
    doc.elements.find((e) => e.id === 'b').ports.find((p) => p.id === 'o_ack').comb_from = combFrom;
    return checkDatapath(doc).diagnostics;
  };
  assert.equal(withCombFrom(['i_req']).filter((d) => d.code === 'comb/loop').length, 1, 'req reaches ack combinationally: the loop is real');
  assert.equal(withCombFrom([]).filter((d) => d.code === 'comb/loop').length, 0, 'ack does not depend on req without a register: no loop');
  assert.deepEqual(withCombFrom(['i_nope']).filter((d) => d.code === 'comb/unknown-input').map((d) => d.evidence.input), ['i_nope']);
});

test('the draft emits comb_from from the netlist and the latency check verifies it against the RTL', async () => {
  const { draftFigure } = await import('../lib/draft.mjs');
  const { draftResiduals } = await import('../lib/draft-check.mjs');
  const { checkLatency } = await import('../lib/checks/latency.mjs');
  const nl = structureNetlist();
  const { doc } = draftFigure(nl, { format: 'study', scope: '' });
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const sum = doc.nets.find((n) => n.sinks.includes('p_sum'));
  const [elId, pinId] = sum.driver.split('.');
  const pin = doc.elements.find((e) => e.id === elId).ports.find((p) => p.id === pinId);
  assert.deepEqual(pin.comb_from, ['i_a', 'i_acc_q'], 'sum is computed from a and the accumulator, not from b');
  assert.deepEqual((await draftResiduals(doc, nl)).filter((r) => /^(latency|comb)\//.test(r.code)), []);
  pin.comb_from = ['i_acc_q'];
  const wrong = checkLatency(doc, nl).diagnostics.filter((d) => d.code === 'latency/comb-from');
  assert.equal(wrong.length, 1, 'a missing combinational input is reported');
  assert.equal(wrong[0].evidence.input, 'i_a');
});

// The sweep versions must equal a full pairwise scan, including result order.
function bruteCrossings(nets) {
  const segs = nets.flatMap((n) => n.polylines.flatMap((pl) => segmentsOfPolyline(pl).map((s) => ({ ...s, net: n.id, cls: n.cls === 'data' ? 'data' : 'control' }))));
  const seen = new Set();
  const pairs = [];
  for (const h of segs.filter((s) => s.horizontal)) {
    for (const v of segs.filter((s) => s.vertical && s.net !== h.net)) {
      const [x, y] = [v.a.x, h.a.y];
      if (!(x > Math.min(h.a.x, h.b.x) + 0.5 && x < Math.max(h.a.x, h.b.x) - 0.5 && y > Math.min(v.a.y, v.b.y) + 0.5 && y < Math.max(v.a.y, v.b.y) - 0.5)) continue;
      const key = `${[h.net, v.net].sort().join('|')}@${x.toFixed(1)},${y.toFixed(1)}`;
      if (!seen.has(key)) { seen.add(key); pairs.push({ nets: [h.net, v.net], x, y }); }
    }
  }
  return pairs;
}
function bruteHugs(nets, minGap = 4, minOverlap = 3) {
  const segs = nets.flatMap((n) => n.polylines.flatMap((pl) => segmentsOfPolyline(pl).map((s) => ({ ...s, net: n.id }))));
  const ov = (a0, a1, b0, b1) => Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hits = new Map();
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const [s, u] = [segs[i], segs[j]];
      if (s.net === u.net) continue;
      const vertical = s.vertical && u.vertical;
      if (!vertical && !(s.horizontal && u.horizontal)) continue;
      const gap = vertical ? Math.abs(s.a.x - u.a.x) : Math.abs(s.a.y - u.a.y);
      const len = vertical ? ov(s.a.y, s.b.y, u.a.y, u.b.y) : ov(s.a.x, s.b.x, u.a.x, u.b.x);
      if (gap > 0.3 && gap < minGap && len > minOverlap) {
        const key = `${s.net}|wire|${u.net}|${gap.toFixed(1)}`;
        if (!hits.has(key)) hits.set(key, { net: s.net, other: u.net, gap });
      }
    }
  }
  return [...hits.values()];
}

test('route metrics: the sorted sweeps give exactly the crossings and hugging hits of a full scan', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const nets = Array.from({ length: 40 }, (_, k) => {
    const pts = [{ x: Math.round(rand() * 200), y: Math.round(rand() * 120) }];
    for (let s = 0; s < 4; s += 1) {
      const last = pts.at(-1);
      pts.push(s % 2 ? { x: last.x, y: Math.round(rand() * 120) } : { x: Math.round(rand() * 200), y: last.y });
    }
    return { id: `n${k}`, cls: k % 3 ? 'data' : 'control', polylines: [pts] };
  });
  assert.deepEqual(crossingCounts(nets).pairs.map((p) => ({ nets: p.nets, x: p.x, y: p.y })), bruteCrossings(nets));
  assert.ok(bruteCrossings(nets).length > 20, 'the sample has crossings');
  const hugs = edgeHugging(nets, []).map((h) => ({ net: h.net, other: h.other, gap: h.gap }));
  assert.deepEqual(hugs, bruteHugs(nets));
  assert.ok(hugs.length > 0, 'the sample has hugging wires');
});

test('straightening is bounded by a deterministic evaluation budget and says when it stopped', () => {
  // a → b with a 5 pt jog: the router has candidates to score.
  const input = () => ({
    nodes: new Map([['a', { x: 0, y: 5, w: 10, h: 10 }], ['b', { x: 60, y: 10, w: 10, h: 10 }]]),
    edges: [{ id: 'n__0', net: 'n', cls: 'data', src: 'a', dst: 'b', pts: [{ x: 10, y: 10 }, { x: 35, y: 10 }, { x: 35, y: 15 }, { x: 60, y: 15 }] }],
  });
  const free = straighten(input(), { minOffsetPt: 12 });
  assert.equal(free.exhausted, false);
  assert.ok(free.evaluations > 0);
  assert.equal(free.after.redundant, 0, 'unbounded, the jog is removed');
  const stopped = straighten(input(), { minOffsetPt: 12, maxEvaluations: 0 });
  assert.deepEqual([stopped.exhausted, stopped.evaluations, stopped.moves.length], [true, 0, 0], 'no candidate scored, the input route kept');
  const again = straighten(input(), { minOffsetPt: 12, maxEvaluations: 3 });
  assert.equal(again.evaluations, 3, 'the budget is exact, so the result is reproducible');
});
