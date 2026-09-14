// Pre-phase-3 rules: completeness against the declared scope
// (coverage/dropped-hardware), hidden pipeline registers and drawn latency
// (latency/hidden-register), inversion bubbles tangent to their gates
// (symbol/bubble-detached) and exactly connected wires (wire/detached,
// wire/touching), plus sub-figure links (detail/ref-unresolved). Generic
// fixtures only; netlists are small hand-built objects.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCoverage } from '../lib/checks/coverage.mjs';
import { checkDetailRefs } from '../lib/checks/detail-refs.mjs';
import { checkLatency } from '../lib/checks/latency.mjs';
import { connectivityChecks } from '../lib/render/connectivity.mjs';
import { renderDatapath } from '../lib/render/datapath.mjs';
import { gateGeometry, tangentCentreX } from '../lib/render/gates.mjs';
import { loadSkin } from '../lib/render/datapath.mjs';
import { validateSchema } from '../lib/validate.mjs';

const errors = (diags) => diags.filter((d) => d.severity === 'error');
const codes = (diags, code) => diags.filter((d) => d.code === code);

// --- a small generic netlist ------------------------------------------------
// top: din → mid (comb) → s1_q → s2_q → dout; a counter cnt_q with enable en;
// instance u_leaf (module leaf) computes leaf_y from mid.
function netlist() {
  const reg = (name, width) => ({ name, width, clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true }, clock_root: 'clk' });
  const net = (name, width, kind = 'wire') => ({ name, width, kind });
  return {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'top', diagnostics: [],
    hierarchy: [{ path: 'top', module: 'top' }, { path: 'top.u_leaf', module: 'leaf' }],
    modules: [
      {
        name: 'top', orig_name: 'top',
        ports: [{ name: 'clk', dir: 'in', width: 1 }, { name: 'rst_n', dir: 'in', width: 1 }, { name: 'din', dir: 'in', width: 8 }, { name: 'en', dir: 'in', width: 1 }, { name: 'dout', dir: 'out', width: 8 }, { name: 'count_o', dir: 'out', width: 4 }],
        nets: [net('clk', 1, 'port'), net('rst_n', 1, 'port'), net('din', 8, 'port'), net('en', 1, 'port'), net('dout', 8, 'port'), net('count_o', 4, 'port'), net('mid', 8), net('s1_q', 8, 'var'), net('s2_q', 8, 'var'), net('cnt_q', 4, 'var'), net('cnt_d', 4), net('leaf_y', 8)],
        registers: [reg('s1_q', 8), reg('s2_q', 8), reg('cnt_q', 4)],
        instances: [{ name: 'u_leaf', module: 'leaf', connections: [{ port: 'a', dir: 'in', expr: { kind: 'net', net: 'mid' } }, { port: 'y', dir: 'out', expr: { kind: 'net', net: 'leaf_y' } }] }],
        deps: [
          { target: 'mid', sources: ['din'], kind: 'comb' },
          { target: 's1_q', sources: ['mid', 'rst_n'], kind: 'seq' },
          { target: 's2_q', sources: ['rst_n', 's1_q'], kind: 'seq' },
          { target: 'dout', sources: ['s2_q'], kind: 'comb' },
          { target: 'cnt_d', sources: ['cnt_q'], kind: 'comb' },
          { target: 'cnt_q', sources: ['cnt_d', 'en', 'rst_n'], kind: 'seq' },
          { target: 'count_o', sources: ['cnt_q'], kind: 'comb' },
        ],
      },
      {
        name: 'leaf', orig_name: 'leaf',
        ports: [{ name: 'a', dir: 'in', width: 8 }, { name: 'y', dir: 'out', width: 8 }],
        nets: [net('a', 8, 'port'), net('y', 8, 'port'), net('t', 8)],
        registers: [], instances: [],
        deps: [{ target: 't', sources: ['a'], kind: 'comb' }, { target: 'y', sources: ['t'], kind: 'comb' }],
      },
    ],
  };
}

