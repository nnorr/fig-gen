// Prototype datapath renderer in the `netlist-mono` theme (skin-driven ELK
// layout → figma-safe SVG). Supports port, const-free subset kinds: mux
// (bar | trapezoid), register, comb xor/and/or/add/concat(join)/split,
// pipeline_register. Phase 2 grows this into the full renderer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ELK from 'elkjs/lib/elk.bundled.js';
import { checkSkin } from '../checks/skin.mjs';
import { parseEndpoint } from '../ir/endpoints.mjs';
import { evalWidth, muxSelWidth } from '../ir/width.mjs';
import { centerBaseline, textWidth } from './text-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASCENT = 0.72;
const DESCENT = 0.21;

export function loadSkin(name = 'netlist-mono') {
  return JSON.parse(fs.readFileSync(path.join(root, 'skins', name, 'skin.json'), 'utf8'));
}

const num = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function el(name, attrs = {}, children = []) {
  return { name, attrs, children };
}
function serialize(node, indent = '') {
  if (typeof node === 'string') return `${indent}${esc(node)}`;
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? num(v) : v)}"`).join('');
  if (!node.children.length) return `${indent}<${node.name}${attrs}/>`;
  if (node.children.length === 1 && typeof node.children[0] === 'string') return `${indent}<${node.name}${attrs}>${esc(node.children[0])}</${node.name}>`;
  return `${indent}<${node.name}${attrs}>\n${node.children.map((c) => serialize(c, `${indent}  `)).join('\n')}\n${indent}</${node.name}>`;
}

function fontSize(t, key) {
  return key === 'label' ? t.font.label_pt : t.font.secondary_pt;
}
function text(skin, value, x, y, sizeKey = 'label', id) {
  const t = skin.tokens;
  return el('text', { ...(id ? { id } : {}), x, y, 'font-family': t.font.family, 'font-size': fontSize(t, sizeKey), fill: t.ink }, [String(value)]);
}
const outlineW = (t, kind) => (typeof t.stroke.outline === 'number' ? t.stroke.outline : (t.stroke.outline[kind] ?? t.stroke.outline.default));

function translatePath(d, dx, dy) {
  return d.replace(/([MLQA])([^MLQAZ]*)/g, (m, cmd, args) => {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === 'A') return `A${[n[0], n[1], n[2], n[3], n[4], num(n[5] + dx), num(n[6] + dy)].join(' ')} `;
    return `${cmd}${n.map((v, i) => num(v + (i % 2 === 0 ? dx : dy))).join(' ')} `;
  }).trim();
}

function netStyle(t, cls, width) {
  const strokeW = cls === 'control' ? t.stroke.control : width > 1 ? t.stroke.bus : t.stroke.wire;
  return {
    fill: 'none',
    stroke: cls === 'control' ? t.ctrl : t.ink,
    'stroke-width': strokeW,
    'stroke-linecap': 'butt',
    'stroke-linejoin': 'miter',
    ...(cls === 'control' ? { 'stroke-dasharray': t.dash.control.join(' ') } : {}),
  };
}
const wantsArrow = (t, cls, width) => t.arrow.at.includes(cls === 'control' ? 'control' : width > 1 ? 'bus' : 'wire');

function arrowHead(t, id, tip, ux, uy, fill) {
  const bx = tip.x - ux * t.arrow.length;
  const by = tip.y - uy * t.arrow.length;
  const hw = t.arrow.width / 2;
  return el('path', { id, d: `M${num(tip.x)} ${num(tip.y)} L${num(bx - uy * hw)} ${num(by + ux * hw)} L${num(bx + uy * hw)} ${num(by - ux * hw)} Z`, fill, stroke: 'none' });
}

