// Text outlines stay finite. opentype.js 2.0.0 Path.toPathData rounds with
// `fraction + "e+" + places`; a fraction below 1e-6 prints in exponent form and
// parses as NaN, which cuts the path (Libertinus Serif hits it on about 2 % of
// character pairs). lib/fonts.mjs snaps those fractions, and
// text/non-finite-outline stops a PDF with a broken outline.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import { deliver, pdfDiagnostics } from '../lib/deliver.mjs';
import { FONT_FILES, finitePathData, glyphOutline, glyphPathData, loadFont } from '../lib/fonts.mjs';
import { relaxDiagnostics } from '../lib/format.mjs';
import { outlineSvgText, svgToOutlinedPdf } from '../lib/pdf.mjs';
import { renderWithResvg, selectRasterizer, svgSizePx } from '../lib/preview.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));

test('every printable character pair outlines to finite path data in all bundled faces; finite library outlines are unchanged', () => {
  const libraryNaN = {};
  for (const [key, spec] of Object.entries(FONT_FILES)) {
    const font = loadFont(spec.css);
    assert.equal(font.key, key);
    libraryNaN[key] = 0;
    const nonFinite = [];
    const changed = [];
    for (const [size, x] of [[8, 90.38], [40, 10]]) {
      for (const a of PRINTABLE) {
        for (const b of PRINTABLE) {
          const library = font.font.getPath(a + b, x, 45, size, { kerning: true }).toPathData(2);
          const { d, finite } = font.outlineChecked(a + b, x, 45, size);
          if (/NaN/.test(library)) libraryNaN[key] += 1;
          else if (library !== d) changed.push(`${a}${b}@${size}`);
          if (!finite) nonFinite.push(`${a}${b}@${size}`);
        }
      }
    }
    assert.deepEqual(nonFinite.slice(0, 12), [], `${spec.family}: non-finite outlines`);
    assert.deepEqual(changed.slice(0, 12), [], `${spec.family}: outlines the library printed finite must stay byte-identical`);
  }
  // The reproduction: the library alone breaks Libertinus pairs ("Sy" at 10 pt, "dh", "ul" ...).
  assert.ok(libraryNaN.libertinus > 100, `opentype.js printed NaN for ${libraryNaN.libertinus} Libertinus pairs; if it no longer does, the workaround in lib/fonts.mjs can go`);
});

test('glyphPathData snaps only fractions that print in exponent form', () => {
  const pathOf = (commands) => {
    const p = new opentype.Path();
    p.commands = commands;
    return p;
  };
  assert.match(pathOf([{ type: 'M', x: 24.000000000000004, y: 12.719999999999999 }]).toPathData(2), /NaN/);
  assert.equal(glyphPathData(pathOf([{ type: 'M', x: 24.000000000000004, y: 12.719999999999999 }, { type: 'L', x: -2.9999999999999996, y: 1e-7 }])), 'M24 12.72L-3 0');
  const ordinary = [{ type: 'M', x: 0.5, y: 1.005 }, { type: 'Q', x1: 2.25, y1: -3.125, x: 7, y: 8.0001 }, { type: 'L', x: 30.999999, y: 2 }, { type: 'Z' }];
  assert.equal(glyphPathData(pathOf(structuredClone(ordinary))), pathOf(structuredClone(ordinary)).toPathData(2));
  // A non-finite position prints as 0 (the optimiser's JSON copy), so it is caught on the commands.
  const lost = glyphOutline(pathOf([{ type: 'M', x: Number.NaN, y: 0 }, { type: 'L', x: 5, y: Number.POSITIVE_INFINITY }]));
  assert.equal(lost.d, 'M0 0L5 0');
  assert.equal(lost.finite, false);
  assert.deepEqual(glyphOutline(pathOf([{ type: 'M', x: 24.000000000000004, y: 1 }, { type: 'Z' }])), { d: 'M24 1Z', finite: true });
  assert.equal(finitePathData('M1 Infinity'), false);
  assert.equal(finitePathData('M1 2L3 4'), true);
  // Layout advances are untouched.
  const lib = loadFont('Libertinus Serif');
  assert.equal(lib.measure('Syndrome dh ul', 8), lib.font.getAdvanceWidth('Syndrome dh ul', 8, { kerning: true }));
});

