// Operator glyphs and bus-ripper helpers (CONVENTIONS §2.3, §4.2).
// Circle operators are drawn as vector strokes: the bundled Latin fonts have
// no ⊕/⊗ glyphs, and a drawn glyph keeps the PDF free of font dependencies.

import { el, num } from '../svg.mjs';

export const OP_GLYPH = { xor: 'oplus', add: 'plus', sub: 'minus', mul: 'times' };
export const GLYPH_KINDS = new Set(['oplus', 'otimes', 'plus', 'minus', 'times']);

export function circleOp(glyph, { x, y, d, ink, fill, outline, id }) {
  const r = d / 2;
  const cx = x + r;
  const cy = y + r;
  const s = r * 0.5;
  const q = r / Math.SQRT2;
  const lines = {
    oplus: `M${num(cx - r)} ${num(cy)} L${num(cx + r)} ${num(cy)} M${num(cx)} ${num(cy - r)} L${num(cx)} ${num(cy + r)}`,
    otimes: `M${num(cx - q)} ${num(cy - q)} L${num(cx + q)} ${num(cy + q)} M${num(cx - q)} ${num(cy + q)} L${num(cx + q)} ${num(cy - q)}`,
    plus: `M${num(cx - s)} ${num(cy)} L${num(cx + s)} ${num(cy)} M${num(cx)} ${num(cy - s)} L${num(cx)} ${num(cy + s)}`,
    minus: `M${num(cx - s)} ${num(cy)} L${num(cx + s)} ${num(cy)}`,
    times: `M${num(cx - s * 0.8)} ${num(cy - s * 0.8)} L${num(cx + s * 0.8)} ${num(cy + s * 0.8)} M${num(cx - s * 0.8)} ${num(cy + s * 0.8)} L${num(cx + s * 0.8)} ${num(cy - s * 0.8)}`,
  }[glyph];
  return [
    el('circle', { id: `${id}-body`, cx, cy, r, fill, stroke: ink, 'stroke-width': outline }),
    el('path', { id: `${id}-op`, d: lines, fill: 'none', stroke: ink, 'stroke-width': outline }),
  ];
}

// Bit ranges of concatenated fields, MSB first (input 0 is the most significant field).
export function fieldRanges(widths) {
  let hi = widths.reduce((a, w) => a + (w ?? 0), 0) - 1;
  return widths.map((w) => {
    const lo = hi - (w ?? 1) + 1;
    const label = w === 1 ? `[${hi}]` : `[${hi}:${lo}]`;
    hi = lo - 1;
    return label;
  });
}