// A labeled "through" stub inside a node: carries a net from the node border
// to the symbol body, with a label above the wire that never touches it.
function throughStub(skin, { id, x0, x1, y, cls, width, label, labelFont, arrowAtX1 }) {
  const t = skin.tokens;
  const style = netStyle(t, cls, width);
  const arrow = arrowAtX1 && wantsArrow(t, cls, width);
  const dir = Math.sign(x1 - x0) || 1;
  const lineEnd = arrow ? x1 - dir * t.arrow.length : x1;
  const out = [el('path', { id: `${id}-stub`, d: `M${num(x0)} ${num(y)} L${num(lineEnd)} ${num(y)}`, ...style })];
  if (arrow) out.push(arrowHead(t, `${id}-stub-arrow`, { x: x1, y }, dir, 0, style.stroke));
  if (label !== undefined) {
    const size = fontSize(t, labelFont);
    const clearance = Math.max(arrow ? t.arrow.width / 2 : 0, style['stroke-width'] / 2) + 0.5;
    const baseline = y - clearance - DESCENT * size;
    const lx = Math.min(x0, x1) + skin.symbols.mux.index_gap;
    out.push(text(skin, label, lx, baseline, labelFont, `${id}-label`));
  }
  return out;
}

// --- symbol instantiation -------------------------------------------------