// Everything in scope represented: a front block (covers mid and u_leaf), two
// pipeline bars, and a counter block marked registered.
function completeFigure() {
  return {
    schema_version: 1, figure_type: 'datapath',
    meta: { title: 'complete', print: { profile: 'ieee' }, scope: { hierarchy: 'all' } },
    clock_domains: [{ id: 'sys', clock: 'clk', reset: { net: 'rst_n', active: 'low', async: true } }],
    elements: [
      { id: 'din', kind: 'port', dir: 'in', width: 8, label: 'data in' },
      { id: 'en', kind: 'port', dir: 'in', width: 1, label: 'count enable', role: 'enable' },
      { id: 'front', kind: 'comb', op: 'custom', width: 8, pin_labels: false, function: { kind: 'custom', name: 'Front logic' }, rtl: { covers: ['mid', 'u_leaf', 'leaf_y'] }, ports: [{ id: 'i', dir: 'in', width: 8 }, { id: 'o', dir: 'out', width: 8 }] },
      { id: 'p1', kind: 'pipeline_register', domain: 'sys', stage: 1, label: 'S0|S1', lanes: [{ id: 'd', width: 8 }] },
      { id: 'p2', kind: 'pipeline_register', domain: 'sys', stage: 2, label: 'S1|S2', lanes: [{ id: 'd', width: 8 }] },
      { id: 'ctr', kind: 'comb', op: 'custom', width: 4, pin_labels: false, function: { kind: 'custom', name: 'Event counter' }, rtl: { covers: ['cnt_q', 'cnt_d'] }, ports: [{ id: 'en', dir: 'in', width: 1, class: 'control', role: 'enable' }, { id: 'n', dir: 'out', width: 4, registered: true }] },
      { id: 'dout', kind: 'port', dir: 'out', width: 8, label: 'data out', rtl: { signal: 'dout' } },
      { id: 'count', kind: 'port', dir: 'out', width: 4, label: 'count', rtl: { signal: 'count_o' } },
    ],
    nets: [
      { id: 'n_din', width: 8, driver: 'din', sinks: ['front.i'], rtl: { signal: 'din' } },
      { id: 'n_mid', width: 8, driver: 'front.o', sinks: ['p1.d_d'], rtl: { signal: 'mid' } },
      { id: 'n_s1', width: 8, driver: 'p1.q_d', sinks: ['p2.d_d'], rtl: { signal: 's1_q' } },
      { id: 'n_s2', width: 8, driver: 'p2.q_d', sinks: ['dout'], rtl: { signal: 's2_q' } },
      { id: 'n_en', width: 1, driver: 'en', sinks: ['ctr.en'], rtl: { signal: 'en' } },
      { id: 'n_cnt', width: 4, driver: 'ctr.n', sinks: ['count'], rtl: { signal: 'count_o' } },
    ],
    regions: [{ id: 'front_r', label: 'front', level: 'block', members: ['front'] }],
  };
}

// --- 1. coverage ------------------------------------------------------------

test('coverage: a figure representing everything in its scope passes, with per-region counts', async () => {
  const doc = completeFigure();
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const { diagnostics, report } = checkCoverage(doc, netlist());
  assert.deepEqual(errors(diagnostics), []);
  assert.deepEqual(report.totals.registers, { covered: 3, total: 3 });
  assert.deepEqual(report.totals.instances, { covered: 1, total: 1 });
  assert.equal(report.totals.nets.covered, report.totals.nets.total);
  assert.equal(report.totals.transfers.represented, report.totals.transfers.total);
  assert.ok(report.totals.transfers.total > 0);
  const region = report.regions.find((r) => r.id === 'front_r');
  assert.deepEqual(region.instances, { covered: 1, total: 1 });
  assert.equal(report.excluded.implicit_nets, 2, 'clock and reset are implicit');
});

test('coverage/dropped-hardware: an instance or register inside the scope that is neither drawn nor covered is an error', () => {
  const noLeaf = completeFigure();
  noLeaf.elements.find((e) => e.id === 'front').rtl.covers = ['mid'];
  const a = checkCoverage(noLeaf, netlist());
  const kinds = codes(a.diagnostics, 'coverage/dropped-hardware').map((d) => d.evidence.kind).sort();
  assert.deepEqual(kinds, ['instance', 'net']);
  assert.deepEqual(a.report.uncovered.instances, ['u_leaf']);
  assert.ok(a.report.uncovered.nets.includes('u_leaf:t'));

  const noCounter = completeFigure();
  noCounter.elements = noCounter.elements.filter((e) => !['ctr', 'en', 'count'].includes(e.id));
  noCounter.nets = noCounter.nets.filter((n) => !['n_en', 'n_cnt'].includes(n.id));
  const b = checkCoverage(noCounter, netlist());
  const reg = codes(b.diagnostics, 'coverage/dropped-hardware').find((d) => d.evidence.kind === 'register');
  assert.ok(reg, JSON.stringify(b.diagnostics));
  assert.deepEqual(reg.evidence.missing, ['top:cnt_q']);
  assert.match(reg.supportedFixes.join(' | '), /narrow meta\.scope/);
});

