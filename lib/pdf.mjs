// Print PDF from a figma-safe SVG: every <text> is outlined into glyph paths
// with the bundled font (same metrics as layout), then pdfkit + svg-to-pdfkit
// convert the outlined SVG. The PDF contains no fonts; metadata dates are
// fixed so output bytes are reproducible.

import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { loadFont } from './fonts.mjs';

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// nonFiniteOutlines: texts whose outline has a NaN or infinite coordinate
// ({ id, text }); a PDF writer would cut or drop those paths.
export function outlineSvgText(svg) {
  const missing = new Set();
  const nonFiniteOutlines = [];
  let count = 0;
  const outlined = svg.replace(/<text\b([^>]*)>([^<]*)<\/text>/g, (match, attrText, content) => {
    const attrs = Object.fromEntries([...attrText.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const font = loadFont(attrs['font-family']);
    const value = unescapeXml(content);
    for (const ch of font.missing(value)) missing.add(ch);
    const { d, finite } = font.outlineChecked(value, Number(attrs.x), Number(attrs.y), Number(attrs['font-size']));
    if (!finite) nonFiniteOutlines.push({ id: attrs.id ?? null, text: value });
    count += 1;
    const id = attrs.id ? ` id="${attrs.id}-outline"` : '';
    return `<path${id} d="${d}" fill="${attrs.fill || '#000000'}" stroke="none"/>`;
  });
  return { svg: outlined, textCount: count, missingGlyphs: [...missing], nonFiniteOutlines };
}

export function pdfHasFonts(pdf) {
  return /\/Font\b|\/FontFile/.test(pdf.toString('latin1'));
}

export async function svgToOutlinedPdf(svg, { widthPt, heightPt, title = 'figure' } = {}) {
  const { svg: outlined, textCount, missingGlyphs, nonFiniteOutlines } = outlineSvgText(svg);
  // Checked before writing: no PDF with cut or dropped labels is produced.
  if (nonFiniteOutlines.length) return { pdf: null, sha256: null, textOutlined: textCount, missingGlyphs, nonFiniteOutlines, fontsPresent: false };
  const pdf = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [widthPt, heightPt],
      margin: 0,
      compress: true,
      info: { Title: title, Creator: 'fig-gen', Producer: 'fig-gen', CreationDate: new Date(0), ModDate: new Date(0) },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    SVGtoPDF(doc, outlined, 0, 0, { width: widthPt, height: heightPt, assumePt: true });
    doc.end();
  });
  return {
    pdf,
    sha256: createHash('sha256').update(pdf).digest('hex'),
    textOutlined: textCount,
    missingGlyphs,
    nonFiniteOutlines,
    fontsPresent: pdfHasFonts(pdf),
  };
}
