// Pre-phase-3 review rules: long feedback as named off-page connectors
// (route/long-feedback), wires clear of region frames (region/wire-hugs-frame),
// named heterogeneous bundles without summed widths (width/bundle-sum), stage
// notes that name each path, figure outputs on the right edge, width labels
// clear of outlines, and gate-input steps moved back to the junction.

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDatapath } from '../lib/checks/datapath.mjs';
import { connectivityChecks } from '../lib/render/connectivity.mjs';
import { alignGateSteps, laneCarried, partitions, pushFramesOffWires, renderDatapath } from '../lib/render/datapath.mjs';
import { frameHugChecks, geometryChecks } from '../lib/render/geometry.mjs';
import { LabelPlacer } from '../lib/render/labels.mjs';
import { el } from '../lib/svg.mjs';
import { validateSchema } from '../lib/validate.mjs';

const errors = (diags) => diags.filter((d) => d.severity === 'error');
const block = (id, name, ins, outs) => ({
  id, kind: 'comb', op: 'custom', width: 8, pin_labels: false, function: { kind: 'custom', name },
  ports: [...ins.map(([pid, w, extra = {}]) => ({ id: pid, dir: 'in', width: w, ...extra })), ...outs.map(([pid, w, extra = {}]) => ({ id: pid, dir: 'out', width: w, ...extra }))],
});

// A controller at the far left whose status comes back from the end of a long chain.
function feedbackFigure(style = {}) {
  const chain = ['Stage one', 'Stage two', 'Stage three', 'Stage four', 'Stage five'];
  const elements = [
    { id: 'din', kind: 'port', dir: 'in', width: 8, label: 'data in' },
    block('ctl', 'Controller', [['d', 8], ['st', 1]], [['q', 8]]),
    ...chain.map((name, i) => block(`b${i}`, name, [['i', 8]], i === chain.length - 1 ? [['o', 8], ['s', 1]] : [['o', 8]])),
    { id: 'dout', kind: 'port', dir: 'out', width: 8, label: 'data out' },
  ];
  const nets = [
    { id: 'n_in', width: 8, driver: 'din', sinks: ['ctl.d'] },
    { id: 'n_c', width: 8, driver: 'ctl.q', sinks: ['b0.i'] },
    ...chain.slice(1).map((_, i) => ({ id: `n_${i}`, width: 8, driver: `b${i}.o`, sinks: [`b${i + 1}.i`] })),
    { id: 'n_out', width: 8, driver: `b${chain.length - 1}.o`, sinks: ['dout'] },
    { id: 'n_status', width: 1, label: 'stage status', driver: `b${chain.length - 1}.s`, sinks: ['ctl.st'] },
  ];
  return { schema_version: 1, figure_type: 'datapath', meta: { title: 'feedback', print: { profile: 'ieee' }, ...(Object.keys(style).length ? { style } : {}) }, clock_domains: [], elements, nets };
}

test('route/long-feedback: a long return net is drawn as a pair of named connectors, which count as connected', async () => {
  const doc = feedbackFigure();
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'fb' });
  assert.deepEqual(r.diagnostics.filter((d) => /^(route\/long-feedback|wire|symbol)\//.test(d.code)), []);
  assert.deepEqual(r.route.connectors.map((c) => c.net), ['n_status']);
  // source tag after the driver, target tag before the sink, both named
  assert.match(r.svg, /id="port-cx_n_status-body"/);
  assert.match(r.svg, /id="port-cx_n_status_to0-body"/);
  assert.equal((r.svg.match(/>stage status</g) || []).length, 2);
  assert.deepEqual(connectivityChecks(r.svg, { anchors: r.geometry.anchors }).diagnostics, []);

  const loops = await renderDatapath(feedbackFigure({ connectors: false }), { variant: '2col', widthPt: 515.5, name: 'fb' });
  const d = loops.diagnostics.filter((x) => x.code === 'route/long-feedback');
  assert.equal(d.length, 1);
  assert.equal(d[0].subject.id, 'n_status');
});

test('region/wire-hugs-frame: a wire along a frame closer than the gap, more for a dashed wire', () => {
  const frames = [{ id: 'r', x0: 0, y0: 0, x1: 100, y1: 50 }];
  const seg = (id, y, dashed = false) => ({ id, a: { x: 10, y }, b: { x: 90, y }, hw: 0.3, dashed });
  assert.deepEqual(frameHugChecks(frames, [seg('far', 60)]), []);
  assert.equal(frameHugChecks(frames, [seg('near', 54)])[0].code, 'region/wire-hugs-frame');
  assert.deepEqual(frameHugChecks(frames, [seg('solid', 57)]), [], 'a solid wire 7 pt away is clear');
  assert.equal(frameHugChecks(frames, [seg('dashed', 57, true)]).length, 1, 'a dashed wire needs 9 pt beside a dashed frame');
  const crossing = { id: 'x', a: { x: 50, y: 40 }, b: { x: 50, y: 70 }, hw: 0.3 };
  assert.deepEqual(frameHugChecks(frames, [crossing]), [], 'crossing a frame is fine');
});

