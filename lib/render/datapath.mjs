// Datapath renderer: skin-driven ELK layout → figma-safe SVG (SPEC §9–10).
// Per variant: the normal layout, then one retry with short labels and
// tighter spacing (SPEC §9.5); 2col spreads layer spacing to use the column
// (≤ 3×) and centers the rest. Framed regions are ELK compound nodes, so a
// frame encloses exactly its members. After layout a straightening pass
// removes redundant jogs on data nets (SPEC §9.4). Text is measured with the
// bundled font; labels are placed collision-free and checked afterwards.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ELK from 'elkjs/lib/elk.bundled.js';
import { PRODUCT_NOTATION, functionNames } from '../checks/labels.mjs';
import { isBundleNet } from '../checks/datapath.mjs';
import { deriveNetClasses } from '../checks/net-class.mjs';
import { checkSkin } from '../checks/skin.mjs';
import { loadFont } from '../fonts.mjs';
import { buildModel } from '../ir/datapath-model.mjs';
import { parseEndpoint } from '../ir/endpoints.mjs';
import { el, num, pathD, printMetrics, serialize, walk } from '../svg.mjs';
import { connectivityChecks } from './connectivity.mjs';
import { GATE_OPS, drawGate, gateGeometry, hatchRect } from './gates.mjs';
import { geometryChecks } from './geometry.mjs';
import { OP_GLYPH, circleOp, fieldRanges } from './glyphs.mjs';
import { LabelPlacer } from './labels.mjs';
import { crossingCounts, dataJogs, edgeHugging } from './route-metrics.mjs';
import { justifyBends, regionBox, routeScore, straighten } from './straighten.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAX_SPREAD = 3;
export const SPREAD_TARGET = 0.9;

export function loadSkin(name = 'netlist-mono') {
  return JSON.parse(fs.readFileSync(path.join(root, 'skins', name, 'skin.json'), 'utf8'));
}

export function renderContext(doc, skin, variant, mode) {
  const style = doc.meta?.style || {};
  const family = style.font_family ? `${style.font_family}, ${loadFont(style.font_family).css}` : skin.tokens.font.family;
  const font = loadFont(family);
  return {
    doc, skin, t: skin.tokens, style, variant, mode, family, font,
    measure: (s, size) => font.measure(s, size),
    base: (size) => (font.ascent * size) / 2,
  };
}

export const fontSize = (ctx, key) => (key === 'label' ? ctx.t.font.label_pt : ctx.t.font.secondary_pt);

export function text(ctx, value, x, y, sizeKey = 'label', id) {
  return el('text', { ...(id ? { id } : {}), x, y, 'font-family': ctx.family, 'font-size': fontSize(ctx, sizeKey), fill: ctx.t.ink }, [String(value)]);
}

export function labelOf(ctx, obj, fallback) {
  const pref = obj.labels?.[ctx.variant] ?? (ctx.mode === 'short' ? 'short' : 'full');
  if (pref === 'short' && obj.short_label) return obj.short_label;
  return obj.label ?? fallback;
}

// Printed primary name: an explicit label, else the functional name from the
// vocabulary (CONVENTIONS §4.3); short mode prefers readable short words.
export function elementTitle(ctx, e, fallback) {
  const names = functionNames(e.function);
  const pref = e.labels?.[ctx.variant] ?? (ctx.mode === 'short' ? 'short' : 'full');
  if (pref === 'short') return e.short_label ?? names?.short ?? e.label ?? names?.display ?? fallback;
  return e.label ?? names?.display ?? fallback;
}

export const outlineW = (t, kind) => (typeof t.stroke.outline === 'number' ? t.stroke.outline : (t.stroke.outline[kind] ?? t.stroke.outline.default));

// One stroke weight for every net, whatever its bit width (CONVENTIONS §1):
// the width is carried by the slash-N label only; control is told apart by
// its dash, not its weight.
export function netStyle(t, cls, _width) {
  const strokeW = cls === 'control' || cls === 'reset' ? (t.stroke.control ?? t.stroke.wire) : t.stroke.wire;
  const dash = cls === 'control' ? t.dash.control : cls === 'reset' ? t.dash.reset : null;
  return {
    fill: 'none',
    stroke: cls === 'control' ? t.ctrl : t.ink,
    'stroke-width': strokeW,
    'stroke-linecap': 'butt',
    'stroke-linejoin': 'miter',
    ...(dash ? { 'stroke-dasharray': dash.join(' ') } : {}),
  };
}
// Whether the skin draws a head for this net kind. CONVENTIONS §1: every net
// ending at a block input pin or a figure output port has one, whatever its
// width or class; a skin that leaves a kind out fails arrow/missing.
// Data of any width is one kind ("data"); a legacy skin that still lists
// "bus"/"wire" is read by width.
const legacyAt = (t) => !t.arrow.at.includes('data') && (t.arrow.at.includes('bus') || t.arrow.at.includes('wire'));
const arrowKind = (cls, width, t = null) => (cls !== 'data' ? cls : t && legacyAt(t) ? (width > 1 ? 'bus' : 'wire') : 'data');
const wantsArrow = (t, cls, width) => t.arrow.at.includes(arrowKind(cls, width, t));

export function arrowHead(t, id, tip, ux, uy, fill, { open = false, length = t.arrow.length, width = t.arrow.width } = {}) {
  const bx = tip.x - ux * length;
  const by = tip.y - uy * length;
  const hw = width / 2;
  const d = `M${num(bx - uy * hw)} ${num(by + ux * hw)} L${num(tip.x)} ${num(tip.y)} L${num(bx + uy * hw)} ${num(by - ux * hw)}${open ? '' : ' Z'}`;
  return open
    ? el('path', { id, d, fill: 'none', stroke: fill, 'stroke-width': t.stroke.wire, 'stroke-linejoin': 'miter' })
    : el('path', { id, d, fill, stroke: 'none' });
}

function translatePath(d, dx, dy) {
  return d.replace(/([MLQA])([^MLQAZ]*)/g, (m, cmd, args) => {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === 'A') return `A${[n[0], n[1], n[2], n[3], n[4], num(n[5] + dx), num(n[6] + dy)].join(' ')} `;
    return `${cmd}${n.map((v, i) => num(v + (i % 2 === 0 ? dx : dy))).join(' ')} `;
  }).trim();
}

function throughStub(ctx, { id, x0, x1, y, cls, width, label, labelFont, arrowAtX1 }) {
  const t = ctx.t;
  const style = netStyle(t, cls, width);
  const arrow = arrowAtX1 && wantsArrow(t, cls, width);
  const dir = Math.sign(x1 - x0) || 1;
  const out = [el('path', { id: `${id}-stub`, d: `M${num(x0)} ${num(y)} L${num(arrow ? x1 - dir * t.arrow.length : x1)} ${num(y)}`, ...style })];
  if (arrow) out.push(arrowHead(t, `${id}-stub-arrow`, { x: x1, y }, dir, 0, style.stroke));
  if (label !== undefined) {
    const size = fontSize(ctx, labelFont);
    const clearance = Math.max(arrow ? t.arrow.width / 2 : 0, style['stroke-width'] / 2) + 0.5;
    out.push(text(ctx, label, Math.min(x0, x1) + ctx.skin.symbols.mux.index_gap, y - clearance - ctx.font.descent * size * 0.6, labelFont, `${id}-label`));
  }
  return out;
}

