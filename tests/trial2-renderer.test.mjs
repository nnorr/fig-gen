// Trial-2 renderer rules: short returns between neighbouring blocks stay wires
// (connectors are decided by block separation, never by tag positions),
// parallel runs of different nets never overlap (wire/collinear-overlap),
// net labels sit close to their own wire and not against a block
// (label/ambiguous-anchor), parallel unlabeled nets are named or reported
// (label/unlabeled-parallel-nets), unused ports sit at the figure edge with a
// stub and an "unused" mark, and constants are small value boxes at the pin.

import assert from 'node:assert/strict';
import test from 'node:test';
import { constantText } from '../lib/checks/labels.mjs';
import { collinearOverlaps, connectivityChecks } from '../lib/render/connectivity.mjs';
import { wireOwners } from '../lib/render/microarch.mjs';
import { blockLayers, closeConnectorMarks, detouchWires, netLabelAnchorProblem, renderDatapath, separateParallelRuns } from '../lib/render/datapath.mjs';

const block = (id, name, ins, outs) => ({ id, kind: 'comb', op: 'custom', width: 1, function: { kind: 'custom', name }, ports: [...ins.map((p) => ({ id: p, dir: 'in', width: 1 })), ...outs.map((p) => ({ id: p, dir: 'out', width: 1 }))] });
const figure = (elements, nets, meta = {}) => ({ schema_version: 1, figure_type: 'datapath', meta: { title: 't', print: { profile: 'ieee' }, ...meta }, clock_domains: [], elements, nets });

// Two neighbouring controllers: a forward command bundle A → B and three
// returns B → A (ready, valid, data), plus figure ports on both sides.
function handshakePair() {
  return figure([
    { id: 'p_valid', kind: 'port', dir: 'in', width: 1, label: 'client valid' },
    { id: 'p_data', kind: 'port', dir: 'in', width: 1, label: 'client data' },
    { id: 'p_ready', kind: 'port', dir: 'out', width: 1, label: 'client ready' },
    { id: 'p_owner', kind: 'port', dir: 'out', width: 1, label: 'owner valid' },
    block('owner', 'Owner controller', ['client_valid', 'client_data', 'cmd_ready', 'rsp_valid', 'rsp_data'], ['reset', 'cmd_valid', 'cmd', 'data', 'client_ready', 'owner_valid']),
    block('adapter', 'Engine adapter', ['reset', 'cmd_valid', 'cmd', 'data'], ['cmd_ready', 'rsp_valid', 'rsp_data']),
  ], [
    { id: 'n_client_valid', width: 1, driver: 'p_valid', sinks: ['owner.client_valid'] },
    { id: 'n_client_data', width: 1, driver: 'p_data', sinks: ['owner.client_data'] },
    ...['reset', 'cmd_valid', 'cmd', 'data'].map((p) => ({ id: `n_${p}`, width: 1, driver: `owner.${p}`, sinks: [`adapter.${p}`] })),
    ...['cmd_ready', 'rsp_valid', 'rsp_data'].map((p) => ({ id: `n_${p}`, width: 1, driver: `adapter.${p}`, sinks: [`owner.${p}`] })),
    { id: 'n_ready', width: 1, driver: 'owner.client_ready', sinks: ['p_ready'] },
    { id: 'n_owner', width: 1, driver: 'owner.owner_valid', sinks: ['p_owner'] },
  ]);
}

