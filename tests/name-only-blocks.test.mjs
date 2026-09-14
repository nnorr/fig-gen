// Boxes show the name only (CONVENTIONS §2.3.3, §4.3): a concat box prints the
// word "concat" and no destination ranges; datapath blocks print no secondary
// lines (stage notes, function.detail, pin labels, sizes) unless the figure
// (meta.style.block_details) or the block (show_details) opts in, and the clutter
// limit applies only then. Latency stays in the receipt.

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSkin } from '../lib/checks/skin.mjs';
import { loadSkin, renderDatapath } from '../lib/render/datapath.mjs';
import { validateSchema } from '../lib/validate.mjs';

const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const opts = { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'names' };

const figure = ({ style, blockExtra = {} } = {}) => ({
  schema_version: 1, figure_type: 'datapath',
  meta: { title: 'names', print: { profile: 'ieee' }, ...(style ? { style } : {}) },
  clock_domains: [],
  elements: [
    { id: 'hi', kind: 'port', dir: 'in', width: 32, label: 'data' },
    { id: 'lo', kind: 'port', dir: 'in', width: 16, label: 'check bits' },
    { id: 'cat', kind: 'comb', op: 'concat', width: 48, in_widths: [32, 16] },
    {
      id: 'st', kind: 'comb', op: 'custom', width: 48, pin_labels: true,
      function: { kind: 'custom', name: 'Status logic', detail: 'two outputs' },
      ports: [{ id: 'word', dir: 'in', width: 48, label: 'word' }, { id: 'ready', dir: 'out', width: 1, registered: true, latency: 2, label: 'ready' }, { id: 'done', dir: 'out', width: 1, registered: true, label: 'done' }],
      ...blockExtra,
    },
    { id: 'tab', kind: 'comb', op: 'lut', width: 8, depth: 16 },
    { id: 'o1', kind: 'port', dir: 'out', width: 1, label: 'ready out' },
    { id: 'o2', kind: 'port', dir: 'out', width: 1, label: 'done out' },
    { id: 'sel', kind: 'port', dir: 'in', width: 4, label: 'index' },
    { id: 'o3', kind: 'port', dir: 'out', width: 8, label: 'constant' },
  ],
  nets: [
    { id: 'n_hi', width: 32, driver: 'hi', sinks: ['cat.in0'] },
    { id: 'n_lo', width: 16, driver: 'lo', sinks: ['cat.in1'] },
    { id: 'n_w', width: 48, driver: 'cat.out', sinks: ['st.word'] },
    { id: 'n_r', width: 1, driver: 'st.ready', sinks: ['o1'] },
    { id: 'n_d', width: 1, driver: 'st.done', sinks: ['o2'] },
    { id: 'n_s', width: 4, driver: 'sel', sinks: ['tab.addr'] },
    { id: 'n_c', width: 8, driver: 'tab.data', sinks: ['o3'] },
  ],
});

test('concat prints the word only: no destination bit ranges, and the skin lint rejects turning them back on', async () => {
  const r = await renderDatapath(figure(), opts);
  assert.match(r.svg, /id="concat-cat-title"[^>]*>concat</);
  assert.doesNotMatch(r.svg, /id="concat-cat-range\d"/);
  assert.ok(!texts(r.svg).some((x) => /^\[\d+:\d+\]$/.test(x)), texts(r.svg).join(' | '));
  const skin = structuredClone(loadSkin('netlist-mono'));
  assert.deepEqual(checkSkin(skin).filter((d) => d.code === 'glyph/distinguishable'), []);
  skin.symbols.join.input_range_labels = true;
  assert.ok(checkSkin(skin).some((d) => d.code === 'glyph/distinguishable' && /concat/.test(d.message)));
});

test('blocks are name-only by default: no stage notes, detail, pin labels or sizes; the clock wedge and the receipt latency stay', async () => {
  const r = await renderDatapath(figure(), opts);
  const t = texts(r.svg);
  assert.ok(t.includes('Status') && t.includes('logic'), 'the name prints (wrapped over two lines)');
  for (const hidden of ['two outputs', 'ready', 'done', '1 stage: done', '2 stages: ready', '16×8']) assert.ok(!t.includes(hidden), `${hidden} is not printed: ${t.join(' | ')}`);
  assert.ok(t.includes('ready out') && t.includes('done out'), 'port names are not box text and still print');
  assert.match(r.svg, /id="custom-st-body"/);
  assert.ok(/<path d="M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+"[^>]*fill="none"/.test(r.svg), 'clock wedge drawn');
  assert.deepEqual(r.route.stage_notes.map((s) => [s.output, s.latency]).sort(), [['done', 1], ['ready', 2]], 'latency stays in the receipt');
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'label/stage-note-clutter'), []);
});

test('details opt in per figure or per block; the clutter limit applies only then', async () => {
  assert.deepEqual(await validateSchema('datapath', figure({ style: { block_details: true } })), []);
  const all = await renderDatapath(figure({ style: { block_details: true } }), opts);
  const t = texts(all.svg);
  assert.ok(t.includes('two outputs') && t.includes('16×8'), t.join(' | '));
  assert.ok(t.includes('ready') && t.includes('done'), 'pin labels print when opted in');
  // a two-line detail plus the stage note exceeds the two-line limit once details are on
  const cluttered = figure({ style: { block_details: true } });
  cluttered.elements.find((e) => e.id === 'st').function.detail = 'first line\nsecond line';
  const c = await renderDatapath(cluttered, opts);
  assert.equal(c.diagnostics.filter((d) => d.code === 'label/stage-note-clutter').length, 1);
  const quiet = figure();
  quiet.elements.find((e) => e.id === 'st').function.detail = 'first line\nsecond line';
  assert.deepEqual((await renderDatapath(quiet, opts)).diagnostics.filter((d) => d.code === 'label/stage-note-clutter'), [], 'name-only blocks cannot be cluttered');
  const one = await renderDatapath(figure({ blockExtra: { show_details: true } }), opts);
  const t1 = texts(one.svg);
  assert.ok(t1.includes('two outputs'), 'the opted-in block prints its detail');
  assert.ok(!t1.includes('16×8'), 'other blocks stay name-only');
});