function instantiate(element, skin, params, style) {
  const t = skin.tokens;
  const W = (w) => evalWidth(w, params);
  const kind = element.kind === 'comb' ? element.op : element.kind;

  if (element.kind === 'port') {
    const s = skin.symbols.port;
    const label = element.label || element.id;
    const w = textWidth(label, t.font.label_pt) + s.gap;
    const side = element.dir === 'in' ? 'EAST' : 'WEST';
    return {
      width: w, height: s.height, isPort: true,
      pins: [{ id: 'p', x: side === 'EAST' ? w : 0, y: s.height / 2, side, class: element.class || 'data', width: W(element.width) }],
      draw: (x, y) => [text(skin, label, side === 'EAST' ? x : x + s.gap, y + s.height / 2 + centerBaseline(t.font.label_pt))],
    };
  }

  if (element.kind === 'mux') {
    const s = skin.symbols.mux;
    const muxStyle = element.style ?? style.mux_style ?? s.style;
    const indices = element.indices ?? style.mux_indices ?? s.indices;
    const n = element.inputs;
    const dataW = W(element.width);
    const labelOf = (i) => (element.input_labels?.[i] ?? (element.encoding === 'onehot' ? `in${i}` : String(i)));
    const idxFont = s.index_font;

    if (muxStyle === 'bar') {
      const b = s.bar;
      const h = n * b.pin_pitch;
      const pinY = (i) => b.pin_pitch * (i + 0.5);
      const stub = indices ? Math.max(...Array.from({ length: n }, (_, i) => textWidth(labelOf(i), fontSize(t, idxFont)))) + 2 * s.index_gap + t.arrow.length : 0;
      const w = stub + b.width;
      const pins = [
        ...Array.from({ length: n }, (_, i) => ({ id: `in${i}`, x: 0, y: pinY(i), side: 'WEST', class: 'data', width: dataW, through: indices })),
        { id: 'sel', x: stub + b.width / 2, y: 0, side: s.select_side, class: 'control', width: muxSelWidth(n, element.encoding) },
        { id: 'out', x: w, y: h / 2, side: 'EAST', class: 'data', width: dataW },
      ];
      return {
        width: w, height: h, pins, shape: 'mux-bar',
        draw: (x, y, _nw, id) => [
          ...(indices ? Array.from({ length: n }, (_, i) => throughStub(skin, { id: `${id}-in${i}`, x0: x, x1: x + stub, y: y + pinY(i), cls: 'data', width: dataW, label: labelOf(i), labelFont: idxFont, arrowAtX1: true })).flat() : []),
          el('rect', { id: `${id}-body`, x: x + stub, y, width: b.width, height: h, fill: t.fill[b.fill], stroke: 'none' }),
        ],
      };
    }

    const s2 = s.trapezoid;
    const h = n * s2.pin_pitch + 2 * s2.end_pad;
    const w = s2.width;
    const inset = (h * (1 - s2.taper_ratio)) / 2;
    const pinY = (i) => s2.end_pad + s2.pin_pitch * (i + 0.5);
    const pins = [
      ...Array.from({ length: n }, (_, i) => ({ id: `in${i}`, x: 0, y: pinY(i), side: 'WEST', class: 'data', width: dataW })),
      { id: 'sel', x: w / 2, y: 0, side: s.select_side, class: 'control', width: muxSelWidth(n, element.encoding) },
      { id: 'out', x: w, y: h / 2, side: 'EAST', class: 'data', width: dataW },
    ];
    return {
      width: w, height: h, pins, shape: 'mux-trapezoid',
      polygon: (x, y) => [{ x, y }, { x: x + w, y: y + inset }, { x: x + w, y: y + h - inset }, { x, y: y + h }],
      inset: s2.index_inset + outlineW(t, 'mux') / 2,
      draw: (x, y, _nw, id) => [
        el('path', { id: `${id}-body`, d: `M${num(x)} ${num(y)} L${num(x + w)} ${num(y + inset)} L${num(x + w)} ${num(y + h - inset)} L${num(x)} ${num(y + h)} Z`, fill: t.fill[s2.fill], stroke: t.ink, 'stroke-width': outlineW(t, 'mux'), 'stroke-linejoin': 'miter' }),
        el('path', { d: `M${num(x + w / 2)} ${num(y)} L${num(x + w / 2)} ${num(y + inset / 2)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.control }),
        ...(indices ? Array.from({ length: n }, (_, i) => text(skin, labelOf(i), x + 2.5 + outlineW(t, 'mux') / 2, y + pinY(i) + centerBaseline(fontSize(t, idxFont)), idxFont, `${id}-idx${i}`)) : []),
      ],
    };
  }

  if (element.kind === 'comb' && (element.op === 'concat' || element.op === 'split')) {
    const isJoin = element.op === 'concat';
    const s = skin.symbols[isJoin ? 'join' : 'split'];
    const k = isJoin ? (element.in_widths?.length ?? element.inputs ?? 2) : element.slices.length;
    const h = k * s.pin_pitch;
    const laneY = (i) => s.pin_pitch * (i + 0.5);
    if (isJoin) {
      const header = s.label ? fontSize(t, s.label_font) + 2 : 0;
      const nodeW = Math.max(s.width, s.label ? textWidth(s.label, fontSize(t, s.label_font)) : 0);
      const bx0 = (nodeW - s.width) / 2;
      const pins = [
        ...Array.from({ length: k }, (_, i) => ({ id: `in${i}`, x: 0, y: header + laneY(i), side: 'WEST', class: 'data', width: W(element.in_widths[i]), through: bx0 > 0.01 })),
        { id: 'out', x: nodeW, y: header + h / 2, side: 'EAST', class: 'data', width: W(element.width), through: bx0 > 0.01 },
      ];
      return {
        width: nodeW, height: h + header, pins, shape: 'join',
        draw: (x, y, _nw, id) => [
          ...(bx0 > 0.01 ? [
            ...pins.filter((p) => p.side === 'WEST').flatMap((p, i) => throughStub(skin, { id: `${id}-in${i}`, x0: x, x1: x + bx0, y: y + p.y, cls: 'data', width: p.width, arrowAtX1: false })),
            ...throughStub(skin, { id: `${id}-out`, x0: x + bx0 + s.width, x1: x + nodeW, y: y + header + h / 2, cls: 'data', width: W(element.width), arrowAtX1: false }),
          ] : []),
          el('rect', { id: `${id}-body`, x: x + bx0, y: y + header, width: s.width, height: h, fill: t.fill[s.fill], stroke: 'none' }),
          ...(s.label ? [text(skin, s.label, x + (nodeW - textWidth(s.label, fontSize(t, s.label_font))) / 2, y + fontSize(t, s.label_font), s.label_font, `${id}-brace`)] : []),
        ],
      };
    }
    const labels = element.slices.map((sl) => `[${sl}]`);
    const zone = Math.max(...labels.map((l) => textWidth(l, fontSize(t, s.label_font)))) + 2 * s.label_gap;
    const nodeW = s.width + zone;
    const pins = [
      { id: 'in0', x: 0, y: h / 2, side: 'WEST', class: 'data', width: W(element.width) },
      ...element.slices.map((sl, i) => {
        const [hi, lo = hi] = sl.split(':').map(Number);
        return { id: `out${i}`, x: nodeW, y: laneY(i), side: 'EAST', class: 'data', width: Math.abs(hi - lo) + 1, through: true };
      }),
    ];
    return {
      width: nodeW, height: h, pins, shape: 'split',
      draw: (x, y, _nw, id) => [
        el('rect', { id: `${id}-body`, x, y, width: s.width, height: h, fill: t.fill[s.fill], stroke: 'none' }),
        ...pins.slice(1).flatMap((p, i) => throughStub(skin, { id: `${id}-out${i}`, x0: x + s.width, x1: x + nodeW, y: y + p.y, cls: 'data', width: p.width, label: labels[i], labelFont: s.label_font, arrowAtX1: false })),
      ],
    };
  }

  if (element.kind === 'pipeline_register') {
    const s = skin.symbols.pipeline_register;
    const lanes = element.lanes;
    const label = element.label;
    const header = label ? t.font.secondary_pt + 3 : 0;
    const barH = lanes.length * s.lane_pitch + 2 * s.margin;
    const nodeW = Math.max(s.width, label ? textWidth(label, t.font.secondary_pt) : 0);
    const bx0 = (nodeW - s.width) / 2;
    const laneY = (i) => header + s.margin + s.lane_pitch * (i + 0.5);
    const pins = lanes.flatMap((lane, i) => [
      { id: `d_${lane.id}`, x: 0, y: laneY(i), side: 'WEST', class: lane.class || 'data', width: W(lane.width) },
      { id: `q_${lane.id}`, x: nodeW, y: laneY(i), side: 'EAST', class: lane.class || 'data', width: W(lane.width) },
    ]);
    return {
      width: nodeW, height: barH + header, pins, shape: 'pipeline-bar',
      draw: (x, y, _nw, id) => {
        const bx = x + bx0;
        const stubs = bx0 > 0.01 ? lanes.map((lane, i) => {
          const ly = y + laneY(i);
          return el('path', { id: `${id}-lane${i}-stub`, d: `M${num(x)} ${num(ly)} L${num(bx)} ${num(ly)} M${num(bx + s.width)} ${num(ly)} L${num(x + nodeW)} ${num(ly)}`, ...netStyle(t, lane.class || 'data', W(lane.width)) });
        }) : [];
        return [
          ...stubs,
          el('rect', { id: `${id}-body`, x: bx, y: y + header, width: s.width, height: barH, fill: t.fill[s.fill], stroke: s.outline ? t.ink : 'none', 'stroke-width': outlineW(t, 'pipeline_register') }),
          ...(s.wedge ? [el('path', { d: `M${num(bx + 1)} ${num(y + header + barH)} L${num(bx + s.width / 2)} ${num(y + header + barH - 4)} L${num(bx + s.width - 1)} ${num(y + header + barH)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire })] : []),
          ...(label ? [text(skin, label, x + (nodeW - textWidth(label, t.font.secondary_pt)) / 2, y + t.font.secondary_pt, 'secondary')] : []),
        ];
      },
    };
  }

  const symbol = skin.symbols[kind];
  if (!symbol) throw new Error(`prototype renderer: no skin symbol for ${element.kind}${element.op ? `/${element.op}` : ''}`);
  const [w, h] = symbol.size;
  const pins = Object.entries(symbol.pins)
    .filter(([, pin]) => !pin.optional || (pin.optional === 'enable' && element.enable) || (pin.optional === 'reset_pin' && element.reset_pin))
    .map(([id, pin]) => ({ id, ...pin, width: pin.class === 'control' || pin.class === 'reset' ? 1 : W(element.width) }));
  return {
    width: w, height: h, pins, shape: kind,
    draw: (x, y) => [
      ...symbol.body.map((b) => {
        const stroke = { stroke: t.ink, 'stroke-width': b.role === 'wedge' || b.role === 'line' ? t.stroke.wire : outlineW(t, kind) };
        if (b.el === 'rect') return el('rect', { x: x + b.x, y: y + b.y, width: b.width, height: b.height, fill: t.fill[symbol.fill], ...stroke });
        return el('path', { d: translatePath(b.d, x, y), fill: b.role === 'outline' ? t.fill[symbol.fill] : 'none', ...stroke, 'stroke-linejoin': 'miter' });
      }),
      ...(symbol.text ? [text(skin, symbol.text.value, x + symbol.text.x - textWidth(symbol.text.value, t.font.label_pt) / 2, y + symbol.text.y + centerBaseline(t.font.label_pt), symbol.text.font)] : []),
      ...(symbol.label?.inside && element.label ? [text(skin, element.label, x + (w - textWidth(element.label, t.font.secondary_pt)) / 2, y + h / 2 + centerBaseline(t.font.secondary_pt) - 2, 'secondary')] : []),
    ],
  };
}