test('returns between two neighbouring blocks are wires: no connector tags and no connector or orphan errors', async () => {
  const r = await renderDatapath(handshakePair(), { variant: '2col', widthPt: 515.5, name: 'pair' });
  assert.doesNotMatch(r.svg, /id="port-cx_/);
  assert.equal(r.route.connectors, undefined);
  assert.deepEqual(r.diagnostics.filter((d) => /^connector\/|^route\/long-(feedback|loop)$/.test(d.code)), []);
});

test('detouchWires: an arrowhead base landing on another net\'s bend column moves that run clear', () => {
  // Net a bends down at x 9 into a pin at x 14; net b ends at a pin at x 14, so
  // with a 5 pt head its drawn wire stops at (9, 24), on a's vertical run.
  const edgePts = new Map([
    ['a__0', [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 37 }, { x: 14, y: 37 }]],
    ['b__0', [{ x: 0, y: 24 }, { x: 14, y: 24 }]],
  ]);
  const edges = [{ id: 'a__0', net: 'a' }, { id: 'b__0', net: 'b' }];
  // the sink block starts at x 14; a run may not hug its outline
  detouchWires(edgePts, edges, { arrowLen: 5, rects: [{ x0: 14, y0: 30, x1: 40, y1: 45 }] });
  const run = edgePts.get('a__0');
  assert.notEqual(run[1].x, 9);
  assert.equal(run[1].x, run[2].x);
  assert.deepEqual([run[0], run[3]], [{ x: 0, y: 0 }, { x: 14, y: 37 }]);
  assert.ok(14 - run[2].x >= 5, 'the last run still holds the arrowhead');
});

test('collinearOverlaps works on any wire owners: microarch links read from the final SVG', () => {
  const svg = [
    '<path id="link-l_a-seg0" d="M0 10 L50 10 L50 40" fill="none"/>',
    '<path id="link-l_a-arrow" d="M48 35 L50 40 L52 35 Z"/>',
    '<path id="link-l_b-seg0" d="M10 11 L60 11" fill="none"/>',
    '<path id="att-at_c-seg0" d="M0 30 L40 30" fill="none"/>',
  ].join('');
  const owners = wireOwners(svg);
  assert.deepEqual(owners.map((o) => o.id).sort(), ['att-at_c', 'link-l_a', 'link-l_b']);
  const found = collinearOverlaps(owners, { collinearGap: 1.5, variant: '2col' });
  assert.equal(found.length, 1);
  assert.equal(found[0].code, 'wire/collinear-overlap');
  assert.deepEqual([found[0].subject.id, found[0].subject.other].sort(), ['link-l_a', 'link-l_b']);
  assert.deepEqual(collinearOverlaps(owners, { collinearGap: 0.5 }), []);
});

test('constantText: a value box prints readable values, never Verilog literal syntax', () => {
  assert.equal(constantText({ value: "1'b0" }), '0');
  assert.equal(constantText({ value: "'1" }), '1');
  assert.equal(constantText({ value: "8'hFF" }), 'all ones');
  assert.equal(constantText({ value: "16'h1F" }), '0x1F');
  assert.equal(constantText({ value: "8'd12" }), '12');
  assert.equal(constantText({ value: "1'b0", label: 'tied low' }), 'tied low');
});

test('parallel nets whose names find no spot get room beside the source pin on a retry', async () => {
  const names = ['request valid for the service', 'request operation code word', 'first request operand value'];
  const doc = figure([
    { id: 'go', kind: 'port', dir: 'in', width: 1, label: 'start' },
    block('a', 'Front logic', ['go'], ['p0', 'p1', 'p2']),
    block('b', 'Service', ['q0', 'q1', 'q2'], ['done']),
    { id: 'fin', kind: 'port', dir: 'out', width: 1, label: 'finished' },
  ], [
    { id: 'n_go', width: 1, driver: 'go', sinks: ['a.go'] },
    ...names.map((label, i) => ({ id: `n_${i}`, width: 1, driver: `a.p${i}`, sinks: [`b.q${i}`], label })),
    { id: 'n_done', width: 1, driver: 'b.done', sinks: ['fin'] },
  ]);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'names' });
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'label/unlabeled-parallel-nets'), []);
  for (let i = 0; i < names.length; i += 1) assert.match(r.svg, new RegExp(`id="net-n_${i}-name"`));
});