const OP_TITLE = {
  cmp: (e) => ({ eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' }[e.cmp || 'eq']),
  shift: (e) => ({ left: '<<', right: '>>', arith: '>>>' }[e.dir || 'left']),
  reduce: (e) => ({ and: '&', or: '|', xor: '^' }[e.reduce || 'or']),
  not: () => '~', buf: () => 'buf', sub: () => '-', mul: () => '×', add: () => '+',
  and: () => '&', or: () => '|', xor: () => '^', nand: () => 'NAND', nor: () => 'NOR', xnor: () => 'XNOR',
  lut: () => 'LUT', rom: () => 'ROM', custom: (e) => e.id,
};

// Break a long block name into two balanced lines when that saves width.
function wrapTitle(ctx, title, size) {
  const full = ctx.measure(title, size);
  const words = String(title).split(' ');
  if (words.length < 2 || full <= 40) return [title];
  let best = null;
  for (let k = 1; k < words.length; k += 1) {
    const lines = [words.slice(0, k).join(' '), words.slice(k).join(' ')];
    const w = Math.max(...lines.map((s) => ctx.measure(s, size)));
    if (!best || w < best.w) best = { lines, w };
  }
  return best.w < full * 0.8 ? best.lines : [title];
}

// --- generic rectangular block (comb ops, custom, memory, instance, sync) --

function genericBlock(ctx, element, pins, { title, sub, fillKey = 'logic', memory = false, pinLabels = false, wedge = false, kind = 'block', glyph = 'labeled-block', titleFont = 'label', wrap = true }) {
  const t = ctx.t;
  const pitch = 12;
  const L = fontSize(ctx, titleFont);
  const S = t.font.secondary_pt;
  // Control inputs enter from the top only as side inputs of a block that
  // also takes data; an all-control block (classifier, enable logic) takes
  // them on the left so the control flow reads left to right without loops.
  const hasDataIn = pins.some((p) => p.dir === 'in' && !['control', 'clock', 'reset'].includes(p.class));
  // A tap (layout plan) enters from below: its net continues past the block
  // as a straight trunk underneath, and only a branch rises into the pin.
  const side = (p) => String(p.side || (ctx.plan?.taps.has(`${element.id}.${p.id}`) ? 'south' : p.dir === 'out' ? 'east' : p.class === 'control' && !pinLabels && hasDataIn ? 'north' : (p.class === 'reset' || p.class === 'clock') && !pinLabels ? 'south' : 'west')).toUpperCase();
  const groups = { WEST: [], EAST: [], NORTH: [], SOUTH: [] };
  for (const p of pins) groups[side(p)].push(p);
  const pinText = (p) => (ctx.mode === 'short' && p.short_label ? p.short_label : (p.label ?? p.id));
  const lw = pinLabels ? Math.max(0, ...groups.WEST.map((p) => ctx.measure(pinText(p), S))) : 0;
  const rw = pinLabels ? Math.max(0, ...groups.EAST.map((p) => ctx.measure(pinText(p), S))) : 0;
  const lines = wrap ? wrapTitle(ctx, title, L) : [title];
  const lineH = L * 1.15;
  const titleW = Math.max(...lines.map((s) => ctx.measure(s, L)));
  const titleH = L + (lines.length - 1) * lineH;
  const subLines = sub ? String(sub).split('\n') : [];
  const subW = subLines.length ? Math.max(...subLines.map((l) => ctx.measure(l, S))) : 0;
  const subH = subLines.length ? subLines.length * (S + 1) + 2 : 0;
  const northLabelH = pinLabels && groups.NORTH.length ? S + 2 : 0;
  const w = Math.max(24, (pinLabels ? lw + rw + 12 : 0) + Math.max(titleW, subW) + 10, (groups.NORTH.length + 1) * pitch, (groups.SOUTH.length + 1) * pitch);
  const rows = Math.max(groups.WEST.length, groups.EAST.length, 1);
  // Height is a whole number of pin pitches, and west/east pins share one
  // grid (offset pitch/2 + k·pitch), so lanes entering and leaving the block
  // can both line up with their neighbours (no forced data jogs).
  // A clock wedge on the bottom edge keeps its own strip below the text.
  const wedgeH = wedge ? 6 : 0;
  const h = Math.ceil(Math.max(rows * pitch, titleH + subH + 8 + northLabelH + wedgeH, 20) / pitch) * pitch;
  const placed = [];
  const distribute = (list, horizontal) => list.forEach((p, i) => {
    const span = horizontal ? w : h;
    const off = horizontal ? (span - list.length * pitch) / 2 + pitch * (i + 0.5) : pitch * (Math.floor((span / pitch - list.length) / 2) + i + 0.5);
    placed.push({ ...p, x: horizontal ? off : (side(p) === 'EAST' ? w : 0), y: horizontal ? (side(p) === 'SOUTH' ? h : 0) : off, side: side(p) });
  });
  distribute(groups.WEST, false);
  distribute(groups.EAST, false);
  distribute(groups.NORTH, true);
  distribute(groups.SOUTH, true);
  return {
    width: w, height: h, pins: placed, shape: kind, glyph,
    draw: (x, y, _nw, id) => {
      const out = [el('rect', { id: `${id}-body`, x, y, width: w, height: h, fill: t.fill[fillKey], stroke: t.ink, 'stroke-width': outlineW(t, kind) })];
      if (memory) out.push(el('path', { d: `M${num(x + 2.5)} ${num(y)} L${num(x + 2.5)} ${num(y + h)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }));
      if (wedge) out.push(el('path', { d: `M${num(x + w / 2 - 3)} ${num(y + h)} L${num(x + w / 2)} ${num(y + h - 4.5)} L${num(x + w / 2 + 3)} ${num(y + h)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }));
      const cx = x + (pinLabels ? lw + 6 : 0) + (w - (pinLabels ? lw + rw + 12 : 0)) / 2;
      const blockH = titleH + subH;
      const top = y + northLabelH / 2 + (h - wedgeH - blockH) / 2;
      lines.forEach((s, i) => out.push(text(ctx, s, cx - ctx.measure(s, L) / 2, top + L / 2 + i * lineH + ctx.base(L), titleFont, `${id}-title${i ? i + 1 : ''}`)));
      subLines.forEach((l, i) => out.push(text(ctx, l, cx - ctx.measure(l, S) / 2, top + titleH + 3 + S / 2 + i * (S + 1) + ctx.base(S), 'secondary', `${id}-sub${i ? i + 1 : ''}`)));
      if (pinLabels) {
        for (const p of placed) {
          const label = pinText(p);
          const pw = ctx.measure(label, S);
          if (p.side === 'WEST') out.push(text(ctx, label, x + 4, y + p.y + ctx.base(S), 'secondary', `${id}-pin-${p.id}`));
          if (p.side === 'EAST') out.push(text(ctx, label, x + w - 4 - pw, y + p.y + ctx.base(S), 'secondary', `${id}-pin-${p.id}`));
          if (p.side === 'NORTH') out.push(text(ctx, label, x + p.x - pw / 2, y + S + 1, 'secondary', `${id}-pin-${p.id}`));
        }
      }
      return out;
    },
  };
}

// --- symbol instantiation -------------------------------------------------

function instantiate(ctx, element, modelPins) {
  const { t, skin } = ctx;
  const widthOf = (id) => modelPins.find((p) => p.id === id)?.width ?? 1;
  const names = functionNames(element.function);
  const inGateRegion = (ctx.doc.regions || []).some((r) => r.level === 'gate' && r.members.includes(element.id));

  // Off-page connector (CONVENTIONS §1.6): a hollow tag pointing along the flow
  // with the net name inside; the source tag takes the wire on its back, the
  // target tag gives it from its tip.
  if (element.kind === 'port' && element.connector) {
    const s = skin.symbols.connector;
    const LS = fontSize(ctx, s.label_font);
    const label = labelOf(ctx, element, element.label);
    const w = ctx.measure(label, LS) + 2 * s.pad + s.tip;
    const h = s.height;
    const p = modelPins[0];
    const source = element.connector === 'source';
    return {
      width: w, height: h, isPort: true, glyph: 'connector', shape: 'connector',
      pins: [{ ...p, x: source ? 0 : w, y: h / 2, side: source ? 'WEST' : 'EAST' }],
      draw: (x, y, _nw, id) => [
        el('path', { id: `${id}-body`, d: `M${num(x)} ${num(y)} L${num(x + w - s.tip)} ${num(y)} L${num(x + w)} ${num(y + h / 2)} L${num(x + w - s.tip)} ${num(y + h)} L${num(x)} ${num(y + h)} Z`, fill: t.fill[s.fill], stroke: t.ink, 'stroke-width': outlineW(t, 'connector'), 'stroke-linejoin': 'miter' }),
        text(ctx, label, x + s.pad, y + h / 2 + ctx.base(LS), s.label_font, `${id}-label`),
      ],
    };
  }

  if (element.kind === 'port' || element.kind === 'const') {
    const s = skin.symbols.port;
    const label = element.kind === 'const' ? element.value : elementTitle(ctx, element, element.id);
    const w = ctx.measure(label, t.font.label_pt) + s.gap;
    const drives = element.kind === 'const' || element.dir === 'in';
    const p = modelPins[0];
    return {
      width: w, height: s.height, isPort: true, glyph: 'port-label',
      pins: [{ ...p, x: drives ? w : 0, y: s.height / 2, side: drives ? 'EAST' : 'WEST' }],
      draw: (x, y, _nw, id) => [text(ctx, label, drives ? x : x + s.gap, y + s.height / 2 + ctx.base(t.font.label_pt), 'label', `${id}-label`)],
    };
  }

  if (element.kind === 'mux') {
    const s = skin.symbols.mux;
    const muxStyle = element.style ?? ctx.style.mux_style ?? s.style;
    const indices = element.indices ?? ctx.style.mux_indices ?? s.indices;
    const n = element.inputs;
    const dataW = widthOf('out');
    const selPin = modelPins.find((p) => p.id === 'sel');
    const labelOfIdx = (i) => (element.input_labels?.[i] ?? (element.encoding === 'onehot' ? `in${i}` : String(i)));
    const idxFont = s.index_font;
    // Bit-sliced replicas: say what repeats ("6 × 8-bit"), not a bare ×6.
    // No lane caption: widths are single integers (CONVENTIONS §2.1); symbol
    // structure belongs in the caption or function.detail.
    const lanesLabel = null;
    const footer = lanesLabel ? t.font.secondary_pt + 3 : 0;
    if (muxStyle === 'bar') {
      const b = s.bar;
      const h = n * b.pin_pitch;
      const pinY = (i) => b.pin_pitch * (i + 0.5);
      const stub = indices ? Math.max(...Array.from({ length: n }, (_, i) => ctx.measure(labelOfIdx(i), fontSize(ctx, idxFont)))) + 2 * s.index_gap + t.arrow.length : 0;
      // The lane label hangs centered under the bar and may be wider than the
      // node (geometry checks verify it touches nothing); it does not widen
      // the layer.
      const lanesW = lanesLabel ? ctx.measure(lanesLabel, t.font.secondary_pt) : 0;
      const w = stub + b.width;
      const barX = stub;
      const pins = [
        ...Array.from({ length: n }, (_, i) => ({ id: `in${i}`, dir: 'in', class: 'data', width: dataW, x: 0, y: pinY(i), side: 'WEST', through: indices || barX > 0.01 })),
        { ...selPin, x: barX + b.width / 2, y: 0, side: s.select_side },
        { id: 'out', dir: 'out', class: 'data', width: dataW, x: w, y: h / 2, side: 'EAST' },
      ];
      return {
        // Lane label is right-aligned under the bar: it overhangs to the left
        // only, keeping the space after the output free (e.g. for a slice label).
        width: w, height: h + footer, pins, shape: 'mux-bar', glyph: 'mux-bar', overhang: { left: Math.max(0, lanesW - w), right: 0 },
        draw: (x, y, _nw, id) => [
          ...(indices ? Array.from({ length: n }, (_, i) => throughStub(ctx, { id: `${id}-in${i}`, x0: x, x1: x + barX, y: y + pinY(i), cls: 'data', width: dataW, label: labelOfIdx(i), labelFont: idxFont, arrowAtX1: true })).flat()
            : barX > 0.01 ? Array.from({ length: n }, (_, i) => throughStub(ctx, { id: `${id}-in${i}`, x0: x, x1: x + barX, y: y + pinY(i), cls: 'data', width: dataW, arrowAtX1: true })).flat() : []),
          ...(barX + b.width < w - 0.01 ? [el('path', { id: `${id}-out-stub`, d: `M${num(x + barX + b.width)} ${num(y + h / 2)} L${num(x + w)} ${num(y + h / 2)}`, ...netStyle(t, 'data', dataW) })] : []),
          el('rect', { id: `${id}-body`, x: x + barX, y, width: b.width, height: h, fill: t.fill[b.fill], stroke: 'none' }),
          ...(lanesLabel ? [text(ctx, lanesLabel, x + w - lanesW, y + h + t.font.secondary_pt + 1, 'secondary', `${id}-lanes`)] : []),
        ],
      };
    }
    const s2 = s.trapezoid;
    const h = n * s2.pin_pitch + 2 * s2.end_pad;
    const w = s2.width;
    const inset = (h * (1 - s2.taper_ratio)) / 2;
    const pinY = (i) => s2.end_pad + s2.pin_pitch * (i + 0.5);
    const pins = [
      ...Array.from({ length: n }, (_, i) => ({ id: `in${i}`, dir: 'in', class: 'data', width: dataW, x: 0, y: pinY(i), side: 'WEST' })),
      { ...selPin, x: w / 2, y: 0, side: s.select_side },
      { id: 'out', dir: 'out', class: 'data', width: dataW, x: w, y: h / 2, side: 'EAST' },
    ];
    return {
      width: w, height: h + footer, pins, shape: 'mux-trapezoid', glyph: 'mux-trapezoid',
      polygon: (x, y) => [{ x, y }, { x: x + w, y: y + inset }, { x: x + w, y: y + h - inset }, { x, y: y + h }],
      inset: s2.index_inset + outlineW(t, 'mux') / 2,
      draw: (x, y, _nw, id) => [
        el('path', { id: `${id}-body`, d: `M${num(x)} ${num(y)} L${num(x + w)} ${num(y + inset)} L${num(x + w)} ${num(y + h - inset)} L${num(x)} ${num(y + h)} Z`, fill: t.fill[s2.fill], stroke: t.ink, 'stroke-width': outlineW(t, 'mux'), 'stroke-linejoin': 'miter' }),
        el('path', { d: `M${num(x + w / 2)} ${num(y)} L${num(x + w / 2)} ${num(y + inset / 2)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.control }),
        ...(indices ? Array.from({ length: n }, (_, i) => text(ctx, labelOfIdx(i), x + 2.5 + outlineW(t, 'mux') / 2, y + pinY(i) + ctx.base(fontSize(ctx, idxFont)), idxFont, `${id}-idx${i}`)) : []),
        ...(lanesLabel ? [text(ctx, lanesLabel, x + w / 2 - ctx.measure(lanesLabel, t.font.secondary_pt) / 2, y + h + t.font.secondary_pt + 1, 'secondary', `${id}-lanes`)] : []),
      ],
    };
  }

  // Concatenation (CONVENTIONS §2.3.3): hollow outlined box named by the word
  // "concat", MSB field on top, each input labeled inside the box with its
  // destination range in the result.
  if (element.kind === 'comb' && element.op === 'concat') {
    const s = skin.symbols.join;
    const LS = fontSize(ctx, s.label_font);
    const ins = modelPins.filter((p) => p.dir === 'in');
    const out = modelPins.find((p) => p.dir === 'out');
    const ranges = s.input_range_labels ? fieldRanges(ins.map((p) => p.width)) : [];
    // One row per input plus a row for the word, inserted in the middle; the
    // output leaves on the word row (on the pin grid). Each destination range
    // sits just inside the box on its input's row, so the box is only as wide
    // as its longest text and needs no label zone in front of it.
    const wordRow = Math.floor(Math.max(ins.length, 1) / 2);
    const rows = Math.max(ins.length, 1) + 1;
    const laneY = (i) => s.pin_pitch * (i + (i >= wordRow ? 1 : 0) + 0.5);
    const wordY = s.pin_pitch * (wordRow + 0.5);
    const h = rows * s.pin_pitch;
    const pad = s.label_gap + outlineW(t, 'concat');
    const W = Math.max(s.min_width, ctx.measure(s.label, LS) + 2 * pad, ...ranges.map((r) => ctx.measure(r, LS) + 2 * pad));
    const pins = [...ins.map((p, i) => ({ ...p, x: 0, y: laneY(i), side: 'WEST' })), { ...out, x: W, y: wordY, side: 'EAST' }];
    return {
      width: W, height: h, pins, shape: 'concat', glyph: 'concat-box',
      draw: (x, y, _nw, id) => [
        el('rect', { id: `${id}-body`, x, y, width: W, height: h, fill: t.fill[s.fill], stroke: t.ink, 'stroke-width': outlineW(t, 'concat') }),
        ...ranges.map((r, i) => text(ctx, r, x + pad, y + laneY(i) + ctx.base(LS), s.label_font, `${id}-range${i}`)),
        text(ctx, s.label, x + (W - ctx.measure(s.label, LS)) / 2, y + wordY + ctx.base(LS), s.label_font, `${id}-title`),
      ],
    };
  }

  // Split (CONVENTIONS §2.3.1): the bus is a spine, each slice leaves through
  // a 45° ripper stub labeled [msb:lsb]; no dot, no body. One slice only is a
  // truncation (§2.3.2): a label on a straight wire.
  if (element.kind === 'comb' && element.op === 'split') {
    const input = modelPins.find((p) => p.dir === 'in');
    const outs = modelPins.filter((p) => p.dir === 'out');
    const labels = element.slices.map((sl) => `[${sl}]`);
    if (outs.length === 1) {
      const s = skin.symbols.truncate;
      const LS = fontSize(ctx, s.label_font);
      const lw = ctx.measure(labels[0], LS);
      const W = Math.max(s.min_length, lw + 2 * s.label_gap + 4);
      // Wire on the shared pin grid (pitch/2 + pitch); the label sits in the row above.
      const yw = 18;
      const style = netStyle(t, 'data', outs[0].width);
      return {
        width: W, height: yw + 3, shape: 'truncation', glyph: 'truncation-label',
        pins: [{ ...input, x: 0, y: yw, side: 'WEST', through: true }, { ...outs[0], x: W, y: yw, side: 'EAST' }],
        draw: (x, y, _nw, id) => [
          el('path', { id: `${id}-wire-stub`, d: `M${num(x)} ${num(y + yw)} L${num(x + W)} ${num(y + yw)}`, ...style }),
          text(ctx, labels[0], x + (W - lw) / 2, y + yw - style['stroke-width'] / 2 - 0.8 - ctx.font.descent * LS * 0.6, s.label_font, `${id}-slice`),
        ],
      };
    }
    const s = skin.symbols.split;
    const LS = fontSize(ctx, s.label_font);
    const d = s.stub / Math.SQRT2;
    const labelW = Math.max(...labels.map((l) => ctx.measure(l, LS)));
    const xs = s.in_stub;
    const tapY = (i) => s.pin_pitch * (i + 1.5);
    // The input enters on the shared pin grid one pitch above the first tap;
    // the spine runs down past it, so the wire's end stays on its pin exactly.
    const yIn = tapY(0) - s.pin_pitch;
    const yLast = tapY(outs.length - 1);
    const W = xs + d + 2 * s.label_gap + labelW + 4;
    const inStyle = netStyle(t, 'data', input.width);
    return {
      width: W, height: yLast + 4, shape: 'split', glyph: 'split-taps',
      pins: [{ ...input, x: 0, y: yIn, side: 'WEST', through: true }, ...outs.map((p, i) => ({ ...p, x: W, y: tapY(i), side: 'EAST' }))],
      draw: (x, y, _nw, id) => [
        el('path', { id: `${id}-in-stub`, d: `M${num(x)} ${num(y + yIn)} L${num(x + xs)} ${num(y + yIn)}`, ...inStyle }),
        ...(outs.length > 1 ? [el('path', { id: `${id}-spine`, d: `M${num(x + xs)} ${num(y + yIn)} L${num(x + xs)} ${num(y + yLast - d)}`, ...inStyle })] : []),
        ...outs.flatMap((p, i) => {
          const style = netStyle(t, 'data', p.width);
          const yi = y + tapY(i);
          return [
            el('path', { id: `${id}-tap${i}-stub`, d: `M${num(x + xs)} ${num(yi - d)} L${num(x + xs + d)} ${num(yi)} L${num(x + W)} ${num(yi)}`, ...style }),
            text(ctx, labels[i], x + xs + d + s.label_gap, yi - style['stroke-width'] / 2 - 0.8 - ctx.font.descent * LS * 0.6, s.label_font, `${id}-slice${i}`),
          ];
        }),
      ],
    };
  }

  if (element.kind === 'comb' && (element.op === 'extend' || element.op === 'replicate')) {
    // Bus operations are named by a word, never by Verilog braces (CONVENTIONS §2.3, §3.5).
    const title = element.op === 'extend'
      ? skin.symbols.extend.labels[element.extend === 'sign' ? 'sign' : 'zero']
      : (skin.symbols.replicate.label ?? 'repl ×{N}').replace('{N}', String(element.count));
    return genericBlock(ctx, element, modelPins, { title, titleFont: skin.symbols[element.op].label_font, kind: element.op, glyph: `${element.op}-box`, wrap: false });
  }

  if (element.kind === 'pipeline_register') {
    const s = skin.symbols.pipeline_register;
    // Layout plan: a lane whose net passes under a neighbouring block (tap)
    // goes below the lanes attached to that block's pins, and far enough down
    // to clear the block's bottom edge on the pin grid.
    const needs = ctx.plan?.lanes.get(element.id) || [];
    const order = element.lanes.map((l) => l.id);
    for (const r of needs.filter((x) => x.attach.length)) {
      const lastAttached = r.attach.map((a) => a.lane).sort((a, b) => order.indexOf(a) - order.indexOf(b)).at(-1);
      if (order.indexOf(r.lane) < order.indexOf(lastAttached)) {
        order.splice(order.indexOf(r.lane), 1);
        order.splice(order.indexOf(lastAttached) + 1, 0, r.lane);
      }
    }
    const lanes = order.map((id) => element.lanes.find((l) => l.id === id));
    const extra = lanes.map(() => 0);
    const clearance = t.arrow.length + 6;
    for (const r of needs.filter((x) => x.attach.length).sort((a, b) => order.indexOf(a.lane) - order.indexOf(b.lane))) {
      const block = ctx.symbols?.get(r.block);
      const last = r.attach.slice().sort((a, b) => order.indexOf(a.lane) - order.indexOf(b.lane)).at(-1);
      const pin = block?.pins.find((p) => p.id === last.pin);
      if (!pin) continue;
      const [iL, ia] = [order.indexOf(r.lane), order.indexOf(last.lane)];
      const natural = (iL - ia) * s.lane_pitch + extra[iL] - extra[ia];
      const need = block.height - pin.y + clearance;
      if (need <= natural) continue;
      const add = Math.ceil((need - natural) / s.lane_pitch) * s.lane_pitch;
      for (let i = iL; i < extra.length; i += 1) extra[i] += add;
    }
    const label = labelOf(ctx, element, undefined);
    // No header: the stage label is placed above the bar after routing
    // (overLabel), and lanes sit on the shared pin grid (pitch/2 + k·pitch).
    const header = 0;
    const barH = lanes.length * s.lane_pitch + 2 * s.margin + (extra.at(-1) ?? 0);
    // The stage label is centered above the bar and may overhang it; the bar
    // itself sets the layer width (geometry checks verify the label is clear).
    const nodeW = s.width;
    const bx0 = 0;
    const laneY = (i) => header + s.margin + s.lane_pitch * (i + 0.5) + extra[i];
    const pins = lanes.flatMap((lane, i) => [
      { ...modelPins.find((p) => p.id === `d_${lane.id}`), x: 0, y: laneY(i), side: 'WEST' },
      { ...modelPins.find((p) => p.id === `q_${lane.id}`), x: nodeW, y: laneY(i), side: 'EAST' },
    ]);
    return {
      width: nodeW, height: barH + header, pins, shape: 'pipeline-bar', glyph: 'pipeline-bar',
      draw: (x, y, _nw, id) => {
        const bx = x + bx0;
        return [
          ...(bx0 > 0.01 ? lanes.map((lane, i) => el('path', { id: `${id}-lane${i}-stub`, d: `M${num(x)} ${num(y + laneY(i))} L${num(bx)} ${num(y + laneY(i))} M${num(bx + s.width)} ${num(y + laneY(i))} L${num(x + nodeW)} ${num(y + laneY(i))}`, ...netStyle(t, lane.class || 'data', widthOf(`d_${lane.id}`)) })) : []),
          el('rect', { id: `${id}-body`, x: bx, y: y + header, width: s.width, height: barH, fill: t.fill[s.fill], stroke: s.outline ? t.ink : 'none', 'stroke-width': outlineW(t, 'pipeline_register') }),
          ...(s.wedge ? [el('path', { d: `M${num(bx + 1)} ${num(y + header + barH)} L${num(bx + s.width / 2)} ${num(y + header + barH - 4)} L${num(bx + s.width - 1)} ${num(y + header + barH)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire })] : []),
        ];
      },
      overLabel: label || null,
    };
  }

  if (element.kind === 'register') {
    const symbol = skin.symbols.register;
    const [w, h] = symbol.size;
    const pins = Object.entries(symbol.pins)
      .filter(([pid]) => modelPins.some((p) => p.id === pid))
      .map(([pid, geo]) => ({ ...modelPins.find((p) => p.id === pid), x: geo.x, y: geo.y, side: geo.side }));
    const label = labelOf(ctx, element, undefined);
    const fits = label && ctx.measure(label, t.font.secondary_pt) <= w - 2;
    return {
      width: w, height: h, pins, shape: 'register', glyph: 'register',
      draw: (x, y, _nw, id) => [
        ...symbol.body.map((b) => (b.el === 'rect'
          ? el('rect', { id: `${id}-body`, x: x + b.x, y: y + b.y, width: b.width, height: b.height, fill: t.fill[symbol.fill], stroke: t.ink, 'stroke-width': outlineW(t, 'register') })
          : el('path', { d: translatePath(b.d, x, y), fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }))),
        ...(fits ? [text(ctx, label, x + (w - ctx.measure(label, t.font.secondary_pt)) / 2, y + h / 2 - 2 + ctx.base(t.font.secondary_pt), 'secondary', `${id}-label`)] : []),
      ],
      overLabel: label && !fits ? label : null,
    };
  }

  // Circle operators (CONVENTIONS §4.2): ⊕ GF add / XOR, ⊗ GF multiply,
  // + − × arithmetic. The glyph is the name. Gate-level regions keep gates.
  const opGlyph = element.kind === 'comb' ? (names?.glyph ?? OP_GLYPH[element.op]) : null;
  const ins = modelPins.filter((p) => p.dir === 'in');
  const outs = modelPins.filter((p) => p.dir === 'out');
  if (opGlyph && !inGateRegion && !element.label && ins.length === 2 && outs.length === 1) {
    const s = skin.symbols.op_circle;
    const d = s.diameter;
    const pins = [{ ...ins[0], x: 0, y: d / 2, side: 'WEST' }, { ...ins[1], x: d / 2, y: d, side: 'SOUTH' }, { ...outs[0], x: d, y: d / 2, side: 'EAST' }];
    return {
      width: d, height: d, pins, shape: `op-${opGlyph}`, glyph: `circle-${opGlyph}`,
      draw: (x, y, _nw, id) => circleOp(opGlyph, { x, y, d, ink: t.ink, fill: t.fill[s.fill], outline: outlineW(t, 'op'), id }),
    };
  }

  // Gate-level symbols: logic ops use IEEE distinctive shapes (any input
  // count, bubbles); a reduce element is a gate inside a gate-level region.
  if (element.kind === 'comb' && !element.label && (GATE_OPS.has(element.op) || (element.op === 'reduce' && inGateRegion))) {
    const spec = skin.symbols.gates;
    const op = element.op === 'reduce' ? (element.reduce || 'or') : element.op;
    const inverted = element.invert_inputs || [];
    const geo = gateGeometry(spec, { op, inputs: ins.length, inverted, invertOutput: element.invert_output });
    // ELK keeps WEST ports on the node border (x = 0); `ax` is the exact anchor
    // (curved back, or a bubble's outer tangent point) the wire is extended to.
    const pins = [
      ...ins.map((p, i) => ({ ...p, x: 0, ax: geo.anchors[i].x, y: geo.anchors[i].y, side: 'WEST', ...(geo.anchors[i].bubble ? { bubble: geo.anchors[i].bubble } : {}) })),
      { ...outs[0], x: geo.w, y: geo.out.y, side: 'EAST', ...(geo.out.bubble ? { bubble: geo.out.bubble } : {}) },
    ];
    return {
      width: geo.w, height: geo.h, pins, shape: `gate-${op}`, glyph: `gate-${op}${inverted.length || element.invert_output ? '-inv' : ''}`,
      draw: (x, y, _nw, id) => drawGate(spec, geo, { x, y, id, fill: t.fill[spec.fill], ink: t.ink, outline: outlineW(t, 'gate') }),
    };
  }

  const detail = ctx.mode !== 'short' ? names?.detail : undefined;
  // A collapsed block that holds registers on its outputs is marked registered
  // (CONVENTIONS §5.4): a clock wedge on its bottom edge and its latency.
  const registeredOuts = modelPins.filter((p) => p.dir === 'out' && p.sequential);
  const stages = Math.max(0, ...registeredOuts.map((p) => p.latency ?? 1));
  const isMemoryFn = element.function?.kind === 'memory';
  const plural = (k) => `${k} stage${k > 1 ? 's' : ''}`;
  // A memory's registered read is the clock wedge alone (CONVENTIONS §6). When
  // registered outputs differ in latency, the note names each path (§5.5).
  const perPath = new Set(registeredOuts.map((p) => p.latency ?? 1)).size > 1;
  const stageNote = !stages || isMemoryFn ? null : perPath ? registeredOuts.map((p) => `${p.label ?? p.short_label ?? p.id}: ${plural(p.latency ?? 1)}`).join('\n') : plural(stages);
  const withStages = (sub) => (stageNote ? (sub ? `${sub}\n${stageNote}` : stageNote) : sub);
  switch (element.kind) {
    case 'comb':
      return genericBlock(ctx, element, modelPins, {
        title: elementTitle(ctx, element, OP_TITLE[element.op]?.(element) ?? element.op),
        sub: ['lut', 'rom'].includes(element.op) ? `${element.depth}×${element.width}` : withStages(detail),
        pinLabels: element.op === 'custom' && (element.pin_labels ?? (modelPins.length > 2 || modelPins.some((p) => p.label))),
        kind: element.op,
        wedge: stages > 0,
      });
    case 'memory':
      return genericBlock(ctx, element, modelPins, { title: elementTitle(ctx, element, element.id), sub: `${element.depth}×${element.width}`, fillKey: 'storage', memory: true, pinLabels: element.pin_labels ?? true, wedge: true, kind: 'memory', glyph: 'memory-block' });
    case 'synchronizer':
      return genericBlock(ctx, element, modelPins, { title: element.label ?? 'sync', sub: element.style, fillKey: 'storage', wedge: true, kind: 'synchronizer', glyph: 'synchronizer' });
    case 'instance': {
      const sym = genericBlock(ctx, element, modelPins, { title: elementTitle(ctx, element, element.module), sub: withStages(detail), pinLabels: element.pin_labels ?? true, kind: 'instance', wedge: stages > 0 });
      const blackbox = element.level === 'blackbox' || (ctx.doc.regions || []).some((r) => r.level === 'blackbox' && r.members.includes(element.id));
      if (!blackbox || element.internals === 'known') return sym;
      // Blackbox: plain box with ports only, lightly hatched (explicit lines).
      const h = skin.symbols.blackbox;
      return {
        ...sym,
        shape: 'blackbox',
        draw: (x, y, nw, id) => {
          const [body, ...rest] = sym.draw(x, y, nw, id);
          return [body, hatchRect({ x: x + 0.8, y: y + 0.8, w: sym.width - 1.6, h: sym.height - 1.6, spacing: h.hatch_spacing, stroke: h.hatch_stroke, color: h.hatch_color, id: `${id}-hatch` }), ...rest];
        },
      };
    }
    default:
      throw new Error(`renderer: unsupported element kind ${element.kind}`);
  }
}

// --- regions ---------------------------------------------------------------

// Framed regions become nested ELK compound nodes. Blackbox regions are not
// framed by default: the hatch already marks them.
function regionTree(doc, { pad, padTop }) {
  const all = doc.regions || [];
  const framed = all.filter((r) => r.frame ?? r.level !== 'blackbox');
  const ids = new Set(framed.map((r) => r.id));
  const byId = new Map(all.map((r) => [r.id, r]));
  const parentOf = (r) => {
    let p = r.parent;
    while (p && !ids.has(p)) p = byId.get(p)?.parent;
    return p || null;
  };
  const nodes = framed.map((r) => ({ id: r.id, region: r, parent: parentOf(r), children: [], leaves: new Set(), inside: new Set(), pad, padTop }));
  const map = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) if (n.parent) map.get(n.parent).children.push(n);
  const depth = (n) => (n.parent ? 1 + depth(map.get(n.parent)) : 0);
  const owner = new Map();
  for (const n of [...nodes].sort((a, b) => depth(a) - depth(b))) for (const m of n.region.members) owner.set(m, n.id);
  for (const [m, rid] of owner) map.get(rid).leaves.add(m);
  const fill = (n) => {
    n.leaves.forEach((m) => n.inside.add(m));
    for (const c of n.children) {
      fill(c);
      c.inside.forEach((m) => n.inside.add(m));
    }
  };
  const roots = nodes.filter((n) => !n.parent);
  roots.forEach(fill);
  return { roots, all: nodes, owner };
}

