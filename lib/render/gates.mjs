// Parametric IEEE distinctive-shape gates (AND/OR/XOR/NAND/NOR/XNOR/NOT/BUF)
// with n inputs and inversion bubbles, plus explicit hatching for blackbox
// boxes. Everything is emitted as plain paths/circles (figma-safe).

import { el, num } from '../svg.mjs';

export const GATE_OPS = new Set(['and', 'or', 'xor', 'nand', 'nor', 'xnor', 'not', 'buf']);
const BASE = { nand: 'and', nor: 'or', xnor: 'xor', not: 'not', buf: 'not', and: 'and', or: 'or', xor: 'xor' };

// Geometry for a gate with k inputs; `inverted` lists input indices with bubbles.
export function gateGeometry(spec, { op, inputs = 2, inverted = [], invertOutput = false }) {
  const base = BASE[op];
  const outBubble = ['nand', 'nor', 'xnor', 'not'].includes(op) !== Boolean(invertOutput);
  const k = base === 'not' ? 1 : inputs;
  const d = spec.bubble_diameter;
  const inPad = inverted.length ? d : 0;
  const bodyX = inPad + (base === 'xor' ? spec.xor_gap : 0);
  const bodyW = spec.width;
  const h = Math.max(spec.min_height, k * spec.pin_pitch + 4);
  const w = bodyX + bodyW + (outBubble ? d : 0);
  const pinY = (i) => (h - k * spec.pin_pitch) / 2 + spec.pin_pitch * (i + 0.5);
  // x where an input stub meets the body's back edge
  const backX = (y) => {
    if (base === 'or' || base === 'xor') {
      const t = y / h;
      return bodyX + 2 * t * (1 - t) * bodyW * 0.25;
    }
    return bodyX;
  };
  return { base, k, h, w, bodyX, bodyW, outBubble, inPad, pinY, backX, d };
}

export function drawGate(spec, geo, { x, y, id, fill, ink, outline, wire, inverted = [] }) {
  const { base, h, bodyX, bodyW, outBubble, pinY, backX, d, k } = geo;
  const X = (v) => num(x + v);
  const Y = (v) => num(y + v);
  const bx = bodyX;
  let body;
  if (base === 'and') body = `M${X(bx)} ${Y(0)} L${X(bx + bodyW / 2)} ${Y(0)} A${num(h / 2)} ${num(h / 2)} 0 0 1 ${X(bx + bodyW / 2)} ${Y(h)} L${X(bx)} ${Y(h)} Z`;
  else if (base === 'or' || base === 'xor') body = `M${X(bx)} ${Y(0)} Q${X(bx + bodyW * 0.6)} ${Y(0)} ${X(bx + bodyW)} ${Y(h / 2)} Q${X(bx + bodyW * 0.6)} ${Y(h)} ${X(bx)} ${Y(h)} Q${X(bx + bodyW * 0.25)} ${Y(h / 2)} ${X(bx)} ${Y(0)} Z`;
  else body = `M${X(bx)} ${Y(0)} L${X(bx + bodyW)} ${Y(h / 2)} L${X(bx)} ${Y(h)} Z`;
  const out = [el('path', { id: `${id}-body`, d: body, fill, stroke: ink, 'stroke-width': outline, 'stroke-linejoin': 'miter' })];
  if (base === 'xor') out.push(el('path', { id: `${id}-back`, d: `M${X(bx - spec.xor_gap)} ${Y(0)} Q${X(bx - spec.xor_gap + bodyW * 0.25)} ${Y(h / 2)} ${X(bx - spec.xor_gap)} ${Y(h)}`, fill: 'none', stroke: ink, 'stroke-width': outline }));
  const stubs = [];
  for (let i = 0; i < k; i += 1) {
    const py = pinY(i);
    const inv = inverted.includes(i);
    const end = base === 'xor' ? backX(py) - spec.xor_gap + 2 * (py / h) * (1 - py / h) * bodyW * 0.25 * 0 : backX(py);
    const startX = inv ? d : 0;
    if (inv) out.push(el('circle', { id: `${id}-bubble-in${i}`, cx: x + d / 2, cy: y + py, r: d / 2 - outline / 2, fill: '#FFFFFF', stroke: ink, 'stroke-width': outline }));
    if (end - startX > 0.05) stubs.push(`M${X(startX)} ${Y(py)} L${X(end)} ${Y(py)}`);
  }
  if (stubs.length) out.push(el('path', { id: `${id}-stubs`, d: stubs.join(' '), fill: 'none', stroke: ink, 'stroke-width': wire }));
  if (outBubble) out.push(el('circle', { id: `${id}-bubble-out`, cx: x + bx + bodyW + d / 2, cy: y + h / 2, r: d / 2 - outline / 2, fill: '#FFFFFF', stroke: ink, 'stroke-width': outline }));
  return out;
}

// Diagonal hatch lines clipped geometrically to a rectangle (no <pattern>).
export function hatchRect({ x, y, w, h, spacing, stroke, color, id }) {
  const segs = [];
  for (let c = -h + spacing; c < w; c += spacing) {
    // line: from (x + c, y + h) upward at 45°: points (x + c + t, y + h - t)
    const t0 = Math.max(0, -c);
    const t1 = Math.min(h, w - c);
    if (t1 - t0 < 0.5) continue;
    segs.push(`M${num(x + c + t0)} ${num(y + h - t0)} L${num(x + c + t1)} ${num(y + h - t1)}`);
  }
  return el('path', { id, d: segs.join(' '), fill: 'none', stroke: color, 'stroke-width': stroke });
}
