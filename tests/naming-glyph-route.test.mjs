// Addenda Q (functional block names), R (frames, crossings, text on lines),
// S (straight data trunks) and T (distinguishable bus-operation glyphs).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkLabels, functionNames, unreadableReason, VOCABULARY } from '../lib/checks/labels.mjs';
import { renderDatapath } from '../lib/render/datapath.mjs';
import { crossingCounts, dataJogs, textLineCollisions } from '../lib/render/route-metrics.mjs';
import { straighten } from '../lib/render/straighten.mjs';
import { boundaryDiagnostics } from '../lib/rtl/crosscheck.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = (diags) => diags.filter((d) => d.severity === 'error');

// --- Q: naming --------------------------------------------------------------

test('the schema function enum and the vocabulary file list the same kinds', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'datapath.schema.json'), 'utf8'));
  assert.deepEqual([...schema.$defs.function.properties.kind.enum].sort(), Object.keys(VOCABULARY.kinds).sort());
});

test('mnemonics, RTL names and math shorthand are unreadable; functional names are not', () => {
  for (const bad of ['cls', 'en', 'e_i', 'H4..2', 'h1..0', 'S2/S1', 'S1/a^i', 'X=a^i', '== 0', 'dec_data_i', 'valid_o']) assert.ok(unreadableReason(bad), bad);
  for (const good of ['Error classifier', 'Chien search', 'Locator', 'GF mul', 'corrected data', 'ECC', 'MUX', '⊕', 'S0|S1', 'AHB-Lite slave']) assert.equal(unreadableReason(good), null, good);
});

test('printed names default to the vocabulary, qualified and with readable short words', () => {
  assert.deepEqual(functionNames({ kind: 'gf_mul', qualifier: 'GF(2^8)' }), { display: 'GF(2^8) multiplier', short: 'GF mul', glyph: 'otimes', detail: undefined });
  assert.equal(functionNames({ kind: 'memory', qualifier: 'Data' }).short, 'Data memory');
  assert.equal(functionNames({ kind: 'error_locator', detail: 'X = S2/S1' }).display, 'Error locator');
  assert.equal(functionNames({ kind: 'custom', name: 'Montgomery reducer' }).display, 'Montgomery reducer');
});

test('label/unreadable is a warning by default and an error under --quality paper', async () => {
  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 't', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'din', kind: 'port', dir: 'in', width: 8, label: 'data in' },
      { id: 'cls', kind: 'comb', op: 'custom', width: 1, label: 'cls', function: { kind: 'classifier' }, ports: [{ id: 'a', dir: 'in', width: 8 }, { id: 'y', dir: 'out', width: 1 }] },
      { id: 'flag_o', kind: 'port', dir: 'out', width: 1 },
    ],
    nets: [{ id: 'n0', width: 8, driver: 'din', sinks: ['cls.a'] }, { id: 'n1', width: 1, driver: 'cls.y', sinks: ['flag_o'] }],
  };
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const warn = checkLabels(doc, 'datapath');
  assert.deepEqual(warn.map((d) => [d.code, d.severity, d.subject.id]).sort(), [['label/unreadable', 'warning', 'cls'], ['label/unreadable', 'warning', 'flag_o']]);
  assert.match(warn.find((d) => d.subject.id === 'cls').supportedFixes[0], /Error classifier/);
  assert.ok(checkLabels(doc, 'datapath', { quality: 'paper' }).every((d) => d.severity === 'error'));
  const missing = structuredClone(doc);
  delete missing.elements[1].function;
  assert.ok((await validateSchema('datapath', missing)).some((d) => /function/.test(d.message)), 'custom blocks require a function');
});

test('net and port names may not start with the reserved [ or { (D3)', () => {
  const doc = { elements: [{ id: 'p', kind: 'port', dir: 'in', width: 1, label: '[7:0] bus' }], nets: [{ id: 'n', label: '{a,b}', width: 1, driver: 'p', sinks: [] }] };
  assert.equal(checkLabels(doc, 'datapath').filter((d) => d.code === 'label/reserved-prefix').length, 2);
});

// --- T: glyphs --------------------------------------------------------------