function levelsShown(doc) {
  const regions = doc.regions || [];
  const byId = new Map(regions.map((r) => [r.id, r]));
  const depth = (r) => (r.parent && byId.has(r.parent) ? 1 + depth(byId.get(r.parent)) : 0);
  const inner = new Map();
  for (const r of [...regions].sort((a, b) => depth(a) - depth(b))) for (const m of r.members) inner.set(m, r.level);
  const levels = new Set();
  for (const e of doc.elements) {
    if (e.kind === 'port' || e.kind === 'const') continue;
    levels.add(inner.get(e.id) ?? (e.kind === 'instance' && e.level === 'blackbox' ? 'blackbox' : 'block'));
  }
  return levels;
}
const LEVEL_LEGEND = { blackbox: 'hatched box = blackbox', block: 'plain box = block', rtl: 'dashed frame = RTL region', gate: 'gate symbols = gate level' };

// --- layout ----------------------------------------------------------------

export function partitions(doc) {
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const stage = new Map(doc.elements.map((e) => [e.id, e.kind === 'pipeline_register' ? e.stage ?? 1 : 0]));
  // Feedback nets (a later element driving an earlier one, e.g. results
  // returning to a controller) must not pull their sink into a later stage:
  // find back edges by DFS from the elements nothing drives, in model order.
  const out = new Map(doc.elements.map((e) => [e.id, []]));
  const driven = new Set();
  for (const net of doc.nets) {
    const from = parseEndpoint(net.driver)?.element;
    for (const sinkText of net.sinks) {
      const to = parseEndpoint(sinkText)?.element;
      if (out.has(from) && byId.has(to)) { out.get(from).push(to); driven.add(to); }
    }
  }
  const back = new Set();
  const state = new Map();
  const dfs = (v) => {
    state.set(v, 'open');
    for (const w of out.get(v)) {
      if (state.get(w) === 'open') back.add(`${v}>${w}`);
      else if (!state.has(w)) dfs(w);
    }
    state.set(v, 'done');
  };
  for (const e of [...doc.elements.filter((x) => !driven.has(x.id)), ...doc.elements]) if (!state.has(e.id)) dfs(e.id);
  for (let iter = 0; iter < doc.elements.length + 2; iter += 1) {
    let changed = false;
    for (const net of doc.nets) {
      const fromId = parseEndpoint(net.driver)?.element;
      const from = stage.get(fromId);
      for (const sinkText of net.sinks) {
        const sink = byId.get(parseEndpoint(sinkText)?.element);
        if (!sink || sink.kind === 'pipeline_register' || from === undefined || back.has(`${fromId}>${sink.id}`)) continue;
        if (from > stage.get(sink.id)) { stage.set(sink.id, from); changed = true; }
      }
    }
    if (!changed) break;
  }
  const result = new Map(doc.elements.map((e) => [e.id, e.layout?.layer ?? (e.kind === 'pipeline_register' ? 2 * stage.get(e.id) - 1 : 2 * stage.get(e.id))]));
  // Figure outputs sit on the right edge; a connector tag sits beside the
  // element it connects to.
  const last = Math.max(0, ...doc.elements.filter((e) => e.kind !== 'port' && e.kind !== 'const').map((e) => result.get(e.id)));
  const lastStage = Math.max(0, ...doc.elements.filter((e) => e.kind !== 'port').map((e) => stage.get(e.id)));
  const netOfPort = (e) => doc.nets.find((n) => (e.dir === 'out' ? n.sinks.some((sk) => parseEndpoint(sk)?.element === e.id) : parseEndpoint(n.driver)?.element === e.id));
  const sourceTags = [];
  for (const e of doc.elements.filter((x) => x.kind === 'port' && !x.layout)) {
    const net = netOfPort(e);
    const other = net && (e.dir === 'out' ? parseEndpoint(net.driver)?.element : parseEndpoint(net.sinks[0])?.element);
    if (e.connector === 'target') { if (other && result.has(other)) result.set(e.id, result.get(other)); continue; }
    if (e.connector === 'source') { sourceTags.push(e.id); continue; }
    // A figure output driven from the last stage sits on the right edge with the others.
    if (e.dir === 'out' && other && stage.get(other) >= lastStage) result.set(e.id, last + 1);
  }
  // Source tags line up in one column after the latest of their drivers.
  if (sourceTags.length) {
    const col = Math.max(...sourceTags.map((id) => { const net = netOfPort({ id, dir: 'out' }); return result.get(parseEndpoint(net.driver)?.element) ?? 0; }));
    for (const id of sourceTags) result.set(id, col + 1);
  }
  result.backEdges = back;
  return result;
}

// Pin re-assignment plan (SPEC §9.4): a data input of a block whose net also
// continues to a later layer becomes a tap on the block's bottom edge, so the
// trunk can pass straight underneath instead of bending around the block. The
// pipeline registers next to the block then order and space their lanes so
// the passing lane runs below it. Returns { taps: Set('el.pin'), lanes }.
export function tapPlan(model, part) {
  const taps = new Set();
  const lanes = new Map();
  const isBlock = (e) => (e.kind === 'comb' ? e.op === 'custom' : !['port', 'const', 'mux', 'register', 'pipeline_register'].includes(e.kind));
  const netAt = new Map();
  for (const n of model.nets) {
    netAt.set(`${n.driver.element.id}.${n.driver.pin.id}`, n);
    for (const s of n.sinks) netAt.set(`${s.element.id}.${s.pin.id}`, n);
  }
  const need = (reg, entry) => {
    if (!lanes.has(reg)) lanes.set(reg, []);
    lanes.get(reg).push(entry);
  };
  for (const n of model.nets) {
    for (const s of n.sinks) {
      const b = s.element;
      if (!isBlock(b) || ['control', 'clock', 'reset'].includes(s.pin.class)) continue;
      const pb = part.get(b.id);
      if (part.get(n.driver.element.id) > pb) continue;
      const beyond = n.sinks.filter((o) => o !== s && part.get(o.element.id) > pb);
      if (!beyond.length) continue;
      taps.add(`${b.id}.${s.pin.id}`);
      if (n.driver.element.kind === 'pipeline_register') {
        const reg = n.driver.element;
        const lane = n.driver.pin.id.replace(/^q_/, '');
        const attach = reg.lanes.filter((l) => l.id !== lane).flatMap((l) => {
          const sink = (netAt.get(`${reg.id}.q_${l.id}`)?.sinks || []).find((o) => o.element.id === b.id);
          return sink ? [{ lane: l.id, pin: sink.pin.id }] : [];
        });
        need(reg.id, { lane, block: b.id, attach });
      }
      for (const o of beyond.filter((x) => x.element.kind === 'pipeline_register')) {
        const reg = o.element;
        const lane = o.pin.id.replace(/^d_/, '');
        const attach = reg.lanes.filter((l) => l.id !== lane).flatMap((l) => {
          const dn = netAt.get(`${reg.id}.d_${l.id}`);
          return dn?.driver.element.id === b.id ? [{ lane: l.id, pin: dn.driver.pin.id }] : [];
        });
        need(reg.id, { lane, block: b.id, attach });
      }
    }
  }
  return { taps, lanes };
}

