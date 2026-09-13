// Parametric IEEE distinctive-shape gates (AND/OR/XOR/NAND/NOR/XNOR/NOT/BUF)
// with n inputs and inversion bubbles, plus explicit hatching for blackbox
// boxes. Everything is emitted as plain paths/circles (figma-safe).
//
// Geometry is exact (CONVENTIONS §4.1): an output bubble is tangent to the
// body at its output apex (the arc apex of AND, the shield tip of OR/XOR, the
// NOT triangle tip); an input bubble is tangent to the input edge at the pin's
// y (the flat back of AND, the curved back of OR/XOR). Pin anchors are the
// points where a wire meets the symbol: the bubble's outer tangent point, the
// back edge at that y, or the apex. Tangency is between stroke centerlines, so
// it holds for every stroke width.

import { el, num } from '../svg.mjs';

export const GATE_OPS = new Set(['and', 'or', 'xor', 'nand', 'nor', 'xnor', 'not', 'buf']);
const BASE = { nand: 'and', nor: 'or', xnor: 'xor', not: 'not', buf: 'not', and: 'and', or: 'or', xor: 'xor' };

// Centre x (left of the edge) of a circle of radius r on the line y = py that
// touches the input edge x = edge(y) from the left. Flat edges are exact;
// curved edges are solved by bisection on the sampled curve.
export function tangentCentreX(edge, h, py, r) {
  const samples = 400;
  const dist = (cx) => {
    let best = Infinity;
    for (let s = 0; s <= samples; s += 1) {
      const y = (h * s) / samples;
      best = Math.min(best, Math.hypot(edge(y) - cx, y - py));
    }
    return best;
  };
  let hi = edge(py) - r * 0.25; // too close: distance < r
  let lo = edge(py) - 3 * r; // far enough: distance > r
  for (let it = 0; it < 40; it += 1) {
    const mid = (lo + hi) / 2;
    if (dist(mid) > r) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Geometry for a gate with k inputs; `inverted` lists input indices with bubbles.
export function gateGeometry(spec, { op, inputs = 2, inverted = [], invertOutput = false }) {
  const base = BASE[op];
  const outBubble = ['nand', 'nor', 'xnor', 'not'].includes(op) !== Boolean(invertOutput);
  const k = base === 'not' ? 1 : inputs;
  const d = spec.bubble_diameter;
  const r = d / 2;
  const h = Math.max(spec.min_height, k * spec.pin_pitch + 4);
  const pinY = (i) => (base === 'not' ? h / 2 : (h - k * spec.pin_pitch) / 2 + spec.pin_pitch * (i + 0.5));
  // AND: a flat top/bottom then a semicircle of radius h/2 (apex at flat + h/2).
  // OR/XOR: a shield whose back bulges by a quarter of the body width.
  const flat = base === 'and' ? Math.max(spec.width - h / 2, h * 0.3) : 0;
  const bodyW = base === 'and' ? flat + h / 2 : base === 'not' ? spec.width : Math.max(spec.width, h * 0.55);
  const bulge = base === 'or' || base === 'xor' ? bodyW * 0.25 : 0;
  const backGap = base === 'xor' ? spec.xor_gap : 0;
  // Outer input edge (the extra back line of XOR, else the body back) relative to its origin.
  const curve = (y) => (bulge ? 2 * (y / h) * (1 - y / h) * bulge : 0);
  // Input anchors with the outer edge at x = 0; shift so the leftmost anchor sits at x = 0.
  const raw = Array.from({ length: k }, (_, i) => {
    const y = pinY(i);
    if (!inverted.includes(i)) return { y, x: curve(y), cx: null };
    // A flat back (AND, NOT) is exact; a curved back (OR, XOR) is solved.
    const cx = bulge ? tangentCentreX(curve, h, y, r) : -r;
    return { y, x: cx - r, cx };
  });
  const inPad = Math.max(0, -Math.min(0, ...raw.map((a) => a.x)));
  const bodyX = inPad + backGap;
  const apexX = bodyX + bodyW;
  const w = apexX + (outBubble ? d : 0);
  const anchors = raw.map((a) => ({ y: a.y, x: a.x + inPad, bubble: a.cx === null ? null : { cx: a.cx + inPad, cy: a.y, r } }));
  const out = { x: w, y: h / 2, bubble: outBubble ? { cx: apexX + r, cy: h / 2, r } : null };
  return { base, k, h, w, bodyX, bodyW, flat, bulge, backGap, inPad, apexX, outBubble, pinY, anchors, out, d, r };
}

export function drawGate(spec, geo, { x, y, id, fill, ink, outline }) {
  const { base, h, bodyX: bx, bodyW, flat, bulge, inPad } = geo;
  const X = (v) => num(x + v);
  const Y = (v) => num(y + v);
  let body;
  if (base === 'and') body = `M${X(bx)} ${Y(0)} L${X(bx + flat)} ${Y(0)} A${num(h / 2)} ${num(h / 2)} 0 0 1 ${X(bx + flat)} ${Y(h)} L${X(bx)} ${Y(h)} Z`;
  else if (base === 'or' || base === 'xor') body = `M${X(bx)} ${Y(0)} Q${X(bx + bodyW * 0.6)} ${Y(0)} ${X(bx + bodyW)} ${Y(h / 2)} Q${X(bx + bodyW * 0.6)} ${Y(h)} ${X(bx)} ${Y(h)} Q${X(bx + bulge)} ${Y(h / 2)} ${X(bx)} ${Y(0)} Z`;
  else body = `M${X(bx)} ${Y(0)} L${X(bx + bodyW)} ${Y(h / 2)} L${X(bx)} ${Y(h)} Z`;
  const out = [el('path', { id: `${id}-body`, d: body, fill, stroke: ink, 'stroke-width': outline, 'stroke-linejoin': 'miter' })];
  // XOR's extra back line has the same curve as the body back, offset by the
  // gap. A quadratic from (0,0) with control (c, h/2) to (0,h) has
  // x(y) = 2·(y/h)·(1 − y/h)·c, which is `curve` with c = bulge.
  if (base === 'xor') out.push(el('path', { id: `${id}-back`, d: `M${X(inPad)} ${Y(0)} Q${X(inPad + bulge)} ${Y(h / 2)} ${X(inPad)} ${Y(h)}`, fill: 'none', stroke: ink, 'stroke-width': outline }));
  geo.anchors.forEach((a, i) => {
    if (a.bubble) out.push(el('circle', { id: `${id}-bubble-in${i}`, cx: x + a.bubble.cx, cy: y + a.bubble.cy, r: a.bubble.r, fill: '#FFFFFF', stroke: ink, 'stroke-width': outline }));
  });
  if (geo.out.bubble) out.push(el('circle', { id: `${id}-bubble-out`, cx: x + geo.out.bubble.cx, cy: y + geo.out.bubble.cy, r: geo.out.bubble.r, fill: '#FFFFFF', stroke: ink, 'stroke-width': outline }));
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