test('coverage/dropped-hardware: a transfer between represented signals needs a wire', () => {
  const doc = completeFigure();
  // The front block still covers mid, but nothing connects it to the first register.
  doc.nets = doc.nets.filter((n) => n.id !== 'n_mid');
  doc.elements.find((e) => e.id === 'front').rtl.covers.push('mid');
  const { diagnostics } = checkCoverage(doc, netlist());
  const t = codes(diagnostics, 'coverage/dropped-hardware').find((d) => d.evidence.kind === 'transfer');
  assert.ok(t, JSON.stringify(diagnostics));
  assert.match(t.message, /mid → s1_q/);
});

test('coverage: only an explicitly narrowed scope leaves hardware out (instance and cone scopes)', () => {
  const leaf = {
    schema_version: 1, figure_type: 'datapath',
    meta: { title: 'leaf', print: { profile: 'ieee' }, rtl: { instance: 'u_leaf' }, scope: { instance: 'u_leaf' } },
    clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'value in', rtl: { signal: 'a' } },
      { id: 'blk', kind: 'comb', op: 'custom', width: 8, pin_labels: false, function: { kind: 'custom', name: 'Leaf logic' }, rtl: { covers: ['t'] }, ports: [{ id: 'i', dir: 'in', width: 8 }, { id: 'o', dir: 'out', width: 8 }] },
      { id: 'y', kind: 'port', dir: 'out', width: 8, label: 'value out', rtl: { signal: 'y' } },
    ],
    nets: [{ id: 'n_a', width: 8, driver: 'a', sinks: ['blk.i'], rtl: { signal: 'a' } }, { id: 'n_y', width: 8, driver: 'blk.o', sinks: ['y'], rtl: { signal: 'y' } }],
  };
  const r = checkCoverage(leaf, netlist());
  assert.deepEqual(errors(r.diagnostics), []);
  assert.equal(r.report.totals.registers.total, 0, 'top registers are outside the narrowed scope');
  assert.equal(codes(r.diagnostics, 'coverage/scope-undeclared').length, 0);

  const undeclared = structuredClone(leaf);
  delete undeclared.meta.scope;
  assert.equal(codes(checkCoverage(undeclared, netlist()).diagnostics, 'coverage/scope-undeclared').length, 1);

  const cone = structuredClone(completeFigure());
  cone.meta.scope = { cone: { outputs: ['dout'], inputs: ['din'] } };
  cone.elements = cone.elements.filter((e) => !['ctr', 'en', 'count'].includes(e.id));
  cone.nets = cone.nets.filter((n) => !['n_en', 'n_cnt'].includes(n.id));
  cone.elements.find((e) => e.id === 'front').rtl.covers = ['mid'];
  const c = checkCoverage(cone, netlist());
  assert.deepEqual(errors(c.diagnostics), []);
  assert.deepEqual(c.report.totals.registers, { covered: 2, total: 2 });
});

// --- 2. hidden pipeline registers and latency --------------------------------

test('latency/hidden-register: a pipeline register absorbed by a collapsed block is an error; drawing the bar fixes it', async () => {
  const hidden = completeFigure();
  // One block from din to the first register's output, marked registered: the latency matches, but S0|S1 is hidden.
  hidden.elements = hidden.elements.filter((e) => e.id !== 'p1');
  hidden.elements.find((e) => e.id === 'front').ports.find((p) => p.id === 'o').registered = true;
  hidden.nets = hidden.nets.filter((n) => !['n_mid', 'n_s1'].includes(n.id));
  hidden.nets.push({ id: 'n_s1', width: 8, driver: 'front.o', sinks: ['p2.d_d'], rtl: { signal: 's1_q' } });
  assert.deepEqual(await validateSchema('datapath', hidden), []);
  const h = checkLatency(hidden, netlist());
  const d = codes(h.diagnostics, 'latency/hidden-register');
  assert.equal(d.length, 1, JSON.stringify(h.diagnostics));
  assert.deepEqual(d[0].evidence.hidden, ['s1_q']);
  assert.equal(h.report.hidden_registers, 1);
  assert.match(d[0].supportedFixes[0], /split the block at the register boundary/);

  const ok = checkLatency(completeFigure(), netlist());
  assert.deepEqual(ok.diagnostics, []);
  assert.equal(ok.report.hidden_registers, 0);
});

