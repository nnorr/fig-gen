// Style tweaks: one stroke weight for every net (net/stroke-uniform), junction
// dots clear of arrowheads and pins (route/dot-near-arrow), and words on
// bus-operation boxes (concat, repl ×N, sext/zext).

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSkin } from '../lib/checks/skin.mjs';
import { connectivityChecks } from '../lib/render/connectivity.mjs';
import { loadSkin, renderDatapath, spreadJunctions } from '../lib/render/datapath.mjs';
import { validateSchema } from '../lib/validate.mjs';

const errors = (diags) => diags.filter((d) => d.severity === 'error');

// 8-bit buses, a 1-bit flag and a dashed select; the mux output fans out.
function mixedWidths() {
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'widths', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'value A' },
      { id: 'b', kind: 'port', dir: 'in', width: 8, label: 'value B' },
      { id: 's', kind: 'port', dir: 'in', width: 1, class: 'control', label: 'select' },
      { id: 'm', kind: 'mux', inputs: 2, width: 8 },
      { id: 'z', kind: 'comb', op: 'custom', width: 1, function: { kind: 'custom', name: 'Zero detector' }, ports: [{ id: 'i', dir: 'in', width: 8 }, { id: 'y', dir: 'out', width: 1 }] },
      { id: 'q', kind: 'port', dir: 'out', width: 8, label: 'result' },
      { id: 'f', kind: 'port', dir: 'out', width: 1, label: 'is zero' },
    ],
    nets: [
      { id: 'na', width: 8, driver: 'a', sinks: ['m.in0'] },
      { id: 'nb', width: 8, driver: 'b', sinks: ['m.in1'] },
      { id: 'ns', width: 1, class: 'control', driver: 's', sinks: ['m.sel'] },
      { id: 'nm', width: 8, driver: 'm.out', sinks: ['q', 'z.i'] },
      { id: 'nz', width: 1, driver: 'z.y', sinks: ['f'] },
    ],
  };
}

test('net/stroke-uniform: buses, 1-bit wires and dashed control share one stroke; width is only in the label', async () => {
  const doc = mixedWidths();
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'widths' });
  assert.deepEqual(errors(r.diagnostics), []);
  const widths = new Set([...r.svg.matchAll(/id="net-[^"]+-seg\d+"[^>]*stroke-width="([\d.]+)"/g)].map((m) => m[1]));
  const wire = String(loadSkin().tokens.stroke.wire);
  assert.deepEqual([...widths], [wire]);
  assert.match(r.svg, new RegExp(`id="net-ns-seg0"[^>]*stroke-width="${wire}"[^>]*stroke-dasharray`), 'control is dashed at the same weight');
  assert.match(r.svg, /id="net-na-width"[^>]*>8</, 'a bus shows its width by its slash-N label');
  assert.equal(r.route.connectivity.stroke_nonuniform, 0);
  assert.ok(r.route.connectivity.strokes_checked >= 5);

  const heavy = r.svg.replace(new RegExp(`(id="net-nm-seg0"[^>]*stroke-width=")${wire}"`), `$1${Number(wire) * 2}"`);
  const d = connectivityChecks(heavy, { anchors: r.geometry.anchors, wireStroke: Number(wire) }).diagnostics.filter((x) => x.code === 'net/stroke-uniform');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'error');

  const skin = loadSkin();
  assert.ok(!checkSkin(skin).some((x) => x.code === 'net/stroke-uniform'));
  skin.tokens.stroke.bus = skin.tokens.stroke.wire * 2;
  assert.ok(checkSkin(skin).some((x) => x.code === 'net/stroke-uniform'), 'a heavier bus token is rejected');
});

// Two branches of net n from (0,10): one straight to (30,10), one turning down at x = turn.
const dotSvg = (turn) => `<svg xmlns="http://www.w3.org/2000/svg" width="40pt" height="50pt" viewBox="0 0 40 50"><g id="nets"><g id="nets-data"><g id="net-n">
<path id="net-n-seg0" d="M0 10 L25.5 10" fill="none" stroke="#000000" stroke-width="0.6" stroke-linejoin="miter"/>
<path id="net-n-seg1" d="M0 10 L${turn} 10 L${turn} 40 L25.5 40" fill="none" stroke="#000000" stroke-width="0.6" stroke-linejoin="miter"/>
<path id="net-n-arrow0" d="M25.5 8.4 L30 10 L25.5 11.6 Z" fill="#000000" stroke="none"/>
<path id="net-n-arrow1" d="M25.5 38.4 L30 40 L25.5 41.6 Z" fill="#000000" stroke="none"/>
<circle id="net-n-dot0" cx="${turn}" cy="10" r="1.2" fill="#000000" stroke="none"/>
</g></g></g></svg>`;

test('route/dot-near-arrow: a junction dot within 8 pt of an arrowhead base is an error on the final SVG', () => {
  const near = connectivityChecks(dotSvg(20), { dotArrowClearance: 8 });
  const hits = near.diagnostics.filter((d) => d.code === 'route/dot-near-arrow');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].subject.id, 'n');
  assert.match(hits[0].message, /arrowhead base/);
  assert.equal(near.counts.dot_near_arrow, 1);
  const clear = connectivityChecks(dotSvg(12), { dotArrowClearance: 8 });
  assert.deepEqual(clear.diagnostics.filter((d) => d.code === 'route/dot-near-arrow'), []);
  assert.equal(clear.counts.dots_checked, 1);
});

