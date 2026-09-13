// Checkpoint 3a datapath rules: a bundle's name is printed or reported
// (label/bundle-name-omitted), a bundle that forms one data word opts into its
// width label (width_label), staged blocks of one function print one naming
// scheme (label/stage-naming) and are justified as a stage group, and a
// pipeline bar's stage label never disappears silently (print/stage-label-omitted).

import assert from 'node:assert/strict';
import test from 'node:test';
import { carriesToLaterStage } from '../lib/checks/function-evidence.mjs';
import { stageNamingProblems } from '../lib/checks/labels.mjs';
import { renderDatapath } from '../lib/render/datapath.mjs';
import { validateSchema } from '../lib/validate.mjs';

const figure = (elements, nets, extra = {}) => ({ schema_version: 1, figure_type: 'datapath', meta: { title: 't', print: { profile: 'ieee' } }, clock_domains: [{ id: 'cd', clock: 'clk' }], elements, nets, ...extra });
const block = (id, name, ins, outs, fn = { kind: 'custom', name }) => ({ id, kind: 'comb', op: 'custom', width: 8, function: fn, ports: [...ins.map(([p, w]) => ({ id: p, dir: 'in', width: w })), ...outs.map(([p, w]) => ({ id: p, dir: 'out', width: w }))] });

// A source block, a bundle of two data fields into a sink block, and ports.
function bundleFigure({ label = 'stored codeword', widthLabel } = {}) {
  return figure([
    { id: 'p_in', kind: 'port', dir: 'in', width: 8, label: 'input word' },
    block('src', 'Source logic', [['i', 8]], [['word', 48]]),
    block('dst', 'Sink logic', [['word', 48]], [['o', 8]]),
    { id: 'p_out', kind: 'port', dir: 'out', width: 8, label: 'result' },
  ], [
    { id: 'n_in', width: 8, driver: 'p_in', sinks: ['src.i'] },
    { id: 'n_word', width: 48, driver: 'src.word', sinks: ['dst.word'], label, bundle_of: ['data_word', 'check_bytes'], ...(widthLabel === undefined ? {} : { width_label: widthLabel }) },
    { id: 'n_out', width: 8, driver: 'dst.o', sinks: ['p_out'] },
  ]);
}

test('width_label is a schema field of nets', async () => {
  assert.deepEqual(await validateSchema('datapath', bundleFigure({ widthLabel: true })), []);
});

test('label/bundle-name-omitted: a named bundle prints its name, or the paper variant reports it (study warns)', async () => {
  const doc = bundleFigure({ label: 'stored data word and all its check bytes' });
  for (const variant of ['2col', 'study']) {
    const r = await renderDatapath(doc, variant === 'study' ? { variant: 'study', name: 'b' } : { variant, widthPt: 515.5, maxHeightPt: 230.4, name: 'b' });
    const printed = /id="net-n_word-name"/.test(r.svg);
    const found = r.diagnostics.filter((d) => d.code === 'label/bundle-name-omitted');
    assert.ok(printed || found.length === 1, `${variant}: the bundle name is either printed or reported`);
    if (found.length) assert.equal(found[0].severity, variant === 'study' ? 'warning' : 'error');
    assert.ok(!r.diagnostics.some((d) => d.code === 'print/net-label-omitted' && d.subject?.id === 'n_word'), 'a bundle is never only a print warning');
  }
});

test('label/bundle-name-omitted fires in paper when a named bundle has no room at all', async () => {
  // Two blocks one layer apart with a long name: the run holds no name, and the
  // retry that widens the gap is kept only when it fits (it cannot fit 150 pt).
  const doc = bundleFigure({ label: 'stored data word and all its check bytes' });
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 150, maxHeightPt: 230.4, name: 'b' });
  if (!/id="net-n_word-name"/.test(r.svg)) {
    const d = r.diagnostics.find((x) => x.code === 'label/bundle-name-omitted');
    assert.ok(d, 'reported');
    assert.equal(d.severity, 'error');
    assert.deepEqual(d.evidence.nets, ['n_word']);
  }
});

test('width_label: a bundle that forms one data word gets its slash-N; a plain bundle does not', async () => {
  const withWidth = await renderDatapath(bundleFigure({ label: 'word', widthLabel: true }), { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'w' });
  assert.match(withWidth.svg, /<text id="net-n_word-width"[^>]*>48</);
  const plain = await renderDatapath(bundleFigure({ label: 'word' }), { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'p' });
  assert.doesNotMatch(plain.svg, /id="net-n_word-width"/);
});