test('returns into a neighbouring block try its east and top edges and keep one only when crossings drop', async () => {
  // Fig 2 shape: many figure inputs into a logic block, requests to a service,
  // and three service results returning into the logic block.
  const ins = ['a', 'b', 'c', 'd'];
  const doc = figure([
    ...ins.map((p) => ({ id: `p_${p}`, kind: 'port', dir: 'in', width: 1, label: `input ${p}` })),
    block('logic', 'Front logic', [...ins.map((p) => `i_${p}`), 'r0', 'r1', 'r2'], ['q0', 'q1', 'o']),
    block('svc', 'Service', ['q0', 'q1'], ['r0', 'r1', 'r2']),
    { id: 'p_out', kind: 'port', dir: 'out', width: 1, label: 'result' },
  ], [
    ...ins.map((p) => ({ id: `n_${p}`, width: 1, driver: `p_${p}`, sinks: [`logic.i_${p}`] })),
    ...[0, 1].map((i) => ({ id: `n_q${i}`, width: 1, driver: `logic.q${i}`, sinks: [`svc.q${i}`], label: `request ${['valid', 'word'][i]}` })),
    ...[0, 1, 2].map((i) => ({ id: `n_r${i}`, width: 1, driver: `svc.r${i}`, sinks: [`logic.r${i}`], label: `response ${['valid', 'status', 'word'][i]}` })),
    { id: 'n_out', width: 1, driver: 'logic.o', sinks: ['p_out'] },
  ]);
  const base = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'ret', returnSide: 'west' });
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'ret' });
  const cpn = (x) => x.route.readability.crossings_per_net;
  assert.ok(cpn(r) <= cpn(base), `crossings ${cpn(r)} vs default ${cpn(base)}`);
  const info = r.diagnostics.find((d) => d.code === 'route/return-pins');
  if (info) assert.ok(cpn(r) < cpn(base));
  assert.ok(r.diagnostics.filter((d) => d.severity === 'error').length <= base.diagnostics.filter((d) => d.severity === 'error').length);
});

test('blockLayers: blocks whose horizontal extents overlap share a drawn layer', () => {
  const layers = blockLayers([{ id: 'a', x: 0, w: 40 }, { id: 'b', x: 20, w: 40 }, { id: 'c', x: 100, w: 10 }, { id: 'd', x: 200, w: 10 }]);
  assert.deepEqual([...layers], [['a', 0], ['b', 0], ['c', 1], ['d', 2]]);
});

test('closeConnectorMarks decides from the blocks, not from where the tags landed', () => {
  const tag = (id, net, sinks) => ({ id, kind: 'port', connector: sinks ? 'target' : 'source', connector_net: net, ...(sinks ? { connector_sinks: sinks } : {}) });
  const doc = {
    elements: [{ id: 'a', kind: 'comb' }, { id: 'b', kind: 'comb' }, { id: 'c', kind: 'comb' }, tag('cx_n', 'n'), tag('cx_n_to0', 'n', [0]), tag('cx_m', 'm'), tag('cx_m_to0', 'm', [0])],
    nets: [
      { id: 'n', driver: 'b.o', sinks: ['cx_n'] }, { id: 'n__cx0', driver: 'cx_n_to0', sinks: ['a.i'] },
      { id: 'm', driver: 'c.o', sinks: ['cx_m'] }, { id: 'm__cx0', driver: 'cx_m_to0', sinks: ['a.j'] },
    ],
  };
  const box = (x) => ({ x, y: 0, w: 40, h: 10 });
  // n: neighbouring blocks, tags parked far apart at the edges; m: two layers apart, tags side by side.
  const pos = new Map([['a', box(100)], ['b', box(200)], ['c', box(300)], ['cx_n', box(600)], ['cx_n_to0', box(10)], ['cx_m', box(600)], ['cx_m_to0', box(620)]]);
  assert.deepEqual(closeConnectorMarks(doc, pos), [{ net: 'n', sinks: [0] }]);
});

