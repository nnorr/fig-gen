// Declared handshake abstraction (SPEC §4.11) and control-only returns as
// connectors by rule; RTL abbreviations in generated port names.

import assert from 'node:assert/strict';
import test from 'node:test';
import { abstraction, ABSTRACT_CAPTION } from '../lib/abstraction.mjs';
import { expandAbbreviations } from '../lib/checks/labels.mjs';
import { renderDatapath } from '../lib/render/datapath.mjs';
import { validateSchema } from '../lib/validate.mjs';
import { checkView } from '../lib/view.mjs';

const figure = ({ abstract, omit, caption = 'Block view of the whole design; handshake signals omitted.' } = {}) => ({
  schema_version: 1, figure_type: 'datapath',
  meta: { title: 'handshake', caption, print: { profile: 'ieee' } },
  view: { preset: 'block', scope: '', ...(abstract ? { abstract } : {}) },
  clock_domains: [],
  elements: [
    { id: 'a', kind: 'port', dir: 'in', width: 16, label: 'operand' },
    { id: 'ctl', kind: 'comb', op: 'custom', width: 16, function: { kind: 'controller' }, holds_state: true, ports: [{ id: 'd', dir: 'in', width: 16 }, { id: 'go', dir: 'out', width: 1, latency: 'state' }, { id: 'q', dir: 'out', width: 16, latency: 'state' }, { id: 'done', dir: 'in', width: 1, role: 'handshake' }] },
    { id: 'unit', kind: 'comb', op: 'custom', width: 16, function: { kind: 'arithmetic_unit' }, ports: [{ id: 'valid', dir: 'in', width: 1, role: 'handshake' }, { id: 'x', dir: 'in', width: 16 }, { id: 'ready', dir: 'out', width: 1 }, { id: 'y', dir: 'out', width: 16 }] },
    { id: 'o', kind: 'port', dir: 'out', width: 16, label: 'result' },
  ],
  nets: [
    { id: 'n_a', width: 16, driver: 'a', sinks: ['ctl.d'] },
    { id: 'n_go', width: 1, driver: 'ctl.go', sinks: ['unit.valid'], ...(omit?.go ? { omit: { reason: 'handshake' } } : {}) },
    { id: 'n_rdy', width: 1, driver: 'unit.ready', sinks: ['ctl.done'] },
    { id: 'n_q', width: 16, driver: 'ctl.q', sinks: ['unit.x'], ...(omit?.data ? { omit: { reason: 'not allowed' } } : {}) },
    { id: 'n_y', width: 16, driver: 'unit.y', sinks: ['o'] },
  ],
});

test('view.abstract handshakes omits 1-bit handshake nets between drawn blocks; the drawing leaves them out, the IR keeps them', async () => {
  const doc = figure({ abstract: { handshakes: true, reason: 'valid/ready each step' } });
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const abs = abstraction(doc);
  assert.deepEqual(abs.abstracted.map((a) => a.net).sort(), ['n_go', 'n_rdy']);
  assert.deepEqual(abs.diagnostics, []);
  assert.equal(abs.drawn.nets.length, 3);
  assert.equal(doc.nets.length, 5, 'the figure itself is unchanged');
  const view = checkView(doc, {});
  assert.deepEqual(view.report.abstracted_handshakes.map((a) => a.net).sort(), ['n_go', 'n_rdy']);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'abs' });
  assert.doesNotMatch(r.svg, /id="net-n_go-/);
  assert.doesNotMatch(r.svg, /id="net-n_rdy-/);
  assert.match(r.svg, /id="net-n_q-seg0"/);
});

test('an abstraction must be declared in the caption, and data nets are never abstracted', () => {
  const noCaption = abstraction(figure({ abstract: { handshakes: true, reason: 'valid/ready each step' }, caption: 'Block view of the whole design.' }));
  assert.ok(noCaption.diagnostics.some((d) => d.code === 'view/abstract-caption' && d.severity === 'error'));
  assert.ok(ABSTRACT_CAPTION.length > 0);
  const data = abstraction(figure({ omit: { data: true } }));
  assert.ok(data.diagnostics.some((d) => d.code === 'view/abstract-invalid' && /16 bits/.test(d.message)));
  assert.ok(!data.abstracted.some((a) => a.net === 'n_q'), 'the data net stays drawn');
  const one = abstraction(figure({ omit: { go: true } }));
  assert.deepEqual(one.abstracted.map((a) => a.net), ['n_go']);
  assert.deepEqual(one.diagnostics, []);
});

const muxFigure = (caption) => ({
  schema_version: 1, figure_type: 'datapath',
  meta: { title: 'select', caption, print: { profile: 'ieee' } },
  view: { preset: 'block', scope: '', abstract: { selects: true, reason: 'selects come from the controller' } },
  clock_domains: [],
  elements: [
    { id: 'a', kind: 'port', dir: 'in', width: 16, label: 'operand' },
    { id: 'b', kind: 'port', dir: 'in', width: 16, label: 'other operand' },
    { id: 'ctl', kind: 'comb', op: 'custom', width: 2, function: { kind: 'controller' }, holds_state: true, ports: [{ id: 'd', dir: 'in', width: 16 }, { id: 's', dir: 'out', width: 2, latency: 'state', class: 'control' }] },
    { id: 'm', kind: 'mux', inputs: 3, width: 16, style: 'bar' },
    { id: 'o', kind: 'port', dir: 'out', width: 16, label: 'result' },
  ],
  nets: [
    { id: 'n_a', width: 16, driver: 'a', sinks: ['ctl.d', 'm.in0', 'm.in2'] },
    { id: 'n_b', width: 16, driver: 'b', sinks: ['m.in1'] },
    { id: 'n_s', width: 2, driver: 'ctl.s', sinks: ['m.sel'] },
    { id: 'n_y', width: 16, driver: 'm.out', sinks: ['o'] },
  ],
});

test('view.abstract selects hides multi-bit mux selects; the mux keeps its bar and the caption must say so', async () => {
  const doc = muxFigure('Block view of the whole design; mux selects omitted.');
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const abs = abstraction(doc);
  assert.deepEqual(abs.abstracted.map((a) => [a.net, a.kind]), [['n_s', 'select']]);
  assert.deepEqual(abs.diagnostics, []);
  assert.equal(doc.nets.length, 4, 'the figure itself is unchanged');
  assert.deepEqual(checkView(doc, {}).report.abstracted_selects.map((a) => a.net), ['n_s']);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'sel' });
  assert.doesNotMatch(r.svg, /id="net-n_s-/);
  assert.match(r.svg, /id="mux-m-body"/);
  assert.ok(!r.diagnostics.some((d) => ['symbol/mux-sel-missing', 'glyph/distinguishable'].includes(d.code)), JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error')));
  const noCaption = abstraction(muxFigure('Block view of the whole design.'));
  assert.ok(noCaption.diagnostics.some((d) => d.code === 'view/abstract-caption' && /mux selects omitted/.test(d.message)));
});

test('RTL abbreviations in generated names: err expands to error', () => {
  assert.equal(expandAbbreviations('err detected'), 'error detected');
  assert.equal(expandAbbreviations('error corrected'), 'error corrected');
});
