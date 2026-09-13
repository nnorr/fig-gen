// Bundled fonts (OFL, from @fontsource) used for text measurement during
// layout and for outlining text in PDFs. The SVG keeps the configured
// family name; measurement and outlines use the metric-compatible file.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FONT_FILES = Object.freeze({
  sans: { family: 'Arimo', file: 'node_modules/@fontsource/arimo/files/arimo-latin-400-normal.woff', css: 'Arial, Helvetica, Arimo, sans-serif' },
  serif: { family: 'Tinos', file: 'node_modules/@fontsource/tinos/files/tinos-latin-400-normal.woff', css: 'Times New Roman, Times, Tinos, serif' },
  libertinus: { family: 'Libertinus Serif', file: 'node_modules/@fontsource/libertinus-serif/files/libertinus-serif-latin-400-normal.woff', css: 'Libertinus Serif, serif' },
});

// Map a CSS-like family list to a bundled font. "sans-serif" must win over
// the "serif" substring, so sans patterns are tested first.
export function fontKeyFor(family = '') {
  const f = String(family).toLowerCase();
  if (/libertinus|linux libertine/.test(f)) return 'libertinus';
  if (/arial|helvetica|arimo|liberation sans|nimbus sans|sans/.test(f)) return 'sans';
  if (/times|tinos|termes|serif/.test(f)) return 'serif';
  return 'sans';
}

const cache = new Map();

export function loadFont(family) {
  const key = fontKeyFor(family);
  if (cache.has(key)) return cache.get(key);
  const spec = FONT_FILES[key];
  const bytes = fs.readFileSync(path.join(root, spec.file));
  const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const upm = font.unitsPerEm;
  const os2 = font.tables.os2 || {};
  const loaded = {
    key,
    family: spec.family,
    css: spec.css,
    file: spec.file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    font,
    ascent: (os2.sCapHeight || font.ascender * 0.7) / upm,
    descent: Math.abs(font.descender) / upm,
    measure: (text, size) => font.getAdvanceWidth(String(text), size, { kerning: true }),
    missing: (text) => [...new Set([...String(text)].filter((ch) => font.charToGlyph(ch).index === 0))],
    outline: (text, x, y, size) => font.getPath(String(text), x, y, size, { kerning: true }).toPathData(2),
  };
  cache.set(key, loaded);
  return loaded;
}
