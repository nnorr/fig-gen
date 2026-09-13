import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'svg');
const read = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');

test('figma-safe fixture passes lint', () => {
  assert.deepEqual(lintFigmaSafe(read('figma-safe-ok.svg')), []);
});

test('unsafe fixture reports each rule class', () => {
  const codes = new Set(lintFigmaSafe(read('figma-unsafe.svg')).map((d) => d.code));
  for (const code of ['svg/physical-units', 'svg/inline-presentation', 'svg/no-marker', 'svg/forbidden-feature',
    'svg/no-reuse', 'svg/text-positioning', 'svg/layer-structure']) {
    assert.ok(codes.has(code), `expected ${code}, got ${[...codes].join(', ')}`);
  }
});

test('viewBox must match physical size in pt', () => {
  const svg = '<svg width="3.5in" height="1in" viewBox="0 0 350 100"><g id="a"></g></svg>';
  assert.ok(lintFigmaSafe(svg).some((d) => d.code === 'svg/physical-units'));
  const ok = '<svg width="3.5in" height="1in" viewBox="0 0 252 72"><g id="a"></g></svg>';
  assert.deepEqual(lintFigmaSafe(ok), []);
});

test('more than one clipPath exceeds the budget', () => {
  const svg = '<svg width="10pt" height="10pt" viewBox="0 0 10 10"><g id="g"><clipPath id="c1"></clipPath><clipPath id="c2"></clipPath></g></svg>';
  assert.ok(lintFigmaSafe(svg).some((d) => d.code === 'svg/clip-budget'));
});