test('text/non-finite-outline: reported by outlining, no PDF written, an error in every format', async () => {
  const text = (attrs, value) => `<text ${attrs} font-family="Libertinus Serif" font-size="8" fill="#000000">${value}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40pt" height="12pt"><g id="g">${text('id="t-bad" y="8"', 'dh')}${text('id="t-ok" x="1" y="8"', 'ok')}</g></svg>`;
  assert.deepEqual(outlineSvgText(svg).nonFiniteOutlines, [{ id: 't-bad', text: 'dh' }]);
  const pdf = await svgToOutlinedPdf(svg, { widthPt: 40, heightPt: 12 });
  assert.equal(pdf.pdf, null);
  assert.deepEqual(pdf.nonFiniteOutlines, [{ id: 't-bad', text: 'dh' }]);
  for (const format of ['paper', 'study']) {
    const list = pdfDiagnostics(format === 'paper' ? '2col' : 'study', pdf);
    relaxDiagnostics(list, format);
    assert.equal(list.length, 1);
    assert.equal(list[0].code, 'text/non-finite-outline');
    assert.equal(list[0].severity, 'error');
    assert.match(list[0].message, /: 1 text outline has a non-finite coordinate: t-bad "dh"$/);
    assert.deepEqual(list[0].subject.ids, ['t-bad']);
  }
  const fixed = await svgToOutlinedPdf(svg.replace('id="t-bad" y="8"', 'id="t-bad" x="1" y="8"'), { widthPt: 40, heightPt: 12 });
  assert.ok(Buffer.isBuffer(fixed.pdf));
  assert.deepEqual(pdfDiagnostics('2col', fixed), []);
});

test('a Libertinus figure delivers a PDF whose label outlines match the drawn text (none cut)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-outline-'));
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'datapath-pipelined-xor.json'), 'utf8'));
    doc.meta.style.font_family = 'Libertinus Serif';
    const figurePath = path.join(dir, 'xor-libertinus.json');
    fs.writeFileSync(figurePath, JSON.stringify(doc));
    const r = await deliver({ type: 'datapath', figurePath, outDir: path.join(dir, 'out'), format: 'study', pdf: true });
    assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
    const svg = fs.readFileSync(path.join(dir, 'out', 'xor-libertinus.study.svg'), 'utf8');
    assert.ok(fs.statSync(path.join(dir, 'out', 'xor-libertinus.study.pdf')).size > 0);
    const outlined = outlineSvgText(svg);
    assert.deepEqual(outlined.nonFiniteOutlines, []);
    // Each label alone: ink of resvg's <text> vs ink of the PDF outline.
    const rasterizer = selectRasterizer({ requested: 'resvg' });
    const head = /<svg\b[^>]*>/.exec(svg)[0];
    const size = svgSizePx(svg);
    const ink = (svgText) => {
      const { pixels } = renderWithResvg(rasterizer.resvg, svgText, size, 2);
      let n = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) n += 1;
      return n;
    };
    const labels = [...svg.matchAll(/<text\b[^>]*>[^<]*<\/text>/g)].map((m) => m[0]);
    assert.ok(labels.some((l) => />input A</.test(l)));
    for (const label of labels) {
      const drawn = ink(`${head}${label}</svg>`);
      const outline = ink(outlineSvgText(`${head}${label}</svg>`).svg);
      assert.ok(drawn > 0 && Math.abs(drawn - outline) <= 0.15 * drawn, `${label}: ${drawn} px drawn as text, ${outline} px outlined`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