// --- stage partitions -----------------------------------------------------

function partitions(doc) {
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const stage = new Map(doc.elements.map((e) => [e.id, e.kind === 'pipeline_register' ? e.stage ?? 1 : 0]));
  for (let iter = 0; iter < doc.elements.length + 2; iter += 1) {
    let changed = false;
    for (const net of doc.nets) {
      const from = stage.get(parseEndpoint(net.driver).element);
      for (const sinkText of net.sinks) {
        const sink = byId.get(parseEndpoint(sinkText).element);
        if (sink.kind === 'pipeline_register') continue;
        if (from > stage.get(sink.id)) { stage.set(sink.id, from); changed = true; }
      }
    }
    if (!changed) break;
  }
  return new Map(doc.elements.map((e) => [e.id, e.layout?.layer ?? (e.kind === 'pipeline_register' ? 2 * stage.get(e.id) - 1 : 2 * stage.get(e.id))]));
}

// --- geometry helpers & checks ----------------------------------------------

const onSegment = (p, a, b, eps = 0.01) => (
  (Math.abs(a.x - b.x) < eps && Math.abs(p.x - a.x) < eps && p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps)
  || (Math.abs(a.y - b.y) < eps && Math.abs(p.y - a.y) < eps && p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps)
);
const onPath = (p, pts) => pts.some((a, i) => i > 0 && onSegment(p, pts[i - 1], a));