test('latency/hidden-register: drawn latency must equal the RTL latency; internal state may stay in a block marked registered', async () => {
  const marked = checkLatency(completeFigure(), netlist());
  const path = marked.report.paths.find((p) => p.element === 'ctr');
  assert.equal(path.status, 'ok');
  assert.deepEqual(path.state, ['cnt_q'], 'the counter feeds itself: internal state, not a pipeline register');

  const unmarked = completeFigure();
  delete unmarked.elements.find((e) => e.id === 'ctr').ports.find((p) => p.id === 'n').registered;
  const u = checkLatency(unmarked, netlist());
  const d = codes(u.diagnostics, 'latency/hidden-register');
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].evidence.rtl, d[0].evidence.drawn], [1, 0]);

  // Option (b) is visible: a clock wedge on the block, and its latency when details are opted in.
  const detailed = completeFigure();
  detailed.meta.style = { ...(detailed.meta.style || {}), block_details: true };
  const r = await renderDatapath(detailed, { variant: '2col', widthPt: 515.5, name: 'marked' });
  assert.match(r.svg, /id="custom-ctr-sub"[^>]*>[^<]*1 stage</);
  assert.match(r.svg, /id="custom-ctr"[\s\S]*?L[\d.]+ [\d.]+ L[\d.]+ [\d.]+"[^>]*fill="none"/);
});

// --- 3. inversion bubbles -----------------------------------------------------

function gateFigure(op, inputs, invert = [], invertOutput = false) {
  const elements = [
    ...Array.from({ length: inputs }, (_, i) => ({ id: `in${i}`, kind: 'port', dir: 'in', width: 1, label: `input ${i}` })),
    { id: 'g', kind: 'comb', op, width: 1, ...(op === 'not' ? {} : { inputs }), ...(invert.length ? { invert_inputs: invert } : {}), ...(invertOutput ? { invert_output: true } : {}) },
    { id: 'y', kind: 'port', dir: 'out', width: 1, label: 'output' },
  ];
  const nets = [...Array.from({ length: inputs }, (_, i) => ({ id: `n${i}`, width: 1, driver: `in${i}`, sinks: [`g.in${i}`] })), { id: 'ny', width: 1, driver: 'g.out', sinks: ['y'] }];
  return { schema_version: 1, figure_type: 'datapath', meta: { title: `${op} gate`, print: { profile: 'ieee' } }, clock_domains: [], elements, nets, regions: [{ id: 'gates', label: 'gates', level: 'gate', members: ['g'] }] };
}

const GATE_CASES = [
  ['nand', 2, []], ['nor', 2, []], ['xnor', 2, []], ['not', 1, []],
  ['and', 2, [1]], ['and', 3, [0, 2]], ['and', 4, [1, 2]],
  ['or', 2, [0]], ['or', 3, [1]], ['or', 4, [0, 3]],
  ['xor', 3, [2]], ['nand', 4, [0]],
];

test('symbol/bubble-detached: bubbles are tangent to AND/OR/XOR/NOT outlines and wires meet them, for 1-4 inputs', async () => {
  for (const [op, n, inv] of GATE_CASES) {
    const doc = gateFigure(op, n, inv);
    assert.deepEqual(await validateSchema('datapath', doc), [], `${op}${n}`);
    const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'gate' });
    const label = `${op} ${n} inputs, inverted ${inv}`;
    assert.deepEqual(r.diagnostics.filter((d) => /^(wire|symbol)\//.test(d.code)), [], label);
    const c = r.route.connectivity;
    assert.equal(c.bubble_detached, 0, label);
    assert.equal(c.wire_detached, 0, label);
    const expected = inv.length + (['nand', 'nor', 'xnor', 'not'].includes(op) ? 1 : 0);
    assert.equal(c.bubbles_checked, expected, label);
    // every inverted pin's wire ends on its bubble's outer tangent point
    for (const a of r.geometry.anchors.filter((x) => x.bubble)) {
      assert.ok(Math.abs(Math.hypot(a.x - a.bubble.cx, a.y - a.bubble.cy) - a.bubble.r) < 1e-6, `${label}: ${a.pin}`);
    }
  }
});

