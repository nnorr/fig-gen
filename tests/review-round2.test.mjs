// Review round 2 rules: arrowheads on every net end (arrow/missing), wires in
// their own channels (route/edge-hugging), every data bend justified after
// lane re-ordering and pin re-assignment were tried (route/data-jog,
// route/data-bend), and no abbreviated words in primary labels
// (label/unreadable).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkLabels, unreadableReason, VOCABULARY } from '../lib/checks/labels.mjs';
import { buildModel } from '../lib/ir/datapath-model.mjs';
import { loadSkin, renderDatapath, tapPlan } from '../lib/render/datapath.mjs';
import { edgeHugging } from '../lib/render/route-metrics.mjs';
import { justifyBends, straighten } from '../lib/render/straighten.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = (diags) => diags.filter((d) => d.severity === 'error');

function flagFigure() {
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'flags', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'value A' },
      { id: 'b', kind: 'port', dir: 'in', width: 8, label: 'value B' },
      { id: 'cmp', kind: 'comb', op: 'custom', width: 1, pin_labels: false, function: { kind: 'comparator' }, ports: [{ id: 'x', dir: 'in', width: 8 }, { id: 'y', dir: 'in', width: 8 }, { id: 'eq', dir: 'out', width: 1 }] },
      { id: 'cls', kind: 'comb', op: 'custom', width: 1, pin_labels: false, function: { kind: 'classifier' }, ports: [{ id: 'f', dir: 'in', width: 1 }, { id: 'o', dir: 'out', width: 1 }] },
      { id: 'flag', kind: 'port', dir: 'out', width: 1, label: 'values equal' },
    ],
    nets: [
      { id: 'na', width: 8, driver: 'a', sinks: ['cmp.x'] },
      { id: 'nb', width: 8, driver: 'b', sinks: ['cmp.y'] },
      { id: 'neq', width: 1, driver: 'cmp.eq', sinks: ['cls.f'] },
      { id: 'nflag', width: 1, driver: 'cls.o', sinks: ['flag'] },
    ],
  };
}

// --- 1. arrowheads ------------------------------------------------------------

test('arrow/missing: 1-bit flags into a block and out of the figure get arrowheads like buses', async () => {
  const doc = flagFigure();
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'flags' });
  assert.deepEqual(errors(r.diagnostics), []);
  for (const id of ['na', 'nb', 'neq', 'nflag']) assert.match(r.svg, new RegExp(`id="net-${id}-arrow0"`), id);
  const skin = loadSkin();
  skin.tokens.arrow.at = ['bus'];
  const r2 = await renderDatapath(flagFigure(), { variant: '2col', widthPt: 515.5, name: 'flags', skin });
  assert.deepEqual(r2.diagnostics.filter((d) => d.code === 'arrow/missing').map((d) => [d.severity, d.subject.id]).sort(), [['error', 'neq'], ['error', 'nflag']]);
});

test('arrow/missing exempts gate inputs inside gate-level regions only', async () => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'datapath-mixed-gates.json'), 'utf8'));
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'gates' });
  assert.equal(r.diagnostics.filter((d) => d.code === 'arrow/missing').length, 0);
  const gateIds = new Set((doc.regions || []).filter((g) => g.level === 'gate').flatMap((g) => g.members));
  const gateOnly = doc.nets.filter((n) => n.sinks.every((s) => gateIds.has(s.split('.')[0]) && doc.elements.find((e) => e.id === s.split('.')[0])?.kind === 'comb' && !doc.elements.find((e) => e.id === s.split('.')[0])?.label));
  assert.ok(gateOnly.length > 0, 'example has nets into gate symbols');
  for (const n of gateOnly) assert.doesNotMatch(r.svg, new RegExp(`id="net-${n.id}-arrow\\d+"`), n.id);
  const others = doc.nets.filter((n) => n.sinks.some((s) => !gateIds.has(s.split('.')[0])) && !n.sinks.some((s) => doc.elements.find((e) => e.id === s.split('.')[0])?.op === 'split'));
  assert.ok(others.some((n) => new RegExp(`id="net-${n.id}-arrow\\d+"`).test(r.svg)));
});

// --- 2. edge hugging ----------------------------------------------------------