test('width/bundle-sum: a heterogeneous bundle is named and drawn without a summed width', async () => {
  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'bundle', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'bus', kind: 'port', dir: 'in', width: 13 },
      block('slave', 'Bus slave logic', [['b', 13]], [['q', 8]]),
      { id: 'q', kind: 'port', dir: 'out', width: 8, label: 'read data' },
    ],
    nets: [
      { id: 'n_bus', width: 13, driver: 'bus', sinks: ['slave.b'], bundle_of: ['sel', 'write', 'addr', 'wdata'] },
      { id: 'n_q', width: 8, driver: 'slave.q', sinks: ['q'] },
    ],
  };
  assert.deepEqual(await validateSchema('datapath', doc), []);
  assert.ok(checkDatapath(doc).diagnostics.some((d) => d.code === 'width/bundle-sum'));
  doc.nets[0].label = 'AHB-Lite';
  assert.ok(!checkDatapath(doc).diagnostics.some((d) => d.code === 'width/bundle-sum'));
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'bundle' });
  assert.deepEqual(errors(r.diagnostics), []);
  assert.doesNotMatch(r.svg, /id="net-n_bus-width"/);
  assert.match(r.svg, /id="net-n_bus-name"[^>]*>AHB-Lite</);
  assert.match(r.svg, /id="net-n_q-width"/, 'a homogeneous bus keeps its width');
});

test('stage notes group registered outputs by latency when their latencies differ', async () => {
  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'notes', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'value in' },
      block('st', 'Status logic', [['i', 8]], [['rd', 8, { registered: true, label: 'read' }], ['irq', 1, { registered: true, latency: 2, label: 'IRQ' }]]),
      { id: 'o1', kind: 'port', dir: 'out', width: 8, label: 'read data' },
      { id: 'o2', kind: 'port', dir: 'out', width: 1, label: 'interrupt' },
    ],
    nets: [{ id: 'n_a', width: 8, driver: 'a', sinks: ['st.i'] }, { id: 'n_r', width: 8, driver: 'st.rd', sinks: ['o1'] }, { id: 'n_i', width: 1, driver: 'st.irq', sinks: ['o2'] }],
  };
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'notes' });
  assert.deepEqual(errors(r.diagnostics), []);
  assert.match(r.svg, />1 stage: read</);
  assert.match(r.svg, />2 stages: IRQ</);
  assert.doesNotMatch(r.svg, />2 stages</);
});

test('figure outputs sit on the last layer, connectors beside their element', () => {
  const doc = {
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 1 }, { id: 'p', kind: 'pipeline_register', stage: 1, lanes: [{ id: 'v', width: 1 }] },
      { id: 'early', kind: 'port', dir: 'out', width: 1 }, { id: 'x', kind: 'comb', op: 'xor', width: 1 }, { id: 'late', kind: 'port', dir: 'out', width: 1 },
    ],
    nets: [{ id: 'n1', driver: 'a', sinks: ['p.d_v', 'x.in0'] }, { id: 'n2', driver: 'p.q_v', sinks: ['early', 'x.in1'] }, { id: 'n3', driver: 'x.out', sinks: ['late'] }],
  };
  const part = partitions(doc);
  assert.equal(part.get('early'), part.get('late'));
  assert.ok(part.get('early') > part.get('x'));
});

test('width labels keep 1 pt from outlines other than their own slash', () => {
  const font = { measure: (s, size) => s.length * size * 0.55, ascent: 0.72, descent: 0.21, missing: () => [] };
  const tree = el('svg', {}, [
    el('rect', { id: 'preg-p-body', x: 10, y: 0, width: 7, height: 40, fill: '#BFBFBF', stroke: '#000000', 'stroke-width': 0.8 }),
    el('text', { id: 'net-n-width', x: 17.6, y: 20, 'font-size': 7 }, ['48']),
  ]);
  assert.ok(geometryChecks(tree, { font }).some((d) => d.code === 'geometry/text-on-line' && d.subject.label === 'net-n-width'));
  const clear = el('svg', {}, [tree.children[0], el('text', { id: 'net-n-width', x: 19.5, y: 20, 'font-size': 7 }, ['48'])]);
  assert.ok(!geometryChecks(clear, { font }).some((d) => d.code === 'geometry/text-on-line'));
});