function junctions(polylines) {
  const found = [];
  polylines.forEach((pts, i) => {
    for (let k = 1; k < pts.length - 1; k += 1) {
      const p = pts[k];
      const mid = { x: (p.x + pts[k + 1].x) / 2, y: (p.y + pts[k + 1].y) / 2 };
      const leaves = polylines.some((other, j) => j !== i && onPath(p, other) && !onPath(mid, other));
      if (leaves && !found.some((f) => Math.abs(f.x - p.x) < 0.01 && Math.abs(f.y - p.y) < 0.01)) found.push(p);
    }
  });
  return found;
}

function slashSite(polylines, need) {
  for (const pts of polylines) {
    for (let k = 1; k < pts.length; k += 1) {
      const a = pts[k - 1];
      const b = pts[k];
      const horizontal = Math.abs(a.y - b.y) < 0.01;
      const len = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
      if (len >= need) return { a, b, horizontal };
    }
  }
  return null;
}

function walk(node, visit) {
  if (typeof node === 'string') return;
  visit(node);
  for (const c of node.children) walk(c, visit);
}

function textBoxes(tree) {
  const boxes = [];
  walk(tree, (n) => {
    if (n.name !== 'text') return;
    const size = Number(n.attrs['font-size']);
    const x = Number(n.attrs.x);
    const y = Number(n.attrs.y);
    boxes.push({ id: n.attrs.id, text: n.children[0], x0: x, x1: x + textWidth(n.children[0], size), y0: y - ASCENT * size, y1: y + DESCENT * size });
  });
  return boxes;
}