test('label/stage-naming: stages of one function all declare function.stage', () => {
  const staged = (id, stage) => block(id, null, [['a', 8]], [['b', 8]], { kind: 'syndrome', stage });
  const mixed = figure([staged('s2', '2/2'), block('s1', 'Syndrome stage 1', [['a', 8]], [['b', 8]])], []);
  const found = stageNamingProblems(mixed);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, 'label/stage-naming');
  assert.equal(found[0].subject.id, 's1');
  assert.match(found[0].supportedFixes[0], /function\.stage/);
  // Same vocabulary kind without a stage beside a staged one.
  assert.equal(stageNamingProblems(figure([staged('s2', '2/2'), block('s1', null, [['a', 8]], [['b', 8]], { kind: 'syndrome' })], [])).length, 1);
  // Both staged: one scheme.
  assert.deepEqual(stageNamingProblems(figure([staged('s1', '1/2'), staged('s2', '2/2')], [])), []);
  // An unrelated custom block that numbers its own stage is not the same function.
  assert.deepEqual(stageNamingProblems(figure([staged('s2', '2/2'), block('c1', 'Controller stage 1', [['a', 8]], [['b', 8]])], [])), []);
});

test('carriesToLaterStage: an output carried through pipeline lanes to a later stage of the same function is exempt', () => {
  const doc = figure([
    block('st1', null, [['w', 48]], [['h', 8], ['sym', 48]], { kind: 'syndrome', stage: '1/2' }),
    { id: 'bar', kind: 'pipeline_register', domain: 'cd', lanes: [{ id: 'h', width: 8 }, { id: 'sym', width: 48 }] },
    block('st2', null, [['h', 8], ['sym', 48]], [['s', 8]], { kind: 'syndrome', stage: '2/2' }),
    block('other', 'Other logic', [['x', 48]], [['y', 8]]),
  ], [
    { id: 'n_h', width: 8, driver: 'st1.h', sinks: ['bar.d_h'] },
    { id: 'n_sym', width: 48, driver: 'st1.sym', sinks: ['bar.d_sym'] },
    { id: 'n_h2', width: 8, driver: 'bar.q_h', sinks: ['st2.h'] },
    { id: 'n_sym2', width: 48, driver: 'bar.q_sym', sinks: ['st2.sym'] },
    { id: 'n_side', width: 48, driver: 'st2.s', sinks: ['other.x'] },
  ]);
  const net = (id) => doc.nets.find((n) => n.id === id);
  const el = (id) => doc.elements.find((e) => e.id === id);
  assert.equal(carriesToLaterStage(doc, net('n_sym'), el('st1')), true);
  assert.equal(carriesToLaterStage(doc, net('n_side'), el('st2')), false, 'the last stage carries nothing on');
  const unstaged = { ...el('st1'), function: { kind: 'syndrome' } };
  assert.equal(carriesToLaterStage(doc, net('n_sym'), unstaged), false, 'only staged functions are judged as a group');
});

// A bar between two blocks inside a region frame whose top edge sits close
// above the bar (the frame's own padding): the stage label still prints.
function barFigure(label = 'S0|S1') {
  return figure([
    { id: 'p_in', kind: 'port', dir: 'in', width: 8, label: 'input word' },
    block('a', 'First stage', [['i', 8]], [['o', 8]]),
    { id: 'bar', kind: 'pipeline_register', domain: 'cd', label, lanes: [{ id: 'x', width: 8 }] },
    block('b', 'Second stage', [['i', 8]], [['o', 8]]),
    { id: 'p_out', kind: 'port', dir: 'out', width: 8, label: 'result' },
  ], [
    { id: 'n_in', width: 8, driver: 'p_in', sinks: ['a.i'] },
    { id: 'n_x', width: 8, driver: 'a.o', sinks: ['bar.d_x'] },
    { id: 'n_x2', width: 8, driver: 'bar.q_x', sinks: ['b.i'] },
    { id: 'n_out', width: 8, driver: 'b.o', sinks: ['p_out'] },
  ], { regions: [{ id: 'r', label: 'Pipeline', level: 'block', members: ['a', 'bar', 'b'], frame: true }] });
}

test('print/stage-label-omitted: a bar label prints inside a tight region frame', async () => {
  const r = await renderDatapath(barFigure(), { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'bar' });
  assert.match(r.svg, /<text id="preg-bar-label"[^>]*>S0\|S1</);
  assert.ok(!r.diagnostics.some((d) => d.code === 'print/stage-label-omitted'));
});

test('print/stage-label-omitted: a bar label that cannot fit is an error in paper and a warning in study', async () => {
  const long = 'S0|S1 boundary register of the first and second stage wider';
  for (const variant of ['2col', 'study']) {
    const r = await renderDatapath(barFigure(long), variant === 'study' ? { variant: 'study', name: 'bar' } : { variant, widthPt: 120, maxHeightPt: 230.4, name: 'bar' });
    if (/id="preg-bar-label"/.test(r.svg)) continue;
    const d = r.diagnostics.find((x) => x.code === 'print/stage-label-omitted');
    assert.ok(d, `${variant}: reported`);
    assert.equal(d.severity, variant === 'study' ? 'warning' : 'error');
  }
});
