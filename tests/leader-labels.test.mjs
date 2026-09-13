// Leader labels (net label_placement "leader" | "auto"): a net name that has no
// room on its wire sits in free space, joined to its own wire by a short
// orthogonal leader that touches no other wire, block, frame or text; without
// a valid leader the name is still reported (label/bundle-name-omitted).

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSkin, renderDatapath } from '../lib/render/datapath.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { validateSchema } from '../lib/validate.mjs';

const figure = (elements, nets) => ({ schema_version: 1, figure_type: 'datapath', meta: { title: 't', print: { profile: 'ieee' } }, clock_domains: [{ id: 'cd', clock: 'clk' }], elements, nets });
const block = (id, name, ins, outs) => ({ id, kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name }, ports: [...ins.map(([p, w]) => ({ id: p, dir: 'in', width: w })), ...outs.map(([p, w]) => ({ id: p, dir: 'out', width: w }))] });

// A source block driving a named bundle into a sink block over a short run.
function bundleFigure(placement) {
  return figure([
    { id: 'p_in', kind: 'port', dir: 'in', width: 8, label: 'input word' },
    block('src', 'Source logic', [['i', 8]], [['word', 48]]),
    block('dst', 'Sink logic', [['word', 48]], [['o', 8]]),
    { id: 'p_out', kind: 'port', dir: 'out', width: 8, label: 'result' },
  ], [
    { id: 'n_in', width: 8, driver: 'p_in', sinks: ['src.i'] },
    { id: 'n_word', width: 48, driver: 'src.word', sinks: ['dst.word'], label: 'stored data word and all its check bytes', width_label: true, bundle_of: ['data_word', 'check_bytes'], ...(placement ? { label_placement: placement } : {}) },
    { id: 'n_out', width: 8, driver: 'dst.o', sinks: ['p_out'] },
  ]);
}

const pts = (d) => [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
const bb = (a, b) => ({ x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
const gap = (p, q) => Math.hypot(Math.max(0, q.x0 - p.x1, p.x0 - q.x1), Math.max(0, q.y0 - p.y1, p.y0 - q.y1));
const segDist = (p, a, b) => {
  const dx = b.x - a.x; const dy = b.y - a.y; const l2 = dx * dx + dy * dy;
  const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
};

test('label_placement is a schema field of nets', async () => {
  assert.deepEqual(await validateSchema('datapath', bundleFigure('leader')), []);
  assert.notDeepEqual(await validateSchema('datapath', bundleFigure('sideways')), []);
});

test('a bundle name with no room on its short run prints as a leader label joined to its own wire only', async () => {
  const doc = bundleFigure('leader');
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 330, maxHeightPt: 230.4, name: 'lead' });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`), []);
  assert.deepEqual(lintFigmaSafe(r.svg), []);
  const leaderTag = /<path id="net-n_word-leader" d="([^"]+)"[^>]*>/.exec(r.svg);
  assert.ok(leaderTag, 'leader path drawn');
  assert.doesNotMatch(leaderTag[0], /marker|arrow/);
  assert.match(r.svg, /<text id="net-n_word-name"[^>]*>stored data word and all its check bytes</);
  assert.ok(r.diagnostics.some((d) => d.code === 'label/leader-used' && d.severity === 'info'));
  const leader = pts(leaderTag[1]);
  assert.ok(leader.length >= 2 && leader.length <= 3, 'straight or one bend');
  const length = leader.slice(1).reduce((a, p, k) => a + Math.hypot(p.x - leader[k].x, p.y - leader[k].y), 0);
  assert.ok(length <= loadSkin().tokens.net_label.leader_max_pt + 0.01, `leader ${length} pt`);
  // starts on its own wire
  const own = [...r.svg.matchAll(/<path id="net-n_word-seg\d+" d="([^"]+)"/g)].map((m) => pts(m[1]));
  assert.ok(own.some((pl) => pl.slice(1).some((b, k) => segDist(leader[0], pl[k], b) < 0.35)), 'leader starts on n_word');
  // touches no other net's wire
  const foreign = [...r.svg.matchAll(/<path id="net-(n_in|n_out)-seg\d+" d="([^"]+)"/g)].map((m) => pts(m[2]));
  for (const [a, b] of leader.slice(1).map((p, k) => [leader[k], p])) {
    for (const pl of foreign) for (const [c, d] of pl.slice(1).map((p, k) => [pl[k], p])) assert.ok(gap(bb(a, b), bb(c, d)) >= 1.5, 'leader clear of other wires');
  }
});

test('a bundle whose sink pin prints its label is named at the pin, not omitted', async () => {
  const doc = bundleFigure();
  const dst = doc.elements.find((e) => e.id === 'dst');
  dst.pin_labels = true;
  dst.ports.find((p) => p.id === 'word').label = 'codeword';
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 330, maxHeightPt: 230.4, name: 'pin' });
  assert.equal(r.diagnostics.filter((d) => d.code === 'label/bundle-name-omitted').length, 0);
  assert.match(r.svg, />codeword</);
});

test('without a valid leader (or without opting in) the bundle name is still reported', async () => {
  const plain = await renderDatapath(bundleFigure(), { variant: '2col', widthPt: 330, maxHeightPt: 230.4, name: 'plain' });
  assert.ok(plain.diagnostics.some((d) => d.code === 'label/bundle-name-omitted' && d.severity === 'error'));
  assert.doesNotMatch(plain.svg, /net-n_word-leader/);
  const skin = structuredClone(loadSkin());
  skin.tokens.net_label.leader_max_pt = 2;
  const tight = await renderDatapath(bundleFigure('leader'), { variant: '2col', widthPt: 330, maxHeightPt: 230.4, name: 'tight', skin });
  assert.ok(tight.diagnostics.some((d) => d.code === 'label/bundle-name-omitted' && d.severity === 'error'));
  assert.doesNotMatch(tight.svg, /net-n_word-leader/);
});