function wireSegments(tree) {
  const segs = [];
  walk(tree, (n) => {
    if (n.name !== 'path' || !/-(seg\d+|stub)$/.test(n.attrs.id || '')) return;
    const hw = Number(n.attrs['stroke-width']) / 2;
    const tokens = n.attrs.d.match(/[ML]\s*-?[\d.]+\s+-?[\d.]+/g) || [];
    let prev = null;
    for (const tok of tokens) {
      const [, cmd, xs, ys] = /([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/.exec(tok);
      const p = { x: Number(xs), y: Number(ys) };
      if (cmd === 'L' && prev) segs.push({ id: n.attrs.id, a: prev, b: p, hw });
      prev = p;
    }
  });
  return segs;
}

const boxesOverlap = (a, b, pad = 0) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

export function geometryChecks(tree, { polygons = [] } = {}) {
  const diagnostics = [];
  const boxes = textBoxes(tree);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxesOverlap(boxes[i], boxes[j])) diagnostics.push({ code: 'geometry/label-overlap', severity: 'error', message: `labels "${boxes[i].text}" and "${boxes[j].text}" overlap`, subject: { ids: [boxes[i].id, boxes[j].id] }, supportedFixes: ['add short_label', 'increase spacing for this variant'] });
    }
  }
  for (const box of boxes) {
    for (const s of wireSegments(tree)) {
      const seg = { x0: Math.min(s.a.x, s.b.x) - s.hw, x1: Math.max(s.a.x, s.b.x) + s.hw, y0: Math.min(s.a.y, s.b.y) - s.hw, y1: Math.max(s.a.y, s.b.y) + s.hw };
      if (boxesOverlap(box, seg, -0.05)) {
        diagnostics.push({ code: 'geometry/label-on-wire', severity: 'error', message: `label "${box.text}" touches wire ${s.id}`, subject: { label: box.id, wire: s.id }, supportedFixes: ['move the label', 'increase spacing for this variant'] });
        break;
      }
    }
  }
  for (const { id, points, margin, labelIds } of polygons) {
    const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
    const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
    for (const box of boxes.filter((b) => labelIds.includes(b.id))) {
      const corners = [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x0, y: box.y1 }, { x: box.x1, y: box.y1 }];
      const ok = points.every((a, k) => {
        const b = points[(k + 1) % points.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const side = (p) => ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len;
        const inward = Math.sign(side({ x: cx, y: cy }));
        return corners.every((c) => side(c) * inward >= margin);
      });
      if (!ok) diagnostics.push({ code: 'symbol/label-clearance', severity: 'error', message: `label "${box.text}" is closer than ${margin} pt to the outline of ${id}`, subject: { id, label: box.id }, supportedFixes: ['increase the symbol end padding', 'use mux_style bar'] });
    }
  }
  return diagnostics;
}

// --- main -------------------------------------------------------------------