test('bubble geometry is computed from the outline: output apex, flat back and curved back', () => {
  const spec = { ...loadSkin().symbols.gates };
  assert.equal(spec.bubble_diameter, 4, 'CONVENTIONS §4.1: 4 pt bubbles');
  for (const inputs of [2, 3, 4, 8]) {
    const nand = gateGeometry(spec, { op: 'nand', inputs, inverted: [0] });
    assert.ok(Math.abs(nand.out.bubble.cx - nand.out.bubble.r - nand.apexX) < 1e-9, 'output bubble touches the arc apex');
    assert.ok(Math.abs(nand.out.x - (nand.out.bubble.cx + nand.out.bubble.r)) < 1e-9, 'output wire starts at the bubble');
    assert.ok(Math.abs(nand.anchors[0].bubble.cx + nand.anchors[0].bubble.r - nand.bodyX) < 1e-9, 'input bubble touches the flat back');
    const nor = gateGeometry(spec, { op: 'nor', inputs, inverted: [inputs - 1] });
    const a = nor.anchors[inputs - 1];
    const curve = (y) => nor.bodyX + 2 * (y / nor.h) * (1 - y / nor.h) * nor.bulge;
    let best = Infinity;
    for (let s = 0; s <= 2000; s += 1) { const y = (nor.h * s) / 2000; best = Math.min(best, Math.hypot(curve(y) - a.bubble.cx, y - a.bubble.cy)); }
    assert.ok(Math.abs(best - a.bubble.r) < 0.02, `curved back tangent within 0.02 pt (got ${best - a.bubble.r})`);
    assert.ok(Math.abs(nor.out.bubble.cx - nor.out.bubble.r - nor.apexX) < 1e-9);
  }
  const flat = tangentCentreX(() => 10, 20, 7, 2);
  assert.ok(Math.abs(flat - 8) < 1e-6);
});