export function buildLayoutGraph(doc, model, skin, variant, mode, scale, plan = null) {
  const ctx = renderContext(doc, skin, variant, mode);
  const symbols = new Map();
  ctx.plan = plan;
  ctx.symbols = symbols;
  // Blocks first: pipeline registers size their lane gaps from them.
  const all = [...model.elements.values()];
  for (const { el: e, pins } of all.filter((x) => x.el.kind !== 'pipeline_register')) symbols.set(e.id, instantiate(ctx, e, pins));
  for (const { el: e, pins } of all.filter((x) => x.el.kind === 'pipeline_register')) symbols.set(e.id, instantiate(ctx, e, pins));
  const part = partitions(doc);
  const base = skin.elk.variants[variant] || skin.elk.variants['2col'];
  const spacing = { ...base };
  // Scaled layer gaps keep a floor so orthogonal bends still have a channel.
  const FLOOR = { 'elk.layered.spacing.nodeNodeBetweenLayers': skin.elk.min_layer_gap ?? 10, 'elk.layered.spacing.edgeNodeBetweenLayers': 5, 'elk.layered.spacing.edgeEdgeBetweenLayers': 4 };
  for (const key of Object.keys(FLOOR)) spacing[key] = Math.max(FLOOR[key], base[key] * scale);
  const edges = [];
  for (const n of model.nets) {
    // A truncation label rides on its wire; an ELK edge label reserves the room.
    // TAIL (end) labels are placed beside the source port without a dummy
    // layer, so the reservation costs only the label's own length.
    const slice = n.net.truncation && skin.symbols.truncate.reserve_space !== false ? [{ id: `${n.net.id}-slice`, text: n.net.truncation.label, width: ctx.measure(n.net.truncation.label, ctx.t.font.secondary_pt) + (skin.symbols.truncate.reserve_pad ?? 16), height: ctx.t.font.secondary_pt + 2, layoutOptions: { 'elk.edgeLabels.placement': 'TAIL' } }] : null;
    // A net whose junction dot had no room (route/dot-near-arrow) gets an
    // empty TAIL label on the retry: room for a dot 8 pt from the driver pin
    // and 8 pt before an arrowhead.
    const room = !slice && model.dotReserve?.has(n.net.id) ? [{ id: `${n.net.id}-room`, text: ' ', width: 2 * (skin.tokens.route.dot_arrow_clearance ?? 8) + skin.tokens.arrow.length, height: 2, layoutOptions: { 'elk.edgeLabels.placement': 'TAIL' } }] : null;
    const labels = slice ?? room;
    n.sinks.forEach((s, i) => edges.push({ id: `${n.net.id}__${i}`, sources: [`${n.driver.element.id}.${n.driver.pin.id}`], targets: [`${s.element.id}.${s.pin.id}`], ...(labels ? { labels: labels.map((l) => ({ ...l, id: `${l.id}${i}` })) } : {}) }));
  }
  const m = ctx.t.block_margin;
  const fr = skin.symbols.region_frame;
  const tree = regionTree(doc, { pad: fr.pad, padTop: ctx.t.font.secondary_pt + 6 });
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  // Straight data trunks (CONVENTIONS §1.4): network-simplex placement with
  // favorStraightEdges, then our straightening pass on the result.
  // considerModelOrder crashes elkjs 0.12 together with compound nodes, so it
  // is used only for figures without framed regions.
  const placement = { 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', 'elk.layered.nodePlacement.favorStraightEdges': true, ...(tree.roots.length ? {} : { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' }) };
  // Feedback nets: break cycles depth-first from the sources, so a result
  // returning to an upstream block is the reversed edge, not the forward flow.
  const cycles = part.backEdges?.size ? { 'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST' } : {};
  const leaf = (e) => {
    const sym = symbols.get(e.id);
    return {
      id: e.id, width: sym.width, height: sym.height,
      layoutOptions: {
        'elk.portConstraints': 'FIXED_POS', 'elk.partitioning.partition': part.get(e.id),
        ...(sym.isPort ? {} : { 'elk.margins': `[top=${m + (sym.overLabel ? ctx.t.font.secondary_pt + 2 : 0)},left=0,bottom=${m},right=0]` }),
      },
      ports: sym.pins.map((p) => ({ id: `${e.id}.${p.id}`, x: p.x, y: p.y, width: 0, height: 0, layoutOptions: { 'elk.port.side': p.side } })),
    };
  };
  const compound = (n) => ({
    id: `region:${n.id}`,
    layoutOptions: {
      'elk.padding': `[top=${n.padTop},left=${n.pad},bottom=${n.pad},right=${n.pad}]`,
      'elk.partitioning.activate': true, 'elk.partitioning.partition': Math.min(...[...n.inside].map((id) => part.get(id))),
      ...placement, ...spacing,
    },
    children: [...[...n.leaves].filter((id) => byId.has(id)).map((id) => leaf(byId.get(id))), ...n.children.map(compound)],
  });
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL', 'elk.randomSeed': 1,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.json.shapeCoords': 'ROOT', 'elk.json.edgeCoords': 'ROOT',
      'elk.partitioning.activate': true, 'elk.padding': '[top=10,left=4,bottom=10,right=4]',
      ...placement, ...spacing, ...cycles,
    },
    children: [...doc.elements.filter((e) => !tree.owner.has(e.id)).map(leaf), ...tree.roots.map(compound)],
    edges,
  };
  return { ctx, symbols, part, tree, graph };
}

async function layoutOnce(doc, model, skin, variant, mode, scale, plan = null) {
  const { ctx, symbols, part, tree, graph } = buildLayoutGraph(doc, model, skin, variant, mode, scale, plan);
  const laid = await new ELK().layout(graph);
  const nodes = new Map();
  const visit = (g) => {
    for (const c of g.children || []) {
      if (c.id.startsWith('region:')) visit(c);
      else nodes.set(c.id, c);
    }
  };
  visit(laid);
  return { ctx, symbols, part, laid, nodes, tree, contentW: laid.width, contentH: laid.height };
}

// --- net drawing helpers ----------------------------------------------------

const onSegment = (p, a, b, eps = 0.01) => (
  (Math.abs(a.x - b.x) < eps && Math.abs(p.x - a.x) < eps && p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps)
  || (Math.abs(a.y - b.y) < eps && Math.abs(p.y - a.y) < eps && p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps)
);
const onPath = (p, pts) => pts.some((a, i) => i > 0 && onSegment(p, pts[i - 1], a));

export function junctions(polylines) {
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

function* segmentsOf(polylines) {
  for (const pts of polylines) {
    for (let k = 1; k < pts.length; k += 1) {
      const a = pts[k - 1];
      const b = pts[k];
      const horizontal = Math.abs(a.y - b.y) < 0.01;
      yield { a, b, horizontal, len: horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y) };
    }
  }
}

// Truncation is a label on the wire, not a symbol (CONVENTIONS §2.3.2): a
// single-slice split whose input feeds nothing else is drawn as one net that
// carries its [msb:lsb] label. Render-only; checks run on the original IR.
function mergeTruncations(doc) {
  const splits = doc.elements.filter((e) => e.kind === 'comb' && e.op === 'split' && (e.slices || []).length === 1);
  if (!splits.length) return doc;
  const out = structuredClone(doc);
  for (const sp of splits) {
    const inNet = out.nets.find((n) => n.sinks.some((s) => parseEndpoint(s)?.element === sp.id));
    const outNet = out.nets.find((n) => parseEndpoint(n.driver)?.element === sp.id);
    if (!inNet || !outNet || inNet.sinks.length !== 1) continue;
    out.elements = out.elements.filter((e) => e.id !== sp.id);
    out.nets = out.nets.filter((n) => n.id !== inNet.id);
    outNet.driver = inNet.driver;
    outNet.truncation = { label: `[${sp.slices[0]}]`, from_width: inNet.width, element: sp.id };
    for (const r of out.regions || []) r.members = r.members.filter((m) => m !== sp.id);
  }
  out.regions = (out.regions || []).filter((r) => r.members.length);
  return out;
}


// A corner or short run of one net lying on another net's wire reads as a
// junction without a dot (wire/touching, CONVENTIONS §1.5). Slide that
// interior run sideways, together with the same net's coincident branch runs,
// to the nearest offset where no vertex touches a foreign wire; offsets that
// also keep ≥ minGap from parallel foreign wires are preferred. Terminal runs
// stay on their pins.
export function detouchWires(edgePts, edges, { minGap = 4, rects = [] } = {}) {
  const EPS = 0.1;
  const near = (p, q) => Math.abs(p.x - q.x) < 0.01 && Math.abs(p.y - q.y) < 0.01;
  const onSeg = (p, a, b) => (Math.abs(a.x - b.x) < 0.01
    ? Math.abs(p.x - a.x) < EPS && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS
    : Math.abs(p.y - a.y) < EPS && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS);
  const segsOf = (pts) => pts.slice(1).map((b, i) => [pts[i], b]);
  const foreign = (net) => edges.filter((f) => f.net !== net).map((f) => edgePts.get(f.id));
  const touches = (net) => {
    const own = edges.filter((f) => f.net === net).map((f) => edgePts.get(f.id));
    const others = foreign(net);
    return own.some((pts) => pts.some((p) => others.some((o) => segsOf(o).some(([a, b]) => onSeg(p, a, b)))))
      || others.some((pts) => pts.some((p) => own.some((o) => segsOf(o).some(([a, b]) => onSeg(p, a, b)))));
  };
  const hugs = (net, a, b) => {
    const vertical = Math.abs(a.x - b.x) < 0.01;
    return foreign(net).some((pts) => segsOf(pts).some(([c, d]) => {
      if (vertical !== (Math.abs(c.x - d.x) < 0.01)) return false;
      const gap = vertical ? Math.abs(c.x - a.x) : Math.abs(c.y - a.y);
      const [lo, hi] = vertical ? [Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)), Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y))] : [Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)), Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))];
      return gap < minGap && hi - lo > 3;
    }));
  };
  // A run may not enter a block or run along its outline closer than minGap.
  const nearBlock = (a, b) => rects.some((r) => {
    const vertical = Math.abs(a.x - b.x) < 0.01;
    const [lo, hi] = vertical ? [Math.max(Math.min(a.y, b.y), r.y0), Math.min(Math.max(a.y, b.y), r.y1)] : [Math.max(Math.min(a.x, b.x), r.x0), Math.min(Math.max(a.x, b.x), r.x1)];
    if (hi - lo <= 0.01) return false;
    const c = vertical ? a.x : a.y;
    const [e0, e1] = vertical ? [r.x0, r.x1] : [r.y0, r.y1];
    return (c > e0 - minGap && c < e1 + minGap) && (c > e0 + 0.01 && c < e1 - 0.01 || hi - lo > 3);
  });
  // Shortest runs first: the stray jog moves, not the long trunk it sits on.
  const candidates = edges.flatMap((e) => {
    const pts = edgePts.get(e.id);
    return Array.from({ length: Math.max(0, pts.length - 3) }, (_, j) => ({ e, k: j + 1, len: Math.hypot(pts[j + 2].x - pts[j + 1].x, pts[j + 2].y - pts[j + 1].y) }));
  }).sort((p, q) => p.len - q.len);
  for (const { e, k } of candidates) {
    const pts = edgePts.get(e.id);
    {
      if (!touches(e.net)) continue;
      const [a, b] = [pts[k], pts[k + 1]];
      const vertical = Math.abs(a.x - b.x) < 0.01;
      if (!vertical && Math.abs(a.y - b.y) > 0.01) continue;
      const others = foreign(e.net);
      const involved = [a, b].some((p) => others.some((o) => segsOf(o).some(([c, d]) => onSeg(p, c, d)))) || others.some((o) => o.some((p) => onSeg(p, a, b)));
      if (!involved) continue;
      // The same run in sibling branches moves along; a sibling that has it as a terminal run pins it.
      const group = [];
      let pinned = false;
      for (const f of edges.filter((x) => x.net === e.net)) {
        const q = edgePts.get(f.id);
        for (let i = 0; i + 1 < q.length; i += 1) {
          if (near(q[i], a) && near(q[i + 1], b)) { if (i === 0 || i + 2 >= q.length) pinned = true; else group.push({ q, i }); }
        }
      }
      if (pinned) continue;
      const axis = vertical ? 'x' : 'y';
      const [prev, next] = [pts[k - 1], pts[k + 2]];
      let fallback = null;
      let done = false;
      for (const d of [2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 1, -1, 8, -8]) {
        const v = a[axis] + d;
        // The neighbouring runs keep their direction and a visible length.
        if (Math.sign(prev[axis] - a[axis]) !== Math.sign(prev[axis] - v) || Math.abs(prev[axis] - v) < 0.5) continue;
        if (Math.sign(next[axis] - b[axis]) !== Math.sign(next[axis] - v) || Math.abs(next[axis] - v) < 0.5) continue;
        const saved = group.map(({ q, i }) => [q[i][axis], q[i + 1][axis]]);
        for (const { q, i } of group) { q[i][axis] = v; q[i + 1][axis] = v; }
        const clean = !touches(e.net) && !nearBlock(pts[k], pts[k + 1]);
        const hugging = clean && hugs(e.net, pts[k], pts[k + 1]);
        if (clean && !hugging) { done = true; break; }
        if (clean && fallback === null) fallback = v;
        group.forEach(({ q, i }, j) => { q[i][axis] = saved[j][0]; q[i + 1][axis] = saved[j][1]; });
      }
      if (!done && fallback !== null) for (const { q, i } of group) { q[i][axis] = fallback; q[i + 1][axis] = fallback; }
    }
  }
}

// Backward branches (feedback) whose span exceeds ratio × the layout width.
export function longFeedback(model, run, ratio) {
  const marks = [];
  for (const n of model.nets) {
    n.sinks.forEach((s, i) => {
      if (!run.part.backEdges?.has(`${n.driver.element.id}>${s.element.id}`)) return;
      const d = run.nodes.get(n.driver.element.id);
      const k = run.nodes.get(s.element.id);
      if (!d || !k) return;
      const span = d.x + d.width - k.x;
      if (span > ratio * run.contentW) marks.push({ net: n.net.id, sink: i, span: Math.round(span * 100) / 100 });
    });
  }
  return marks;
}

// Replace marked sinks of a net with a pair of named connectors: a source tag
// after the driver and a target tag before each sink. Render-only.
export function withConnectors(doc, model, marks) {
  const out = structuredClone(doc);
  const classes = deriveNetClasses(model);
  const byNet = new Map();
  for (const m of marks) { if (!byNet.has(m.net)) byNet.set(m.net, []); byNet.get(m.net).push(m.sink); }
  for (const [netId, idx] of byNet) {
    const net = out.nets.find((n) => n.id === netId);
    const label = net.label ?? net.short_label ?? (net.rtl?.signal ? net.rtl.signal.replace(/_[io]$/, '').replace(/_/g, ' ') : netId);
    const cls = classes.get(netId)?.drawn;
    const keepClass = cls && cls !== 'data' ? { class: cls, class_reason: 'connector' } : {};
    const targets = net.sinks.filter((_, i) => idx.includes(i));
    const srcId = `cx_${netId}`;
    const shortName = net.short_label ? { short_label: net.short_label } : {};
    out.elements.push({ id: srcId, kind: 'port', dir: 'out', width: net.width, label, ...shortName, connector: 'source' });
    net.sinks = [...net.sinks.filter((_, i) => !idx.includes(i)), srcId];
    Object.assign(net, keepClass);
    targets.forEach((t, k) => {
      const tid = `cx_${netId}_to${k}`;
      out.elements.push({ id: tid, kind: 'port', dir: 'in', width: net.width, label, ...shortName, connector: 'target' });
      out.nets.push({ id: `${netId}__cx${k}`, width: net.width, driver: tid, sinks: [t], ...keepClass, ...(net.bundle_of ? { bundle_of: net.bundle_of } : {}) });
    });
  }
  return out;
}