export async function renderDatapathPrototype(doc, { skin = loadSkin(), variant = '2col', widthPt, name = 'figure' } = {}) {
  const t = skin.tokens;
  const params = doc.params || {};
  const style = doc.meta?.style || {};
  const diagnostics = [...checkSkin(skin)];
  const symbols = new Map(doc.elements.map((e) => [e.id, instantiate(e, skin, params, style)]));
  const part = partitions(doc);

  const pinOf = (endpointText) => {
    const ep = parseEndpoint(endpointText);
    const sym = symbols.get(ep.element);
    if (!sym) throw new Error(`unknown element in endpoint ${endpointText}`);
    const pin = sym.pins.find((p) => p.id === (ep.port ?? 'p'));
    if (!pin) throw new Error(`unknown pin in endpoint ${endpointText}`);
    return { ep, pin, width: ep.slice ? ep.slice.width : pin.width };
  };

  const edges = [];
  const netInfo = new Map();
  const connected = new Set();
  for (const net of doc.nets) {
    const width = evalWidth(net.width, params);
    const driver = pinOf(net.driver);
    const sinks = net.sinks.map(pinOf);
    for (const end of [driver, ...sinks]) {
      connected.add(`${end.ep.element}.${end.pin.id}`);
      if (end.width !== width) diagnostics.push({ code: 'width/mismatch', severity: 'error', message: `net ${net.id}: ${end.ep.element}.${end.pin.id} is ${end.width} bits, net is ${width}`, subject: { id: net.id } });
    }
    const cls = net.class || (sinks.some((s) => s.pin.class === 'control') || driver.pin.class === 'control' ? 'control' : 'data');
    netInfo.set(net.id, { net, width, cls, sinkPins: sinks.map((s) => s.pin) });
    sinks.forEach((s, i) => edges.push({ id: `${net.id}__${i}`, sources: [`${driver.ep.element}.${driver.pin.id}`], targets: [`${s.ep.element}.${s.pin.id}`] }));
  }
  for (const e of doc.elements.filter((x) => x.kind === 'mux')) {
    if (!connected.has(`${e.id}.sel`)) diagnostics.push({ code: 'symbol/mux-sel-missing', severity: 'error', message: `mux ${e.id} has no net on its select pin; a mux bar must show its select`, subject: { id: e.id }, supportedFixes: [`connect a net to ${e.id}.sel`] });
  }

  const m = t.block_margin;
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.randomSeed': 1,
      'elk.partitioning.activate': true,
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=6,left=4,bottom=6,right=4]',
      ...skin.elk.variants[variant],
    },
    children: doc.elements.map((e) => {
      const sym = symbols.get(e.id);
      return {
        id: e.id,
        width: sym.width,
        height: sym.height,
        layoutOptions: {
          'elk.portConstraints': 'FIXED_POS',
          'elk.partitioning.partition': part.get(e.id),
          ...(sym.isPort ? {} : { 'elk.margins': `[top=${m},left=0,bottom=${m},right=0]` }),
        },
        ports: sym.pins.map((p) => ({ id: `${e.id}.${p.id}`, x: p.x, y: p.y, width: 0, height: 0, layoutOptions: { 'elk.port.side': p.side } })),
      };
    }),
    edges,
  };

  const laid = await new ELK().layout(graph);
  const contentW = laid.width;
  const canvasW = widthPt ?? contentW;
  if (contentW > canvasW + 0.01) {
    diagnostics.push({ code: 'print/width-overflow', severity: 'error', message: `${variant}: content ${num(contentW)} pt exceeds column ${num(canvasW)} pt`, evidence: { contentW, canvasW }, supportedFixes: ['add short_label to wide labels', 'collapse an instance', 'drop this variant'] });
  }
  const ox = Math.max(0, (canvasW - contentW) / 2);
  const W = Math.max(canvasW, contentW);
  const H = laid.height;

  const stageGroups = new Map();
  const polygons = [];
  for (const node of laid.children) {
    const e = doc.elements.find((x) => x.id === node.id);
    const sym = symbols.get(node.id);
    const kindName = e.kind === 'comb' ? (e.op === 'concat' ? 'join' : e.op) : e.kind === 'pipeline_register' ? 'preg' : e.kind === 'register' ? 'reg' : e.kind;
    const gid = `${kindName}-${e.id}`;
    const group = el('g', { id: gid }, sym.draw(node.x + ox, node.y, node.width, gid));
    if (sym.polygon) polygons.push({ id: e.id, points: sym.polygon(node.x + ox, node.y), margin: sym.inset, labelIds: Array.from({ length: e.inputs }, (_, i) => `${gid}-idx${i}`) });
    const key = e.kind === 'port' ? 'ports' : `stage-${part.get(e.id)}`;
    if (!stageGroups.has(key)) stageGroups.set(key, []);
    stageGroups.get(key).push(group);
  }

  const byNet = new Map();
  const sinkPinOf = new Map();
  for (const edge of laid.edges) {
    const [netId, idx] = edge.id.split('__');
    const sec = edge.sections[0];
    const pts = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint].map((p) => ({ x: p.x + ox, y: p.y }));
    if (!byNet.has(netId)) byNet.set(netId, []);
    byNet.get(netId).push(pts);
    sinkPinOf.set(`${netId}__${byNet.get(netId).length - 1}`, netInfo.get(netId).sinkPins[Number(idx)]);
  }

  const netGroups = { data: [], control: [] };
  const unlabeledBuses = [];
  let minStroke = Infinity;
  for (const [netId, polylines] of byNet) {
    const { width, cls } = netInfo.get(netId);
    const nstyle = netStyle(t, cls, width);
    minStroke = Math.min(minStroke, nstyle['stroke-width']);
    const segs = [];
    const heads = [];
    polylines.forEach((pts, i) => {
      const draw = pts.map((p) => ({ ...p }));
      const sinkPin = sinkPinOf.get(`${netId}__${i}`);
      if (wantsArrow(t, cls, width) && !sinkPin?.through) {
        const a = draw[draw.length - 2];
        const b = draw[draw.length - 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        draw[draw.length - 1] = { x: b.x - ux * Math.min(t.arrow.length, len * 0.8), y: b.y - uy * Math.min(t.arrow.length, len * 0.8) };
        heads.push(arrowHead(t, `net-${netId}-arrow${i}`, b, ux, uy, nstyle.stroke));
      }
      segs.push(el('path', { id: `net-${netId}-seg${i}`, d: draw.map((p, k) => `${k ? 'L' : 'M'}${num(p.x)} ${num(p.y)}`).join(' '), ...nstyle }));
    });
    const extras = [];
    for (const [k, j] of junctions(polylines).entries()) {
      extras.push(el('circle', { id: `net-${netId}-dot${k}`, cx: j.x, cy: j.y, r: Math.max((t.junction_diam_factor * nstyle['stroke-width']) / 2, 1.2), fill: nstyle.stroke, stroke: 'none' }));
    }
    if (width > 1) {
      const s = t.bus_slash;
      const d = s.length / 2 / Math.SQRT2;
      const site = slashSite(polylines, s.offset + s.length + t.arrow.length);
      if (!site) {
        unlabeledBuses.push(netId);
      } else if (site.horizontal) {
        const cx = site.a.x + Math.sign(site.b.x - site.a.x) * s.offset;
        extras.push(el('path', { id: `net-${netId}-slash`, d: `M${num(cx - d)} ${num(site.a.y + d)} L${num(cx + d)} ${num(site.a.y - d)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }));
        extras.push(text(skin, String(width), cx - textWidth(String(width), t.font.secondary_pt) / 2 + 1.5, site.a.y - d - s.label_gap, 'secondary', `net-${netId}-width`));
      } else {
        const cy = site.a.y + Math.sign(site.b.y - site.a.y) * s.offset;
        extras.push(el('path', { id: `net-${netId}-slash`, d: `M${num(site.a.x - d)} ${num(cy + d)} L${num(site.a.x + d)} ${num(cy - d)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }));
        extras.push(text(skin, String(width), site.a.x + d + s.label_gap, cy + centerBaseline(t.font.secondary_pt), 'secondary', `net-${netId}-width`));
      }
    }
    netGroups[cls === 'control' ? 'control' : 'data'].push(el('g', { id: `net-${netId}` }, [...segs, ...heads, ...extras]));
  }
  if (unlabeledBuses.length) {
    diagnostics.push({ code: 'print/width-label-omitted', severity: 'info', message: `${variant}: no room for a slash-N width label on ${unlabeledBuses.join(', ')}`, subject: { ids: unlabeledBuses }, supportedFixes: ['state the common bus width in the caption', 'use the 2col variant', 'increase layer spacing for this variant'] });
  }

  const datapathChildren = [...stageGroups.entries()]
    .sort(([a], [b]) => (a === 'ports' ? -1 : b === 'ports' ? 1 : Number(a.split('-')[1]) - Number(b.split('-')[1])))
    .map(([key, groups]) => el('g', { id: key }, groups));

  const svg = el('svg', { xmlns: 'http://www.w3.org/2000/svg', id: `fig-${name}-${variant}`, width: `${num(W)}pt`, height: `${num(H)}pt`, viewBox: `0 0 ${num(W)} ${num(H)}` }, [
    el('g', { id: 'frame' }, [el('rect', { x: 0, y: 0, width: W, height: H, fill: t.background, stroke: 'none' })]),
    el('g', { id: 'nets' }, [el('g', { id: 'nets-data' }, netGroups.data), el('g', { id: 'nets-control' }, netGroups.control)]),
    el('g', { id: 'datapath' }, datapathChildren),
  ]);
  diagnostics.push(...geometryChecks(svg, { polygons }));

  return {
    svg: `${serialize(svg)}\n`,
    width_pt: W,
    height_pt: H,
    content_width_pt: contentW,
    min_font_pt: Math.min(t.font.label_pt, t.font.secondary_pt),
    min_stroke_pt: Math.min(minStroke, t.stroke.wire, outlineW(t, 'default')),
    diagnostics,
  };
}