test('wire/collinear-overlap: parallel runs of two nets closer than the collinear gap are an error', () => {
  const wire = (net, d) => `<g id="net-${net}"><path id="net-${net}-seg0" d="${d}" stroke="#000" stroke-width="0.9" stroke-linejoin="miter" fill="none"/></g>`;
  const svg = (y) => `<svg><g id="nets"><g id="nets-data">${wire('a', 'M0 10 L100 10')}${wire('b', `M20 ${y} L80 ${y}`)}</g></g></svg>`;
  const of = (y) => connectivityChecks(svg(y)).diagnostics.filter((d) => d.code === 'wire/collinear-overlap');
  assert.deepEqual(of(10).map((d) => [d.severity, d.subject.id, d.subject.other, d.evidence.overlap]), [['error', 'a', 'b', 60]]);
  assert.equal(of(11).length, 1, 'a stroke apart reads as one wire');
  assert.equal(of(14).length, 0, 'wider gaps are route/edge-hugging');
});

test('separateParallelRuns moves an interior run to the parallel gap and keeps its ends', () => {
  const edgePts = new Map([
    ['a__0', [{ x: 0, y: 20 }, { x: 100, y: 20 }]],
    ['b__0', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 21 }, { x: 90, y: 21 }, { x: 90, y: 40 }, { x: 100, y: 40 }]],
  ]);
  separateParallelRuns(edgePts, [{ id: 'a__0', net: 'a' }, { id: 'b__0', net: 'b' }], { minGap: 4 });
  const b = edgePts.get('b__0');
  assert.deepEqual([b[2].y, b[3].y], [24, 24]);
  assert.deepEqual([b[0], b.at(-1)], [{ x: 0, y: 0 }, { x: 100, y: 40 }]);
  assert.deepEqual(edgePts.get('a__0'), [{ x: 0, y: 20 }, { x: 100, y: 20 }]);
});

test('netLabelAnchorProblem: nearer its own wire than other nets, within the maximum distance, and nearer its wire than a block it faces', () => {
  const box = { x0: 10, x1: 40, y0: 50, y1: 56 };
  assert.equal(netLabelAnchorProblem({ own: 1, foreign: 10 }, box, []), null);
  assert.equal(netLabelAnchorProblem({ own: 1, foreign: 1.2, other: 'n2' }, box, []).reason, 'foreign-wire');
  assert.equal(netLabelAnchorProblem({ own: 15, foreign: Infinity }, box, [], { maxDistance: 12 }).reason, 'far-from-wire');
  const below = { id: 'blk', x0: 0, x1: 100, y0: 58, y1: 90 };
  assert.deepEqual(netLabelAnchorProblem({ own: 5, foreign: Infinity }, box, [below]), { reason: 'closer-to-block', block: 'blk', block_distance: 2 });
  assert.equal(netLabelAnchorProblem({ own: 1.5, foreign: Infinity }, box, [below]), null, 'the wire is nearer than the block');
  assert.equal(netLabelAnchorProblem({ own: 5, foreign: Infinity }, box, [{ id: 'corner', x0: 42, x1: 60, y0: 58, y1: 70 }]), null, 'a block only diagonally near is not faced');
});

// Two blocks joined by three parallel nets without names.
function parallelNets(withSignals) {
  return figure([
    { id: 'din', kind: 'port', dir: 'in', width: 1, label: 'request' },
    block('ctl', 'Controller', ['i'], ['go', 'stop', 'mode']),
    block('eng', 'Engine', ['go', 'stop', 'mode'], ['o']),
    { id: 'dout', kind: 'port', dir: 'out', width: 1, label: 'response' },
  ], [
    { id: 'n_in', width: 1, driver: 'din', sinks: ['ctl.i'] },
    ...['go', 'stop', 'mode'].map((p) => ({ id: `n_${p}`, width: 1, driver: `ctl.${p}`, sinks: [`eng.${p}`], ...(withSignals ? { rtl: { signal: `${p}_o` } } : {}) })),
    { id: 'n_out', width: 1, driver: 'eng.o', sinks: ['dout'] },
  ]);
}