test('route/edge-hugging: wires closer than 4 pt to an outline or another wire', () => {
  const rects = [{ id: 'B', x0: 0, y0: 0, x1: 20, y1: 20 }];
  const v = (id, x) => ({ id, polylines: [[{ x, y: -5 }, { x, y: 25 }]] });
  const hits = edgeHugging([v('near', 22), v('w1', 30), v('w2', 32), v('clear', 40)], rects);
  assert.deepEqual(hits.map((h) => [h.net, h.kind, h.other]).sort(), [['near', 'block', 'B'], ['w1', 'wire', 'w2']]);
  assert.equal(edgeHugging([v('ok', 25)], rects).length, 0);
});

test('straightening gives a hugging wire its own channel', () => {
  const nodes = new Map([['S', { x: 0, y: 0, w: 10, h: 10 }], ['B', { x: 43, y: 10, w: 10, h: 20 }], ['D', { x: 60, y: 30, w: 10, h: 10 }]]);
  const edges = [{ id: 'e__0', net: 'e', cls: 'control', src: 'S', dst: 'D', pts: [{ x: 10, y: 5 }, { x: 41.5, y: 5 }, { x: 41.5, y: 35 }, { x: 60, y: 35 }] }];
  const st = straighten({ nodes, edges }, { minOffsetPt: 12 });
  assert.ok(st.before.hug > 0);
  assert.equal(st.after.hug, 0);
  const x = st.edges[0].pts.find((p, i) => i > 0 && Math.abs(p.x - st.edges[0].pts[i - 1].x) < 0.01).x;
  assert.ok(x <= 39, `channel at ${x}`);
});

// --- 3. bend justification ----------------------------------------------------

test('route/data-bend: each remaining bend is justified, or reported as avoidable', () => {
  const edge = (id, net, src, dst, pts) => ({ id, net, cls: 'data', src, dst, pts: pts.map(([x, y]) => ({ x, y })) });
  const free = justifyBends({ nodes: new Map([['S', { x: 0, y: 0, w: 10, h: 10 }], ['D', { x: 50, y: 20, w: 10, h: 10 }]]), edges: [edge('n__0', 'n', 'S', 'D', [[10, 5], [30, 5], [30, 25], [50, 25]])] });
  assert.equal(free[0].avoidable, true);
  const boxed = justifyBends({
    nodes: new Map([['S', { x: 0, y: 0, w: 10, h: 10 }], ['P', { x: 0, y: 22, w: 10, h: 10 }], ['D', { x: 50, y: 20, w: 10, h: 10 }], ['O', { x: 50, y: 0, w: 10, h: 12 }]]),
    edges: [edge('n__0', 'n', 'S', 'D', [[10, 5], [30, 5], [30, 25], [50, 25]])],
  });
  assert.equal(boxed[0].avoidable, false);
  assert.match(boxed[0].reason, /blocked: .*overlaps block O.*overlaps block P/);
  const reasons = justifyBends({
    nodes: new Map([['S', { x: 0, y: 0, w: 10, h: 10 }], ['T', { x: 60, y: 0, w: 10, h: 10 }], ['U', { x: 60, y: 40, w: 10, h: 10 }], ['V', { x: 50, y: 20, w: 10, h: 10 }]]),
    edges: [
      edge('f__0', 'f', 'S', 'T', [[10, 5], [60, 5]]),
      edge('f__1', 'f', 'S', 'U', [[10, 5], [40, 5], [40, 45], [60, 45]]),
      edge('t__0', 't', 'S', 'V', [[10, 8], [55, 8], [55, 20]]),
      edge('b__0', 'b', 'T', 'S', [[70, 5], [75, 5], [75, -10], [-5, -10], [-5, 5], [0, 5]]),
    ],
  });
  const why = Object.fromEntries(reasons.map((b) => [b.edge, b.reason]));
  assert.match(why.f__1, /fan-out branch to another row/);
  assert.equal(why.t__0, 'turn into a pin on a top or bottom edge');
  assert.equal(why.b__0, 'feedback');
});

