#!/usr/bin/env node
// Phase-2 PDF spike: opentype.js outlining of a bundled WOFF font, then
// pdfkit + svg-to-pdfkit. Checks: glyph metrics, missing glyphs, no font
// resources in the PDF, byte-identical output across runs.
// Usage: node scripts/spike-pdf.mjs [out.pdf]

import crypto from 'node:crypto';
import fs from 'node:fs';
import opentype from 'opentype.js';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';

const buf = fs.readFileSync(new URL('../node_modules/@fontsource/arimo/files/arimo-latin-400-normal.woff', import.meta.url));
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log('font', font.names.fontFamily?.en, 'upm', font.unitsPerEm, 'ascender', font.ascender, 'descender', font.descender);
console.log('advance "Hello 8" @8pt', font.getAdvanceWidth('Hello 8', 8, { kerning: true }));
console.log('glyph index for U+2192 (0 = missing):', font.charToGlyph('→').index, '| for "8":', font.charToGlyph('8').index);
const d = font.getPath('valid_i 8', 10, 20, 8, { kerning: true }).toPathData(2);
console.log('outlined path chars', d.length);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="40pt" viewBox="0 0 100 40"><g id="a"><rect x="0" y="0" width="100" height="40" fill="#FFFFFF" stroke="none"/><path d="M5 30 L95 30" stroke="#000000" stroke-width="1.2" fill="none" stroke-dasharray="2 1.5"/><path d="${d}" fill="#000000" stroke="none"/><circle cx="50" cy="30" r="1.5" fill="#000000"/></g></svg>`;

function make() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [100, 40], margin: 0, compress: true, info: { CreationDate: new Date(0), ModDate: new Date(0), Producer: 'fig-gen', Creator: 'fig-gen' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    SVGtoPDF(doc, svg, 0, 0, { width: 100, height: 40, assumePt: true });
    doc.end();
  });
}

const a = await make();
const b = await make();
const h = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 16);
const latin = a.toString('latin1');
console.log('pdf bytes', a.length, 'sha', h(a), h(b), 'identical:', a.equals(b));
console.log('font resource present:', /\/Font\b/.test(latin), '| FontFile:', /FontFile/.test(latin), '| trailer /ID:', /\/ID\s*\[/.test(latin));
if (process.argv[2]) fs.writeFileSync(process.argv[2], a);
