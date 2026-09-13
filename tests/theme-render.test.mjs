import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSkin } from '../lib/checks/skin.mjs';
import { loadSkin, renderDatapathPrototype } from '../lib/render/datapath-proto.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = () => JSON.parse(fs.readFileSync(path.join(root, 'examples', 'datapath-theme-sample.json'), 'utf8'));
const errors = (r) => r.diagnostics.filter((d) => d.severity === 'error');

test('default skin passes the skin lint (bar kinds distinct, mux has select)', () => {
  assert.deepEqual(checkSkin(loadSkin()), []);
});

test('skin lint flags a join bar that looks like the mux bar', () => {
  const skin = loadSkin();
  skin.symbols.join.width = skin.symbols.mux.bar.width;
  skin.symbols.join.label = null;
  assert.ok(checkSkin(skin).some((d) => d.code === 'skin/bar-kinds-indistinct'));
});

for (const variant of ['1col', '2col']) {
  test(`bar mux default: ${variant} renders clean, no index labels, select connected`, async () => {
    const r = await renderDatapathPrototype(sample(), { variant, widthPt: variant === '1col' ? 252 : 515.5 });
    assert.deepEqual(errors(r), []);
    assert.deepEqual(lintFigmaSafe(r.svg), []);
    assert.match(r.svg, /<rect id="mux-m0-body"[^>]*fill="#000000"[^>]*stroke="none"/);
    assert.doesNotMatch(r.svg, /mux-m0-in\d-label|mux-m0-idx/);
    assert.match(r.svg, /<g id="net-n_sel">/);
  });
}

test('opt-in indices on the bar mux sit outside the bar without touching wires', async () => {
  const doc = sample();
  doc.meta.style.mux_indices = true;
  const r = await renderDatapathPrototype(doc, { variant: '2col', widthPt: 515.5 });
  assert.deepEqual(errors(r), []);
  assert.equal((r.svg.match(/id="mux-m0-in\d-label"/g) || []).length, 4);
});

test('trapezoid alternative keeps opt-in indices inset from the slope', async () => {
  const doc = sample();
  Object.assign(doc.meta.style, { mux_style: 'trapezoid', mux_indices: true });
  const r = await renderDatapathPrototype(doc, { variant: '2col', widthPt: 515.5 });
  assert.deepEqual(errors(r), []);
  assert.equal((r.svg.match(/id="mux-m0-idx\d"/g) || []).length, 4);
});

test('a mux without a select net is an error', async () => {
  const doc = sample();
  doc.nets = doc.nets.filter((n) => n.id !== 'n_sel');
  doc.elements = doc.elements.filter((e) => e.id !== 'sel');
  const r = await renderDatapathPrototype(doc, { variant: '2col', widthPt: 515.5 });
  assert.ok(errors(r).some((d) => d.code === 'symbol/mux-sel-missing'));
});
