// Bundled fonts (OFL, from @fontsource) used for text measurement during
// layout and for outlining text in PDFs. The SVG keeps the configured
// family name; measurement and outlines use the metric-compatible file.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
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

// WOFF 1.0 → sfnt (TrueType/OpenType) bytes: the same tables, inflated and
// laid out as a plain font file, for readers that take only sfnt (resvg).
export function woffToSfnt(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.toString('latin1', 0, 4) !== 'wOFF') return buf;
  const numTables = buf.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < numTables; i += 1) {
    const e = 44 + i * 20;
    const offset = buf.readUInt32BE(e + 4);
    const compLength = buf.readUInt32BE(e + 8);
    const origLength = buf.readUInt32BE(e + 12);
    const raw = buf.subarray(offset, offset + compLength);
    const data = compLength < origLength ? zlib.inflateSync(raw) : raw;
    if (data.length !== origLength) throw new Error(`WOFF table ${buf.toString('latin1', e, e + 4)} is ${data.length} bytes, expected ${origLength}`);
    tables.push({ tag: buf.subarray(e, e + 4), checksum: buf.readUInt32BE(e + 16), data });
  }
  const pad4 = (n) => (n + 3) & ~3;
  const headerSize = 12 + 16 * numTables;
  const out = Buffer.alloc(headerSize + tables.reduce((sum, t) => sum + pad4(t.data.length), 0));
  const log2 = Math.floor(Math.log2(numTables));
  out.writeUInt32BE(buf.readUInt32BE(4), 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(2 ** log2 * 16, 6);
  out.writeUInt16BE(log2, 8);
  out.writeUInt16BE((numTables - 2 ** log2) * 16, 10);
  let offset = headerSize;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    t.tag.copy(out, r);
    out.writeUInt32BE(t.checksum, r + 4);
    out.writeUInt32BE(offset, r + 8);
    out.writeUInt32BE(t.data.length, r + 12);
    t.data.copy(out, offset);
    offset += pad4(t.data.length);
  });
  return out;
}

let sfntFiles = null;

// The bundled fonts as sfnt files, written once per content hash into a
// per-user temp directory and reused: [{ key, family, path }].
export function bundledSfntFiles() {
  if (sfntFiles) return sfntFiles;
  const dir = path.join(os.tmpdir(), `figgen-fonts-${process.getuid?.() ?? 'user'}`);
  sfntFiles = Object.entries(FONT_FILES).map(([key, spec]) => {
    const sfnt = woffToSfnt(fs.readFileSync(path.join(root, spec.file)));
    const hash = createHash('sha256').update(sfnt).digest('hex').slice(0, 16);
    const file = path.join(dir, `${path.basename(spec.file, path.extname(spec.file))}-${hash}.ttf`);
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(sfnt)) {
      fs.mkdirSync(dir, { recursive: true });
      const partial = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(partial, sfnt);
      fs.renameSync(partial, file);
    }
    return { key, family: spec.family, path: file };
  });
  return sfntFiles;
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