function passUnderFigure() {
  const block = { id: 'ev', kind: 'comb', op: 'custom', width: 8, pin_labels: false, function: { kind: 'gf_poly_eval' }, ports: [{ id: 'i', dir: 'in', width: 48 }, { id: 's', dir: 'out', width: 8 }, { id: 't', dir: 'out', width: 8 }] };
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'pass under', print: { profile: 'ieee' } },
    clock_domains: [{ id: 'sys', clock: 'clk', reset: { net: 'rst_n', active: 'low', async: true } }],
    elements: [
      { id: 'cw', kind: 'port', dir: 'in', width: 48, label: 'word' },
      block,
      // the passing lane is authored first; the plan moves it below the block's lanes
      { id: 'p1', kind: 'pipeline_register', domain: 'sys', stage: 1, lanes: [{ id: 'w', width: 48 }, { id: 's', width: 8 }, { id: 't', width: 8 }] },
      { id: 'wo', kind: 'port', dir: 'out', width: 48, label: 'word out' },
      { id: 'so', kind: 'port', dir: 'out', width: 8, label: 'first value' },
      { id: 'to', kind: 'port', dir: 'out', width: 8, label: 'second value' },
    ],
    nets: [
      { id: 'n_cw', width: 48, driver: 'cw', sinks: ['ev.i', 'p1.d_w'] },
      { id: 'n_s', width: 8, driver: 'ev.s', sinks: ['p1.d_s'] },
      { id: 'n_t', width: 8, driver: 'ev.t', sinks: ['p1.d_t'] },
      { id: 'n_wo', width: 48, driver: 'p1.q_w', sinks: ['wo'] },
      { id: 'n_so', width: 8, driver: 'p1.q_s', sinks: ['so'] },
      { id: 'n_to', width: 8, driver: 'p1.q_t', sinks: ['to'] },
    ],
  };
}

test('pin re-assignment: a trunk continuing past a block passes under it on its own lane', async () => {
  const doc = passUnderFigure();
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const model = buildModel(doc);
  const part = new Map([['cw', 0], ['ev', 0], ['p1', 1], ['wo', 2], ['so', 2], ['to', 2]]);
  const plan = tapPlan(model, part);
  assert.deepEqual([...plan.taps], ['ev.i']);
  assert.deepEqual(plan.lanes.get('p1'), [{ lane: 'w', block: 'ev', attach: [{ lane: 's', pin: 's' }, { lane: 't', pin: 't' }] }]);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'under' });
  assert.deepEqual(errors(r.diagnostics), []);
  assert.equal(r.route.layout_plans.find((p) => p.chosen).plan, 'taps');
  // the trunk into the register is straight; the only bend is the branch rising into the tap
  const bends = Object.fromEntries(r.route.data_bends.map((b) => [b.wire, b.justification]));
  assert.equal(bends.n_cw__1, undefined);
  assert.equal(bends.n_cw__0, 'turn into a pin on a top or bottom edge');
  assert.ok(r.route.data_bends.every((b) => b.justification));
  assert.equal(r.route.edge_hugging, 0);
});

// --- 4. abbreviations ---------------------------------------------------------

test('label/unreadable flags abbreviated words with periods; vocabulary names are written out', () => {
  for (const bad of ['Pos. match', 'Syndrome calc.', 'Ctrl. logic', 'Const. mul']) assert.match(unreadableReason(bad) || '', /abbreviated word/, bad);
  for (const good of ['Position match', 'Syndrome calculator (stage 1/2)', 'e.g. value', 'GF(2^8) adder (XOR)']) assert.doesNotMatch(unreadableReason(good) || '', /abbreviated/, good);
  for (const [kind, entry] of Object.entries(VOCABULARY.kinds)) {
    for (const name of [entry.display, entry.short, entry.stage_display, entry.qualified?.replace('{q}', 'GF(2^8)')].filter(Boolean)) {
      assert.doesNotMatch(unreadableReason(name) || '', /abbreviated/, `${kind}: ${name}`);
    }
  }
  const doc = { elements: [{ id: 'pm', kind: 'comb', op: 'custom', function: { kind: 'position_match' }, short_label: 'Pos. match' }], nets: [] };
  assert.deepEqual(checkLabels(doc, 'datapath').map((d) => [d.code, d.subject.field]), [['label/unreadable', 'short_label']]);
});
