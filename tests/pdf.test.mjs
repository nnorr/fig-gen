import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fontKeyFor, loadFont } from '../lib/fonts.mjs';
import { outlineSvgText, svgToOutlinedPdf } from '../lib/pdf.mjs';

const svg = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'svg', 'figma-safe-ok.svg'), 'utf8');

test('font family lists map to bundled fonts (sans-serif is sans)', () => {
  assert.equal(fontKeyFor('Arial, Helvetica, sans-serif'), 'sans');
  assert.equal(fontKeyFor('Times New Roman, serif'), 'serif');
  assert.equal(fontKeyFor('Libertinus Serif'), 'libertinus');
  assert.ok(loadFont('Arial').measure('Hello', 8) > 15);
});

test('outlining replaces every <text> with a glyph path', () => {
  const out = outlineSvgText(svg);
  assert.equal(out.textCount, 2);
  assert.doesNotMatch(out.svg, /<text/);
  assert.deepEqual(out.missingGlyphs, []);
});

test('PDFs contain no fonts and are byte-identical across runs', async () => {
  const a = await svgToOutlinedPdf(svg, { widthPt: 252, heightPt: 72 });
  const b = await svgToOutlinedPdf(svg, { widthPt: 252, heightPt: 72 });
  assert.equal(a.fontsPresent, false);
  assert.equal(a.sha256, b.sha256);
});

test('missing glyphs are reported', () => {
  const out = outlineSvgText('<svg><g id="g"><text x="0" y="8" font-family="Arial" font-size="8" fill="#000000">AHB→APB</text></g></svg>');
  assert.deepEqual(out.missingGlyphs, ['→']);
});