function glyphFigure() {
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'glyphs', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'field A' },
      { id: 'b', kind: 'port', dir: 'in', width: 8, label: 'field B' },
      { id: 'sel', kind: 'port', dir: 'in', width: 1, class: 'control', label: 'select' },
      { id: 'cat', kind: 'comb', op: 'concat', width: 16, in_widths: [8, 8] },
      { id: 'sp', kind: 'comb', op: 'split', width: 16, slices: ['15:8', '7:0'] },
      { id: 'ext', kind: 'comb', op: 'extend', extend: 'sign', width: 8, out_width: 16 },
      { id: 'x', kind: 'comb', op: 'xor', width: 16, function: { kind: 'gf_add' } },
      { id: 'm', kind: 'mux', inputs: 2, width: 8 },
      { id: 'hi', kind: 'port', dir: 'out', width: 8, label: 'high byte' },
      { id: 'lo', kind: 'port', dir: 'out', width: 16, label: 'result' },
    ],
    nets: [
      { id: 'na', width: 8, driver: 'a', sinks: ['cat.in0', 'ext.in0'] },
      { id: 'nb', width: 8, driver: 'b', sinks: ['cat.in1'] },
      { id: 'nc', width: 16, driver: 'cat.out', sinks: ['sp.in0', 'x.in0'] },
      { id: 'ne', width: 16, driver: 'ext.out', sinks: ['x.in1'] },
      { id: 'nh', width: 8, driver: 'sp.out0', sinks: ['m.in0'] },
      { id: 'nl', width: 8, driver: 'sp.out1', sinks: ['m.in1'] },
      { id: 'ns', width: 1, class: 'control', driver: 'sel', sinks: ['m.sel'] },
      { id: 'nm', width: 8, driver: 'm.out', sinks: ['hi'] },
      { id: 'nx', width: 16, driver: 'x.out', sinks: ['lo'] },
    ],
  };
}

test('concat is a hollow box with the word concat, split is ripper taps, extension a sext box, XOR a ⊕ circle; only the mux is a solid bar', async () => {
  const doc = glyphFigure();
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'glyphs' });
  assert.deepEqual(errors(r.diagnostics), []);
  assert.deepEqual(lintFigmaSafe(r.svg), []);
  assert.match(r.svg, /<rect id="concat-cat-body"[^>]*fill="#FFFFFF"[^>]*stroke="#000000"/);
  assert.match(r.svg, /id="concat-cat-title"[^>]*>concat</);
  assert.doesNotMatch(r.svg, />\{ \}</, 'no Verilog braces on a bus-operation box');
  assert.match(r.svg, />\[15:8\]</);
  assert.match(r.svg, />\[7:0\]</);
  assert.match(r.svg, /id="split-sp-tap0-stub"/);
  assert.doesNotMatch(r.svg, /id="split-sp-body"/, 'a split has no body');
  assert.match(r.svg, /id="extend-ext-title"[^>]*>sext</);
  assert.match(r.svg, /<circle id="xor-x-body"/);
  const solidBars = [...r.svg.matchAll(/<rect id="([^"]+)"[^>]*fill="#000000"[^>]*stroke="none"/g)].map((m) => m[1]);
  assert.deepEqual(solidBars, ['mux-m-body']);
});

test('a single slice is a label on the wire (truncation), not a symbol', async () => {
  const doc = glyphFigure();
  doc.elements.find((e) => e.id === 'sp').slices = ['15:8'];
  doc.nets = doc.nets.filter((n) => n.id !== 'nl');
  doc.elements.find((e) => e.id === 'm').inputs = 2;
  doc.nets.find((n) => n.id === 'nh').sinks = ['m.in0', 'm.in1'];
  // the split's input feeds only the split, so it collapses to a wire label
  doc.nets.find((n) => n.id === 'nc').sinks = ['sp.in0'];
  doc.nets.find((n) => n.id === 'ne').sinks = ['x.in0', 'x.in1'];
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'trunc' });
  assert.deepEqual(errors(r.diagnostics), []);
  assert.doesNotMatch(r.svg, /id="split-sp/);
  assert.match(r.svg, /id="net-nh-slice"[^>]*>\[15:8\]</);
  // a truncation changes the width, so the new width is always labeled after the slice
  assert.match(r.svg, /id="net-nh-width"[^>]*>8</);
});

test('a solid narrow bar without a select pin is rejected (D1)', async () => {
  const doc = glyphFigure();
  doc.nets = doc.nets.filter((n) => n.id !== 'ns');
  doc.elements = doc.elements.filter((e) => e.id !== 'sel');
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'nosel' });
  assert.ok(r.diagnostics.some((d) => d.code === 'glyph/distinguishable'));
  assert.ok(r.diagnostics.some((d) => d.code === 'symbol/mux-sel-missing'));
});