test('the renderer moves a crowded branch point upstream along the trunk, unless that enters a block', () => {
  const make = () => new Map([['n__0', [{ x: 0, y: 10 }, { x: 30, y: 10 }]], ['n__1', [{ x: 0, y: 10 }, { x: 26, y: 10 }, { x: 26, y: 40 }, { x: 60, y: 40 }]]]);
  const edges = [{ id: 'n__0', net: 'n' }, { id: 'n__1', net: 'n' }];
  const pts = make();
  assert.equal(spreadJunctions(pts, edges, { clearance: 8, arrowLen: 4.5 }), 1);
  assert.deepEqual(pts.get('n__1').map((p) => p.x), [0, 17.5, 17.5, 60], 'smallest upstream move that clears the arrowhead base at x = 25.5');
  const blocked = make();
  assert.equal(spreadJunctions(blocked, edges, { clearance: 8, arrowLen: 4.5, rects: [{ x0: 0, y0: 20, x1: 20, y1: 45 }] }), 0);
  assert.deepEqual(blocked.get('n__1').map((p) => p.x), [0, 26, 26, 60], 'left in place (and reported) when every move enters a block');
});

test('a dot on a riser whose branch enters a pin on the same row moves with the whole riser', () => {
  // trunk r__2 runs on at y = 42; a riser at x = 30 carries r__0 into a pin at (31, 64) and r__1 on down
  const pts = new Map([
    ['r__0', [{ x: 0, y: 42 }, { x: 30, y: 42 }, { x: 30, y: 64 }, { x: 31, y: 64 }]],
    ['r__1', [{ x: 0, y: 42 }, { x: 30, y: 42 }, { x: 30, y: 134 }, { x: 80, y: 134 }]],
    ['r__2', [{ x: 0, y: 42 }, { x: 90, y: 42 }]],
  ]);
  const edges = ['r__0', 'r__1', 'r__2'].map((id) => ({ id, net: 'r' }));
  assert.ok(spreadJunctions(pts, edges, { clearance: 8, arrowLen: 4.5 }) >= 1);
  assert.deepEqual(pts.get('r__0').map((p) => p.x), [0, 18.5, 18.5, 31], 'the riser moves 8 pt clear of the arrowhead base at x = 26.5');
  assert.deepEqual(pts.get('r__1').map((p) => p.x), [0, 18.5, 18.5, 80]);
});

test('bus-operation boxes are named by words: concat, repl ×N, sext; braces are rejected by the glyph lint', async () => {
  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'words', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'field A' },
      { id: 'b', kind: 'port', dir: 'in', width: 8, label: 'field B' },
      { id: 'en', kind: 'port', dir: 'in', width: 1, label: 'enable' },
      { id: 'cat', kind: 'comb', op: 'concat', width: 16, in_widths: [8, 8] },
      { id: 'ext', kind: 'comb', op: 'extend', extend: 'sign', width: 8, out_width: 16 },
      { id: 'rep', kind: 'comb', op: 'replicate', width: 1, count: 4 },
      { id: 'lo', kind: 'port', dir: 'out', width: 16, label: 'joined' },
      { id: 'wide', kind: 'port', dir: 'out', width: 16, label: 'widened' },
      { id: 'mask', kind: 'port', dir: 'out', width: 4, label: 'mask' },
    ],
    nets: [
      { id: 'na', width: 8, driver: 'a', sinks: ['cat.in0', 'ext.in0'] },
      { id: 'nb', width: 8, driver: 'b', sinks: ['cat.in1'] },
      { id: 'nc', width: 16, driver: 'cat.out', sinks: ['lo'] },
      { id: 'ne', width: 16, driver: 'ext.out', sinks: ['wide'] },
      { id: 'nr', width: 1, driver: 'en', sinks: ['rep.in0'] },
      { id: 'nq', width: 4, driver: 'rep.out', sinks: ['mask'] },
    ],
  };
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'words' });
  assert.deepEqual(errors(r.diagnostics), []);
  assert.match(r.svg, /<rect id="concat-cat-body"[^>]*fill="#FFFFFF"[^>]*stroke="#000000"/, 'still a hollow outlined box');
  assert.match(r.svg, /id="concat-cat-title"[^>]*>concat</);
  assert.match(r.svg, /id="replicate-rep-title"[^>]*>repl ×4</);
  assert.match(r.svg, /id="extend-ext-title"[^>]*>sext</);
  assert.doesNotMatch(r.svg, />\[\d+:\d+\]</, 'the concat box prints the word only: no destination bit ranges');
  assert.doesNotMatch(r.svg, />[^<]*[{}][^<]*</, 'no braces in any text');

  const skin = loadSkin();
  assert.ok(!checkSkin(skin).some((d) => d.code === 'glyph/distinguishable'));
  for (const mutate of [(s) => { s.symbols.join.label = '{ }'; }, (s) => { s.symbols.replicate.label = '{N{ }}'; }, (s) => { s.symbols.extend.labels.sign = 'SE'; }]) {
    const bad = loadSkin();
    mutate(bad);
    assert.ok(checkSkin(bad).some((d) => d.code === 'glyph/distinguishable'));
  }
});