test('symbol/bubble-detached flags a bubble floating off its body (the old fixed-offset placement)', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g id="datapath"><g id="stage-0"><g id="nand-g">
    <path id="nand-g-body" d="M281.34 36 L292.34 36 A8 8 0 0 1 292.34 52 L281.34 52 Z" fill="#FFFFFF" stroke="#000000" stroke-width="0.8"/>
    <circle id="nand-g-bubble-out" cx="305.09" cy="44" r="1.35" fill="#FFFFFF" stroke="#000000" stroke-width="0.8"/>
  </g></g></g></svg>`;
  const r = connectivityChecks(svg);
  const d = codes(r.diagnostics, 'symbol/bubble-detached');
  assert.equal(d.length, 1);
  assert.ok(d[0].evidence.gap > 3, `gap ${d[0].evidence.gap}`);
});

// --- 4. detached wires ----------------------------------------------------------

function fanoutFigure() {
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'fan-out', print: { profile: 'ieee' } },
    clock_domains: [{ id: 'sys', clock: 'clk' }],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'value A' },
      { id: 'b', kind: 'port', dir: 'in', width: 8, label: 'value B' },
      { id: 'x', kind: 'comb', op: 'xor', width: 8, inputs: 3 },
      { id: 'o', kind: 'comb', op: 'or', width: 8, inputs: 2 },
      { id: 'p', kind: 'pipeline_register', domain: 'sys', stage: 1, label: 'S0|S1', lanes: [{ id: 'x', width: 8 }, { id: 'o', width: 8 }] },
      { id: 'yx', kind: 'port', dir: 'out', width: 8, label: 'parity' },
      { id: 'yo', kind: 'port', dir: 'out', width: 8, label: 'union' },
    ],
    nets: [
      { id: 'na', width: 8, driver: 'a', sinks: ['x.in0', 'o.in0', 'x.in2'] },
      { id: 'nb', width: 8, driver: 'b', sinks: ['x.in1', 'o.in1'] },
      { id: 'nx', width: 8, driver: 'x.out', sinks: ['p.d_x'] },
      { id: 'no', width: 8, driver: 'o.out', sinks: ['p.d_o'] },
      { id: 'nqx', width: 8, driver: 'p.q_x', sinks: ['yx'] },
      { id: 'nqo', width: 8, driver: 'p.q_o', sinks: ['yo'] },
    ],
    regions: [{ id: 'g', label: 'gates', level: 'gate', members: ['x', 'o'] }],
  };
}

test('wire/detached: wires end on OR/XOR curved backs, T-junctions carry dots, lanes pass pipeline bars level', async () => {
  const doc = fanoutFigure();
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'fan' });
  assert.deepEqual(r.diagnostics.filter((d) => /^(wire|symbol)\//.test(d.code)), []);
  assert.ok(r.route.connectivity.junctions_checked >= 1);
  assert.ok(r.geometry.lanePairs.length === 2);
  // the XOR anchors lie on its extra back line, the OR anchors on its body back
  assert.ok(r.geometry.anchors.some((a) => a.element === 'x' && a.role === 'sink'));

  // A branch start pulled 0.5 pt off its pin is reported with the gap.
  const moved = r.svg.replace(/(id="net-nqx-seg0" d="M)([\d.]+)/, (m, p, x) => `${p}${Number(x) + 0.5}`);
  const m = connectivityChecks(moved, { anchors: r.geometry.anchors, lanePairs: r.geometry.lanePairs });
  const d = codes(m.diagnostics, 'wire/detached');
  assert.equal(d.length, 1);
  assert.equal(d[0].subject.id, 'nqx');
  assert.ok(Math.abs(d[0].evidence.gap - 0.5) <= 0.01, `gap ${d[0].evidence.gap} (SVG coordinates are rounded to 0.01 pt)`);

  // A junction dot removed, a lane that changes level, an arrow shaft stopping short.
  const noDots = r.svg.replace(/<circle id="net-na-dot\d+"[^>]*\/>/g, '');
  assert.ok(codes(connectivityChecks(noDots, { anchors: r.geometry.anchors }).diagnostics, 'wire/detached').some((x) => /junction dot/.test(x.message)));
  const lanes = r.geometry.lanePairs.map((lp, i) => (i ? lp : { ...lp, outY: lp.outY + 0.4 }));
  assert.ok(codes(connectivityChecks(r.svg, { anchors: r.geometry.anchors, lanePairs: lanes }).diagnostics, 'wire/detached').some((x) => /changes level/.test(x.message)));
  const shortShaft = r.svg.replace(/(id="net-nqo-seg0" d="M[\d.]+ [\d.]+ L)([\d.]+)/, (all, p, x) => `${p}${Number(x) - 0.3}`);
  assert.ok(codes(connectivityChecks(shortShaft, { anchors: r.geometry.anchors }).diagnostics, 'wire/detached').some((x) => /arrowhead base/.test(x.message)));
});

test('wire/touching: a vertex of one net on another net\'s wire; crossings without a vertex are fine', () => {
  const wrap = (paths) => `<svg xmlns="http://www.w3.org/2000/svg"><g id="nets"><g id="nets-data">${paths}</g></g></svg>`;
  const net = (id, d) => `<g id="net-${id}"><path id="net-${id}-seg0" d="${d}" fill="none" stroke="#000000" stroke-width="0.6" stroke-linejoin="miter"/></g>`;
  const touch = connectivityChecks(wrap(net('a', 'M0 10 L50 10') + net('b', 'M20 0 L20 10 L30 10 L30 30')));
  assert.ok(codes(touch.diagnostics, 'wire/touching').length >= 1);
  const cross = connectivityChecks(wrap(net('a', 'M0 10 L50 10') + net('b', 'M20 0 L20 30')));
  assert.equal(codes(cross.diagnostics, 'wire/touching').length, 0);
  const notched = connectivityChecks(wrap('<g id="net-c"><path id="net-c-seg0" d="M0 0 L10 0 L10 10" fill="none" stroke="#000000" stroke-width="0.6" stroke-linejoin="bevel"/></g>'));
  assert.ok(codes(notched.diagnostics, 'wire/detached').some((x) => /notched joins/.test(x.message)));
});

// --- 5. sub-figure links --------------------------------------------------------

test('detail/ref-unresolved: a collapsed element may link the sub-figure that draws it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-detail-'));
  try {
    fs.writeFileSync(path.join(dir, 'b.datapath.json'), JSON.stringify({ elements: [{ id: 'core' }] }));
    const doc = { elements: [{ id: 'blk', detail_ref: { figure: 'b.datapath.json', id: 'core' } }, { id: 'bad', detail_ref: { figure: 'missing.datapath.json' } }, { id: 'badid', detail_ref: { figure: 'b.datapath.json', id: 'nope' } }] };
    const r = checkDetailRefs(doc, { figureDir: dir });
    assert.deepEqual(r.diagnostics.map((d) => d.subject.id).sort(), ['bad', 'badid']);
    assert.deepEqual(r.refs.map((x) => x.element), ['blk']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