// --- R/S: routing metrics, straightening, frames ------------------------------

test('route metrics: crossings per class, redundant jogs vs unavoidable bends, text on lines', () => {
  const nets = [
    { id: 'd1', cls: 'data', polylines: [[{ x: 0, y: 10 }, { x: 100, y: 10 }]] },
    { id: 'c1', cls: 'control', polylines: [[{ x: 50, y: 0 }, { x: 50, y: 30 }]] },
    { id: 'd2', cls: 'data', polylines: [[{ x: 0, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 26 }, { x: 100, y: 26 }]] },
    { id: 'd3', cls: 'data', polylines: [[{ x: 0, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 70 }, { x: 100, y: 70 }]] },
  ];
  assert.deepEqual(crossingCounts(nets).counts, { data: 0, control: 0, mixed: 2, total: 2 });
  const j = dataJogs(nets, { minOffsetPt: 12 });
  assert.equal(j.straight, 1);
  assert.equal(j.redundant, 1);
  assert.equal(j.jogs.find((x) => x.kind === 'redundant').net, 'd2');
  assert.equal(j.jogs.find((x) => x.kind === 'unavoidable').reason, 'cross-row');
  const hits = textLineCollisions([{ id: 't', text: 'legend', x0: 10, x1: 60, y0: 2, y1: 9 }], [{ id: 'frame', a: { x: 0, y: 5 }, b: { x: 80, y: 5 }, hw: 0.25 }]);
  assert.deepEqual(hits.map((h) => h.line), ['frame']);
});

test('straightening removes a redundant jog by shifting a block, and keeps constraints', () => {
  const nodes = new Map([
    ['src', { x: 0, y: 0, w: 20, h: 24 }],
    ['dst', { x: 60, y: 7, w: 20, h: 24 }],
  ]);
  const edges = [{ id: 'e__0', net: 'e', cls: 'data', src: 'src', dst: 'dst', pts: [{ x: 20, y: 12 }, { x: 40, y: 12 }, { x: 40, y: 19 }, { x: 60, y: 19 }] }];
  const r = straighten({ nodes, edges });
  assert.equal(r.before.redundant, 1);
  assert.equal(r.after.redundant, 0);
  assert.deepEqual(r.edges[0].pts.map((p) => p.y), [12, 12]);
  // a blocker in the way: the move must not put a wire through it
  const blocked = new Map([...nodes, ['wall', { x: 30, y: 10, w: 8, h: 4 }]]);
  const rb = straighten({ nodes: blocked, edges });
  for (const e of rb.edges) for (let k = 1; k < e.pts.length; k += 1) {
    const [a, b] = [e.pts[k - 1], e.pts[k]];
    const w = blocked.get('wall');
    const through = Math.min(a.x, b.x) < w.x + w.w && Math.max(a.x, b.x) > w.x && Math.min(a.y, b.y) < w.y + w.h && Math.max(a.y, b.y) > w.y;
    assert.equal(through, false);
  }
});

test('framed regions enclose exactly their members; no frame, wire or text collisions', async () => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'datapath-mixed-gates.json'), 'utf8'));
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'frames' });
  const codes = r.diagnostics.map((d) => d.code);
  for (const c of ['region/frame-foreign-block', 'region/frame-member-outside', 'region/frame-edge-crossing', 'region/wire-on-frame', 'geometry/text-on-line']) assert.ok(!codes.includes(c), c);
  assert.equal(r.route.data_jogs_redundant, 0);
});

test('a bundled pin expands to its RTL ports and must add up in width', () => {
  const mod = { orig_name: 'mem', ports: [{ name: 'wen', dir: 'in', width: 1 }, { name: 'waddr', dir: 'in', width: 4 }, { name: 'rdata', dir: 'out', width: 8 }] };
  assert.deepEqual(boundaryDiagnostics('m', 'm', [{ id: 'ctrl', dir: 'in', width: 5, bundle: ['wen', 'waddr'] }, { id: 'rdata', dir: 'out', width: 8 }], mod), []);
  const bad = boundaryDiagnostics('m', 'm', [{ id: 'ctrl', dir: 'in', width: 6, bundle: ['wen', 'waddr'] }, { id: 'rdata', dir: 'out', width: 8 }], mod);
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /total 5 bits/);
});