// A small step into a gate pin (gate pin pitch) moves back to where the branch
// leaves its trunk, so the junction dot sits on the pin row (CONVENTIONS §1.4).
// A junction dot keeps `clearance` from every pin anchor of its net and from
// the base of every arrowhead (assumed at each sink end, `arrowLen` long). A
// dot that is too close moves along the trunk: every branch leaving there
// shifts its turn (and the perpendicular run after it) by the smallest step,
// upstream or downstream, that clears all features, keeps the new branch
// point on the trunk, touches no foreign wire and enters no block.
export function spreadJunctions(edgePts, edges, { clearance = 8, arrowLen = 4.5, rects = [], maxShift = 40, hasArrow = () => true } = {}) {
  const EPS = 0.01;
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const onSeg = (p, a, b) => (Math.abs(a.x - b.x) < EPS
    ? Math.abs(p.x - a.x) < 0.1 && p.y >= Math.min(a.y, b.y) - 0.1 && p.y <= Math.max(a.y, b.y) + 0.1
    : Math.abs(p.y - a.y) < 0.1 && p.x >= Math.min(a.x, b.x) - 0.1 && p.x <= Math.max(a.x, b.x) + 0.1);
  const segs = (pts) => pts.slice(1).map((b, i) => [pts[i], b]);
  const byNet = new Map();
  for (const e of edges) byNet.set(e.net, [...(byNet.get(e.net) || []), e]);
  const features = (list) => list.flatMap((e) => {
    const pts = edgePts.get(e.id);
    if (pts.length < 2) return [];
    const end = pts.at(-1);
    const a = pts.at(-2);
    const len = dist(a, end) || 1;
    const L = Math.min(arrowLen, len * 0.8);
    const base = { x: end.x - ((end.x - a.x) / len) * L, y: end.y - ((end.y - a.y) / len) * L };
    return hasArrow(e) ? [pts[0], end, base] : [pts[0], end];
  });
  const clearOf = (list, j) => features(list).every((f) => dist(j, f) >= clearance - 0.05);
  const touchesForeign = (net) => {
    const own = edges.filter((f) => f.net === net).map((f) => edgePts.get(f.id));
    const others = edges.filter((f) => f.net !== net).map((f) => edgePts.get(f.id));
    return own.some((pts) => pts.some((p) => others.some((o) => segs(o).some(([a, b]) => onSeg(p, a, b)))))
      || others.some((pts) => pts.some((p) => own.some((o) => segs(o).some(([a, b]) => onSeg(p, a, b)))));
  };
  const entersBlock = (a, b) => rects.some((r) => Math.min(a.x, b.x) < r.x1 - 0.5 && Math.max(a.x, b.x) > r.x0 + 0.5 && Math.min(a.y, b.y) < r.y1 - 0.5 && Math.max(a.y, b.y) > r.y0 + 0.5);
  // Every junction of the net clear, the same number of junctions, and the moved
  // point still shared by two branches: the net's topology is unchanged.
  const netValid = (net, list, nj, count) => {
    const polys = list.map((e) => edgePts.get(e.id));
    const js = junctions(polys);
    return js.length === count && polys.filter((pts) => onPath(nj, pts)).length >= 2 && js.every((q) => clearOf(list, q)) && !touchesForeign(net);
  };
  // Second strategy: shift the run the dot sits on sideways (e.g. a riser whose
  // branch enters a pin on the same row, so nothing can slide along the trunk).
  // Every branch's copy of that run moves together; pins never move.
  const shiftRun = (net, list, j) => {
    const count = junctions(list.map((e) => edgePts.get(e.id))).length;
    for (const A of ['x', 'y']) {
      const B = A === 'x' ? 'y' : 'x';
      const runs = [];
      for (const e of list) {
        const pts = edgePts.get(e.id);
        for (let k = 1; k + 2 < pts.length; k += 1) {
          const [p0, a, b, p3] = [pts[k - 1], pts[k], pts[k + 1], pts[k + 2]];
          if (Math.abs(a[A] - j[A]) > EPS || Math.abs(b[A] - j[A]) > EPS) continue;
          if (j[B] < Math.min(a[B], b[B]) - EPS || j[B] > Math.max(a[B], b[B]) + EPS) continue;
          if (Math.abs(p0[B] - a[B]) > EPS || Math.abs(p3[B] - b[B]) > EPS) continue;
          runs.push({ pts, k, lo: Math.min(p0[A], p3[A]), hi: Math.max(p0[A], p3[A]) });
        }
      }
      if (!runs.length) continue;
      const saved = runs.map((r) => [r.pts[r.k][A], r.pts[r.k + 1][A]]);
      const restore = () => runs.forEach((r, i) => { r.pts[r.k][A] = saved[i][0]; r.pts[r.k + 1][A] = saved[i][1]; });
      for (let o = 0.5; o <= maxShift; o += 0.5) {
        for (const v of [j[A] - o, j[A] + o]) {
          if (runs.some((r) => v <= r.lo + 0.5 || v >= r.hi - 0.5)) continue;
          runs.forEach((r) => { r.pts[r.k][A] = v; r.pts[r.k + 1][A] = v; });
          const blocked = runs.some((r) => entersBlock(r.pts[r.k - 1], r.pts[r.k]) || entersBlock(r.pts[r.k], r.pts[r.k + 1]) || entersBlock(r.pts[r.k + 1], r.pts[r.k + 2]));
          if (!blocked && netValid(net, list, { ...j, [A]: v }, count)) return true;
          restore();
        }
      }
    }
    return false;
  };
  let moved = 0;
  for (const [net, list] of byNet) {
    if (list.length < 2) continue;
    const polys = () => list.map((e) => edgePts.get(e.id));
    for (const j0 of junctions(polys())) {
      if (clearOf(list, j0)) continue;
      const j = { ...j0 };
      const junctionCount = junctions(polys()).length;
      // Branches that leave the trunk at j: vertex k on j whose next run is on no other branch.
      const leaving = [];
      for (const e of list) {
        const pts = edgePts.get(e.id);
        for (let k = 1; k + 2 < pts.length; k += 1) {
          if (dist(pts[k], j) > EPS) continue;
          const mid = { x: (pts[k].x + pts[k + 1].x) / 2, y: (pts[k].y + pts[k + 1].y) / 2 };
          const others = list.filter((f) => f !== e).map((f) => edgePts.get(f.id));
          if (others.some((o) => onPath(pts[k], o) && !onPath(mid, o))) leaving.push({ e, k });
        }
      }
      if (!leaving.length) { if (shiftRun(net, list, j)) moved += 1; continue; }
      const shape = leaving.map(({ e, k }) => {
        const pts = edgePts.get(e.id);
        const [prev, cur, next, after] = [pts[k - 1], pts[k], pts[k + 1], pts[k + 2]];
        const axis = Math.abs(prev.y - cur.y) < EPS ? 'x' : Math.abs(prev.x - cur.x) < EPS ? 'y' : null;
        const other = axis === 'x' ? 'y' : 'x';
        // the run after the turn is perpendicular and the one after that parallel to the trunk
        const ok = axis && Math.abs(cur[axis] - next[axis]) < EPS && Math.abs(next[other] - after[other]) < EPS;
        return { pts, k, axis, ok, prev, after };
      });
      if (shape.some((s) => !s.ok) || new Set(shape.map((s) => s.axis)).size !== 1) { if (shiftRun(net, list, j)) moved += 1; continue; }
      const axis = shape[0].axis;
      const saved = shape.map((s) => [s.pts[s.k][axis], s.pts[s.k + 1][axis]]);
      const apply = (v) => shape.forEach((s) => { s.pts[s.k][axis] = v; s.pts[s.k + 1][axis] = v; });
      const offsets = [];
      for (let o = 0.5; o <= maxShift; o += 0.5) offsets.push(-o, o);
      let done = false;
      for (const o of offsets) {
        const v = j[axis] + o;
        // stay strictly inside the trunk run before the turn and before the run after it
        if (shape.some((s) => v <= Math.min(s.prev[axis], s.after[axis]) + 0.5 || v >= Math.max(s.prev[axis], s.after[axis]) - 0.5)) continue;
        apply(v);
        const nj = { ...j, [axis]: v };
        // When every branch leaves here they all move together along their shared run.
        const rest = list.filter((e) => !shape.some((s) => s.pts === edgePts.get(e.id)));
        const stillOnTrunk = !rest.length || rest.some((e) => onPath(nj, edgePts.get(e.id)));
        const valid = stillOnTrunk && clearOf(list, nj) && junctions(polys()).length === junctionCount && !shape.some((s) => entersBlock(s.pts[s.k], s.pts[s.k + 1])) && !touchesForeign(net);
        if (valid) { done = true; moved += 1; break; }
        shape.forEach((s, i) => { s.pts[s.k][axis] = saved[i][0]; s.pts[s.k + 1][axis] = saved[i][1]; });
      }
      if (!done) { apply(j[axis]); if (shiftRun(net, list, j)) moved += 1; }
    }
  }
  return moved;
}

export function alignGateSteps(edgePts, edges, { fine = () => false, rects = [], pitch = 12 } = {}) {
  const EPS = 0.01;
  const onSeg = (p, a, b) => (Math.abs(a.x - b.x) < EPS
    ? Math.abs(p.x - a.x) < 0.1 && p.y >= Math.min(a.y, b.y) - 0.1 && p.y <= Math.max(a.y, b.y) + 0.1
    : Math.abs(p.y - a.y) < 0.1 && p.x >= Math.min(a.x, b.x) - 0.1 && p.x <= Math.max(a.x, b.x) + 0.1);
  const segs = (pts) => pts.slice(1).map((b, i) => [pts[i], b]);
  const clean = (net) => {
    const own = edges.filter((f) => f.net === net).map((f) => edgePts.get(f.id));
    const others = edges.filter((f) => f.net !== net).map((f) => edgePts.get(f.id));
    return !own.some((pts) => pts.some((p) => others.some((o) => segs(o).some(([a, b]) => onSeg(p, a, b)))))
      && !others.some((pts) => pts.some((p) => own.some((o) => segs(o).some(([a, b]) => onSeg(p, a, b)))));
  };
  let moved = 0;
  for (const e of edges.filter(fine)) {
    const pts = edgePts.get(e.id);
    const L = pts.length;
    if (L < 4) continue;
    const [a, b, c, d] = [pts[L - 4], pts[L - 3], pts[L - 2], pts[L - 1]];
    if (Math.abs(a.y - b.y) > EPS || Math.abs(b.x - c.x) > EPS || Math.abs(c.y - d.y) > EPS) continue;
    const step = Math.abs(b.y - c.y);
    if (step < EPS || step >= pitch || d.x - c.x > 10) continue;
    const siblings = edges.filter((f) => f.net === e.net && f.id !== e.id).map((f) => edgePts.get(f.id));
    const turns = siblings.flatMap((q) => q.filter((p) => Math.abs(p.y - a.y) < EPS && p.x > Math.min(a.x, b.x) + EPS && p.x < b.x - 0.5).map((p) => p.x));
    const x0 = turns.length ? Math.max(...turns) : (L - 4 === 0 ? a.x + 4 : a.x);
    if (x0 >= b.x - 0.5) continue;
    const saved = [b.x, c.x];
    b.x = x0; c.x = x0;
    const through = rects.some((r) => c.y > r.y0 + 0.5 && c.y < r.y1 - 0.5 && Math.min(c.x, d.x) < r.x1 - 0.5 && Math.max(c.x, d.x) > r.x0 + 0.5 && !(d.x >= r.x0 - 0.5 && d.x <= r.x1 + 0.5));
    if (through || !clean(e.net)) { b.x = saved[0]; c.x = saved[1]; continue; }
    moved += 1;
  }
  return moved;
}

// A frame edge closer to a parallel wire than the frame gap (1.5 × for a
// dashed wire) moves past the wire. It moves outward only if the frame then
// still covers no foreign block, otherwise inward only if it still holds all
// its members; if neither holds it stays and region/wire-hugs-frame reports it.
export function pushFramesOffWires(frames, wireSegs, { nodeRects = [], membersOf = () => [], W = Infinity, H = Infinity, frameGap = 6 } = {}) {
  const meets = (a, r) => Math.min(a.x1, r.x1) - Math.max(a.x0, r.x0) > 0.5 && Math.min(a.y1, r.y1) - Math.max(a.y0, r.y0) > 0.5;
  const holds = (a, r) => r.x0 >= a.x0 && r.x1 <= a.x1 && r.y0 >= a.y0 && r.y1 <= a.y1;
  for (const f of frames) {
    const inside = new Set(membersOf(f.id));
    const valid = (a) => a.x0 >= 0.5 && a.y0 >= 0.5 && a.x1 <= W - 0.5 && a.y1 <= H - 0.5 && nodeRects.every((r) => (inside.has(r.id) ? holds(a, r) : !meets(a, r) || meets(f, r)));
    const shift = (key, outward, inward) => {
      for (const v of [outward, inward]) {
        if (valid({ ...f, [key]: v })) { f[key] = v; return true; }
      }
      return false;
    };
    for (let iter = 0; iter < 12; iter += 1) {
      let moved = false;
      for (const sg of wireSegs) {
        const g = frameGap * (sg.dashed ? 1.5 : 1) + 0.5;
        const xs = [Math.min(sg.a.x, sg.b.x), Math.max(sg.a.x, sg.b.x)];
        const ysg = [Math.min(sg.a.y, sg.b.y), Math.max(sg.a.y, sg.b.y)];
        const overX = Math.min(xs[1], f.x1) - Math.max(xs[0], f.x0) > 3;
        const overY = Math.min(ysg[1], f.y1) - Math.max(ysg[0], f.y0) > 3;
        if (sg.horizontal && overX) {
          if (Math.abs(sg.a.y - f.y1) < g && sg.a.y !== f.y1 - g) moved = shift('y1', Math.max(f.y1, sg.a.y + g), Math.min(f.y1, sg.a.y - g)) || moved;
          if (Math.abs(sg.a.y - f.y0) < g) moved = shift('y0', Math.min(f.y0, sg.a.y - g), Math.max(f.y0, sg.a.y + g)) || moved;
        } else if (!sg.horizontal && overY) {
          if (Math.abs(sg.a.x - f.x0) < g) moved = shift('x0', Math.min(f.x0, sg.a.x - g), Math.max(f.x0, sg.a.x + g)) || moved;
          if (Math.abs(sg.a.x - f.x1) < g) moved = shift('x1', Math.max(f.x1, sg.a.x + g), Math.min(f.x1, sg.a.x - g)) || moved;
        }
      }
      if (!moved) break;
    }
  }
  return frames;
}

// A width carried straight through a pipeline lane is labeled once: a net on
// one side of a lane is not missing its width when the other side (same lane,
// same width) is labeled. `nets` are model nets ({ net, width, driver, sinks }).
export function laneCarried(nets, id, labeled) {
  const n = nets.find((m) => m.net.id === id);
  if (!n) return false;
  const across = (el0, pin) => (el0?.kind === 'pipeline_register' && /^[dq]_/.test(pin ?? '') ? `${pin.startsWith('d_') ? 'q' : 'd'}_${pin.slice(2)}` : null);
  const twins = [];
  for (const s of n.sinks) {
    const other = across(s.element, s.pin?.id);
    if (other) twins.push(...nets.filter((m) => m.driver.element?.id === s.element.id && m.driver.pin?.id === other));
  }
  const back = across(n.driver.element, n.driver.pin?.id);
  if (back) twins.push(...nets.filter((m) => m.sinks.some((s) => s.element?.id === n.driver.element.id && s.pin?.id === back)));
  return twins.some((m) => m !== n && m.width === n.width && labeled.has(m.net.id));
}

// --- main -------------------------------------------------------------------

// Render; if a junction dot still has no room (route/dot-near-arrow), lay out
// again with room reserved on those nets and keep whichever pass has fewer errors.
export async function renderDatapath(doc, opts = {}) {
  const first = await renderDatapathOnce(doc, opts);
  if (opts.dotReserve) return first;
  const crowdedOf = (r) => r.diagnostics.filter((d) => d.code === 'route/dot-near-arrow').map((d) => d.subject.id.replace(/__cx\d+$/, ''));
  const errorCount = (r) => r.diagnostics.filter((d) => d.severity === 'error').length;
  const overflows = (r) => r.diagnostics.some((d) => d.code === 'print/width-overflow');
  // Room can crowd other nets, so the reserve grows over at most three passes
  // (each adds the nets still crowded). The pass with the fewest errors wins;
  // room for a dot never costs the fit: a pass that overflows where the best
  // one fitted, or overflows wider, is discarded.
  let best = first;
  let last = first;
  const reserve = new Set();
  for (let pass = 0; pass < 3; pass += 1) {
    const grow = crowdedOf(last).filter((id) => !reserve.has(id));
    if (!grow.length) break;
    grow.forEach((id) => reserve.add(id));
    last = await renderDatapathOnce(doc, { ...opts, dotReserve: new Set(reserve) });
    const costsFit = overflows(last) && (!overflows(best) || last.content_width_pt > best.content_width_pt + 0.5);
    if (errorCount(last) < errorCount(best) && !costsFit) best = last;
  }
  return best;
}