test('label/unlabeled-parallel-nets: an error in paper variants and a warning in study, with evidence.paper_error', async () => {
  const of = (r) => r.diagnostics.filter((d) => d.code === 'label/unlabeled-parallel-nets');
  const paper = of(await renderDatapath(parallelNets(false), { variant: '2col', widthPt: 515.5, name: 'par' }));
  assert.deepEqual(paper.map((d) => [d.severity, d.evidence.nets, d.evidence.paper_error]), [['error', ['n_go', 'n_stop', 'n_mode'], true]]);
  const study = of(await renderDatapath(parallelNets(false), { variant: 'study', name: 'par' }));
  assert.deepEqual(study.map((d) => d.severity), ['warning']);
});

test('parallel nets with RTL signals are named by the renderer, next to their own wires', async () => {
  const r = await renderDatapath(parallelNets(true), { variant: '2col', widthPt: 515.5, name: 'par' });
  const named = ['n_go', 'n_stop', 'n_mode'].filter((id) => r.svg.includes(`id="net-${id}-name"`));
  assert.ok(named.length >= 2, `named: ${named.join(', ')}`);
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'label/unlabeled-parallel-nets' || d.code === 'label/ambiguous-anchor'), []);
});

test('an unused input sits at the left figure edge with a stub and an "unused" mark; text never overlaps', async () => {
  const doc = figure([
    { id: 'din', kind: 'port', dir: 'in', width: 1, label: 'data in' },
    { id: 'spare', kind: 'port', dir: 'in', width: 1, label: 'spare input' },
    block('b', 'Worker', ['i'], ['o']),
    { id: 'dout', kind: 'port', dir: 'out', width: 1, label: 'data out' },
  ], [
    { id: 'n_in', width: 1, driver: 'din', sinks: ['b.i'] },
    { id: 'n_out', width: 1, driver: 'b.o', sinks: ['dout'] },
  ]);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'unused' });
  assert.match(r.svg, /id="port-spare-unused-stub"/);
  assert.match(r.svg, /<text id="port-spare-unused"[^>]*font-size="7"[^>]*>unused</);
  const xOf = (id) => Number(new RegExp(`<text id="${id}" x="([\\d.]+)"`).exec(r.svg)[1]);
  assert.ok(xOf('port-spare-label') <= xOf('port-din-label') + 0.01, 'at the left edge');
  assert.deepEqual(r.diagnostics.filter((d) => /^geometry\//.test(d.code)), []);
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'port/no-sink').map((d) => d.subject.id), ['spare']);
});

test('a constant is a small outlined value box at its pin, in the secondary font', async () => {
  const doc = figure([
    { id: 'din', kind: 'port', dir: 'in', width: 1, label: 'data in' },
    { id: 'zero', kind: 'const', width: 1, value: "1'b0" },
    block('b', 'Worker', ['i', 'clear'], ['o']),
    { id: 'dout', kind: 'port', dir: 'out', width: 1, label: 'data out' },
  ], [
    { id: 'n_in', width: 1, driver: 'din', sinks: ['b.i'] },
    { id: 'n_zero', width: 1, driver: 'zero.out', sinks: ['b.clear'] },
    { id: 'n_out', width: 1, driver: 'b.o', sinks: ['dout'] },
  ]);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'const' });
  const box = /<rect id="const-zero-body" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*stroke="#000000"/.exec(r.svg);
  assert.ok(box, 'outlined box');
  assert.match(r.svg, /<text id="const-zero-label"[^>]*font-size="7"[^>]*>0</);
  const wire = /<path id="net-n_zero-seg0" d="M([\d.]+) ([\d.]+)/.exec(r.svg);
  // x, width and the wire start are each rounded to 0.01 pt in the SVG
  assert.ok(Math.abs(Number(wire[1]) - (Number(box[1]) + Number(box[3]))) <= 0.02, 'the wire starts at the box outline');
  assert.deepEqual(r.diagnostics.filter((d) => /^(wire|geometry|connector)\//.test(d.code)), []);
});
