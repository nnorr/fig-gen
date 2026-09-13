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

test('skin lint rejects a concatenation or split drawn as a filled bar (glyph/distinguishable)', () => {
  const skin = loadSkin();
  skin.symbols.join = { parametric: 'bus-bar', width: skin.symbols.mux.bar.width, fill: 'ink' };
  const diags = checkSkin(skin);
  assert.ok(diags.some((d) => d.code === 'glyph/distinguishable'));
  assert.ok(diags.some((d) => d.code === 'skin/bar-kinds-indistinct'));
  const skin2 = loadSkin();
  skin2.symbols.split.parametric = 'bus-bar';
  assert.ok(checkSkin(skin2).some((d) => d.code === 'glyph/distinguishable'));
  const skin3 = loadSkin();
  skin3.symbols.pipeline_register.wedge = false;
  assert.ok(checkSkin(skin3).some((d) => d.code === 'glyph/distinguishable'));
  assert.deepEqual(checkSkin(loadSkin()), []);
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