async function renderDatapathOnce(doc, { variant = '2col', widthPt, maxHeightPt, minFontPt = 6, minStrokePt = 0.5, name = 'figure', spread = variant !== '1col', skin, connectorMarks = null, dotReserve = null } = {}) {
  skin = skin ?? loadSkin(doc.meta?.style?.skin);
  const diagnostics = [...checkSkin(skin)];
  doc = mergeTruncations(doc);
  const model = buildModel(doc);
  model.dotReserve = dotReserve;
  const broken = model.nets.flatMap((n) => [n.driver, ...n.sinks]).filter((e) => e.error);
  if (broken.length) throw new Error(`renderer: unresolved endpoints (${broken.map((b) => b.text).join(', ')}); run semantic checks first`);
  const connected = new Set(model.nets.flatMap((n) => n.sinks.map((s) => `${s.element.id}.${s.pin.id}`)));
  for (const { el: e } of model.elements.values()) {
    if (e.kind === 'mux' && !connected.has(`${e.id}.sel`)) diagnostics.push({ code: 'symbol/mux-sel-missing', severity: 'error', message: `mux ${e.id} has no net on its select pin; a mux must show its select`, subject: { id: e.id }, evidence: {}, supportedFixes: [`connect a net to ${e.id}.sel`] });
  }
  // Long feedback/return nets become named off-page connectors (CONVENTIONS
  // §1.6): measure a first layout, replace the long returning branches, lay out again.
  const feedbackRatio = skin.tokens.route.long_feedback_ratio ?? 0.5;
  if (!connectorMarks && doc.meta?.style?.connectors !== false) {
    const probe = await layoutOnce(doc, model, skin, variant, 'full', 1);
    const marks = longFeedback(model, probe, feedbackRatio);
    if (marks.length) return renderDatapathOnce(withConnectors(doc, model, marks), { variant, widthPt, maxHeightPt, minFontPt, minStrokePt, name, spread, skin, connectorMarks: marks, dotReserve });
  }

  let chosen = null;
  let run = null;
  let tightest = null;
  // Bounded effort (SPEC §9.5): the normal layout, then one retry with short
  // labels and tighter spacing. No further repair loops.
  for (const [mode, scale] of [['full', 1], ['short', skin.elk.short_retry_scale ?? 0.45]]) {
    run = await layoutOnce(doc, model, skin, variant, mode, scale);
    chosen = { labels: mode, spacing_scale: scale, spread: false, wrapped: false };
    if (!widthPt || run.contentW <= widthPt + 0.01) { tightest = null; break; }
    if (!tightest || run.contentW < tightest.run.contentW) tightest = { run, chosen };
  }
  if (tightest) ({ run, chosen } = tightest);
  if (chosen.labels === 'short') diagnostics.push({ code: 'print/label-fallback', severity: 'info', message: `${variant}: short labels used to fit ${widthPt} pt`, subject: { variant }, evidence: {}, supportedFixes: [] });
  if (spread && widthPt && run.contentW < SPREAD_TARGET * widthPt * 0.95) {
    const probe = await layoutOnce(doc, model, skin, variant, chosen.labels, chosen.spacing_scale * 2);
    const slope = probe.contentW - run.contentW;
    if (slope > 1) {
      const scale = Math.min(MAX_SPREAD, chosen.spacing_scale * (1 + (SPREAD_TARGET * widthPt - run.contentW) / slope));
      const spreadRun = await layoutOnce(doc, model, skin, variant, chosen.labels, scale);
      if (spreadRun.contentW <= widthPt) { run = spreadRun; chosen = { ...chosen, spacing_scale: Math.round(scale * 100) / 100, spread: true }; }
    }
  }

  // Line style follows usage (CONVENTIONS §1): control only when every sink
  // is a select/enable/handshake pin; an authored class needs a reason.
  const classes = deriveNetClasses(model);
  const netInfo = new Map(model.nets.map((n) => [n.net.id, { n, cls: classes.get(n.net.id).drawn }]));
  const rt = run.ctx.t.route;
  const scoreOpts = { minOffsetPt: rt.jog_min_offset_pt, crossingWeight: rt.crossing_weight ?? 200 };
  // Straightening pass (SPEC §9.4) on one layout run.
  const straightenRun = (r) => {
    const finePitchOf = (n) => [n.driver, ...n.sinks].some((end) => /^gate-/.test(r.symbols.get(end.element?.id)?.shape || ''));
    const out = straighten({
      nodes: new Map([...r.nodes].map(([id, n]) => [id, { x: n.x, y: n.y, w: n.width, h: n.height, port: Boolean(r.symbols.get(id)?.isPort) }])),
      edges: r.laid.edges.map((edge) => {
        const [, netId, idx] = /^(.*)__(\d+)$/.exec(edge.id);
        const { n, cls } = netInfo.get(netId);
        const sec = edge.sections[0];
        return { id: edge.id, net: netId, cls: cls === 'data' ? 'data' : 'control', finePitch: finePitchOf(n), src: n.driver.element.id, dst: n.sinks[Number(idx)].element.id, pts: [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint] };
      }),
      regions: r.tree.roots,
      // Grid phase of each multi-pin node's data pins (ports and single pins align freely).
      pinPhase: new Map([...r.symbols].flatMap(([id, sym]) => {
        const ys = (sym.pins || []).filter((p) => !['control', 'clock', 'reset'].includes(p.class) && (p.side === 'WEST' || p.side === 'EAST')).map((p) => p.y);
        return ys.length >= 2 ? [[id, ((ys[0] % 12) + 12) % 12]] : [];
      })),
    }, scoreOpts);
    const score = routeScore(out.edges, scoreOpts.minOffsetPt, scoreOpts.crossingWeight, out.nodes);
    const bends = justifyBends({ nodes: out.nodes, edges: out.edges, regions: r.tree.roots }, scoreOpts);
    // Avoidable bends weigh like redundant jogs when choosing between plans.
    return { st: out, score, bends, value: score.value + bends.filter((b) => b.avoidable).length * 1000 };
  };
  // Pin re-assignment (taps under blocks) is tried before any bend is accepted;
  // the plan with the better straightened route is kept.
  let straightened = straightenRun(run);
  const plan = tapPlan(model, run.part);
  const layoutPlans = [{ plan: 'default', score: Math.round(straightened.value) }];
  if (plan.taps.size) {
    const alt = await layoutOnce(doc, model, skin, variant, chosen.labels, chosen.spacing_scale, plan);
    if (!widthPt || alt.contentW <= Math.max(widthPt, run.contentW) + 0.01) {
      const altStraightened = straightenRun(alt);
      layoutPlans.push({ plan: 'taps', taps: [...plan.taps], score: Math.round(altStraightened.value) });
      if (altStraightened.value < straightened.value) {
        run = alt;
        straightened = altStraightened;
        layoutPlans.at(-1).chosen = true;
      }
    } else layoutPlans.push({ plan: 'taps', taps: [...plan.taps], rejected: 'wider than the column' });
  }
  if (!layoutPlans.some((p) => p.chosen)) layoutPlans[0].chosen = true;
  const { ctx, symbols, part, tree } = run;
  const t = ctx.t;
  const S = t.font.secondary_pt;
  if (widthPt && run.contentW > widthPt + 0.01) diagnostics.push({ code: 'print/width-overflow', severity: 'error', message: `${variant}: content ${num(run.contentW)} pt exceeds column ${num(widthPt)} pt even with short labels and tight spacing`, subject: { variant }, evidence: { content: run.contentW, column: widthPt }, supportedFixes: ['add short_label to wide labels', 'collapse more hardware into blocks whose rtl.covers name it (never drop hardware)', 'allow a taller figure up to the profile maximum height', 'narrow meta.scope explicitly or split into sub-figures (a)/(b) linked with detail_ref'] });
  const W = Math.max(widthPt ?? run.contentW, run.contentW);
  const ox = Math.max(0, (W - run.contentW) / 2);

  const finePitch = (n) => [n.driver, ...n.sinks].some((end) => /^gate-/.test(symbols.get(end.element?.id)?.shape || ''));
  const st = straightened.st;
  const boxes = new Map();
  // Frames enclose what a member draws, including labels hanging past its box.
  const frameNodes = new Map([...st.nodes].map(([id, r]) => {
    const o = symbols.get(id).overhang;
    return [id, o ? { ...r, x: r.x - o.left, w: r.w + o.left + o.right } : r];
  }));
  const collectBoxes = (n) => {
    n.children.forEach(collectBoxes);
    const b = regionBox(frameNodes, n);
    if (b) boxes.set(n.id, b);
  };
  tree.roots.forEach(collectBoxes);
  const ys = [
    ...[...st.nodes].flatMap(([id, r]) => [r.y - (symbols.get(id).overLabel ? S + 2 : 0), r.y + r.h]),
    ...st.edges.flatMap((e) => e.pts.map((p) => p.y)),
    ...[...boxes.values()].flatMap((b) => [b.y, b.y + b.h]),
  ];
  const PAD = 10;
  const dy = PAD - Math.min(...ys);
  const pos = new Map([...st.nodes].map(([id, r]) => [id, { x: r.x + ox, y: r.y + dy, w: r.w, h: r.h }]));
  // A zig-zag shorter than 2 pt between two same-direction runs (an ELK
  // routing artifact) reads as a touch on whatever wire it sits on: collapse
  // it onto the first run. Terminal segments stay on their pins.
  const collapseMicroJogs = (pts) => {
    const p = pts.map((q) => ({ ...q }));
    for (let k = 1; k + 2 < p.length - 1; k += 1) {
      const [a, b, c, e] = [p[k - 1], p[k], p[k + 1], p[k + 2]];
      const shortH = Math.abs(b.y - c.y) < 0.01 && Math.abs(b.x - c.x) < 2 && Math.abs(a.x - b.x) < 0.01 && Math.abs(c.x - e.x) < 0.01 && Math.sign(b.y - a.y) === Math.sign(e.y - c.y);
      const shortV = Math.abs(b.x - c.x) < 0.01 && Math.abs(b.y - c.y) < 2 && Math.abs(a.y - b.y) < 0.01 && Math.abs(c.y - e.y) < 0.01 && Math.sign(b.x - a.x) === Math.sign(e.x - c.x);
      if (shortH) { c.x = b.x; e.x = b.x; }
      if (shortV) { c.y = b.y; e.y = b.y; }
    }
    return simplifyPts(p);
  };
  const simplifyPts = (pts) => {
    const out = [];
    for (const q of pts) if (!out.length || Math.hypot(out.at(-1).x - q.x, out.at(-1).y - q.y) > 0.005) out.push(q);
    for (let k = out.length - 2; k >= 1; k -= 1) {
      const [a, b, c] = [out[k - 1], out[k], out[k + 1]];
      if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) out.splice(k, 1);
    }
    return out;
  };
  const edgePts = new Map(st.edges.map((e) => [e.id, collapseMicroJogs(e.pts.map((p) => ({ x: p.x + ox, y: p.y + dy })))]));
  // Exact anchors (CONVENTIONS §1.5): a pin whose anchor lies inside its node
  // (a gate's curved back or input bubble) gets its wire extended to it.
  const pinOf = (end) => symbols.get(end.element.id).pins.find((q) => q.id === end.pin.id);
  const anchorAt = (end) => {
    const p = pos.get(end.element.id);
    const q = pinOf(end);
    return { x: p.x + (q.ax ?? q.x), y: p.y + q.y, q, p };
  };
  const extendEnd = (pts, atStart, x) => {
    const i = atStart ? 0 : pts.length - 1;
    const j = atStart ? 1 : pts.length - 2;
    if (Math.abs(pts[i].x - x) < 1e-6) return;
    if (pts.length > 1 && Math.abs(pts[i].y - pts[j].y) < 0.01) pts[i].x = x;
    else if (atStart) pts.unshift({ x, y: pts[0].y });
    else pts.push({ x, y: pts[pts.length - 1].y });
  };
  const anchors = [];
  const lanePairs = [];
  for (const e of st.edges) {
    const [, netId, idx] = /^(.*)__(\d+)$/.exec(e.id);
    const { n } = netInfo.get(netId);
    const sink = n.sinks[Number(idx)];
    const pts = edgePts.get(e.id);
    const da = anchorAt(n.driver);
    const sa = anchorAt(sink);
    if (da.q.ax !== undefined) extendEnd(pts, true, da.x);
    if (sa.q.ax !== undefined) extendEnd(pts, false, sa.x);
    const bub = (a) => (a.q.bubble ? { bubble: { cx: a.p.x + a.q.bubble.cx, cy: a.p.y + a.q.bubble.cy, r: a.q.bubble.r } } : {});
    const kindName = (el0) => (el0.kind === 'comb' ? (el0.op === 'concat' ? 'concat' : el0.op) : el0.kind === 'pipeline_register' ? 'preg' : el0.kind === 'register' ? 'reg' : el0.kind);
    anchors.push(
      { net: netId, branch: Number(idx), role: 'driver', element: n.driver.element.id, pin: n.driver.pin.id, gid: `${kindName(n.driver.element)}-${n.driver.element.id}`, port: n.driver.element.kind === 'port' || n.driver.element.kind === 'const', x: da.x, y: da.y, ...bub(da) },
      { net: netId, branch: Number(idx), role: 'sink', element: sink.element.id, pin: sink.pin.id, gid: `${kindName(sink.element)}-${sink.element.id}`, port: sink.element.kind === 'port', x: sa.x, y: sa.y, ...bub(sa) },
    );
  }
  detouchWires(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    minGap: rt.min_parallel_gap_pt ?? 4,
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
  });
  alignGateSteps(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    // Gate pins and figure ports / connector tags: no step just before the pin.
    fine: (e) => finePitch(netInfo.get(e.net).n) || netInfo.get(e.net).n.sinks[Number(/__(\d+)$/.exec(e.id)[1])]?.element?.kind === 'port',
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
  });
  // Junction dots keep route.dot_arrow_clearance from arrowheads and pin
  // anchors of their net (CONVENTIONS §1.5): move the branch point along the trunk.
  spreadJunctions(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    clearance: rt.dot_arrow_clearance ?? 8,
    // No head on gate inputs in gate regions, into a split, or at a pass-through pin.
    hasArrow: (e) => {
      const sink = netInfo.get(e.net).n.sinks[Number(/__(\d+)$/.exec(e.id)[1])];
      const sym = symbols.get(sink.element.id);
      const gateIn = /^gate-/.test(sym?.shape || '') && (doc.regions || []).some((r) => r.level === 'gate' && r.members.includes(sink.element.id));
      const ripper = sink.element.kind === 'comb' && sink.element.op === 'split';
      return !gateIn && !ripper && !sym?.pins.find((p) => p.id === sink.pin.id)?.through;
    },
    arrowLen: t.arrow.length,
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
  });
  for (const { el: e } of model.elements.values()) {
    if (e.kind !== 'pipeline_register') continue;
    const sym = symbols.get(e.id);
    const p = pos.get(e.id);
    for (const lane of e.lanes) {
      const dIn = sym.pins.find((q) => q.id === `d_${lane.id}`);
      const qOut = sym.pins.find((q) => q.id === `q_${lane.id}`);
      if (dIn && qOut) lanePairs.push({ element: e.id, lane: lane.id, x: p.x, inY: p.y + dIn.y, outY: p.y + qOut.y });
    }
  }
  const frames = [...boxes].map(([id, b]) => ({ id, x0: b.x + ox, y0: b.y + dy, x1: b.x + ox + b.w, y1: b.y + dy + b.h }));
  const levels = levelsShown(doc);
  const legend = levels.size > 2 && doc.meta?.legend !== false ? ['blackbox', 'block', 'rtl', 'gate'].filter((l) => levels.has(l)).map((l) => LEVEL_LEGEND[l]).join('; ') : null;
  const H = Math.max(...ys) + dy + PAD + (legend ? S + 6 : 0);

  const placer = new LabelPlacer(ctx.font);
  const stageGroups = new Map();
  const polygons = [];
  const overLabels = [];
  for (const { el: e } of model.elements.values()) {
    const p = pos.get(e.id);
    const sym = symbols.get(e.id);
    const kindName = e.kind === 'comb' ? (e.op === 'concat' ? 'concat' : e.op) : e.kind === 'pipeline_register' ? 'preg' : e.kind === 'register' ? 'reg' : e.kind;
    const gid = `${kindName}-${e.id}`;
    const children = sym.draw(p.x, p.y, p.w, gid);
    placer.addRect({ x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h, ...(sym.isPort ? {} : { pad: 1 }) });
    if (sym.overLabel) overLabels.push({ gid, children, text: sym.overLabel, p });
    if (sym.polygon) polygons.push({ id: e.id, points: sym.polygon(p.x, p.y), margin: sym.inset, labelIds: Array.from({ length: e.inputs }, (_, i) => `${gid}-idx${i}`) });
    const key = e.kind === 'port' || e.kind === 'const' ? 'ports' : `stage-${part.get(e.id)}`;
    if (!stageGroups.has(key)) stageGroups.set(key, []);
    stageGroups.get(key).push(el('g', { id: gid }, children));
  }

  // Offsets of ELK-reserved truncation labels from their edge's source point.
  const sliceLabelOffset = new Map();
  for (const edge of run.laid.edges) {
    const lab = edge.labels?.[0];
    const start = edge.sections?.[0]?.startPoint;
    if (lab && start && lab.x !== undefined) sliceLabelOffset.set(/^(.*)__\d+$/.exec(edge.id)[1], { dx: lab.x - start.x, dy: lab.y - start.y });
  }
  const byNet = new Map();
  for (const edge of run.laid.edges) {
    const [, netId, idx] = /^(.*)__(\d+)$/.exec(edge.id);
    const pts = edgePts.get(edge.id);
    if (!byNet.has(netId)) byNet.set(netId, []);
    const sink = netInfo.get(netId).n.sinks[Number(idx)];
    const sym = symbols.get(sink.element.id);
    const sinkSym = sym.pins.find((q) => q.id === sink.pin.id);
    // No head: a gate input inside a gate-level region (the gate shape shows
    // direction), and a bus entering a split, where the wire does not end but
    // continues as the ripper spine.
    const gateInput = /^gate-/.test(sym.shape || '') && (doc.regions || []).some((r) => r.level === 'gate' && r.members.includes(sink.element.id));
    const ripper = sink.element.kind === 'comb' && sink.element.op === 'split';
    byNet.get(netId).push({ pts, through: Boolean(sinkSym?.through), sink, arrowRequired: !gateInput && !ripper, exempt: gateInput ? 'gate input in a gate-level region' : ripper ? 'bus continues as ripper spine' : null });
  }

  // pass 1: wires, arrows, junctions (all wires become label obstacles)
  const drawn = [];
  const arrowZones = [];
  const placedLabelBoxes = [];
  // Label placement for one net: skip spots in another net's arrow zone
  // (arrow/label-proximity), then let the placer avoid everything else.
  // Region frames are avoided here too; if a width label has no frame-free
  // spot, the frame edge it would touch grows outward to enclose the label
  // (frames enclose what their members' nets draw; frame checks verify the result).
  // Same text-box metric as the geometry checks (ascent above, 0.6·descent below).
  const tbox = (label, size, x, y) => ({ x0: x, x1: x + ctx.measure(label, size), y0: y - ctx.font.ascent * size, y1: y + ctx.font.descent * size * 0.6 });
  const clearOfArrows = (netId, box) => !arrowZones.some((z) => z.net !== netId && box.x0 < z.x1 && z.x0 < box.x1 && box.y0 < z.y1 && z.y0 < box.y1);
  const frameEdgesHit = (box) => frames.flatMap((f) => {
    const e = 0.6;
    const v = (x) => box.x0 - e < x && x < box.x1 + e && box.y0 < f.y1 && f.y0 < box.y1;
    const h = (y) => box.y0 - e < y && y < box.y1 + e && box.x0 < f.x1 && f.x0 < box.x1;
    return [v(f.x0) && [f, 'x0'], v(f.x1) && [f, 'x1'], h(f.y0) && [f, 'y0'], h(f.y1) && [f, 'y1']].filter(Boolean);
  });
  const placeFor = (netId, label, size, cands, { nudgeFrames = false } = {}) => {
    const usable = cands.filter((c) => {
      const box = tbox(label, size, c.x, c.y);
      return clearOfArrows(netId, box) && (nudgeFrames || !frameEdgesHit(box).length);
    });
    const spot = placer.place(label, size, usable);
    if (!spot) return spot;
    const box = tbox(label, size, spot.x, spot.y);
    if (nudgeFrames) {
      // Grow each touched edge outward past this label, and keep growing past
      // any label placed earlier that the moved edge would now strike.
      const hitsEdge = (b, f, edge) => frameEdgesHit(b).some(([g, e]) => g === f && e === edge);
      for (const [f, edge] of frameEdgesHit(box)) {
        const push = (b) => {
          if (edge === 'x0') f.x0 = Math.max(0.5, Math.min(f.x0, b.x0 - 1.5));
          if (edge === 'x1') f.x1 = Math.min(W - 0.5, Math.max(f.x1, b.x1 + 1.5));
          if (edge === 'y0') f.y0 = Math.max(0.5, Math.min(f.y0, b.y0 - 1.5));
          if (edge === 'y1') f.y1 = Math.max(f.y1, b.y1 + 1.5);
        };
        push(box);
        for (let guard = 0; guard < 8; guard += 1) {
          const struck = placedLabelBoxes.find((b) => hitsEdge(b, f, edge));
          if (!struck) break;
          push(struck);
        }
      }
    }
    placedLabelBoxes.push(box);
    return spot;
  };
  for (const n of model.nets) {
    const branches = byNet.get(n.net.id) || [];
    const { cls } = netInfo.get(n.net.id);
    const width = n.width ?? 1;
    const style = netStyle(t, cls, width);
    const segs = [];
    const heads = [];
    branches.forEach(({ pts, through, sink, arrowRequired }, i) => {
      const draw = pts.map((q) => ({ ...q }));
      // A through pin's head is drawn by the symbol at the end of its stub.
      if (arrowRequired && !wantsArrow(t, cls, width)) {
        diagnostics.push({ code: 'arrow/missing', severity: 'error', message: `${variant}: ${arrowKind(cls, width, t)} net ${n.net.id} ends at ${sink.element.id}.${sink.pin.id} without an arrowhead`, subject: { id: n.net.id, variant, sink: `${sink.element.id}.${sink.pin.id}` }, evidence: { kind: arrowKind(cls, width, t), skin_arrow_at: t.arrow.at }, supportedFixes: [`add "${arrowKind(cls, width, t)}" to the skin's arrow.at`] });
      }
      if (arrowRequired && wantsArrow(t, cls, width) && !through) {
        const a = draw[draw.length - 2];
        const b = draw[draw.length - 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        const L = Math.min(t.arrow.length, len * 0.8);
        draw[draw.length - 1] = { x: b.x - ux * L, y: b.y - uy * L };
        heads.push(arrowHead(t, `net-${n.net.id}-arrow${i}`, b, ux, uy, style.stroke, { length: L }));
        // Zone (head + last 8 pt of shaft) that labels of OTHER nets must avoid.
        const back = { x: b.x - ux * (L + 8), y: b.y - uy * (L + 8) };
        const grow = t.arrow.width / 2 + 1.5;
        arrowZones.push({ net: n.net.id, x0: Math.min(b.x, back.x) - grow, x1: Math.max(b.x, back.x) + grow, y0: Math.min(b.y, back.y) - grow, y1: Math.max(b.y, back.y) + grow });
        // No placer obstacle here: a net's own width label may sit next to
        // its arrow; foreign labels near an arrow are caught by arrow/label-proximity.
      }
      segs.push(el('path', { id: `net-${n.net.id}-seg${i}`, d: pathD(draw), ...style }));
      placer.addPolyline(pts, style['stroke-width']);
    });
    const dots = junctions(branches.map((b) => b.pts)).map((j, k) => el('circle', { id: `net-${n.net.id}-dot${k}`, cx: j.x, cy: j.y, r: Math.max((t.junction_diam_factor * style['stroke-width']) / 2, 1.2), fill: style.stroke, stroke: 'none' }));
    drawn.push({ n, cls, width, branches, children: [...segs, ...heads, ...dots] });
  }
  // A wire must never run along a frame edge (it would read as part of the
  // frame): push that edge off the wire, outward when the canvas allows.
  // A wire parallel to a frame edge closer than the frame gap (1.5 × for a
  // dashed wire beside the dashed frame) pushes that edge past the wire.
  const frameGap = rt.frame_gap_pt ?? 6;
  const wireSegs = drawn.flatMap((d) => d.branches.flatMap((b) => [...segmentsOf([b.pts])].map((sg) => ({ ...sg, dashed: d.cls === 'control' }))));
  pushFramesOffWires(frames, wireSegs, {
    nodeRects: [...pos].map(([id, r]) => ({ id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
    membersOf: (id) => tree.all.find((x) => x.id === id)?.inside ?? [],
    W, H, frameGap,
  });
  // pass 2: width slashes and net names, placed where they touch nothing
  const unlabeled = [];
  const missingWidth = [];
  const widthLabeled = new Set();
  // CONVENTIONS §2.1: a width is labeled where it is introduced or changed.
  // It is required when the driver is a port or constant, the net is a
  // truncation, or no input of the driving element carries the same width;
  // a width carried through (pipeline lane, register, mux, same-width block)
  // is labeled when there is room and may be omitted otherwise.
  const widthRequired = (n) => {
    const drv = n.driver.element;
    if (!drv || drv.kind === 'port' || drv.kind === 'const' || n.net.truncation) return true;
    return !model.nets.some((m) => m !== n && m.width === n.width && m.sinks.some((s) => s.element?.id === drv.id));
  };
  for (const d of drawn) {
    const { n, width, branches, children } = d;
    const pl = branches.map((b) => b.pts);
    // Truncation label [msb:lsb] just downstream of the source, width slash after it.
    let sliceEnd = null;
    if (n.net.truncation) {
      const tl = n.net.truncation.label;
      const tw = ctx.measure(tl, S);
      const first = pl[0] && pl[0].length > 1 ? { a: pl[0][0], b: pl[0][1] } : null;
      let spot = null;
      if (first && Math.abs(first.a.y - first.b.y) < 0.01) {
        const dir = Math.sign(first.b.x - first.a.x) || 1;
        const x = dir > 0 ? first.a.x + 4 : first.a.x - 4 - tw;
        // ELK reserved this room as an end label next to the source port;
        // keep its offset from the (possibly straightened) source point.
        const reserved = sliceLabelOffset.get(n.net.id);
        const cands = [];
        // Prefer right after the source; otherwise slide along the first run.
        const runEnd = dir > 0 ? first.b.x - tw - t.arrow.length - 2 : first.b.x + t.arrow.length + 2;
        for (let k = 0; k < 12; k += 1) {
          const cx = dir > 0 ? x + k * 5 : x - k * 5;
          if ((dir > 0 && cx > runEnd) || (dir < 0 && cx < runEnd)) break;
          cands.push({ x: cx, y: first.a.y - 2 }, { x: cx, y: first.a.y + 2 + ctx.font.ascent * S });
        }
        if (reserved) cands.unshift({ x: first.a.x + reserved.dx + 2, y: first.a.y + reserved.dy + ctx.font.ascent * S + 1 });
        spot = placeFor(n.net.id, tl, S, cands);
        if (spot) sliceEnd = Math.max(4 + tw, spot.x + tw - first.a.x);
      }
      if (spot) children.push(text(ctx, tl, spot.x, spot.y, 'secondary', `net-${n.net.id}-slice`));
      else diagnostics.push({ code: 'print/slice-label-omitted', severity: 'error', message: `${variant}: no room for the truncation label ${tl} on ${n.net.id}; the slice would be invisible`, subject: { id: n.net.id }, evidence: {}, supportedFixes: ['increase spacing for this variant', `draw ${n.net.truncation.element} as a split with an explicit tap`] });
    }
    if (width > 1 && !isBundleNet(n)) {
      const s = t.bus_slash;
      const q = s.length / 2 / Math.SQRT2;
      // One integer, never an N×W product (CONVENTIONS §2.1).
      const label = String(width);
      const lw = ctx.measure(label, S);
      let done = false;
      const ends = pl.map((p) => p[p.length - 1]);
      // Phase 1: spots clear of frames. Phase 2: let a frame grow around the label.
      for (const nudge of [false, true]) {
      if (done) break;
      let firstSeg = true;
      for (const seg of segmentsOf(pl)) {
        const afterSlice = firstSeg && sliceEnd !== null;
        firstSeg = false;
        if (seg.len < s.length) continue;
        const dir = seg.horizontal ? Math.sign(seg.b.x - seg.a.x) || 1 : Math.sign(seg.b.y - seg.a.y) || 1;
        // Candidate slash positions along the segment: near the source (or
        // right after a truncation label, never on it), the middle, and just
        // before the arrowhead when the segment ends at a pin.
        const intoPin = ends.some((e) => Math.abs(e.x - seg.b.x) < 0.01 && Math.abs(e.y - seg.b.y) < 0.01);
        const lo = afterSlice ? sliceEnd + q + 2 : q + 0.5;
        const hi = seg.len - q - (intoPin ? t.arrow.length + 0.5 : 0.5);
        // Preferred spots first, then a 1 pt sweep so a gap between a block
        // and a frame edge on a short wire is still found.
        const sweep = [];
        for (let o = lo; o <= hi + 1e-6; o += 1) sweep.push(o);
        const offsets = [afterSlice ? lo : s.offset, seg.len / 2, hi, ...sweep].filter((o, k, all) => o >= lo && o <= hi && all.indexOf(o) === k);
        for (const off of offsets) {
          if (seg.horizontal) {
            const cx = seg.a.x + dir * off;
            if (placer.hitsText({ x0: cx - q, y0: seg.a.y - q, x1: cx + q, y1: seg.a.y + q })) continue;
            const spot = placeFor(n.net.id, label, S, [
              { x: cx - lw / 2 + 1.5, y: seg.a.y - q - s.label_gap },
              { x: cx - lw / 2 + 1.5, y: seg.a.y + q + s.label_gap + ctx.font.ascent * S },
            ], { nudgeFrames: nudge });
            if (!spot) continue;
            // The slash is an obstacle for later labels (a neighbour's number must not sit on it).
            placer.addRect({ x0: cx - q, y0: seg.a.y - q, x1: cx + q, y1: seg.a.y + q, pad: 1.2 });
            children.push(el('path', { id: `net-${n.net.id}-slash`, d: `M${num(cx - q)} ${num(seg.a.y + q)} L${num(cx + q)} ${num(seg.a.y - q)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }));
            children.push(text(ctx, label, spot.x, spot.y, 'secondary', `net-${n.net.id}-width`));
          } else {
            const cy = seg.a.y + dir * off;
            if (placer.hitsText({ x0: seg.a.x - q, y0: cy - q, x1: seg.a.x + q, y1: cy + q })) continue;
            const spot = placeFor(n.net.id, label, S, [
              { x: seg.a.x + q + s.label_gap, y: cy + ctx.base(S) },
              { x: seg.a.x - q - s.label_gap - lw, y: cy + ctx.base(S) },
            ], { nudgeFrames: nudge });
            if (!spot) continue;
            placer.addRect({ x0: seg.a.x - q, y0: cy - q, x1: seg.a.x + q, y1: cy + q, pad: 1.2 });
            children.push(el('path', { id: `net-${n.net.id}-slash`, d: `M${num(seg.a.x - q)} ${num(cy + q)} L${num(seg.a.x + q)} ${num(cy - q)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }));
            children.push(text(ctx, label, spot.x, spot.y, 'secondary', `net-${n.net.id}-width`));
          }
          widthLabeled.add(n.net.id);
          done = true;
          break;
        }
        if (done) break;
      }
      }
      if (!done) (d.cls === 'data' && widthRequired(n) ? missingWidth : unlabeled).push(n.net.id);
    }
    // An off-page connector tag already names its net.
    const atConnector = n.driver.element?.connector || n.sinks.some((s) => s.element?.connector);
    if (n.net.label && !atConnector) {
      const lbl = labelOf(ctx, n.net, n.net.id);
      const lw = ctx.measure(lbl, S);
      const candidates = [];
      for (const seg of segmentsOf(pl)) {
        if (!seg.horizontal || seg.len < lw + 4) continue;
        const x0 = Math.min(seg.a.x, seg.b.x);
        const x1 = Math.max(seg.a.x, seg.b.x);
        for (const x of [x0 + 2, (x0 + x1 - lw) / 2, x1 - lw - 2 - t.arrow.length]) {
          candidates.push({ x, y: seg.a.y - 2.5 }, { x, y: seg.a.y + 2.5 + ctx.font.ascent * S });
        }
      }
      const spot = placeFor(n.net.id, lbl, S, candidates);
      if (spot) children.push(text(ctx, lbl, spot.x, spot.y, 'secondary', `net-${n.net.id}-name`));
      else diagnostics.push({ code: 'print/net-label-omitted', severity: 'warning', message: `${variant}: no free spot for net label '${lbl}' on ${n.net.id}`, subject: { id: n.net.id }, evidence: {}, supportedFixes: ['add short_label', 'use the 2col variant'] });
    }
  }
  // Region frames are label obstacles too.
  for (const f of frames) placer.addPolyline([{ x: f.x0, y: f.y0 }, { x: f.x1, y: f.y0 }, { x: f.x1, y: f.y1 }, { x: f.x0, y: f.y1 }, { x: f.x0, y: f.y0 }], skin.symbols.region_frame.stroke);

  // Labels above symbols (pipeline stage names, long register names) are
  // placed after the wires so they cannot sit on one; they may overhang the
  // symbol, which keeps the bar from widening its layer.
  for (const o of overLabels) {
    const lw = ctx.measure(o.text, S);
    const cx = o.p.x + o.p.w / 2;
    const asc = ctx.font.ascent * S;
    const cands = [o.p.y - 2, o.p.y - 3 - S].flatMap((y) => [cx - lw / 2, o.p.x, o.p.x + o.p.w - lw, cx - lw / 2 - 4, cx - lw / 2 + 4].map((x) => ({ x, y })));
    const spot = placer.place(o.text, S, cands.filter((c) => c.x >= 0 && c.x + lw <= W && c.y - asc >= 0));
    if (spot) o.children.push(text(ctx, o.text, spot.x, spot.y, 'secondary', `${o.gid}-label`));
    else diagnostics.push({ code: 'print/stage-label-omitted', severity: 'warning', message: `${variant}: no free spot above ${o.gid} for its label '${o.text}'`, subject: { id: o.gid }, evidence: {}, supportedFixes: ['name the stage in the caption', 'increase spacing for this variant'] });
  }

  if (unlabeled.length) diagnostics.push({ code: 'print/width-label-omitted', severity: 'info', message: `${variant}: no room for a slash-N width label on control nets ${unlabeled.join(', ')}`, subject: { ids: unlabeled }, evidence: {}, supportedFixes: ['state the width in the caption'] });
  // Every multi-bit data net shows its width (CONVENTIONS §2.1).
  // A width carried straight through a pipeline lane is labeled once: when the
  // lane's other side shows the same width, this side is not missing it.
  const laneTwin = (id) => laneCarried(model.nets, id, widthLabeled);
  for (const id of missingWidth.filter((x) => laneTwin(x))) unlabeled.push(id);
  missingWidth.splice(0, missingWidth.length, ...missingWidth.filter((x) => !laneTwin(x)));
  for (const id of missingWidth) diagnostics.push({ code: 'width/missing', severity: 'error', message: `${variant}: multi-bit data net ${id} has no width label (no free spot for the slash and number)`, subject: { id, variant }, evidence: {}, supportedFixes: ['lengthen the net (spacing, fewer bends)', 'move a neighbouring label', 'drop this variant for this figure'] });

  // Region frames: enclose exactly their members (compound layout), label inside the top padding.
  const regionGroups = [];
  const fr = skin.symbols.region_frame;
  for (const f of frames) {
    const r = (doc.regions || []).find((x) => x.id === f.id);
    const kids = [el('rect', { id: `region-${f.id}-frame`, x: f.x0, y: f.y0, width: f.x1 - f.x0, height: f.y1 - f.y0, fill: 'none', stroke: t.ink, 'stroke-width': fr.stroke, 'stroke-dasharray': fr.dash.join(' ') })];
    const lbl = chosen.labels === 'short' && r.short_label ? r.short_label : r.label;
    if (lbl) {
      const asc = ctx.font.ascent * S;
      const lw = ctx.measure(lbl, S);
      const spot = placer.place(lbl, S, [{ x: f.x0 + 2.5, y: f.y0 + 2 + asc }, { x: f.x1 - lw - 2.5, y: f.y0 + 2 + asc }]);
      if (spot) kids.push(text(ctx, lbl, spot.x, spot.y, 'secondary', `region-${f.id}-label`));
      else diagnostics.push({ code: 'print/region-label-omitted', severity: 'warning', message: `${variant}: no free spot for region label '${lbl}'`, subject: { id: f.id }, evidence: {}, supportedFixes: ['add short_label to the region', 'name the region in the caption'] });
    }
    regionGroups.push(el('g', { id: `region-${f.id}` }, kids));
  }
  if (legend) {
    const lw = ctx.measure(legend, S);
    regionGroups.push(el('g', { id: 'legend-levels' }, [text(ctx, legend, Math.max(2, W - lw - 2), H - 3, 'secondary', 'legend-levels-text')]));
    if (lw > W - 4) diagnostics.push({ code: 'print/legend-overflow', severity: 'error', message: `${variant}: the abstraction-level legend is wider than the column`, subject: { variant }, evidence: { width: lw }, supportedFixes: ['set meta.legend false and explain the levels in the caption'] });
  }

  const netGroups = { data: [], control: [] };
  for (const d of drawn) netGroups[d.cls === 'data' ? 'data' : 'control'].push(el('g', { id: `net-${d.n.net.id}` }, d.children));

  const datapathChildren = [...stageGroups.entries()]
    .sort(([a], [b]) => (a === 'ports' ? -1 : b === 'ports' ? 1 : Number(a.split('-')[1]) - Number(b.split('-')[1])))
    .map(([key, groups]) => el('g', { id: key }, groups));
  const svgTree = el('svg', { xmlns: 'http://www.w3.org/2000/svg', id: `fig-${name}-${variant}`, width: `${num(W)}pt`, height: `${num(H)}pt`, viewBox: `0 0 ${num(W)} ${num(H)}` }, [
    el('g', { id: 'frame' }, [el('rect', { x: 0, y: 0, width: W, height: H, fill: t.background, stroke: 'none' })]),
    el('g', { id: 'nets' }, [el('g', { id: 'nets-data' }, netGroups.data), el('g', { id: 'nets-control' }, netGroups.control)]),
    el('g', { id: 'datapath' }, datapathChildren),
    ...(regionGroups.length ? [el('g', { id: 'regions' }, regionGroups)] : []),
  ]);

  const frameList = frames.map((f) => ({ ...f, members: tree.all.find((x) => x.id === f.id).inside }));
  const nodeList = [...pos].map(([id, r]) => ({ id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
  diagnostics.push(...geometryChecks(svgTree, { font: ctx.font, polygons, frames: frameList, nodes: nodeList, frameGap: rt.frame_gap_pt ?? 6 }));

  // Glyph distinguishability (CONVENTIONS §3.5): a solid narrow bar is a mux
  // with a select pin and ≥ 2 inputs (D1); no two element kinds share a glyph.
  const lint = skin.glyph_lint;
  walk(svgTree, (node) => {
    if (node.name !== 'rect' || (node.attrs.stroke && node.attrs.stroke !== 'none')) return;
    const fill = String(node.attrs.fill || '').toUpperCase();
    if (!['#000000', String(t.ink).toUpperCase(), String(t.fill.ink).toUpperCase()].includes(fill) || Number(node.attrs.width) >= lint.solid_bar_max_width) return;
    const m = /^mux-(.+)-body$/.exec(node.attrs.id || '');
    const mux = m && model.elements.get(m[1])?.el;
    if (!mux || mux.kind !== 'mux' || mux.inputs < 2 || !connected.has(`${mux.id}.sel`)) {
      diagnostics.push({ code: 'glyph/distinguishable', severity: 'error', message: `${variant}: solid bar ${node.attrs.id || '(unnamed)'} is not a mux with a select pin; a solid narrow bar always means mux`, subject: { id: node.attrs.id }, evidence: {}, supportedFixes: ['draw concatenation as a { } box and splits as ripper taps (skin join/split)'] });
    }
  });
  const TEXT_BOXES = new Set(['labeled-block', 'port-label', 'concat-box', 'extend-box', 'replicate-box', 'memory-block', 'synchronizer']);
  const glyphKinds = new Map();
  for (const { el: e } of model.elements.values()) {
    const g = symbols.get(e.id).glyph;
    if (!g || TEXT_BOXES.has(g)) continue;
    const category = e.kind === 'comb' ? `comb/${e.op === 'reduce' ? e.reduce || 'or' : e.op}` : e.kind;
    if (!glyphKinds.has(g)) glyphKinds.set(g, new Set());
    glyphKinds.get(g).add(category);
  }
  for (const [g, kinds] of glyphKinds) {
    const distinct = new Set([...kinds].map((k) => (k.startsWith('comb/') && g.startsWith('gate-') ? 'gate' : k.startsWith('comb/') && g.startsWith('circle-') ? `op:${g}` : k)));
    if (distinct.size > 1) diagnostics.push({ code: 'glyph/distinguishable', severity: 'error', message: `${variant}: element kinds ${[...kinds].join(', ')} all render as ${g}`, subject: { glyph: g }, evidence: { kinds: [...kinds] }, supportedFixes: ['give one of the kinds its own symbol in the skin'] });
  }

  // Routing quality (SPEC §9.4): straight data trunks, crossings per class.
  const routeNets = drawn.map((d) => ({ id: d.n.net.id, cls: d.cls === 'data' ? 'data' : 'control', finePitch: finePitch(d.n), polylines: d.branches.map((b) => b.pts) }));
  // Width labels are never products (width/product-notation).
  walk(svgTree, (node) => {
    if (node.name === 'text' && /-width$/.test(node.attrs.id || '') && PRODUCT_NOTATION.test(String(node.children[0]))) {
      diagnostics.push({ code: 'width/product-notation', severity: 'error', message: `${variant}: width label "${node.children[0]}" (${node.attrs.id}) is a product`, subject: { id: node.attrs.id }, evidence: {}, supportedFixes: ['print the total width'] });
    }
  });
  const jogs = dataJogs(routeNets, { minOffsetPt: rt.jog_min_offset_pt });
  for (const j of jogs.jogs.filter((x) => x.kind === 'redundant')) {
    diagnostics.push({ code: 'route/data-jog', severity: 'error', message: `${variant}: data net ${j.net} has a redundant ${num(j.offset)} pt level change at (${num(j.at.x)}, ${num(j.at.y)})`, subject: { id: j.net, variant }, evidence: j, supportedFixes: ['give connected blocks the same lane order and pin pitch', 'reorder ports so the data lanes line up'] });
  }
  // Every remaining bend on a data wire needs a justification: fan-out to
  // another row, feedback, gate pin pitch, or a straight path that moving
  // either end block (lane re-ordering) cannot clear. Otherwise it is an error.
  const { bends } = straightened;
  for (const b of bends) {
    if (b.avoidable) diagnostics.push({ code: 'route/data-jog', severity: 'error', message: `${variant}: data wire ${b.edge} bends but ${b.attempts.at(-1)}`, subject: { id: b.net, variant }, evidence: b, supportedFixes: ['re-order the blocks so the data lanes line up', 'move the pin to the side the wire arrives from'] });
    else diagnostics.push({ code: 'route/data-bend', severity: 'warning', message: `${variant}: data wire ${b.edge} bends ${b.bends}× (${b.reason})`, subject: { id: b.net, variant }, evidence: b, supportedFixes: [] });
  }
  // Wires parallel to a block outline or another wire closer than 4 pt.
  const hugRects = [...pos].filter(([id]) => !symbols.get(id).isPort).map(([id, r]) => ({ id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
  const hugging = edgeHugging(routeNets, hugRects, { minGap: rt.min_parallel_gap_pt ?? 4 });
  for (const h of hugging) {
    diagnostics.push({ code: 'route/edge-hugging', severity: 'error', message: `${variant}: net ${h.net} runs ${num(h.gap)} pt from ${h.kind === 'block' ? `the outline of ${h.other}` : `net ${h.other}`} at (${num(h.at.x)}, ${num(h.at.y)})`, subject: { id: h.net, variant }, evidence: h, supportedFixes: ['give the wire its own channel (≥ 4 pt from outlines and other wires)', 'raise the edge-to-node spacing'] });
  }
  // Long returning branches that are still drawn as loops.
  const partBack = part.backEdges || new Set();
  for (const n of model.nets) {
    n.sinks.forEach((s, i) => {
      if (!partBack.has(`${n.driver.element.id}>${s.element.id}`)) return;
      const d = pos.get(n.driver.element.id);
      const k = pos.get(s.element.id);
      if (!d || !k) return;
      const span = d.x + d.w - k.x;
      if (span > feedbackRatio * run.contentW) diagnostics.push({ code: 'route/long-feedback', severity: 'error', message: `${variant}: net ${n.net.id} returns ${num(span)} pt (more than ${feedbackRatio * 100}% of the figure width) to ${s.element.id} as a loop`, subject: { id: n.net.id, variant }, evidence: { span, ratio: feedbackRatio }, supportedFixes: ['draw it with named connectors (meta.style.connectors, default on)', 'reorder the blocks so the net runs forward'] });
    });
  }
  const crossings = crossingCounts(routeNets).counts;
  for (const cls of ['data', 'control', 'mixed']) {
    if (crossings[cls] > rt.max_crossings[cls]) diagnostics.push({ code: 'route/crossings', severity: 'warning', message: `${variant}: ${crossings[cls]} ${cls} wire crossings (threshold ${rt.max_crossings[cls]})`, subject: { variant, class: cls }, evidence: { crossings }, supportedFixes: ['reorder ports or elements so the flow is monotone', 'bundle parallel control nets'] });
  }
  const route = {
    data_nets_straight: jogs.straight, data_nets_total: jogs.total, data_jogs_redundant: jogs.redundant, data_bends_unavoidable: jogs.unavoidable,
    crossings, straightening: { moves: st.moves.length, redundant_jogs_before: st.before.redundant, redundant_jogs_after: st.after.redundant },
    edge_hugging: hugging.length, layout_plans: layoutPlans,
    ...(connectorMarks ? { connectors: connectorMarks.map((m) => ({ net: m.net, sink: m.sink, span: m.span })) } : {}),
    data_bends: bends.map((b) => ({ wire: b.edge, net: b.net, bends: b.bends, justification: b.avoidable ? null : b.reason })),
  };

  // Exact connectivity on the final SVG geometry (wire/detached, wire/touching,
  // symbol/bubble-detached): after straightening, anchor extension and bubbles.
  const svgText = `${serialize(svgTree)}\n`;
  const connectivity = connectivityChecks(svgText, { anchors, lanePairs, variant, dotArrowClearance: rt.dot_arrow_clearance ?? 8, wireStroke: t.stroke.wire });
  diagnostics.push(...connectivity.diagnostics);
  route.connectivity = connectivity.counts;

  const metrics = printMetrics(svgTree);
  if (metrics.minFont < minFontPt) diagnostics.push({ code: 'print/min-font', severity: 'error', message: `${variant}: ${metrics.minFont} pt text is below ${minFontPt} pt`, subject: { variant }, evidence: {}, supportedFixes: ['raise the skin font size'] });
  if (metrics.minStroke < minStrokePt) diagnostics.push({ code: 'print/min-stroke', severity: 'error', message: `${variant}: ${metrics.minStroke} pt stroke is below ${minStrokePt} pt`, subject: { variant }, evidence: {}, supportedFixes: ['raise the skin stroke width'] });
  if (maxHeightPt && H > maxHeightPt) diagnostics.push({ code: 'print/max-height', severity: 'error', message: `${variant}: height ${num(H)} pt exceeds ${num(maxHeightPt)} pt`, subject: { variant }, evidence: {}, supportedFixes: ['collapse more hardware into blocks whose rtl.covers name it (never drop hardware)', 'raise meta.print.max_height_in up to the profile maximum', 'narrow meta.scope explicitly or split into sub-figures (a)/(b) linked with detail_ref'] });

  return {
    svg: svgText,
    width_pt: W,
    height_pt: H,
    content_width_pt: run.contentW,
    min_font_pt: metrics.minFont,
    min_stroke_pt: metrics.minStroke,
    layout: chosen,
    route,
    font: { family: ctx.font.family, sha256: ctx.font.sha256 },
    short_labels_used: chosen.labels === 'short' ? doc.elements.filter((e) => e.short_label || functionNames(e.function)).map((e) => e.id) : [],
    // Pin anchors and pipeline lane levels the connectivity check used.
    geometry: { anchors, lanePairs },
    diagnostics,
  };
}