test('gate-input steps start at the junction dot, not just before the pin', async () => {
  // two flags fan out to a NAND and a 4-input AND with bubbles (classifier shape)
  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'steps', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'az', kind: 'port', dir: 'in', width: 1, label: 'A is zero' }, { id: 'bz', kind: 'port', dir: 'in', width: 1, label: 'B is zero' }, { id: 'h', kind: 'port', dir: 'in', width: 1, label: 'hit' },
      { id: 'g1', kind: 'comb', op: 'nand', width: 1, inputs: 2 }, { id: 'g2', kind: 'comb', op: 'and', width: 1, inputs: 3, invert_inputs: [0, 1] },
      { id: 'o1', kind: 'port', dir: 'out', width: 1, label: 'detected' }, { id: 'o2', kind: 'port', dir: 'out', width: 1, label: 'corrected' },
    ],
    nets: [
      { id: 'na', width: 1, driver: 'az', sinks: ['g1.in0', 'g2.in0'] }, { id: 'nb', width: 1, driver: 'bz', sinks: ['g1.in1', 'g2.in1'] }, { id: 'nh', width: 1, driver: 'h', sinks: ['g2.in2'] },
      { id: 'n1', width: 1, driver: 'g1.out', sinks: ['o1'] }, { id: 'n2', width: 1, driver: 'g2.out', sinks: ['o2'] },
    ],
    regions: [{ id: 'cls', label: 'gates', level: 'gate', members: ['g1', 'g2'] }],
  };
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'steps' });
  assert.deepEqual(r.diagnostics.filter((d) => /^(wire|symbol)\//.test(d.code)), []);
  for (const id of ['na', 'nb']) {
    const branches = [...r.svg.matchAll(new RegExp(`id="net-${id}-seg\\d+" d="([^"]+)"`, 'g'))].map((m) => [...m[1].matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((q) => ({ x: Number(q[1]), y: Number(q[2]) })));
    for (const pts of branches) {
      const L = pts.length;
      if (L < 4) continue;
      const [b, c, d] = [pts[L - 3], pts[L - 2], pts[L - 1]];
      const step = Math.abs(b.y - c.y);
      if (Math.abs(b.x - c.x) < 0.01 && step > 0 && step < 12) assert.ok(d.x - c.x > 10, `${id}: a ${step} pt step ${d.x - c.x} pt before the pin`);
    }
  }
});

test('a step just before a port or connector pin moves back to the run start', () => {
  const edgePts = new Map([['n__0', [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 5 }, { x: 45, y: 5 }]]]);
  const moved = alignGateSteps(edgePts, [{ id: 'n__0', net: 'n' }], { fine: () => true });
  assert.equal(moved, 1);
  assert.deepEqual(edgePts.get('n__0').map((p) => p.x), [0, 4, 4, 45]);
});

test('frame push-off never grows a frame over a foreign block; it moves the edge inward instead', () => {
  const wire = [{ a: { x: 20, y: 63 }, b: { x: 90, y: 63 }, horizontal: true, dashed: false }];
  const member = { id: 'm', x0: 20, y0: 20, x1: 60, y1: 50 };
  const foreign = { id: 'f', x0: 20, y0: 66, x1: 60, y1: 80 };
  const opts = (rects) => ({ nodeRects: rects, membersOf: () => ['m'], W: 200, H: 200, frameGap: 6 });
  const free = pushFramesOffWires([{ id: 'r', x0: 10, y0: 10, x1: 100, y1: 60 }], wire, opts([member]));
  assert.equal(free[0].y1, 69.5, 'outward past the wire when nothing is below');
  const blocked = pushFramesOffWires([{ id: 'r', x0: 10, y0: 10, x1: 100, y1: 60 }], wire, opts([member, foreign]));
  assert.equal(blocked[0].y1, 56.5, 'inward when outward would cover a foreign block');
  const stuck = pushFramesOffWires([{ id: 'r', x0: 10, y0: 10, x1: 100, y1: 60 }], wire, opts([{ ...member, y1: 58 }, foreign]));
  assert.equal(stuck[0].y1, 60, 'stays (and is reported) when neither direction is valid');
});

test('a width slash never covers a label already placed', () => {
  const font = { measure: (s, size) => s.length * size * 0.55, ascent: 0.72, descent: 0.21 };
  const placer = new LabelPlacer(font);
  placer.addPolyline([{ x: 0, y: 20 }, { x: 100, y: 20 }]);
  assert.ok(placer.place('8', 7, [{ x: 40, y: 17 }]));
  assert.ok(placer.hitsText({ x0: 40, y0: 13, x1: 44, y1: 17 }), 'a slash on the placed number');
  assert.ok(!placer.hitsText({ x0: 0, y0: 19, x1: 4, y1: 21 }), 'wires are not text');
});

test('width/missing: a width carried through a pipeline lane is labeled once, on either side', () => {
  const reg = { id: 'p', kind: 'pipeline_register' };
  const nets = [
    { net: { id: 'in' }, width: 48, driver: { element: { id: 'b', kind: 'comb' }, pin: { id: 'o' } }, sinks: [{ element: reg, pin: { id: 'd_s' } }] },
    { net: { id: 'out' }, width: 48, driver: { element: reg, pin: { id: 'q_s' } }, sinks: [{ element: { id: 'c', kind: 'comb' }, pin: { id: 'i' } }] },
  ];
  assert.ok(laneCarried(nets, 'in', new Set(['out'])));
  assert.ok(laneCarried(nets, 'out', new Set(['in'])));
  assert.ok(!laneCarried(nets, 'in', new Set()), 'neither side labeled');
  nets[1].width = 32;
  assert.ok(!laneCarried(nets, 'in', new Set(['out'])), 'a width change across the lane needs its own label');
});
