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
import { PRODUCT_NOTATION, constantText, distinctInstanceNames, functionNames, readableIdentifier, unreadableReason } from '../checks/labels.mjs';
import { isBundleNet } from '../checks/datapath.mjs';
import { deriveNetClasses } from '../checks/net-class.mjs';
import { abstraction } from '../abstraction.mjs';
import { checkSkin } from '../checks/skin.mjs';
import { loadFont } from '../fonts.mjs';
import { buildModel } from '../ir/datapath-model.mjs';
import { parseEndpoint } from '../ir/endpoints.mjs';
import { el, num, pathD, printMetrics, serialize, walk } from '../svg.mjs';
import { connectivityChecks } from './connectivity.mjs';
import { GATE_OPS, drawGate, gateGeometry, hatchRect } from './gates.mjs';
import { geometryChecks, frameEntryChecks, growFramesForEntries, separateSiblingFrames } from './geometry.mjs';
import { mergeDuplicateSplits } from '../ir/canonical.mjs';
import { OP_GLYPH, circleOp, fieldRanges } from './glyphs.mjs';
import { LabelPlacer } from './labels.mjs';
import { readabilityFromSvg } from './readability.mjs';
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
    // Text the renderer generates (checked for readability) and the per-output
    // latency list behind shortened stage notes.
    generated: [], stageTable: [],
    measure: (s, size) => font.measure(s, size),
    base: (size) => (font.ascent * size) / 2,
  };
}

export const fontSize = (ctx, key) => (key === 'label' ? ctx.t.font.label_pt : ctx.t.font.secondary_pt);

export function text(ctx, value, x, y, sizeKey = 'label', id) {
  return el('text', { ...(id ? { id } : {}), x, y, 'font-family': ctx.family, 'font-size': fontSize(ctx, sizeKey), fill: ctx.t.ink }, [String(value)]);
}

// Does a block print secondary lines (stage notes, detail, pin labels, sizes)? Name only by default.
export const showsDetails = (ctx, element) => ctx.doc?.meta?.style?.block_details === true || element?.show_details === true;

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
  // An author's label outranks the vocabulary's short word in short mode; only its own short_label replaces it.
  if (pref === 'short') return e.short_label ?? e.label ?? names?.short ?? names?.display ?? fallback;
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
  const side = (p) => String(p.side || ctx.returnSides?.get(`${element.id}.${p.id}`) || (ctx.plan?.taps.has(`${element.id}.${p.id}`) ? 'south' : p.dir === 'out' ? 'east' : p.class === 'control' && !pinLabels && hasDataIn ? 'north' : (p.class === 'reset' || p.class === 'clock') && !pinLabels ? 'south' : 'west')).toUpperCase();
  const groups = { WEST: [], EAST: [], NORTH: [], SOUTH: [] };
  for (const p of pins) groups[side(p)].push(p);
  // No pin names inside boxes by default (CONVENTIONS §4.3, label/pin-clutter):
  // with pin_labels on, only pins that carry a readable label print, never an
  // RTL pin id and never a clock or reset pin.
  const printsLabel = (p) => pinLabels && Boolean(p.label) && p.class !== 'clock' && p.class !== 'reset';
  const pinText = (p) => (ctx.mode === 'short' && p.short_label ? p.short_label : p.label);
  const lw = pinLabels ? Math.max(0, ...groups.WEST.filter(printsLabel).map((p) => ctx.measure(pinText(p), S))) : 0;
  const rw = pinLabels ? Math.max(0, ...groups.EAST.filter(printsLabel).map((p) => ctx.measure(pinText(p), S))) : 0;
  const lines = wrap ? wrapTitle(ctx, title, L) : [title];
  const lineH = L * 1.15;
  const titleW = Math.max(...lines.map((s) => ctx.measure(s, L)));
  const titleH = L + (lines.length - 1) * lineH;
  const subLines = sub ? String(sub).split('\n') : [];
  const subW = subLines.length ? Math.max(...subLines.map((l) => ctx.measure(l, S))) : 0;
  const subH = subLines.length ? subLines.length * (S + 1) + 2 : 0;
  const northLabelH = groups.NORTH.some(printsLabel) ? S + 2 : 0;
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
    width: w, height: h, pins: placed, shape: kind, glyph, subLineCount: subLines.length,
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
        for (const p of placed.filter(printsLabel)) {
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

// In-block stage notes (label/stage-note-clutter): at most this many lines.
export const STAGE_NOTE_LINES = 2;
const STAGE_LINE_CHARS = 36;

// Stage-note lines for registered outputs whose latencies differ: one line per
// latency naming its outputs when that fits, else the latency range on one line.
export function stageNoteLines(entries, { maxLines = STAGE_NOTE_LINES } = {}) {
  const plural = (k) => `${k} stage${k > 1 ? 's' : ''}`;
  const latencies = [...new Set(entries.map((e) => e.latency))].sort((a, b) => a - b);
  if (latencies.length === 1) return [plural(latencies[0])];
  const grouped = latencies.map((k) => `${plural(k)}: ${[...new Set(entries.filter((e) => e.latency === k).map((e) => e.name))].join(', ')}`);
  if (grouped.length <= maxLines && grouped.every((l) => l.length <= STAGE_LINE_CHARS)) return grouped;
  return [`outputs: ${latencies[0]}–${latencies.at(-1)} stages`];
}

// Output latency table of a study figure: one line per block listing its
// outputs by latency ("Owner controller: 1 stage: ready, done; 2 stages: data"),
// continued on an indented line when longer than maxChars; the renderer wraps
// the lines into columns of STAGE_TABLE_ROWS.
export const STAGE_TABLE_ROWS = 16;
export function stageTableRows(entries, { maxChars = 110 } = {}) {
  const byBlock = new Map();
  for (const r of entries) {
    if (!byBlock.has(r.element)) byBlock.set(r.element, { block: r.block, outputs: new Map() });
    byBlock.get(r.element).outputs.set(r.pin, r);
  }
  const rows = [];
  for (const { block, outputs } of byBlock.values()) {
    const list = [...outputs.values()];
    const latencies = [...new Set(list.map((o) => o.latency))].sort((a, b) => a - b);
    const parts = latencies.map((k, i) => `${k} stage${k > 1 ? 's' : ''}: ${[...new Set(list.filter((o) => o.latency === k).map((o) => o.output))].join(', ')}${i < latencies.length - 1 ? ';' : ''}`);
    let line = `${block}:`;
    for (const part of parts) {
      if (`${line} ${part}`.length > maxChars && line !== `${block}:`) {
        rows.push(line);
        line = `    ${part}`;
      } else line = `${line} ${part}`;
    }
    rows.push(line);
  }
  return rows;
}

// Readable name of a pin for generated text: its label, else its net's label,
// else its net's RTL signal or the pin id made readable; never a raw id.
function pinPhrase(ctx, element, p) {
  if (p.label) return p.label;
  const endpoint = `${element.id}.${p.id}`;
  const net = (ctx.doc.nets || []).find((n) => n.driver === endpoint || (n.sinks || []).includes(endpoint));
  return net?.label ?? readableIdentifier(net?.rtl?.signal ?? net?.rtl_unmapped?.rtl?.signal ?? p.id);
}

// Study figures: a net between instances whose probe route crosses the frame
// of a region holding neither of its ends, or passes that frame by (a
// horizontal run spanning its whole width: ELK routes around frames), or that
// joins two instance frames more than one flow layer apart (rootRanks: it
// would cross the units between them), becomes a pair of named connectors, so
// wires stay inside the frames of the instances they connect. A rank gap
// between blocks drawn fewer than `minLayers` layers apart is not a reason.
export function regionCrossingMarks(model, run, { minLayers = 2 } = {}) {
  const layers = run.nodes ? probeLayers(run) : new Map();
  const boxes = [];
  const visit = (g) => {
    for (const c of g.children || []) {
      if (!c.id.startsWith('region:')) continue;
      boxes.push({ id: c.id.slice('region:'.length), x0: c.x, y0: c.y, x1: c.x + c.width, y1: c.y + c.height });
      visit(c);
    }
  };
  visit(run.laid);
  if (!boxes.length) return [];
  const inside = new Map(run.tree.all.map((n) => [n.id, n.inside]));
  const through = (a, b, box) => Math.max(a.x, b.x) > box.x0 + 0.5 && Math.min(a.x, b.x) < box.x1 - 0.5 && Math.max(a.y, b.y) > box.y0 + 0.5 && Math.min(a.y, b.y) < box.y1 - 0.5;
  const past = (a, b, box) => Math.abs(a.y - b.y) < 0.01 && Math.min(a.x, b.x) < box.x0 && Math.max(a.x, b.x) > box.x1;
  const hits = (a, b, box) => through(a, b, box) || past(a, b, box);
  const nodeById = new Map(run.tree.all.map((n) => [n.id, n]));
  const frameOf = (id) => {
    const r = run.tree.owner?.get(id);
    if (!r) return null;
    let n = nodeById.get(r);
    while (n?.parent) n = nodeById.get(n.parent);
    return n ? `region:${n.id}` : null;
  };
  const routes = new Map((run.laid.edges || []).map((e) => [e.id, e]));
  const marks = [];
  for (const n of model.nets) {
    n.sinks.forEach((s, i) => {
      const sec = routes.get(`${n.net.id}__${i}`)?.sections?.[0];
      if (!sec || s.error || n.driver.error) return;
      const pts = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint];
      const ends = [n.driver.element.id, s.element.id];
      const crossed = boxes.filter((b) => !ends.some((id) => inside.get(b.id)?.has(id)) && pts.some((p, k) => k > 0 && hits(pts[k - 1], p, b)));
      const [from, to] = ends.map(frameOf);
      const gap = run.ranks && from && to && from !== to ? Math.abs(run.ranks.get(from) - run.ranks.get(to)) : 0;
      if (crossed.length || (gap > 1 && layerGap(layers, ends[0], ends[1]) >= minLayers)) marks.push({ net: n.net.id, sink: i, span: crossed.length || gap - 1, kind: 'inter-region' });
    });
  }
  return marks;
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
    ctx.generated.push({ id: element.id, where: 'connector', text: label });
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

  // A constant is a small outlined value box at the pin, in the secondary
  // font: never port-style text (label/constant-as-port-label).
  if (element.kind === 'const') {
    const S = t.font.secondary_pt;
    const pad = skin.symbols.port.const_pad ?? 2;
    const label = constantText(element);
    const h = S + 3;
    const w = ctx.measure(label, S) + 2 * pad;
    const p = modelPins[0];
    return {
      width: w, height: h, isPort: true, glyph: 'const-box', shape: 'const',
      pins: [{ ...p, x: w, y: h / 2, side: 'EAST' }],
      draw: (x, y, _nw, id) => [
        el('rect', { id: `${id}-body`, x, y, width: w, height: h, fill: t.fill.logic, stroke: t.ink, 'stroke-width': outlineW(t, 'const') }),
        text(ctx, label, x + pad, y + h / 2 + ctx.base(S), 'secondary', `${id}-label`),
      ],
    };
  }
  if (element.kind === 'port') {
    const s = skin.symbols.port;
    const label = elementTitle(ctx, element, element.id);
    const p = modelPins[0];
    // A figure port no net touches sits at the figure edge (renderDatapathOnce)
    // with a short stub and a small "unused" mark: an input reads label, stub,
    // mark; an output mark, stub, label.
    if (ctx.unusedPorts?.has(element.id)) {
      const S = t.font.secondary_pt;
      const stub = s.unused_stub ?? 6;
      const mark = 'unused';
      const lw = ctx.measure(label, t.font.label_pt);
      const mw = ctx.measure(mark, S);
      const w = lw + s.gap + stub + 1.5 + mw;
      const mid = s.height / 2;
      const input = element.dir === 'in';
      return {
        width: w, height: s.height, isPort: true, glyph: 'port-label', unused: true,
        pins: [{ ...p, x: input ? w : 0, y: mid, side: input ? 'EAST' : 'WEST' }],
        draw: (x, y, _nw, id) => {
          const [labelX, stubX, markX] = input ? [x, x + lw + s.gap, x + lw + s.gap + stub + 1.5] : [x + mw + 1.5 + stub + s.gap, x + mw + 1.5, x];
          return [
            text(ctx, label, labelX, y + mid + ctx.base(t.font.label_pt), 'label', `${id}-label`),
            el('path', { id: `${id}-unused-stub`, d: `M${num(stubX)} ${num(y + mid)} L${num(stubX + stub)} ${num(y + mid)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }),
            text(ctx, mark, markX, y + mid + ctx.base(S), 'secondary', `${id}-unused`),
          ];
        },
      };
    }
    const w = ctx.measure(label, t.font.label_pt) + s.gap;
    const drives = element.dir === 'in';
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
  // "concat" only. The input order is the convention (MSB field on top); each
  // input keeps its width slash on its wire, and no destination range is printed.
  if (element.kind === 'comb' && element.op === 'concat') {
    const s = skin.symbols.join;
    const LS = fontSize(ctx, s.label_font);
    const ins = modelPins.filter((p) => p.dir === 'in');
    const out = modelPins.find((p) => p.dir === 'out');
    const ranges = [];
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

  if (element.kind === 'register' && Array.isArray(element.lanes)) {
    // A register bank (CONVENTIONS §5.6): one narrow storage box (the skin's
    // register width), a clock wedge, one lane per register on the pin pitch
    // (d west, q east), the load enable on top. No name is printed: the nets and
    // ports on its lanes say what it holds.
    const symbol = skin.symbols.register;
    const pitch = skin.symbols.pipeline_register.lane_pitch;
    const margin = pitch / 2;
    const w = symbol.width_pt ?? symbol.size[0];
    const h = element.lanes.length * pitch + 2 * margin;
    const laneY = (i) => margin + pitch * (i + 0.5);
    const pins = [
      ...(element.shared_d ? modelPins.filter((p) => p.id === 'd').map((p) => ({ ...p, x: 0, y: laneY(Math.floor((element.lanes.length - 1) / 2)), side: 'WEST' })) : []),
      ...element.lanes.flatMap((lane, i) => [
        ...(element.shared_d ? [] : [{ ...modelPins.find((p) => p.id === `d_${lane.id}`), x: 0, y: laneY(i), side: 'WEST' }]),
        { ...modelPins.find((p) => p.id === `q_${lane.id}`), x: w, y: laneY(i), side: 'EAST' },
      ]),
      ...modelPins.filter((p) => p.id === 'en').map((p) => ({ ...p, x: w / 2, y: 0, side: 'NORTH' })),
      ...modelPins.filter((p) => p.id === 'rst').map((p) => ({ ...p, x: w * 0.75, y: h, side: 'SOUTH' })),
    ];
    return {
      width: w, height: h, pins, shape: 'register-bank', glyph: 'register',
      draw: (x, y, _nw, id) => [
        el('rect', { id: `${id}-body`, x, y, width: w, height: h, fill: t.fill[symbol.fill], stroke: t.ink, 'stroke-width': outlineW(t, 'register') }),
        el('path', { d: `M${num(x + w / 2 - 3)} ${num(y + h)} L${num(x + w / 2)} ${num(y + h - 4.5)} L${num(x + w / 2 + 3)} ${num(y + h)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }),
      ],
      overLabel: null,
    };
  }

  if (element.kind === 'register') {
    const symbol = skin.symbols.register;
    const [w, h] = symbol.size;
    const pins = Object.entries(symbol.pins)
      .filter(([pid]) => modelPins.some((p) => p.id === pid))
      .map(([pid, geo]) => ({ ...modelPins.find((p) => p.id === pid), x: geo.x, y: geo.y, side: geo.side }));
    return {
      width: w, height: h, pins, shape: 'register', glyph: 'register',
      draw: (x, y, _nw, id) => [
        ...symbol.body.map((b) => (b.el === 'rect'
          ? el('rect', { id: `${id}-body`, x: x + b.x, y: y + b.y, width: b.width, height: b.height, fill: t.fill[symbol.fill], stroke: t.ink, 'stroke-width': outlineW(t, 'register') })
          : el('path', { d: translatePath(b.d, x, y), fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }))),
      ],
      // No name is printed (CONVENTIONS §5.1): its ports and nets say what it holds.
      overLabel: null,
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

  // Blocks print their name only (CONVENTIONS §4.3): stage notes, function.detail,
  // pin labels and sizes appear inside a box only when the figure
  // (meta.style.block_details) or the block (show_details) opts in. Latency and
  // detail stay in the receipt (route.stage_notes) and the study side table.
  const details = showsDetails(ctx, element);
  const detail = details && ctx.mode !== 'short' ? names?.detail : undefined;
  // A collapsed block that holds registers on its outputs is marked registered
  // (CONVENTIONS §5.4): a clock wedge on its bottom edge and its latency.
  const registeredOuts = modelPins.filter((p) => p.dir === 'out' && p.sequential);
  // A state output ("state") has no stage count: it keeps the clock wedge but
  // is left out of stage notes (its internal bound is not a latency).
  const timedOuts = registeredOuts.filter((p) => p.latencySpec !== 'state');
  const stages = Math.max(0, ...timedOuts.map((p) => p.latency ?? 1));
  const clocked = registeredOuts.length > 0;
  const isMemoryFn = element.function?.kind === 'memory';
  const plural = (k) => `${k} stage${k > 1 ? 's' : ''}`;
  // A memory's registered read is the clock wedge alone (CONVENTIONS §6). When
  // registered outputs differ in latency, the note stays within two lines: a
  // line per latency naming its outputs when short, else the latency range. The
  // full per-output list goes to the receipt (route.stage_notes) and, in a
  // study figure, to the output latency table below the drawing.
  const perPath = new Set(timedOuts.map((p) => p.latency ?? 1)).size > 1;
  const entries = timedOuts.map((p) => ({ name: pinPhrase(ctx, element, p), latency: p.latency ?? 1, pin: p.id }));
  if (stages && !isMemoryFn && perPath) {
    const block = elementTitle(ctx, element, element.module ?? element.id);
    for (const e of entries) {
      ctx.stageTable.push({ element: element.id, block, output: e.name, pin: e.pin, latency: e.latency });
      ctx.generated.push({ id: element.id, where: 'stage note', text: e.name });
    }
  }
  const detailLines = detail ? String(detail).split('\n').length : 0;
  const noteLines = !details || !stages || isMemoryFn ? [] : perPath ? stageNoteLines(entries, { maxLines: Math.max(1, STAGE_NOTE_LINES - detailLines) }) : [plural(stages)];
  const stageNote = noteLines.length ? noteLines.join('\n') : null;
  const withStages = (sub) => (stageNote ? (sub ? `${sub}\n${stageNote}` : stageNote) : sub);
  switch (element.kind) {
    case 'comb':
      return genericBlock(ctx, element, modelPins, {
        title: elementTitle(ctx, element, OP_TITLE[element.op]?.(element) ?? element.op),
        sub: ['lut', 'rom'].includes(element.op) ? (details ? `${element.depth}×${element.width}` : undefined) : withStages(detail),
        pinLabels: details && element.op === 'custom' && element.pin_labels === true,
        kind: element.op,
        wedge: clocked,
      });
    case 'memory':
      return genericBlock(ctx, element, modelPins, { title: elementTitle(ctx, element, element.id), sub: details ? `${element.depth}×${element.width}` : undefined, fillKey: 'storage', memory: true, pinLabels: details && element.pin_labels === true, wedge: true, kind: 'memory', glyph: 'memory-block' });
    case 'synchronizer':
      return genericBlock(ctx, element, modelPins, { title: element.label ?? 'sync', sub: details ? element.style : undefined, fillKey: 'storage', wedge: true, kind: 'synchronizer', glyph: 'synchronizer' });
    case 'instance': {
      const sym = genericBlock(ctx, element, modelPins, { title: elementTitle(ctx, element, element.module), sub: withStages(detail), pinLabels: details && element.pin_labels === true, kind: 'instance', wedge: clocked });
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

// Study figures: rank the root-level units (elements outside frames and the
// outermost instance frames) along the flow between them (clients, then the
// owner, then the engine). Feedback between units (handshake returns, results)
// is found depth-first from the units with the fewest inputs and ignored; each
// unit gets its longest-path layer. The ranks find nets that skip a layer
// (regionCrossingMarks); they are not imposed as layout partitions, because
// ELK's layered flow already orders the frames and forcing the ranks added
// crossings on the trial views (whole design 1.35 → 1.72, engine 2.23 → 2.51
// crossings per net).
export function rootRanks(doc, model, tree) {
  if (tree.roots.length < 2) return null;
  const nodeById = new Map(tree.all.map((n) => [n.id, n]));
  const rootOf = (id) => {
    const r = tree.owner.get(id);
    if (!r) return id;
    let n = nodeById.get(r);
    while (n.parent) n = nodeById.get(n.parent);
    return `region:${n.id}`;
  };
  const units = [...doc.elements.filter((e) => !tree.owner.has(e.id)).map((e) => e.id), ...tree.roots.map((n) => `region:${n.id}`)];
  const out = new Map(units.map((u) => [u, new Set()]));
  const indeg = new Map(units.map((u) => [u, 0]));
  for (const n of model.nets) {
    if (n.driver.error) continue;
    const a = rootOf(n.driver.element.id);
    for (const s of n.sinks) {
      if (s.error) continue;
      const b = rootOf(s.element.id);
      if (a === b || out.get(a)?.has(b) || !out.has(b)) continue;
      out.get(a).add(b);
      indeg.set(b, indeg.get(b) + 1);
    }
  }
  const state = new Map();
  const back = new Set();
  const dfs = (u) => {
    state.set(u, 1);
    for (const v of out.get(u)) {
      if (!state.has(v)) dfs(v);
      else if (state.get(v) === 1) back.add(`${u}>${v}`);
    }
    state.set(u, 2);
  };
  for (const u of [...units].sort((x, y) => indeg.get(x) - indeg.get(y))) if (!state.has(u)) dfs(u);
  const preds = new Map(units.map((u) => [u, []]));
  for (const [a, vs] of out) for (const v of vs) if (!back.has(`${a}>${v}`)) preds.get(v).push(a);
  const rank = new Map();
  const layer = (u) => {
    if (!rank.has(u)) rank.set(u, Math.max(0, ...preds.get(u).map((p) => layer(p) + 1)));
    return rank.get(u);
  };
  units.forEach(layer);
  return rank;
}

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
  // A register bank (loaded registers that hold) is where a register-transfer
  // loop is cut (CONVENTIONS §5.6): an edge into a bank from anything the bank
  // reaches is feedback (the write-back), so banks precede the selects and
  // operators they feed, as in a textbook multicycle datapath.
  const banks = doc.elements.filter((e) => e.kind === 'register' && Array.isArray(e.lanes));
  for (const bank of banks) {
    const reach = new Set();
    const stack = [bank.id];
    while (stack.length) for (const w of out.get(stack.pop()) || []) if (!reach.has(w)) { reach.add(w); stack.push(w); }
    for (const [from, tos] of out) if (reach.has(from) && tos.includes(bank.id)) back.add(`${from}>${bank.id}`);
  }
  const state = new Map();
  const dfs = (v) => {
    state.set(v, 'open');
    for (const w of out.get(v)) {
      if (back.has(`${v}>${w}`)) continue;
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
  // With register banks, every element takes its longest-path layer along the
  // forward flow (feedback edges excluded), so the loop reads left to right.
  if (banks.length) {
    const flowRank = new Map();
    // A net that lands only on select or enable pins comes from above (the
    // controller) and does not push its sink to a later layer.
    const pinsInto = new Map();
    for (const net of doc.nets) {
      const from = parseEndpoint(net.driver)?.element;
      for (const sinkText of net.sinks) {
        const ep = parseEndpoint(sinkText);
        if (!ep || !byId.has(ep.element)) continue;
        const key = `${from}>${ep.element}`;
        if (!pinsInto.has(key)) pinsInto.set(key, []);
        pinsInto.get(key).push(ep.port);
      }
    }
    const controlOnly = (from, to) => {
      const sink = byId.get(to);
      return (pinsInto.get(`${from}>${to}`) || []).every((p) => (p === 'sel' && sink?.kind === 'mux') || (p === 'en' && ['register', 'pipeline_register'].includes(sink?.kind)));
    };
    const preds = new Map(doc.elements.map((e) => [e.id, []]));
    for (const [from, tos] of out) for (const to of tos) if (!back.has(`${from}>${to}`) && from !== to && !controlOnly(from, to) && byId.get(from)?.kind !== 'port') preds.get(to).push(from);
    const rankOf = (id, seen = new Set()) => {
      if (flowRank.has(id)) return flowRank.get(id);
      if (seen.has(id)) return 0;
      seen.add(id);
      const r = Math.max(0, ...preds.get(id).map((p) => rankOf(p, seen) + 1));
      flowRank.set(id, r);
      return r;
    };
    // An authored layer wins; a layout hint without a layer (align_with, order) keeps the derived layer.
    const hasLayer = (e) => e.layout?.layer !== undefined;
    for (const e of doc.elements) if (!hasLayer(e) && e.kind !== 'port') result.set(e.id, rankOf(e.id));
    // The controller (an element that selects multiplexers) shares the partition
    // of the last element it drives through data pins (the operator): the layout
    // puts it in the column just before that element, above the selects, so its
    // selects and enables run down and back to the muxes and banks, and the
    // column after the operator stays free for the registers it loads. One layer
    // after the operator left an empty band above the banks and pushed the
    // output bank down (FFT butterfly draft: 377 → 287 pt tall at 2col with no
    // new errors; docs/FFT_LAYOUT_ROUND.md).
    for (const e of doc.elements) {
      if (hasLayer(e) || e.kind === 'port') continue;
      const tos = [...new Set(out.get(e.id))];
      if (!tos.some((to) => byId.get(to)?.kind === 'mux' && (pinsInto.get(`${e.id}>${to}`) || []).includes('sel'))) continue;
      const fed = tos.filter((to) => byId.get(to)?.kind !== 'port' && !controlOnly(e.id, to));
      if (fed.length) result.set(e.id, Math.max(...fed.map((to) => result.get(to))));
    }
  }
  // Figure outputs sit on the right edge; a connector tag sits beside the
  // element it connects to.
  const last = Math.max(0, ...doc.elements.filter((e) => e.kind !== 'port' && e.kind !== 'const').map((e) => result.get(e.id)));
  const lastStage = Math.max(0, ...doc.elements.filter((e) => e.kind !== 'port').map((e) => stage.get(e.id)));
  const netOfPort = (e) => doc.nets.find((n) => (e.dir === 'out' ? n.sinks.some((sk) => parseEndpoint(sk)?.element === e.id) : parseEndpoint(n.driver)?.element === e.id));
  const sourceTags = [];
  for (const e of doc.elements.filter((x) => x.kind === 'port' && x.layout?.layer === undefined)) {
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
  // Figure ports no net touches: an input nothing reads, an output nothing drives.
  ctx.unusedPorts = new Set(doc.elements.filter((e) => e.kind === 'port' && !e.connector && !e.off_page && !model.nets.some((n) => n.driver.element?.id === e.id || n.sinks.some((s) => s.element?.id === e.id))).map((e) => e.id));
  // Blocks first: pipeline registers size their lane gaps from them.
  const all = [...model.elements.values()];
  const part = partitions(doc);
  // Return-pin plan (renderDatapath): a returning net enters its opaque sink
  // block on model.returnSide (east: the edge facing the driver; north: the
  // top edge) instead of wrapping around to the west edge.
  if (model.returnSide && model.returnSide !== 'west') {
    const opaque = (e) => ['instance', 'blackbox', 'memory'].includes(e.kind) || (e.kind === 'comb' && e.op === 'custom');
    ctx.returnSides = new Map();
    for (const n of model.nets) {
      for (const s of n.sinks) {
        if (!s.element || !opaque(s.element) || ['clock', 'reset'].includes(s.pin?.class)) continue;
        if (part.backEdges?.has(`${n.driver.element.id}>${s.element.id}`)) ctx.returnSides.set(`${s.element.id}.${s.pin.id}`, model.returnSide);
      }
    }
  }
  for (const { el: e, pins } of all.filter((x) => x.el.kind !== 'pipeline_register')) symbols.set(e.id, instantiate(ctx, e, pins));
  for (const { el: e, pins } of all.filter((x) => x.el.kind === 'pipeline_register')) symbols.set(e.id, instantiate(ctx, e, pins));
  const base = skin.elk.variants[variant] || skin.elk.variants['2col'];
  const spacing = { ...base };
  // Scaled layer gaps keep a floor so orthogonal bends still have a channel.
  // A wire turning into a pin on a block's top or bottom edge runs one
  // in-layer edge-to-node spacing from the block: that run must hold a
  // full-size arrowhead plus a shaft (arrow/no-room), so that spacing never
  // drops below it. Runs into side pins get their room from ensureArrowRoom,
  // which moves the riser back as far as the upstream block allows without
  // hugging it; the between-layer gaps keep their floors so figures still fit.
  const arrowRoom = skin.tokens.arrow.length + (skin.tokens.route?.arrow_min_shaft_pt ?? 1) + 0.5;
  const FLOOR = { 'elk.layered.spacing.nodeNodeBetweenLayers': skin.elk.min_layer_gap ?? 10, 'elk.layered.spacing.edgeNodeBetweenLayers': 5, 'elk.layered.spacing.edgeEdgeBetweenLayers': 4, 'elk.spacing.edgeNode': arrowRoom };
  for (const key of Object.keys(FLOOR)) spacing[key] = Math.max(FLOOR[key], base[key] * scale);
  const edges = [];
  for (const n of model.nets) {
    // A truncation label rides on its wire; an ELK edge label reserves the room.
    // TAIL (end) labels are placed beside the source port without a dummy
    // layer, so the reservation costs only the label's own length.
    const slice = n.net.truncation && skin.symbols.truncate.reserve_space !== false ? [{ id: `${n.net.id}-slice`, text: n.net.truncation.label, width: ctx.measure(n.net.truncation.label, ctx.t.font.secondary_pt) + (skin.symbols.truncate.reserve_pad ?? 16), height: ctx.t.font.secondary_pt + 2, layoutOptions: { 'elk.edgeLabels.placement': 'TAIL' } }] : null;
    // A net whose junction dot had no room (route/dot-near-arrow) gets an
    // empty TAIL label on the retry. Crowded at its driver pin, the room holds
    // the pin clearance and the dot; crowded before a sink's arrowhead (a branch
    // into the adjacent layer), it holds the clearance on both sides of the dot
    // plus the arrowhead, so the junction fits between the driver and the sink.
    // Crowded before an arrowhead, the room sits at the sink end (HEAD): the branch must turn
    // before it, so its junction keeps the clearance from the arrowhead base.
    // First the room widens the gap at the driver (TAIL, the clearance); a net still crowded on the
    // next pass gets it at the sink end (HEAD), where a channel packed against the sink needs it.
    const reserveKind = model.dotReserve?.get?.(n.net.id);
    const arrowRoomKind = reserveKind === 'arrow-head';
    const room = !slice && model.dotReserve?.has(n.net.id) ? [{ id: `${n.net.id}-room`, text: ' ', width: reserveKind === 'arrow-head' ? (skin.tokens.route.dot_room_arrow ?? (skin.tokens.route.dot_arrow_clearance ?? 8) + 1) : reserveKind === 'arrow' ? (skin.tokens.route.dot_arrow_clearance ?? 8) : (skin.tokens.route.dot_arrow_clearance ?? 8) + 2, height: 2, layoutOptions: { 'elk.edgeLabels.placement': arrowRoomKind ? 'HEAD' : 'TAIL' } }] : null;
    // A parallel net whose name found no spot (label/unlabeled-parallel-nets)
    // gets an empty TAIL label as long as its name on the retry: room beside
    // the source pin, where the placer tries first.
    // The room holds the name as printed in this variant (short labels when
    // they are in use) and, on a multi-bit net, its slash-N width label.
    const nameText = !slice && !room && model.nameReserve?.has(n.net.id)
      ? (n.net.label ? labelOf(ctx, n.net, n.net.id) : n.net.short_label ?? ((n.net.rtl?.signal ?? n.net.rtl_unmapped?.rtl?.signal) ? readableIdentifier(n.net.rtl?.signal ?? n.net.rtl_unmapped.rtl.signal) : null))
      : null;
    const slashRoom = (Number(n.net.width) || 1) > 1 ? ctx.measure(String(n.net.width), ctx.t.font.secondary_pt) + 8 : 0;
    const nameRoom = nameText ? [{ id: `${n.net.id}-nameroom`, text: ' ', width: ctx.measure(String(nameText), ctx.t.font.secondary_pt) + 6 + slashRoom + skin.tokens.arrow.length, height: 2, layoutOptions: { 'elk.edgeLabels.placement': 'TAIL' } }] : null;
    // A multi-bit net whose width label lost its spot on that retry gets room for the slash alone.
    const widthRoom = !slice && !room && !nameRoom && slashRoom && model.slashReserve?.has(n.net.id) ? [{ id: `${n.net.id}-slashroom`, text: ' ', width: slashRoom + skin.tokens.arrow.length, height: 2, layoutOptions: { 'elk.edgeLabels.placement': 'TAIL' } }] : null;
    const labels = slice ?? room ?? nameRoom ?? widthRoom;
    // An arrowhead-side room goes only on the edges into the nearest sink layer, where the junction crowds.
    const nearest = arrowRoomKind && room ? Math.min(...n.sinks.map((s) => part.get(s.element.id) ?? Infinity)) : null;
    n.sinks.forEach((s, i) => { const own = labels && !(room && labels === room && nearest !== null && (part.get(s.element.id) ?? Infinity) !== nearest); edges.push({ id: `${n.net.id}__${i}`, sources: [`${n.driver.element.id}.${n.driver.pin.id}`], targets: [`${s.element.id}.${s.pin.id}`], ...(own ? { labels: labels.map((l) => ({ ...l, id: `${l.id}${i}` })) } : {}) }); });
  }
  const m = ctx.t.block_margin;
  const fr = skin.symbols.region_frame;
  const tree = regionTree(doc, { pad: fr.pad, padTop: ctx.t.font.secondary_pt + 6 });
  // Study figures rank the outermost instance frames along the flow (rootRanks),
  // to turn nets that skip a flow layer into connectors.
  const ranks = variant === 'study' ? rootRanks(doc, model, tree) : null;
  // Layout alternatives a study figure may try (renderDatapath). frame-flow:
  // nets between blocks of the same frame (an instance's logic, state and
  // controller) get high shortness and straightness priority, which pulls
  // those blocks into adjacent layers. thorough: a deeper crossing search.
  if (model.layoutAlt === 'frame-flow') {
    for (const e of edges) {
      const a = tree.owner.get(e.sources[0].split('.')[0]);
      if (a && a === tree.owner.get(e.targets[0].split('.')[0])) e.layoutOptions = { ...(e.layoutOptions || {}), 'elk.layered.priority.shortness': 10, 'elk.layered.priority.straightness': 10 };
    }
  }
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  // Straight data trunks (CONVENTIONS §1.4): network-simplex placement with
  // favorStraightEdges, then our straightening pass on the result.
  // considerModelOrder crashes elkjs 0.12 together with compound nodes, so it
  // is used only for figures without framed regions.
  const placement = {
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', 'elk.layered.nodePlacement.favorStraightEdges': true,
    ...(tree.roots.length ? {} : { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' }),
    ...(model.layoutAlt === 'thorough' ? { 'elk.layered.thoroughness': 40, 'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED' } : {}),
  };
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
  return { ctx, symbols, part, tree, graph, ranks };
}

async function layoutOnce(doc, model, skin, variant, mode, scale, plan = null) {
  const { ctx, symbols, part, tree, graph, ranks } = buildLayoutGraph(doc, model, skin, variant, mode, scale, plan);
  const laid = await new ELK().layout(graph);
  const nodes = new Map();
  const visit = (g) => {
    for (const c of g.children || []) {
      if (c.id.startsWith('region:')) visit(c);
      else nodes.set(c.id, c);
    }
  };
  visit(laid);
  return { ctx, symbols, part, laid, nodes, tree, ranks, contentW: laid.width, contentH: laid.height };
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
// stay on their pins. The drawn wire of an arrowed edge ends at the arrowhead
// base (arrowLen before the pin), so that base counts as a vertex too.
export function detouchWires(edgePts, edges, { minGap = 4, rects = [], arrowLen = 0, hasArrow = () => true } = {}) {
  const EPS = 0.1;
  const near = (p, q) => Math.abs(p.x - q.x) < 0.01 && Math.abs(p.y - q.y) < 0.01;
  const onSeg = (p, a, b) => (Math.abs(a.x - b.x) < 0.01
    ? Math.abs(p.x - a.x) < EPS && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS
    : Math.abs(p.y - a.y) < EPS && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS);
  const segsOf = (pts) => pts.slice(1).map((b, i) => [pts[i], b]);
  const vertsOf = (f) => {
    const pts = edgePts.get(f.id);
    if (!arrowLen || pts.length < 2 || !hasArrow(f)) return pts;
    const [p, q] = [pts[pts.length - 2], pts[pts.length - 1]];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len <= arrowLen) return pts;
    return [...pts, { x: q.x - ((q.x - p.x) / len) * arrowLen, y: q.y - ((q.y - p.y) / len) * arrowLen }];
  };
  const foreign = (net) => edges.filter((f) => f.net !== net).map((f) => edgePts.get(f.id));
  const touches = (net) => {
    const ownEdges = edges.filter((f) => f.net === net);
    const otherEdges = edges.filter((f) => f.net !== net);
    const own = ownEdges.map((f) => edgePts.get(f.id));
    const others = otherEdges.map((f) => edgePts.get(f.id));
    return ownEdges.some((f) => vertsOf(f).some((p) => others.some((o) => segsOf(o).some(([a, b]) => onSeg(p, a, b)))))
      || otherEdges.some((f) => vertsOf(f).some((p) => own.some((o) => segsOf(o).some(([a, b]) => onSeg(p, a, b)))));
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
      const involved = [a, b].some((p) => others.some((o) => segsOf(o).some(([c, d]) => onSeg(p, c, d))))
        || edges.filter((f) => f.net !== e.net).some((f) => vertsOf(f).some((p) => onSeg(p, a, b)));
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

// Parallel runs of two nets closer than minGap (exact overlaps included) read
// as one wire or a hugging pair (wire/collinear-overlap, route/edge-hugging).
// Slide an interior run of one of them sideways, together with its net's
// coincident branch runs, to the nearest offset that keeps minGap from every
// parallel foreign run, touches no foreign wire, keeps minGap from block
// outlines, crowds its neighbouring runs no more, and keeps the net's
// junctions (with fixedJunctions: at the same points). Terminal runs stay on
// their pins; the shortest crowded runs move first.
// With clearance given, a move may not bring any junction dot of the net closer
// than `clearance` to a pin anchor or arrowhead base than it was (dot-near-arrow).
export function separateParallelRuns(edgePts, edges, { minGap = 4, rects = [], maxShift = 16, fixedJunctions = false, clearance = null, arrowLen = 4.5, hasArrow = () => true } = {}) {
  const EPS = 0.01;
  const near = (p, q) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;
  const isVertical = (a, b) => Math.abs(a.x - b.x) < EPS;
  const axial = (a, b) => isVertical(a, b) || Math.abs(a.y - b.y) < EPS;
  const onSeg = (p, a, b) => (isVertical(a, b)
    ? Math.abs(p.x - a.x) < 0.1 && p.y >= Math.min(a.y, b.y) - 0.1 && p.y <= Math.max(a.y, b.y) + 0.1
    : Math.abs(p.y - a.y) < 0.1 && p.x >= Math.min(a.x, b.x) - 0.1 && p.x <= Math.max(a.x, b.x) + 0.1);
  const segsOf = (pts) => pts.slice(1).map((b, i) => [pts[i], b]);
  const own = (net) => edges.filter((f) => f.net === net).map((f) => edgePts.get(f.id));
  const foreign = (net) => edges.filter((f) => f.net !== net).map((f) => edgePts.get(f.id));
  const touches = (net) => {
    const mine = own(net);
    const others = foreign(net);
    return mine.some((pts) => pts.some((p) => others.some((o) => segsOf(o).some(([a, b]) => onSeg(p, a, b)))))
      || others.some((pts) => pts.some((p) => mine.some((o) => segsOf(o).some(([a, b]) => onSeg(p, a, b)))));
  };
  // Coordinates of foreign parallel runs closer than minGap to a→b over more than 0.5 pt.
  const crowding = (net, a, b) => {
    if (near(a, b) || !axial(a, b)) return [];
    const vertical = isVertical(a, b);
    const c = vertical ? a.x : a.y;
    const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
    const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
    const out = [];
    for (const pts of foreign(net)) {
      for (const [p, q] of segsOf(pts)) {
        if (near(p, q) || !axial(p, q) || isVertical(p, q) !== vertical) continue;
        const [p0, p1] = vertical ? [p.y, q.y] : [p.x, q.x];
        const overlap = Math.min(hi, Math.max(p0, p1)) - Math.max(lo, Math.min(p0, p1));
        const oc = vertical ? p.x : p.y;
        if (Math.abs(oc - c) < minGap - EPS && overlap > 0.5) out.push(oc);
      }
    }
    return out;
  };
  const nearBlock = (a, b) => rects.some((r) => {
    const vertical = isVertical(a, b);
    const [lo, hi] = vertical ? [Math.max(Math.min(a.y, b.y), r.y0), Math.min(Math.max(a.y, b.y), r.y1)] : [Math.max(Math.min(a.x, b.x), r.x0), Math.min(Math.max(a.x, b.x), r.x1)];
    if (hi - lo <= EPS) return false;
    const c = vertical ? a.x : a.y;
    const [e0, e1] = vertical ? [r.x0, r.x1] : [r.y0, r.y1];
    return c > e0 - minGap && c < e1 + minGap && ((c > e0 + EPS && c < e1 - EPS) || hi - lo > 3);
  });
  const entersBlock = (a, b) => rects.some((r) => Math.min(a.x, b.x) < r.x1 - 0.5 && Math.max(a.x, b.x) > r.x0 + 0.5 && Math.min(a.y, b.y) < r.y1 - 0.5 && Math.max(a.y, b.y) > r.y0 + 0.5);
  for (let round = 0; round < 3; round += 1) {
    let moved = false;
    const candidates = edges.flatMap((e) => {
      const pts = edgePts.get(e.id);
      return Array.from({ length: Math.max(0, pts.length - 3) }, (_, j) => ({ e, k: j + 1, len: Math.hypot(pts[j + 2].x - pts[j + 1].x, pts[j + 2].y - pts[j + 1].y) }))
        .filter(({ k }) => crowding(e.net, pts[k], pts[k + 1]).length);
    }).sort((p, q) => p.len - q.len);
    for (const { e, k } of candidates) {
      const pts = edgePts.get(e.id);
      if (k + 2 >= pts.length) continue;
      const [a, b] = [pts[k], pts[k + 1]];
      const close = crowding(e.net, a, b);
      if (!close.length) continue;
      const axis = isVertical(a, b) ? 'x' : 'y';
      // The same run in sibling branches moves along; a sibling that has it as a terminal run pins it.
      const group = [];
      let pinned = false;
      for (const f of edges.filter((x) => x.net === e.net)) {
        const q = edgePts.get(f.id);
        for (let i = 0; i + 1 < q.length; i += 1) {
          if (near(q[i], a) && near(q[i + 1], b)) { if (i === 0 || i + 2 >= q.length) pinned = true; else group.push({ q, i }); }
        }
      }
      if (pinned || !group.length) continue;
      const list = own(e.net);
      const junctionKey = () => (fixedJunctions ? junctions(list).map((j) => `${j.x.toFixed(2)},${j.y.toFixed(2)}`).sort().join(';') : junctions(list).length);
      const netEdges = edges.filter((x) => x.net === e.net);
      const crowdedDots = () => {
        if (clearance === null) return 0;
        const feats = netEdges.flatMap((x) => {
          const q = edgePts.get(x.id);
          if (q.length < 2) return [];
          const end = q.at(-1); const pa = q.at(-2); const len = Math.hypot(end.x - pa.x, end.y - pa.y) || 1; const L = Math.min(arrowLen, len * 0.8);
          const base = { x: end.x - ((end.x - pa.x) / len) * L, y: end.y - ((end.y - pa.y) / len) * L };
          return hasArrow(x) ? [q[0], end, base] : [q[0], end];
        });
        return junctions(list).filter((j) => feats.some((p) => Math.hypot(j.x - p.x, j.y - p.y) < clearance - 0.05)).length;
      };
      const dotsBefore = crowdedDots();
      const junctionsBefore = junctionKey();
      const touchedBefore = touches(e.net);
      const [prev, next] = [pts[k - 1], pts[k + 2]];
      const c = a[axis];
      const neighbourCrowd = () => crowding(e.net, pts[k - 1], pts[k]).length + crowding(e.net, pts[k + 1], pts[k + 2]).length;
      const crowdBefore = neighbourCrowd();
      const values = [...new Set(close.flatMap((oc) => Array.from({ length: maxShift + 1 }, (_, s) => [oc + minGap + s, oc - minGap - s]).flat()))]
        .filter((v) => Math.abs(v - c) <= maxShift + minGap)
        .sort((u, v) => Math.abs(u - c) - Math.abs(v - c));
      const saved = group.map(({ q, i }) => [q[i][axis], q[i + 1][axis]]);
      const restore = () => group.forEach(({ q, i }, j) => { q[i][axis] = saved[j][0]; q[i + 1][axis] = saved[j][1]; });
      for (const v of values) {
        // The neighbouring runs keep their direction and a visible length.
        if (Math.sign(prev[axis] - c) !== Math.sign(prev[axis] - v) || Math.abs(prev[axis] - v) < 0.5) continue;
        if (Math.sign(next[axis] - c) !== Math.sign(next[axis] - v) || Math.abs(next[axis] - v) < 0.5) continue;
        group.forEach(({ q, i }) => { q[i][axis] = v; q[i + 1][axis] = v; });
        const ok = !crowding(e.net, pts[k], pts[k + 1]).length
          && !nearBlock(pts[k], pts[k + 1]) && !entersBlock(pts[k - 1], pts[k]) && !entersBlock(pts[k + 1], pts[k + 2])
          && (touchedBefore || !touches(e.net))
          && neighbourCrowd() <= crowdBefore
          && junctionKey() === junctionsBefore
          && crowdedDots() <= dotsBefore;
        if (ok) { moved = true; break; }
        restore();
      }
    }
    if (!moved) break;
  }
}

// Every arrowhead keeps the full skin length (arrow/nonuniform). When a sink's
// last run is shorter than the head plus a minimal shaft, the bend before it
// moves back along that run, together with sibling branches of the net that
// share the bend, if the move enters no block, touches no foreign wire and
// keeps the net's junctions. Pins never move; what cannot be fixed is
// reported by the renderer as arrow/no-room.
// A run (axis-aligned segment a→b) of net `net` hugs a block outline or a
// foreign parallel wire: closer than minGap over more than 3 pt — the
// route/edge-hugging rule, used to reject candidate moves of layout passes.
export function runHugs(a, b, net, { edges = [], edgePts = new Map(), rects = [], minGap = 4 } = {}) {
  const EPS = 0.01;
  const vertical = Math.abs(a.x - b.x) < EPS;
  if (!vertical && Math.abs(a.y - b.y) > EPS) return false;
  const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
  const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
  const c = vertical ? a.x : a.y;
  const overlap = (p0, p1) => Math.min(hi, Math.max(p0, p1)) - Math.max(lo, Math.min(p0, p1));
  for (const r of rects) {
    const [e0, e1, s0, s1] = vertical ? [r.x0, r.x1, r.y0, r.y1] : [r.y0, r.y1, r.x0, r.x1];
    if (overlap(s0, s1) > 3 && (Math.abs(c - e0) < minGap || Math.abs(c - e1) < minGap)) return true;
  }
  for (const f of edges) {
    if (f.net === net) continue;
    const pts = edgePts.get(f.id) || [];
    for (let k = 1; k < pts.length; k += 1) {
      const [p, q] = [pts[k - 1], pts[k]];
      if ((Math.abs(p.x - q.x) < EPS) !== vertical) continue;
      if (!vertical && Math.abs(p.y - q.y) > EPS) continue;
      const gap = Math.abs(c - (vertical ? p.x : p.y));
      if (gap > 0.3 && gap < minGap && overlap(vertical ? p.y : p.x, vertical ? q.y : q.x) > 3) return true;
    }
  }
  return false;
}

export function ensureArrowRoom(edgePts, edges, { arrowLen = 4.5, minShaft = 1, rects = [], hasArrow = () => true, minGap = 4 } = {}) {
  const EPS = 0.01;
  const need = arrowLen + minShaft;
  const same = (p, q) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;
  const onSeg = (p, a, b) => (Math.abs(a.x - b.x) < EPS
    ? Math.abs(p.x - a.x) < 0.1 && p.y >= Math.min(a.y, b.y) - 0.1 && p.y <= Math.max(a.y, b.y) + 0.1
    : Math.abs(p.y - a.y) < 0.1 && p.x >= Math.min(a.x, b.x) - 0.1 && p.x <= Math.max(a.x, b.x) + 0.1);
  const segs = (pts) => pts.slice(1).map((b, i) => [pts[i], b]);
  const touchesForeign = (net) => {
    const own = edges.filter((f) => f.net === net).map((f) => edgePts.get(f.id));
    const others = edges.filter((f) => f.net !== net).map((f) => edgePts.get(f.id));
    return own.some((pts) => pts.some((p) => others.some((o) => segs(o).some(([a, b]) => onSeg(p, a, b)))))
      || others.some((pts) => pts.some((p) => own.some((o) => segs(o).some(([a, b]) => onSeg(p, a, b)))));
  };
  const entersBlock = (a, b) => rects.some((r) => Math.min(a.x, b.x) < r.x1 - 0.5 && Math.max(a.x, b.x) > r.x0 + 0.5 && Math.min(a.y, b.y) < r.y1 - 0.5 && Math.max(a.y, b.y) > r.y0 + 0.5);
  let moved = 0;
  for (const e of edges.filter(hasArrow)) {
    const pts = edgePts.get(e.id);
    const n = pts.length;
    if (n < 4) continue; // the bend's other end is the driver pin
    const [p0, b, c, d] = [pts[n - 4], pts[n - 3], pts[n - 2], pts[n - 1]];
    const A = Math.abs(c.y - d.y) < EPS ? 'x' : Math.abs(c.x - d.x) < EPS ? 'y' : null;
    if (!A || Math.abs(d[A] - c[A]) >= need - EPS || Math.abs(b[A] - c[A]) > EPS) continue;
    const dir = Math.sign(d[A] - c[A]) || 1;
    const list = edges.filter((f) => f.net === e.net).map((f) => edgePts.get(f.id));
    const count = junctions(list).length;
    const copies = [];
    for (const q of list) for (let k = 1; k + 1 < q.length; k += 1) if (same(q[k], b) && same(q[k + 1], c)) copies.push([q, k]);
    const saved = copies.map(([q, k]) => [q[k][A], q[k + 1][A]]);
    const restore = () => copies.forEach(([q, k], i) => { q[k][A] = saved[i][0]; q[k + 1][A] = saved[i][1]; });
    // The nearest bend position that makes room and hugs nothing; farther back if needed.
    for (let step = 0; step <= 40; step += 1) {
      const v = d[A] - dir * (need + step * 0.5);
      // The run before the bend keeps its direction.
      if ((v - p0[A]) * (b[A] - p0[A]) <= 0 || Math.abs(v - p0[A]) < 0.5) break;
      copies.forEach(([q, k]) => { q[k][A] = v; q[k + 1][A] = v; });
      const blocked = copies.some(([q, k]) => entersBlock(q[k - 1], q[k]) || entersBlock(q[k], q[k + 1]) || (q[k + 2] && entersBlock(q[k + 1], q[k + 2])));
      const hugging = copies.some(([q, k]) => runHugs(q[k], q[k + 1], e.net, { edges, edgePts, rects, minGap }));
      if (!blocked && !hugging && !touchesForeign(e.net) && junctions(list).length === count) { moved += 1; break; }
      restore();
    }
  }
  return moved;
}

// What sets a layout's size (G7, --why-size): nodes grouped into layers by
// overlapping x ranges; the widest layers with their widest nodes, the tallest
// columns with their tallest nodes, and how much of the width is spacing.
export function sizeReport(run, { top = 3 } = {}) {
  const r = (v) => Math.round(v * 10) / 10;
  const nodes = [...(run.nodes || new Map())].map(([id, n]) => ({ id, x0: n.x ?? 0, x1: (n.x ?? 0) + (n.width ?? 0), w: n.width ?? 0, h: n.height ?? 0 })).sort((a, b) => a.x0 - b.x0);
  const layers = [];
  for (const n of nodes) {
    const layer = layers.find((l) => n.x0 < l.x1 - 0.5 && n.x1 > l.x0 + 0.5);
    if (layer) { layer.x0 = Math.min(layer.x0, n.x0); layer.x1 = Math.max(layer.x1, n.x1); layer.nodes.push(n); } else layers.push({ x0: n.x0, x1: n.x1, nodes: [n] });
  }
  const widest = layers.map((l) => ({ width_pt: r(l.x1 - l.x0), nodes: [...l.nodes].sort((a, b) => b.w - a.w).slice(0, 3).map((n) => `${n.id} (${r(n.w)} pt)`) })).sort((a, b) => b.width_pt - a.width_pt).slice(0, top);
  const tallest = layers.map((l) => ({ height_pt: r(l.nodes.reduce((s, n) => s + n.h, 0)), nodes: [...l.nodes].sort((a, b) => b.h - a.h).slice(0, 3).map((n) => `${n.id} (${r(n.h)} pt)`) })).sort((a, b) => b.height_pt - a.height_pt).slice(0, top);
  const occupied = layers.reduce((s, l) => s + (l.x1 - l.x0), 0);
  return { content_width_pt: r(run.contentW ?? 0), content_height_pt: r(run.contentH ?? 0), layers: layers.length, spacing_pt: r((run.contentW ?? 0) - occupied), widest_layers: widest, tallest_columns: tallest };
}
const describeWidth = (s) => `${s.layers} layers, ${s.spacing_pt} pt of it spacing; widest ${s.widest_layers.map((l) => `${l.width_pt} pt [${l.nodes[0]}]`).join(', ')}`;
const describeHeight = (s) => `tallest columns ${s.tallest_columns.map((c) => `${c.height_pt} pt [${c.nodes.slice(0, 2).join(', ')}]`).join(', ')}`;

// Distance from a label box to its own net's wires and to the nearest other
// net's wires (label/ambiguous-anchor): nets = [{ id, polylines: [[{x,y}]] }].
export function labelAnchorGap(box, nets, netId) {
  const distBoxSeg = (a, c) => {
    const dx = Math.max(0, Math.min(a.x, c.x) - box.x1, box.x0 - Math.max(a.x, c.x));
    const dy = Math.max(0, Math.min(a.y, c.y) - box.y1, box.y0 - Math.max(a.y, c.y));
    return Math.hypot(dx, dy);
  };
  let own = Infinity;
  let foreign = Infinity;
  let other = null;
  for (const n of nets) {
    for (const pts of n.polylines) {
      const dist = pts.slice(1).reduce((best, p, k) => Math.min(best, distBoxSeg(pts[k], p)), Infinity);
      if (n.id === netId) own = Math.min(own, dist);
      else if (dist < foreign) { foreign = dist; other = n.id; }
    }
  }
  return { own, foreign, other };
}

// Why a placed net label does not read as its own net's (label/ambiguous-anchor),
// or null. gap = labelAnchorGap(box, nets, netId). The label is nearer its own
// wire than any other net's (by 0.5 pt), within maxDistance of it, and nearer
// its wire than any block outline it faces (a block whose span it overlaps on
// the other axis, or that it overlaps): a label against a block reads as that
// block's output or pin.
export function netLabelAnchorProblem(gap, box, rects = [], { maxDistance = 12 } = {}) {
  if (gap.own > gap.foreign - 0.5) return { reason: 'foreign-wire' };
  if (gap.own > maxDistance) return { reason: 'far-from-wire' };
  let nearest = null;
  for (const r of rects) {
    const xs = Math.min(box.x1, r.x1) - Math.max(box.x0, r.x0);
    const ys = Math.min(box.y1, r.y1) - Math.max(box.y0, r.y0);
    const d = xs > 0 && ys > 0 ? 0 : xs > 0 ? Math.max(r.y0 - box.y1, box.y0 - r.y1) : ys > 0 ? Math.max(r.x0 - box.x1, box.x0 - r.x1) : null;
    if (d !== null && (!nearest || d < nearest.distance)) nearest = { distance: d, id: r.id };
  }
  if (nearest && nearest.distance < gap.own - 0.5) return { reason: 'closer-to-block', block: nearest.id, block_distance: nearest.distance };
  return null;
}

// Routed length of a polyline and its detour: how much longer the route is
// than the straight (Manhattan) distance between its ends.
export function polylineDetour(pts) {
  let length = 0;
  for (let k = 1; k < pts.length; k += 1) length += Math.abs(pts[k].x - pts[k - 1].x) + Math.abs(pts[k].y - pts[k - 1].y);
  const direct = pts.length > 1 ? Math.abs(pts.at(-1).x - pts[0].x) + Math.abs(pts.at(-1).y - pts[0].y) : 0;
  return { length, detour: length - direct };
}

export function routedLength(edge) {
  const sec = edge.sections?.[0];
  return sec ? polylineDetour([sec.startPoint, ...(sec.bendPoints || []), sec.endPoint]) : null;
}

// Drawn block layers: blocks whose horizontal extents overlap share a column,
// numbered left to right. Ports, constants and connector tags are not blocks.
export function blockLayers(rects) {
  const layer = new Map();
  let col = -1;
  let right = -Infinity;
  for (const r of [...rects].sort((a, b) => a.x - b.x)) {
    if (r.x >= right - 0.5) { col += 1; right = r.x + (r.w ?? 0); } else right = Math.max(right, r.x + (r.w ?? 0));
    layer.set(r.id, col);
  }
  return layer;
}
export const layerGap = (layers, a, b) => (layers.has(a) && layers.has(b) ? Math.abs(layers.get(a) - layers.get(b)) : Infinity);
const probeLayers = (run) => (!run.nodes ? new Map() : blockLayers([...run.nodes].filter(([id]) => !run.symbols.get(id)?.isPort).map(([id, n]) => ({ id, x: n.x, w: n.width }))));

// Long loops (CONVENTIONS §1.6) are decided by the blocks' separation, never
// by where tags would land. A returning branch between blocks fewer than
// `minLayers` drawn layers apart (neighbours, or blocks in one column) stays a
// wire routed above or below them, however long its route. Between blocks
// further apart, a feedback branch routed longer than ratio × the layout
// width, or any branch whose route exceeds its straight distance by more
// than ratio × the width (a wrap-around), becomes a pair of named connectors.
export function longFeedback(model, run, ratio, { minLayers = 2 } = {}) {
  const marks = [];
  const W = run.contentW;
  const layers = probeLayers(run);
  const routes = new Map((run.laid.edges || []).map((e) => [e.id, routedLength(e)]));
  for (const n of model.nets) {
    n.sinks.forEach((s, i) => {
      const r = routes.get(`${n.net.id}__${i}`);
      if (!r) return;
      if (layerGap(layers, n.driver.element.id, s.element.id) < minLayers) return;
      const back = Boolean(run.part.backEdges?.has(`${n.driver.element.id}>${s.element.id}`));
      if (back ? r.length > ratio * W : r.detour > ratio * W) marks.push({ net: n.net.id, sink: i, span: Math.round((back ? r.length : r.detour) * 100) / 100, kind: back ? 'feedback' : 'wrap-around' });
    });
  }
  return marks;
}

// Connector names, one per net and unique in the figure (connector/ambiguous-name).
// A tag names its net readably: its label, else its RTL signal (also one kept
// for structure on an unmapped net), else its id made readable. Nets whose
// names collide are qualified with the readable instance that drives them
// ("Nonce client: start ready"); a number is the last resort.
export function connectorNames(doc, netIds) {
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const nets = netIds.map((id) => doc.nets.find((n) => n.id === id));
  const portLabels = new Set(doc.elements.filter((e) => e.kind === 'port' && !e.connector).map((e) => e.label ?? e.id));
  const baseName = (net) => net.label ?? net.short_label ?? readableIdentifier(net.rtl?.signal ?? net.rtl_unmapped?.rtl?.signal ?? net.id);
  const sourceInstance = (net) => {
    const rtl = net.rtl ?? net.rtl_unmapped?.rtl;
    if (rtl?.instance !== undefined) return rtl.instance;
    const driver = byId.get(String(net.driver).split('.')[0]);
    return driver?.rtl?.instance ?? (driver?.rtl?.covers || []).find((c) => c.includes(':'))?.split(':')[0] ?? '';
  };
  const names = new Map(nets.map((n) => [n.id, baseName(n)]));
  const groups = new Map();
  for (const n of nets) {
    const k = names.get(n.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  for (const [name, list] of groups) {
    // A generic single word ("state", "busy") says nothing on a tag outside its
    // instance frame (tags never sit inside one), and a name equal to a figure
    // port's label would print one name for two signals: qualify both even
    // without a collision.
    const vague = (!/\s/.test(name) && !list[0].label) || portLabels.has(name);
    if (list.length < 2 && !vague) continue;
    const contexts = distinctInstanceNames(list.map(sourceInstance));
    list.forEach((n, i) => { if (contexts[i]) names.set(n.id, `${contexts[i][0].toUpperCase()}${contexts[i].slice(1)}: ${name}`); });
  }
  const count = new Map();
  for (const n of nets) count.set(names.get(n.id), (count.get(names.get(n.id)) || 0) + 1);
  const seen = new Map();
  for (const n of nets) {
    const k = names.get(n.id);
    if (count.get(k) < 2) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
    names.set(n.id, `${k} ${seen.get(k)}`);
  }
  return names;
}

// Replace marked sinks of a net with one pair of named connectors: a source
// tag after the driver and one target tag feeding every marked sink, so a name
// appears on two tags only (connector/duplicate-name). A net that drives a
// figure output, or is driven by a figure input, is not cut: a tag next to the
// port would print the port's name twice, and a port standing alone as a far
// tag has no wire (connector/redundant-port, connector/orphan-tag). Render-only.
export function withConnectors(doc, model, marks) {
  const out = structuredClone(doc);
  const classes = deriveNetClasses(model);
  const byId = new Map(out.elements.map((e) => [e.id, e]));
  const figurePort = (endpoint, dir) => {
    const e = byId.get(String(endpoint).split('.')[0]);
    return e?.kind === 'port' && e.dir === dir && !e.connector;
  };
  const byNet = new Map();
  for (const m of marks) {
    const net = out.nets.find((n) => n.id === m.net);
    if (!net || net.sinks.some((s) => figurePort(s, 'out')) || figurePort(net.driver, 'in')) continue;
    if (!byNet.has(m.net)) byNet.set(m.net, []);
    byNet.get(m.net).push(m.sink);
  }
  const names = connectorNames(out, [...byNet.keys()]);
  for (const [netId, idx] of byNet) {
    const net = out.nets.find((n) => n.id === netId);
    const label = names.get(netId);
    const cls = classes.get(netId)?.drawn;
    const keepClass = cls && cls !== 'data' ? { class: cls, class_reason: 'connector' } : {};
    const targets = net.sinks.filter((_, i) => idx.includes(i));
    const srcId = `cx_${netId}`;
    const shortName = net.short_label ? { short_label: net.short_label } : {};
    out.elements.push({ id: srcId, kind: 'port', dir: 'out', width: net.width, label, ...shortName, connector: 'source', connector_net: netId });
    net.sinks = [...net.sinks.filter((_, i) => !idx.includes(i)), srcId];
    Object.assign(net, keepClass);
    const tid = `cx_${netId}_to0`;
    out.elements.push({ id: tid, kind: 'port', dir: 'in', width: net.width, label, ...shortName, connector: 'target', connector_net: netId, connector_sinks: [...idx] });
    out.nets.push({ id: `${netId}__cx0`, width: net.width, driver: tid, sinks: targets, ...keepClass, ...(net.bundle_of ? { bundle_of: net.bundle_of } : {}) });
  }
  return out;
}

// Connector pairs not worth a connector on the laid-out cut figure: the
// renderer drops their marks and draws the net as a wire. The blocks decide
// (the net's driver and the target tag's sinks fewer than `layers` drawn
// layers apart), never where the tags landed. Only when those blocks are not
// on the figure do the tags decide: within closePt of each other horizontally,
// or at most layers − 1 block columns between them. Layers are the drawn
// block columns, not pipeline partitions (a figure without pipeline stages has one partition).
export function closeConnectorMarks(doc, pos, { closePt = 60, layers = 2 } = {}) {
  const blocks = doc.elements.filter((e) => e.kind !== 'port' && e.kind !== 'const' && pos.has(e.id));
  const layerOf = blockLayers(blocks.map((e) => ({ id: e.id, x: pos.get(e.id).x, w: pos.get(e.id).w })));
  const blockColumns = [...new Set(blocks.map((e) => Math.round(pos.get(e.id).x)))];
  const close = [];
  for (const t of doc.elements.filter((e) => e.connector === 'target')) {
    const net = (doc.nets || []).find((n) => n.id === t.connector_net);
    const cont = (doc.nets || []).find((n) => parseEndpoint(n.driver)?.element === t.id);
    const from = net && parseEndpoint(net.driver)?.element;
    const to = (cont?.sinks || []).map((s) => parseEndpoint(s)?.element);
    if (layerOf.has(from) && to.length && to.every((id) => layerOf.has(id))) {
      if (Math.max(...to.map((id) => layerGap(layerOf, from, id))) < layers) close.push({ net: t.connector_net, sinks: t.connector_sinks || [] });
      continue;
    }
    const src = pos.get(`cx_${t.connector_net}`);
    const tgt = pos.get(t.id);
    if (!src || !tgt) continue;
    const [lo, hi] = [Math.min(src.x, tgt.x), Math.max(src.x, tgt.x)];
    const between = blockColumns.filter((x) => x > lo + 0.5 && x < hi - 0.5).length;
    if (hi - lo <= closePt || between <= layers - 1) close.push({ net: t.connector_net, sinks: t.connector_sinks || [] });
  }
  return close;
}

// Tags and port glyphs without a wire (connector/orphan-tag), measured on the
// final SVG: wire ends are the first and last points of every net segment
// path, and a glyph is attached when a wire end lies within its box grown by
// `tolerance` (a wire into a pin stops at the arrowhead's base).
export function orphanTags(svgText, glyphs, { tolerance = 7 } = {}) {
  const ends = [];
  for (const m of String(svgText).matchAll(/<path\b[^>]*>/g)) {
    if (!/\bid="net-.+-seg\d+"/.test(m[0])) continue;
    const d = /\bd="([^"]+)"/.exec(m[0]);
    const pts = d ? [...d[1].matchAll(/[ML]\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)/g)].map((p) => ({ x: Number(p[1]), y: Number(p[2]) })) : [];
    if (pts.length) ends.push(pts[0], pts.at(-1));
  }
  return glyphs.filter((g) => !ends.some((p) => p.x >= g.x - tolerance && p.x <= g.x + g.w + tolerance && p.y >= g.y - tolerance && p.y <= g.y + g.h + tolerance));
}

// A small step into a gate pin (gate pin pitch) moves back to where the branch
// leaves its trunk, so the junction dot sits on the pin row (CONVENTIONS §1.4).
// A junction dot keeps `clearance` from every pin anchor of its net and from
// the base of every arrowhead (assumed at each sink end, `arrowLen` long). A
// dot that is too close moves along the trunk: every branch leaving there
// shifts its turn (and the perpendicular run after it) by the smallest step,
// upstream or downstream, that clears all features, keeps the new branch
// point on the trunk, touches no foreign wire and enters no block.
// Two horizontal runs of different nets that both end on pins (a branch's last
// run into its sink pin, a lane's first run out of its driver pin) can lie
// closer than minGap over part of their length (wire/collinear-overlap); neither
// run may leave its pin, and separateParallelRuns moves interior runs only. The
// riser that bounds one of the runs slides along it, toward that run's pin, to
// just past the end of the other run: for a first run the riser (and every
// sibling branch that shares it) moves back toward the driver, for a last run it
// moves on toward the sink. A move is kept only when the runs stay long enough
// (the junction keeps `clearance` from the driver pin, the arrowhead keeps its
// run), the moved riser crowds no foreign wire and enters no block, and no new
// foreign run lies closer than minGap. Returns the moves.
export function unstackTerminalRuns(edgePts, edges, { minGap = 4, rects = [], arrowLen = 4.5, clearance = 8, hasArrow = () => true } = {}) {
  const EPS = 0.01;
  const H = (a, b) => Math.abs(a.y - b.y) < EPS && Math.abs(a.x - b.x) > EPS;
  const V = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) > EPS;
  const segsOf = (pts) => pts.slice(1).map((b, i) => [pts[i], b]);
  const foreignRuns = (net, horizontal) => edges.filter((f) => f.net !== net).flatMap((f) => segsOf(edgePts.get(f.id) || []).filter(([a, b]) => (horizontal ? H(a, b) : V(a, b))));
  const overlapping = (net, a, b) => {
    const horizontal = H(a, b);
    const c = horizontal ? a.y : a.x;
    const [lo, hi] = horizontal ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    return foreignRuns(net, horizontal).filter(([p, q]) => Math.abs((horizontal ? p.y : p.x) - c) < minGap - EPS && Math.min(hi, horizontal ? Math.max(p.x, q.x) : Math.max(p.y, q.y)) - Math.max(lo, horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y)) > 0.5);
  };
  const enters = (a, b) => rects.some((r) => Math.min(a.x, b.x) < r.x1 - 0.5 && Math.max(a.x, b.x) > r.x0 + 0.5 && Math.min(a.y, b.y) < r.y1 - 0.5 && Math.max(a.y, b.y) > r.y0 + 0.5);
  const moves = [];
  for (const e of edges) {
    const pts = edgePts.get(e.id);
    if (!pts || pts.length < 4) continue;
    for (const side of ['first', 'last']) {
      const n = pts.length;
      const [pin, corner, far] = side === 'first' ? [pts[0], pts[1], pts[2]] : [pts[n - 1], pts[n - 2], pts[n - 3]];
      if (!H(pin, corner) || !V(corner, far)) continue;
      const hits = overlapping(e.net, pin, corner);
      if (!hits.length) continue;
      // Every branch of the net that shares this terminal run and riser moves with it.
      const siblings = edges.filter((f) => f.net === e.net).map((f) => ({ f, q: edgePts.get(f.id) })).filter(({ q }) => {
        if (!q || q.length < 3) return false;
        const m = q.length;
        const [p0, p1] = side === 'first' ? [q[0], q[1]] : [q[m - 1], q[m - 2]];
        return Math.abs(p0.x - pin.x) < EPS && Math.abs(p0.y - pin.y) < EPS && Math.abs(p1.x - corner.x) < EPS && Math.abs(p1.y - corner.y) < EPS;
      });
      if (side === 'last' && siblings.length > 1) continue;
      const dir = Math.sign(corner.x - pin.x);
      // Past the other runs: the riser moves toward this run's pin.
      const v = dir > 0
        ? Math.min(...hits.map(([p, q]) => Math.min(p.x, q.x))) - minGap
        : Math.max(...hits.map(([p, q]) => Math.max(p.x, q.x))) + minGap;
      if (Math.sign(v - pin.x) !== dir) continue;
      const runLen = Math.abs(v - pin.x);
      if (runLen < (side === 'first' ? clearance : (hasArrow(e) ? arrowLen + 3 : 3))) continue;
      const from = corner.x;
      const saved = siblings.map(({ q }) => q.map((p) => ({ ...p })));
      for (const { q } of siblings) {
        const m = q.length;
        const idx = side === 'first' ? [1, 2] : [m - 2, m - 3];
        for (const i of idx) q[i].x = v;
      }
      const ok = siblings.every(({ f, q }) => {
        const m = q.length;
        const [c1, c2, c3] = side === 'first' ? [q[1], q[2], q[3]] : [q[m - 2], q[m - 3], q[m - 4]];
        // the run after the riser keeps its direction and a visible length
        if (c3 && (!H(c2, c3) || Math.abs(c3.x - v) < (side === 'first' && m === 4 && hasArrow(f) ? arrowLen + 3 : 1))) return false;
        if (c3 && Math.sign(c3.x - c2.x) !== Math.sign(c3.x - saved[0][side === 'first' ? 2 : saved[0].length - 3].x) && Math.abs(c3.x - saved[0][side === 'first' ? 2 : saved[0].length - 3].x) > EPS) return false;
        return !overlapping(f.net, c1, c2).length && !enters(c1, c2) && !overlapping(f.net, side === 'first' ? q[0] : q[m - 1], c1).length && !(c3 && overlapping(f.net, c2, c3).length);
      });
      if (!ok) { siblings.forEach(({ q }, j) => { q.splice(0, q.length, ...saved[j]); }); continue; }
      moves.push({ net: e.net, side, from, to: v });
      break;
    }
  }
  return moves;
}

// A connector tag packed against its driver's column leaves no room for the
// junction just before its arrowhead (route/dot-near-arrow: the dot can keep
// the clearance from the driver pin or from the arrowhead, not both). The tag
// slides right into free space until the junction on its last run keeps
// `clearance` from the arrowhead base; it moves only when nothing else (a
// node, another net's wire, the figure edge) lies in the swept area. Edges are
// { id, net, sink } with sink the element id; pos holds node boxes { x, y, w, h }.
export function nudgeConnectorTags(edgePts, edges, pos, { isTag = () => false, clearance = 8, arrowLen = 4.5, maxX = Infinity, margin = 2 } = {}) {
  const moved = [];
  const segsOf = (pts) => pts.slice(1).map((b, i) => [pts[i], b]);
  for (const e of edges) {
    if (!isTag(e.sink)) continue;
    const pts = edgePts.get(e.id);
    const box = pos.get(e.sink);
    if (!pts || pts.length < 2 || !box) continue;
    const tip = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    if (Math.abs(tip.y - prev.y) > 0.01 || tip.x <= prev.x) continue;
    const base = tip.x - arrowLen;
    const onRun = edges.filter((o) => o.net === e.net && o.id !== e.id).flatMap((o) => edgePts.get(o.id) || []).filter((p) => Math.abs(p.y - tip.y) < 0.01 && p.x >= prev.x - 0.01 && p.x < tip.x - 0.01);
    if (!onRun.length) continue;
    const dotX = Math.max(...onRun.map((p) => p.x));
    const gap = base - dotX;
    if (gap >= clearance - 0.01) continue;
    const delta = clearance - gap;
    const swept = { x0: box.x, x1: box.x + box.w + delta, y0: box.y, y1: box.y + box.h };
    if (swept.x1 > maxX) continue;
    const nodeFree = [...pos].every(([id, r]) => id === e.sink || swept.x1 + margin <= r.x || r.x + r.w + margin <= swept.x0 || swept.y1 + margin <= r.y || r.y + r.h + margin <= swept.y0);
    const wireFree = edges.filter((o) => o.net !== e.net).every((o) => segsOf(edgePts.get(o.id) || []).every(([a, b]) => Math.max(a.x, b.x) < swept.x0 - margin || Math.min(a.x, b.x) > swept.x1 + margin || Math.max(a.y, b.y) < swept.y0 - margin || Math.min(a.y, b.y) > swept.y1 + margin));
    if (!nodeFree || !wireFree) continue;
    box.x += delta;
    tip.x += delta;
    moved.push({ tag: e.sink, net: e.net, shift: Math.round(delta * 100) / 100 });
  }
  return moved;
}

export function spreadJunctions(edgePts, edges, { clearance = 8, arrowLen = 4.5, rects = [], maxShift = 40, hasArrow = () => true, minGap = 4 } = {}) {
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
          const blocked = runs.some((r) => entersBlock(r.pts[r.k - 1], r.pts[r.k]) || entersBlock(r.pts[r.k], r.pts[r.k + 1]) || entersBlock(r.pts[r.k + 1], r.pts[r.k + 2]) || runHugs(r.pts[r.k], r.pts[r.k + 1], net, { edges, edgePts, rects, minGap }));
          if (!blocked && netValid(net, list, { ...j, [A]: v }, count)) return true;
          restore();
        }
      }
    }
    return false;
  };
  // Third strategy: in a channel of parallel risers, trade columns with a foreign
  // riser farther from the arrowheads that carries no junction of its own (a
  // single-sink net), so the riser whose turn is a junction gets room before the
  // arrowhead. Both runs keep their pins; nothing touches or crowds.
  const swapRiser = (net, list, j) => {
    for (const A of ['x', 'y']) {
      const B = A === 'x' ? 'y' : 'x';
      const mine = [];
      for (const e of list) {
        const pts = edgePts.get(e.id);
        for (let k = 1; k + 2 < pts.length; k += 1) {
          if (Math.abs(pts[k][A] - pts[k + 1][A]) > EPS || Math.abs(pts[k][A] - j[A]) > EPS) continue;
          if (dist(pts[k], j) > EPS && dist(pts[k + 1], j) > EPS) continue;
          mine.push({ pts, k });
        }
      }
      if (!mine.length) continue;
      const lo = Math.min(...mine.flatMap(({ pts, k }) => [pts[k][B], pts[k + 1][B]]));
      const hi = Math.max(...mine.flatMap(({ pts, k }) => [pts[k][B], pts[k + 1][B]]));
      const candidates = [];
      for (const f of edges.filter((x) => x.net !== net)) {
        const fl = byNet.get(f.net);
        if (fl.length !== 1) continue;
        const pts = edgePts.get(f.id);
        for (let k = 1; k + 2 < pts.length; k += 1) {
          if (Math.abs(pts[k][A] - pts[k + 1][A]) > EPS) continue;
          const c = pts[k][A];
          if (Math.abs(c - j[A]) < EPS || Math.abs(c - j[A]) > maxShift) continue;
          const flo = Math.min(pts[k][B], pts[k + 1][B]);
          const fhi = Math.max(pts[k][B], pts[k + 1][B]);
          if (Math.min(hi, fhi) - Math.max(lo, flo) <= 0.5) continue;
          candidates.push({ f, pts, k, c });
        }
      }
      candidates.sort((p, q) => Math.abs(p.c - j[A]) - Math.abs(q.c - j[A]));
      for (const cand of candidates) {
        const savedMine = mine.map(({ pts, k }) => [pts[k][A], pts[k + 1][A]]);
        const savedTheirs = [cand.pts[cand.k][A], cand.pts[cand.k + 1][A]];
        const ranges = [...mine.map(({ pts, k }) => [pts[k - 1][A], pts[k + 2][A]]), [cand.pts[cand.k - 1][A], cand.pts[cand.k + 2][A]]];
        mine.forEach(({ pts, k }) => { pts[k][A] = cand.c; pts[k + 1][A] = cand.c; });
        cand.pts[cand.k][A] = j[A]; cand.pts[cand.k + 1][A] = j[A];
        const insideRuns = ranges.every(([p, q], i) => { const v = i < mine.length ? cand.c : j[A]; return v > Math.min(p, q) + 0.5 && v < Math.max(p, q) - 0.5; });
        const nj = { ...j, [A]: cand.c };
        const count = junctions(list.map((e) => edgePts.get(e.id))).length;
        const ok = insideRuns && clearOf(list, nj) && netValid(net, list, nj, count)
          && !touchesForeign(cand.f.net)
          && !mine.some(({ pts, k }) => runHugs(pts[k], pts[k + 1], net, { edges, edgePts, rects, minGap }) || entersBlock(pts[k - 1], pts[k]) || entersBlock(pts[k + 1], pts[k + 2]))
          && !runHugs(cand.pts[cand.k], cand.pts[cand.k + 1], cand.f.net, { edges, edgePts, rects, minGap })
          && !entersBlock(cand.pts[cand.k - 1], cand.pts[cand.k]) && !entersBlock(cand.pts[cand.k + 1], cand.pts[cand.k + 2]);
        if (ok) return true;
        mine.forEach(({ pts, k }, i) => { pts[k][A] = savedMine[i][0]; pts[k + 1][A] = savedMine[i][1]; });
        cand.pts[cand.k][A] = savedTheirs[0]; cand.pts[cand.k + 1][A] = savedTheirs[1];
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
      if (!leaving.length) { if (shiftRun(net, list, j) || swapRiser(net, list, j)) moved += 1; continue; }
      const shape = leaving.map(({ e, k }) => {
        const pts = edgePts.get(e.id);
        const [prev, cur, next, after] = [pts[k - 1], pts[k], pts[k + 1], pts[k + 2]];
        const axis = Math.abs(prev.y - cur.y) < EPS ? 'x' : Math.abs(prev.x - cur.x) < EPS ? 'y' : null;
        const other = axis === 'x' ? 'y' : 'x';
        // the run after the turn is perpendicular and the one after that parallel to the trunk
        const ok = axis && Math.abs(cur[axis] - next[axis]) < EPS && Math.abs(next[other] - after[other]) < EPS;
        return { pts, k, axis, ok, prev, after };
      });
      if (shape.some((s) => !s.ok) || new Set(shape.map((s) => s.axis)).size !== 1) { if (shiftRun(net, list, j) || swapRiser(net, list, j)) moved += 1; continue; }
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
        const valid = stillOnTrunk && clearOf(list, nj) && junctions(polys()).length === junctionCount && !shape.some((s) => entersBlock(s.pts[s.k], s.pts[s.k + 1]) || runHugs(s.pts[s.k], s.pts[s.k + 1], net, { edges, edgePts, rects, minGap })) && !touchesForeign(net);
        if (valid) { done = true; moved += 1; break; }
        shape.forEach((s, i) => { s.pts[s.k][axis] = saved[i][0]; s.pts[s.k + 1][axis] = saved[i][1]; });
      }
      if (!done) { apply(j[axis]); if (shiftRun(net, list, j) || swapRiser(net, list, j)) moved += 1; }
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
  // Declared abstraction (SPEC §4.11): omitted handshake nets are not drawn.
  doc = abstraction(doc).drawn;
  if (opts.dotReserve) return renderDatapathOnce(doc, opts);
  const errorCount = (r) => r.diagnostics.filter((d) => d.severity === 'error').length;
  let first = await renderDatapathOnce(doc, opts);
  // Connectors are chosen on the probe layout; straightening can still leave a
  // loop long on the final routes. Those branches become connectors in one
  // more pass, kept only when it has fewer errors.
  if (doc.meta?.style?.connectors !== false) {
    const extra = first.diagnostics.filter((d) => (d.code === 'route/long-feedback' || d.code === 'route/long-loop') && d.evidence?.sink).map((d) => ({ net: d.subject.id, sinkText: d.evidence.sink, span: d.evidence.length ?? d.evidence.detour, kind: d.code === 'route/long-feedback' ? 'feedback' : 'wrap-around' }));
    // A control-only return (loads, selects, enables) longer than the limit becomes a named connector
    // pair by rule; data returns do so only when the pass has fewer errors.
    const classes = deriveNetClasses(buildModel(doc));
    const isControl = (m) => classes.get(m.net)?.drawn === 'control';
    const control = extra.filter(isControl);
    if (control.length) {
      first = await renderDatapathOnce(doc, { ...opts, extraConnectorMarks: control });
      first.diagnostics.push({ code: 'route/control-connectors', severity: 'info', message: `${opts.variant ?? '2col'}: ${[...new Set(control.map((m) => m.net))].join(', ')} return as named connector pairs (control-only returns longer than the limit)`, subject: {}, evidence: { nets: control.map((m) => m.net) } });
      opts = { ...opts, extraConnectorMarks: control };
    }
    const data = extra.filter((m) => !isControl(m));
    if (data.length) {
      const marks = [...control, ...data];
      const retry = await renderDatapathOnce(doc, { ...opts, extraConnectorMarks: marks });
      if (errorCount(retry) < errorCount(first)) { first = retry; opts = { ...opts, extraConnectorMarks: marks }; }
    }
  }
  // Returns between near blocks are wires (longFeedback). When the figure drawn
  // with those wires does not fit its column, they become connector pairs in
  // one more pass, kept only when it has fewer errors (route/short-return-connectors).
  const unfit = first.diagnostics.filter((d) => d.code === 'print/max-height' || d.code === 'print/width-overflow');
  if (doc.meta?.style?.connectors !== false && opts.connectorMinLayers === undefined && unfit.length) {
    const retry = await renderDatapathOnce(doc, { ...opts, connectorMinLayers: 0 });
    if (retry.route.connectors?.length && errorCount(retry) < errorCount(first)) {
      const nets = [...new Set(retry.route.connectors.map((c) => c.net))];
      retry.diagnostics.push({ code: 'route/short-return-connectors', severity: 'info', message: `${opts.variant ?? '2col'}: ${nets.length} return net(s) between neighbouring blocks are drawn as connector pairs because the figure drawn with their wires does not fit (${unfit.map((d) => d.code).join(', ')})`, subject: { variant: opts.variant ?? '2col' }, evidence: { nets, unfit: unfit.map((d) => d.code) }, supportedFixes: ['allow a taller figure (meta.print.max_height_in)', 'order the pins so the returns enter at the top or bottom of the block'] });
      first = retry;
      opts = { ...opts, connectorMinLayers: 0 };
    }
  }
  // A study figure that reads badly (route/readability) tries the layout
  // alternatives and keeps one only if it lowers crossings per net without
  // adding errors; every tried layout is recorded (route.layout_alternatives).
  if (opts.variant === 'study' && !opts.layoutAlt && first.diagnostics.some((d) => d.code === 'route/readability')) {
    const tried = [{ layout: 'default', crossings_per_net: first.route.readability.crossings_per_net, errors: errorCount(first) }];
    let pick = first;
    let pickAlt = null;
    for (const alt of ['frame-flow', 'thorough']) {
      let r;
      try {
        r = await renderDatapathOnce(doc, { ...opts, layoutAlt: alt });
      } catch (error) {
        // An alternative the layout engine cannot run is recorded, not fatal.
        tried.push({ layout: alt, failed: String(error.message).slice(0, 160) });
        continue;
      }
      tried.push({ layout: alt, crossings_per_net: r.route.readability.crossings_per_net, errors: errorCount(r) });
      if (r.route.readability.crossings_per_net < pick.route.readability.crossings_per_net - 0.005 && errorCount(r) <= errorCount(first)) { pick = r; pickAlt = alt; }
    }
    tried.find((x) => x.layout === (pickAlt ?? 'default')).chosen = true;
    first = pick;
    first.route.layout_alternatives = tried;
    if (pickAlt) opts = { ...opts, layoutAlt: pickAlt };
  }
  const overflows = (r) => r.diagnostics.some((d) => d.code === 'print/width-overflow');
  // Parallel nets between two blocks that stayed unnamed for lack of room
  // (label/unlabeled-parallel-nets), and bundles whose name found no spot
  // (label/bundle-name-omitted): lay out once more with room for each name
  // beside its source pin; kept only with fewer errors and no lost fit.
  const withNameRoom = async (base, o) => {
    const unnamed = [...new Set(base.diagnostics.filter((d) => d.code === 'label/unlabeled-parallel-nets' || d.code === 'label/bundle-name-omitted').flatMap((d) => d.evidence?.nets ?? []))];
    if (!unnamed.length) return { result: base, opts: o };
    let retry = await renderDatapathOnce(doc, { ...o, nameReserve: new Set(unnamed) });
    // The wider gaps can take a width label's spot on another net: once more
    // with room for those slashes too, kept only when it has fewer errors.
    const lostWidth = retry.diagnostics.filter((d) => d.code === 'width/missing' && d.subject?.id).map((d) => d.subject.id);
    let slashes = null;
    if (lostWidth.length) {
      const again = await renderDatapathOnce(doc, { ...o, nameReserve: new Set(unnamed), slashReserve: new Set(lostWidth) });
      if (errorCount(again) < errorCount(retry)) { retry = again; slashes = new Set(lostWidth); }
    }
    const costsFit = overflows(retry) && (!overflows(base) || retry.content_width_pt > base.content_width_pt + 0.5);
    if (errorCount(retry) >= errorCount(base) || costsFit) return { result: base, opts: o };
    retry.diagnostics.push({ code: 'label/parallel-name-room', severity: 'info', message: `${o.variant ?? '2col'}: room reserved beside the source pin for the names of ${unnamed.length} parallel net(s)`, subject: { variant: o.variant ?? '2col' }, evidence: { nets: unnamed }, supportedFixes: [] });
    return { result: retry, opts: { ...o, nameReserve: new Set(unnamed), ...(slashes ? { slashReserve: slashes } : {}) } };
  };
  ({ result: first, opts } = await withNameRoom(first, opts));
  // Returns drawn as wires wrap around their sink block to reach its west
  // pins. Try them entering the block's east edge (facing the driver), then
  // its top edge, each with its own name-room pass; a plan is kept only if
  // crossings per net drop, with no more errors and no lost fit
  // (route/return-pins). returnSide 'west' opts out.
  const crossingsOf = (r) => r.route?.readability?.crossings_per_net ?? Infinity;
  if (!opts.returnSide && crossingsOf(first) > 0 && crossingsOf(first) !== Infinity && partitions(mergeTruncations(mergeDuplicateSplits(doc).doc)).backEdges?.size) {
    const tried = [{ side: 'west', crossings_per_net: crossingsOf(first), errors: errorCount(first) }];
    let pick = null;
    for (const side of ['east', 'north']) {
      let candidate;
      try {
        const { nameReserve: _n, slashReserve: _s, ...plain } = opts;
        candidate = await withNameRoom(await renderDatapathOnce(doc, { ...plain, returnSide: side }), { ...plain, returnSide: side });
      } catch (error) { tried.push({ side, failed: String(error.message).slice(0, 160) }); continue; }
      const r = candidate.result;
      tried.push({ side, crossings_per_net: crossingsOf(r), errors: errorCount(r) });      const costsFit = overflows(r) && (!overflows(first) || r.content_width_pt > first.content_width_pt + 0.5);
      // No error kind the default layout does not already have (an edge-hugging
      // block is not a fair trade for fewer crossings).
      const baseCodes = new Set(first.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code));
      const newKinds = r.diagnostics.some((d) => d.severity === 'error' && !baseCodes.has(d.code));
      if (crossingsOf(r) < crossingsOf(pick?.result ?? first) - 0.005 && errorCount(r) <= errorCount(first) && !newKinds && !costsFit) pick = { ...candidate, side };
    }
    if (pick) {
      pick.result.diagnostics.push({ code: 'route/return-pins', severity: 'info', message: `${opts.variant ?? '2col'}: returning nets enter their sink blocks on the ${pick.side} edge (crossings per net ${crossingsOf(first)} → ${crossingsOf(pick.result)})`, subject: { variant: opts.variant ?? '2col' }, evidence: { tried }, supportedFixes: [] });
      first = pick.result;
      opts = pick.opts;
    }
  }
  // Crowded nets and where: before an arrowhead ('arrow') or at the driver pin ('pin').
  const crowdedOf = (r) => r.diagnostics.filter((d) => d.code === 'route/dot-near-arrow').map((d) => ({ id: d.subject.id.replace(/__cx\d+$/, ''), kind: /arrowhead base/.test(d.message) ? 'arrow' : 'pin' }));
  // Room can crowd other nets, so the reserve grows over at most three passes
  // (each adds the nets still crowded). The pass with the fewest errors wins;
  // room for a dot never costs the fit: a pass that overflows where the best
  // one fitted, or overflows wider, is discarded.
  let best = first;
  let last = first;
  const reserve = new Map();
  for (let pass = 0; pass < 3; pass += 1) {
    const next = (c) => (c.kind !== 'arrow' ? (reserve.get(c.id) ?? 'pin') : reserve.get(c.id) === 'arrow' || reserve.get(c.id) === 'arrow-head' ? 'arrow-head' : 'arrow');
    const grow = crowdedOf(last).filter((c) => reserve.get(c.id) !== next(c));
    if (!grow.length) break;
    grow.forEach((c) => reserve.set(c.id, next(c)));
    last = await renderDatapathOnce(doc, { ...opts, dotReserve: new Map(reserve) });
    // A control-only return that the wider layout made long becomes a connector pair too (the rule holds on every pass).
    const longControl = last.diagnostics.filter((d) => d.code === 'route/long-feedback' && d.evidence?.sink).map((d) => ({ net: d.subject.id, sinkText: d.evidence.sink, span: d.evidence.length ?? d.evidence.detour, kind: 'feedback' })).filter((m) => deriveNetClasses(buildModel(doc)).get(m.net)?.drawn === 'control');
    if (longControl.length) {
      opts = { ...opts, extraConnectorMarks: [...(opts.extraConnectorMarks || []), ...longControl] };
      last = await renderDatapathOnce(doc, { ...opts, dotReserve: new Map(reserve) });
    }
    const costsFit = overflows(last) && (!overflows(best) || last.content_width_pt > best.content_width_pt + 0.5);
    if (errorCount(last) < errorCount(best) && !costsFit) best = last;
  }
  if (first.route.layout_alternatives && !best.route.layout_alternatives) best.route.layout_alternatives = first.route.layout_alternatives;
  return best;
}


async function renderDatapathOnce(doc, { variant = '2col', widthPt, maxHeightPt, minFontPt = 6, minStrokePt = 0.5, name = 'figure', spread = variant !== '1col', skin, connectorMarks = null, dotReserve = null, nameReserve = null, slashReserve = null, returnSide = null, extraConnectorMarks = null, layoutAlt = null, connectorBase = null, connectorMinLayers = null } = {}) {
  skin = skin ?? loadSkin(doc.meta?.style?.skin);
  const diagnostics = [...checkSkin(skin)];
  // Identical splits/buffers are drawn once, and a single slice is a wire label (render-only).
  doc = mergeTruncations(mergeDuplicateSplits(doc).doc);
  const model = buildModel(doc);
  model.dotReserve = dotReserve;
  model.nameReserve = nameReserve;
  model.slashReserve = slashReserve;
  model.returnSide = returnSide;
  model.layoutAlt = layoutAlt;
  const broken = model.nets.flatMap((n) => [n.driver, ...n.sinks]).filter((e) => e.error);
  if (broken.length) throw new Error(`renderer: unresolved endpoints (${broken.map((b) => b.text).join(', ')}); run semantic checks first`);
  const connected = new Set(model.nets.flatMap((n) => n.sinks.map((s) => `${s.element.id}.${s.pin.id}`)));
  for (const { el: e } of model.elements.values()) {
    if (e.kind === 'mux' && !connected.has(`${e.id}.sel`)) diagnostics.push({ code: 'symbol/mux-sel-missing', severity: 'error', message: `mux ${e.id} has no net on its select pin; a mux must show its select`, subject: { id: e.id }, evidence: {}, supportedFixes: [`connect a net to ${e.id}.sel`] });
  }
  // Connector tags: one name per net (connector/ambiguous-name), and a tag
  // never feeds a figure output port directly (connector/redundant-port).
  const connectorNets = new Map();
  for (const e of doc.elements.filter((x) => x.kind === 'port' && x.connector)) {
    const netOf = e.connector_net ?? e.id.replace(/^cx_/, '').replace(/_to\d+$/, '');
    if (!connectorNets.has(e.label)) connectorNets.set(e.label, new Set());
    connectorNets.get(e.label).add(netOf);
  }
  for (const [label, nets] of connectorNets) {
    if (nets.size > 1) diagnostics.push({ code: 'connector/ambiguous-name', severity: 'error', message: `${variant}: ${nets.size} different nets share the connector name "${label}" (${[...nets].join(', ')}); a reader cannot pair the tags`, subject: { variant, label }, evidence: { nets: [...nets] }, supportedFixes: ['give the nets distinct labels', 'leave connector names to the renderer: it qualifies them by source instance'] });
  }
  // A name is a tag at most twice (one pair) and never both a tag and a figure port.
  const tagCount = new Map();
  for (const e of doc.elements.filter((x) => x.kind === 'port' && x.connector)) tagCount.set(e.label, (tagCount.get(e.label) || 0) + 1);
  const figurePortLabels = new Set(doc.elements.filter((x) => x.kind === 'port' && !x.connector).map((x) => x.label ?? x.id));
  for (const [label, count] of tagCount) {
    if (count > 2) diagnostics.push({ code: 'connector/duplicate-name', severity: 'error', message: `${variant}: the name "${label}" is on ${count} connector tags; a name belongs to one source and one target tag`, subject: { variant, label }, evidence: { tags: count }, supportedFixes: ['let one target tag feed every sink of the net (the renderer does this)'] });
    if (figurePortLabels.has(label)) diagnostics.push({ code: 'connector/duplicate-name', severity: 'error', message: `${variant}: "${label}" names both a connector tag and a figure port`, subject: { variant, label }, evidence: { port: label }, supportedFixes: ['qualify the connector name (the renderer adds the source instance)', 'rename the port'] });
  }
  for (const n of model.nets.filter((x) => !x.driver.error && x.driver.element.connector === 'target')) {
    for (const s of n.sinks.filter((x) => !x.error && x.element.kind === 'port' && x.element.dir === 'out' && !x.element.connector)) {
      diagnostics.push({ code: 'connector/redundant-port', severity: 'error', message: `${variant}: connector tag ${n.driver.element.id} feeds figure output ${s.element.id} directly; one signal would print two names`, subject: { variant, id: s.element.id }, evidence: { tag: n.driver.element.id }, supportedFixes: ['draw the output port beside its driver (the renderer does this for long routes into outputs)'] });
    }
  }
  // Long feedback/return nets become named off-page connectors (CONVENTIONS
  // §1.6): measure a first layout, replace the long returning branches, lay out again.
  const feedbackRatio = skin.tokens.route.long_feedback_ratio ?? 0.5;
  if (!connectorMarks && doc.meta?.style?.connectors !== false) {
    const probe = await layoutOnce(doc, model, skin, variant, 'full', 1);
    const minLayers = connectorMinLayers ?? skin.tokens.route.connector_min_layers ?? 2;
    const marks = longFeedback(model, probe, feedbackRatio, { minLayers });
    // Branches found long on an earlier pass's final routes (renderDatapath).
    for (const m of extraConnectorMarks || []) {
      const n = model.nets.find((x) => x.net.id === m.net);
      const sink = n ? n.sinks.findIndex((s) => !s.error && `${s.element.id}.${s.pin.id}` === m.sinkText) : -1;
      if (sink >= 0 && !marks.some((x) => x.net === m.net && x.sink === sink)) marks.push({ net: m.net, sink, span: m.span, kind: m.kind });
    }
    if (variant === 'study') for (const m of regionCrossingMarks(model, probe, { minLayers })) if (!marks.some((x) => x.net === m.net && x.sink === m.sink)) marks.push(m);
    if (marks.length) {
      const cut = withConnectors(doc, model, marks);
      const used = marks.filter((m) => cut.elements.some((e) => e.id === `cx_${m.net}`));
      if (used.length) return renderDatapathOnce(cut, { variant, widthPt, maxHeightPt, minFontPt, minStrokePt, name, spread, skin, connectorMarks: used, dotReserve, nameReserve, slashReserve, returnSide, layoutAlt, connectorBase: doc, connectorMinLayers });
    }
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
    }, { ...scoreOpts, maxEvaluations: rt.straighten_max_evaluations ?? Infinity });
    const score = routeScore(out.edges, scoreOpts.minOffsetPt, scoreOpts.crossingWeight, out.nodes);
    const bends = justifyBends({ nodes: out.nodes, edges: out.edges, regions: r.tree.roots }, scoreOpts);
    // Avoidable bends weigh like redundant jogs when choosing between plans.
    return { st: out, score, bends, value: score.value + bends.filter((b) => b.avoidable).length * 1000 };
  };
  // Pin re-assignment (taps under blocks) is tried before any bend is accepted;
  // the plan with the better straightened route is kept.
  let straightened = straightenRun(run);
  const plan = tapPlan(model, run.part);
  const layoutPlans = [{ plan: 'default', score: Math.round(straightened.value), evaluations: straightened.st.evaluations, ...(straightened.st.exhausted ? { budget_exhausted: true } : {}) }];
  if (plan.taps.size) {
    const alt = await layoutOnce(doc, model, skin, variant, chosen.labels, chosen.spacing_scale, plan);
    if (!widthPt || alt.contentW <= Math.max(widthPt, run.contentW) + 0.01) {
      const altStraightened = straightenRun(alt);
      layoutPlans.push({ plan: 'taps', taps: [...plan.taps], score: Math.round(altStraightened.value), evaluations: altStraightened.st.evaluations, ...(altStraightened.st.exhausted ? { budget_exhausted: true } : {}) });
      if (altStraightened.value < straightened.value) {
        run = alt;
        straightened = altStraightened;
        layoutPlans.at(-1).chosen = true;
      }
    } else layoutPlans.push({ plan: 'taps', taps: [...plan.taps], rejected: 'wider than the column' });
  }
  if (!layoutPlans.some((p) => p.chosen)) layoutPlans[0].chosen = true;
  if (layoutPlans.some((p) => p.budget_exhausted)) diagnostics.push({ code: 'route/straighten-budget', severity: 'info', message: `${variant}: straightening stopped after ${Math.max(...layoutPlans.map((p) => p.evaluations ?? 0))} candidate layouts (skin route.straighten_max_evaluations); the best route found by then is kept and every route check still runs`, subject: { variant }, evidence: { layout_plans: layoutPlans }, supportedFixes: ['narrow the scope or lower the depth', 'raise route.straighten_max_evaluations in the skin'] });
  const { ctx, symbols, part, tree } = run;
  const t = ctx.t;
  // Text the renderer generates is readable in every format (label/unreadable
  // with evidence.generated, never relaxed by the study format).
  const seenGenerated = new Set();
  for (const g of ctx.generated) {
    const key = `${g.id}|${g.where}|${g.text}`;
    if (seenGenerated.has(key)) continue;
    seenGenerated.add(key);
    const reason = unreadableReason(g.text);
    if (reason) diagnostics.push({ code: 'label/unreadable', severity: 'error', message: `${variant}: generated ${g.where} text "${g.text}" on ${g.id} is not a readable name (${reason})`, subject: { id: g.id, variant, field: g.where }, evidence: { generated: true, text: g.text, reason }, supportedFixes: ['give the port or net a readable label', 'map the net to its RTL signal (rtl.signal) so a readable name can be derived'] });
  }
  for (const [id, sym] of symbols) {
    if ((sym.subLineCount ?? 0) > STAGE_NOTE_LINES) diagnostics.push({ code: 'label/stage-note-clutter', severity: 'error', message: `${variant}: ${id} prints ${sym.subLineCount} lines of notes inside its box (at most ${STAGE_NOTE_LINES})`, subject: { id, variant }, evidence: { lines: sym.subLineCount }, supportedFixes: ['shorten function.detail to one line', 'leave output latencies to the renderer: it summarizes them and lists every output in the receipt'] });
  }
  const S = t.font.secondary_pt;
  if (widthPt && run.contentW > widthPt + 0.01) diagnostics.push({ code: 'print/width-overflow', severity: 'error', message: `${variant}: content ${num(run.contentW)} pt exceeds column ${num(widthPt)} pt even with short labels and tight spacing (${num(run.contentW - widthPt)} pt over; width set by ${describeWidth(sizeReport(run))})`, subject: { variant }, evidence: { content: run.contentW, column: widthPt, over: run.contentW - widthPt, size_report: sizeReport(run) }, supportedFixes: ['add short_label to wide labels', 'collapse more hardware into blocks whose rtl.covers name it (never drop hardware)', 'allow a taller figure up to the profile maximum height', 'narrow meta.scope explicitly or split into sub-figures (a)/(b) linked with detail_ref'] });
  // A study figure lists every output latency in a table below the drawing,
  // so blocks keep at most two note lines (label/stage-note-clutter).
  const stageRows = variant === 'study' ? stageTableRows(ctx.stageTable) : [];
  const stageTableTitle = 'Output latency';
  const stageColumns = [];
  for (let i = 0; i < stageRows.length; i += STAGE_TABLE_ROWS) stageColumns.push(stageRows.slice(i, i + STAGE_TABLE_ROWS));
  const stageColumnW = stageColumns.map((col) => Math.max(...col.map((l) => ctx.measure(l, S))) + 12);
  const stageTableW = stageRows.length ? Math.max(ctx.measure(stageTableTitle, S), stageColumnW.reduce((a, b) => a + b, 0)) : 0;
  const W = Math.max(widthPt ?? run.contentW, run.contentW, stageRows.length ? stageTableW + 8 : 0);
  const ox = Math.max(0, (W - run.contentW) / 2);

  const finePitch = (n) => [n.driver, ...n.sinks].some((end) => /^gate-/.test(symbols.get(end.element?.id)?.shape || ''));
  const st = straightened.st;
  // Unused figure ports sit at the figure edge (inputs left, outputs right),
  // at the nearest height clear of every block, port and wire, instead of
  // floating where the layout packed them; below everything when no height is free.
  const unusedNodes = [...st.nodes].filter(([id]) => symbols.get(id)?.unused);
  if (unusedNodes.length) {
    const all = [...st.nodes.values()];
    const left = Math.min(...all.map((r) => r.x));
    const right = Math.max(...all.map((r) => r.x + r.w));
    const top = Math.min(...all.map((r) => r.y));
    const bottom = Math.max(...all.map((r) => r.y + r.h));
    const fixed = [...st.nodes].filter(([id]) => !symbols.get(id)?.unused).map(([, r]) => r);
    const wires = st.edges.flatMap((e) => e.pts.slice(1).map((b, i) => [e.pts[i], b]));
    const placedUnused = [];
    const free = (r) => [...fixed, ...placedUnused].every((o) => r.x + r.w + 4 <= o.x || o.x + o.w + 4 <= r.x || r.y + r.h + 4 <= o.y || o.y + o.h + 4 <= r.y)
      && wires.every(([a, b]) => Math.max(a.x, b.x) < r.x - 2 || Math.min(a.x, b.x) > r.x + r.w + 2 || Math.max(a.y, b.y) < r.y - 2 || Math.min(a.y, b.y) > r.y + r.h + 2);
    let below = bottom + 6;
    for (const [id, r] of unusedNodes) {
      const x = model.elements.get(id).el.dir === 'in' ? left : right - r.w;
      const heights = [r.y, ...Array.from({ length: Math.ceil((bottom - top) / 6) + 1 }, (_, k) => [r.y + (k + 1) * 6, r.y - (k + 1) * 6]).flat()].filter((y) => y >= top && y + r.h <= bottom);
      const y = heights.find((h) => free({ ...r, x, y: h }));
      r.x = x;
      if (y === undefined) { r.y = below; below += r.h + 4; } else r.y = y;
      placedUnused.push(r);
    }
  }
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
  // A connector pair whose tags ended up close together is not a connector:
  // lay the figure out again with those nets drawn as wires.
  if (connectorBase && connectorMarks?.length) {
    const close = closeConnectorMarks(doc, pos, { layers: connectorMinLayers ?? rt.connector_min_layers ?? 2 });
    if (close.length) {
      const drop = new Set(close.flatMap((c) => c.sinks.map((s) => `${c.net}|${s}`)));
      const keep = connectorMarks.filter((m) => !drop.has(`${m.net}|${m.sink}`));
      const cut = keep.length ? withConnectors(connectorBase, buildModel(connectorBase), keep) : connectorBase;
      return renderDatapathOnce(cut, { variant, widthPt, maxHeightPt, minFontPt, minStrokePt, name, spread, skin, connectorMarks: keep, dotReserve, nameReserve, slashReserve, returnSide, layoutAlt, connectorBase, connectorMinLayers });
    }
  }
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
  // Connector tags packed against their driver slide right so the junction before them has room (before pin anchors are taken).
  const nudged = nudgeConnectorTags(edgePts, st.edges.map((e) => { const [, net, idx] = /^(.*)__(\d+)$/.exec(e.id); return { id: e.id, net, sink: netInfo.get(net).n.sinks[Number(idx)].element.id }; }), pos, {
    isTag: (id) => model.elements.get(id)?.el.connector === 'source',
    clearance: rt.dot_arrow_clearance ?? 8,
    arrowLen: t.arrow.length,
    maxX: W,
  });
  if (nudged.length) diagnostics.push({ code: 'route/tag-nudge', severity: 'info', message: `${variant}: ${nudged.map((m) => `${m.tag} +${m.shift} pt`).join(', ')} moved right to keep the junction before the tag clear of its arrowhead`, subject: { variant }, evidence: { nudged }, supportedFixes: [] });
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
  // No head on gate inputs in gate regions, into a split, or at a pass-through pin.
  const edgeHasArrow = (e) => {
    const sink = netInfo.get(e.net).n.sinks[Number(/__(\d+)$/.exec(e.id)[1])];
    const sym = symbols.get(sink.element.id);
    const gateIn = /^gate-/.test(sym?.shape || '') && (doc.regions || []).some((r) => r.level === 'gate' && r.members.includes(sink.element.id));
    const ripper = sink.element.kind === 'comb' && sink.element.op === 'split';
    return !gateIn && !ripper && !sym?.pins.find((p) => p.id === sink.pin.id)?.through;
  };
  detouchWires(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    minGap: rt.min_parallel_gap_pt ?? 4,
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
    arrowLen: t.arrow.length,
    hasArrow: edgeHasArrow,
  });
  // Different nets keep route.min_parallel_gap_pt between parallel runs (wire/collinear-overlap).
  separateParallelRuns(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    minGap: rt.min_parallel_gap_pt ?? 4,
    clearance: rt.dot_arrow_clearance ?? 8,
    arrowLen: t.arrow.length,
    hasArrow: edgeHasArrow,
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
  });
  alignGateSteps(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    // Gate pins and figure ports / connector tags: no step just before the pin.
    fine: (e) => finePitch(netInfo.get(e.net).n) || netInfo.get(e.net).n.sinks[Number(/__(\d+)$/.exec(e.id)[1])]?.element?.kind === 'port',
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
  });
  // Junction dots keep route.dot_arrow_clearance from arrowheads and pin
  // anchors of their net (CONVENTIONS §1.5): move the branch point along the trunk.
  // Full-size arrowheads need a last run as long as the head plus a shaft.
  ensureArrowRoom(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    minGap: rt.min_parallel_gap_pt ?? 4,
    arrowLen: t.arrow.length,
    minShaft: rt.arrow_min_shaft_pt ?? 1,
    hasArrow: edgeHasArrow,
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
  });
  spreadJunctions(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    minGap: rt.min_parallel_gap_pt ?? 4,
    clearance: rt.dot_arrow_clearance ?? 8,
    hasArrow: edgeHasArrow,
    arrowLen: t.arrow.length,
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
  });
  // Terminal runs of different nets lying on top of each other: slide a riser past the other run.
  const unstacked = unstackTerminalRuns(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    minGap: rt.min_parallel_gap_pt ?? 4,
    clearance: rt.dot_arrow_clearance ?? 8,
    arrowLen: t.arrow.length,
    hasArrow: edgeHasArrow,
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
  });
  if (unstacked.length) diagnostics.push({ code: 'route/terminal-runs', severity: 'info', message: `${variant}: ${unstacked.map((m) => `${m.net} riser ${num(m.from)} → ${num(m.to)} pt`).join(', ')} moved off another net's terminal run`, subject: { variant }, evidence: { moves: unstacked }, supportedFixes: [] });
  // Runs the later passes moved together again; junction dots stay where they were placed.
  separateParallelRuns(edgePts, st.edges.map((e) => ({ id: e.id, net: /^(.*)__\d+$/.exec(e.id)[1] })), {
    minGap: rt.min_parallel_gap_pt ?? 4,
    clearance: rt.dot_arrow_clearance ?? 8,
    arrowLen: t.arrow.length,
    hasArrow: edgeHasArrow,
    rects: [...pos].filter(([id]) => !symbols.get(id).isPort).map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
    fixedJunctions: true,
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
  // Frames follow their members, so two instances straightened into a stack
  // get frames that touch: pull the facing edges apart within their padding
  // (region/frame-edge-crossing). The members' extent stays enclosed.
  {
    const treeNode = new Map(tree.all.map((x) => [x.id, x]));
    const withInner = frames.map((f) => {
      const n = treeNode.get(f.id);
      return Object.assign(f, { inner: { x0: f.x0 + n.pad, y0: f.y0 + n.padTop, x1: f.x1 - n.pad, y1: f.y1 - n.pad } });
    });
    separateSiblingFrames(withInner, { labelBand: S + 3 });
    for (const f of withInner) delete f.inner;
  }
  const levels = levelsShown(doc);
  const legend = levels.size > 2 && doc.meta?.legend !== false ? ['blackbox', 'block', 'rtl', 'gate'].filter((l) => levels.has(l)).map((l) => LEVEL_LEGEND[l]).join('; ') : null;
  const stageTableTop = Math.max(...ys) + dy + PAD;
  const stageTableH = stageRows.length ? (Math.min(stageRows.length, STAGE_TABLE_ROWS) + 1) * (S + 2) + 6 : 0;
  const H = stageTableTop + stageTableH + (legend ? S + 6 : 0);
  // A net entering a frame close to a corner grows the frame so it enters
  // mid-edge (region/entry-side), before labels take the space around frames.
  {
    const members = new Map(tree.all.map((x) => [x.id, x.inside]));
    const labelOf = (id) => tree.all.find((x) => x.id === id)?.label;
    const growable = frames.map((f) => Object.assign(f, { members: members.get(f.id), labelH: labelOf(f.id) ? S + 6 : 0, labelW: labelOf(f.id) ? ctx.measure(labelOf(f.id), S) : 0 }));
    const growEntries = [];
    for (const e of st.edges) {
      const [, netId, idx] = /^(.*)__(\d+)$/.exec(e.id);
      const { n } = netInfo.get(netId);
      const sink = n.sinks[Number(idx)];
      if (!sink || n.driver.error) continue;
      for (const f of growable) {
        if (f.members?.has(sink.element.id) && !f.members.has(n.driver.element.id)) growEntries.push({ net: netId, region: f.id, pts: edgePts.get(e.id) });
      }
    }
    growFramesForEntries(growable, growEntries, {
      frameGap: rt.frame_gap_pt ?? 6,
      nodes: [...pos].map(([id, r]) => ({ id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })),
      segs: [...edgePts].flatMap(([id, pts]) => pts.slice(1).map((b, k) => ({ id: `net-${id}-seg`, a: pts[k], b }))),
      bounds: { x0: 0.5, y0: 0.5, x1: W - 0.5, y1: stageRows.length ? stageTableTop - 1 : H - (legend ? S + 6 : 0) - 0.5 },
    });
    for (const f of growable) delete f.members;
  }

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
    // Labels keep 1 pt from a symbol's ink: the pad counts half the outline stroke (connector tags are outlined too; plain port labels are not).
    placer.addRect({ x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h, ...(sym.glyph === 'port-label' ? {} : { pad: 1 + outlineW(t, sym.shape || 'default') / 2 }) });
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
  // A net label sits closer to its own wire than to any other wire, so the
  // reader attaches it to the right net, within net_label.max_wire_distance_pt
  // of that wire, and nearer to it than to any block outline it faces
  // (label/ambiguous-anchor). The placer only offers such spots.
  const anchorGap = (netId, box) => labelAnchorGap(box, drawn.map((d) => ({ id: d.n.net.id, polylines: d.branches.map((br) => br.pts) })), netId);
  const maxLabelDistance = t.net_label?.max_wire_distance_pt ?? 12;
  const labelBlockRects = [...pos].filter(([id]) => !symbols.get(id).isPort).map(([id, r]) => ({ id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
  const ownAnchored = (netId, box) => !netLabelAnchorProblem(anchorGap(netId, box), box, labelBlockRects, { maxDistance: maxLabelDistance });
  // Leader labels (net label_placement "leader" | "auto"): when a net's runs are
  // too short for its name, the name sits in free space and a short orthogonal
  // leader (at most net_label.leader_max_pt, one bend at most, the wire stroke,
  // no marker) joins it to a point on its own wire. The leader crosses and
  // touches no other wire, block, frame edge, text or foreign arrowhead, keeps
  // route.min_parallel_gap_pt from parallel wires of other nets, and ends
  // net_label.leader_gap_pt short of its text. The shortest valid leader wins.
  const leaderMax = t.net_label?.leader_max_pt ?? 24;
  const leaderGap = t.net_label?.leader_gap_pt ?? 1.5;
  const bbOf = (a, b) => ({ x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
  const rectGap = (p, q) => Math.hypot(Math.max(0, q.x0 - p.x1, p.x0 - q.x1), Math.max(0, q.y0 - p.y1, p.y0 - q.y1));
  const placeLeader = (netId, label, size, maxLen = leaderMax) => {
    const lw = ctx.measure(label, size);
    const asc = ctx.font.ascent * size;
    const desc = ctx.font.descent * size * 0.6;
    const segsOfNets = (keep) => drawn.filter((d) => keep(d.n.net.id)).flatMap((d) => d.branches.flatMap((br) => br.pts.slice(1).map((b, k) => ({ a: br.pts[k], b }))));
    const foreign = segsOfNets((id) => id !== netId);
    const own = segsOfNets((id) => id === netId);
    const blocks = [...pos].map(([, r]) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
    const frameEdges = frames.flatMap((f) => [bbOf({ x: f.x0, y: f.y0 }, { x: f.x1, y: f.y0 }), bbOf({ x: f.x1, y: f.y0 }, { x: f.x1, y: f.y1 }), bbOf({ x: f.x0, y: f.y1 }, { x: f.x1, y: f.y1 }), bbOf({ x: f.x0, y: f.y0 }, { x: f.x0, y: f.y1 })]);
    const texts = placer.obstacles.filter((o) => o.text);
    const minParallel = rt.min_parallel_gap_pt ?? 4;
    const legOk = (a, b, anchorSeg) => {
      const bb = bbOf(a, b);
      const vertical = Math.abs(a.x - b.x) < 0.01;
      for (const s of foreign) {
        const sb = bbOf(s.a, s.b);
        if (rectGap(bb, sb) < 1.5) return false;
        if ((Math.abs(s.a.x - s.b.x) < 0.01) === vertical) {
          const along = vertical ? Math.min(bb.y1, sb.y1) - Math.max(bb.y0, sb.y0) : Math.min(bb.x1, sb.x1) - Math.max(bb.x0, sb.x0);
          const gap = vertical ? Math.abs(a.x - s.a.x) : Math.abs(a.y - s.a.y);
          if (along > 0.5 && gap < minParallel) return false;
        }
      }
      if (own.some((s) => s !== anchorSeg && rectGap(bb, bbOf(s.a, s.b)) < 1.5)) return false;
      if (blocks.some((r) => rectGap(bb, r) < 1.5)) return false;
      if (frameEdges.some((e) => rectGap(bb, e) < 1)) return false;
      if (texts.some((o) => rectGap(bb, o) < 1)) return false;
      return !arrowZones.some((z) => z.net !== netId && rectGap(bb, z) < 0.5);
    };
    // Anchors every 1 pt along each run of the net (1.5 pt inside its ends);
    // the text may sit anywhere along the leader's end (it keeps the leader's
    // column or row within its extent), swept in 2 pt steps.
    const cands = [];
    const spread = (from, to, step) => { const out = []; for (let v = from; v <= to + 1e-6; v += step) out.push(v); return out; };
    for (const s of own) {
      const horizontal = Math.abs(s.a.y - s.b.y) < 0.01;
      const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      if (len < 4) continue;
      for (const off of spread(1.5, len - 1.5, 1)) {
        const f = off / len;
        const a = { x: s.a.x + (s.b.x - s.a.x) * f, y: s.a.y + (s.b.y - s.a.y) * f };
        for (let L = 6; L <= maxLen + 1e-6; L += 3) {
          for (const dir of [-1, 1]) {
            if (horizontal) {
              const end = { x: a.x, y: a.y + dir * L };
              const baseline = dir < 0 ? end.y - leaderGap - desc : end.y + leaderGap + asc;
              for (const x of spread(end.x - lw + 1, end.x - 1, 2)) cands.push({ len: L, pts: [a, end], x, y: baseline, seg: s });
              for (const L2 of [4, 8, 12]) {
                if (L + L2 > maxLen + 1e-6) continue;
                for (const side of [1, -1]) {
                  const e2 = { x: end.x + side * L2, y: end.y };
                  cands.push({ len: L + L2, pts: [a, end, e2], x: side > 0 ? e2.x + leaderGap : e2.x - leaderGap - lw, y: end.y + ctx.base(size), seg: s });
                }
              }
            } else {
              const end = { x: a.x + dir * L, y: a.y };
              const x = dir > 0 ? end.x + leaderGap : end.x - leaderGap - lw;
              for (const dy of [0, -3, 3, -6, 6]) cands.push({ len: L, pts: [a, end], x, y: a.y + ctx.base(size) + dy, seg: s });
            }
          }
        }
      }
    }
    cands.sort((p, q) => p.len - q.len);
    for (const c of cands) {
      const box = tbox(label, size, c.x, c.y);
      if (box.x0 < 0.5 || box.x1 > W - 0.5 || box.y0 < 0.5 || box.y1 > H - 0.5) continue;
      if (!placer.fits(box) || !clearOfArrows(netId, box) || frameEdgesHit(box).length) continue;
      const legs = c.pts.slice(1).map((b, k) => [c.pts[k], b]);
      if (!legs.every(([p, q], k) => legOk(p, q, k === 0 ? c.seg : null))) continue;
      // the text keeps the leader gap from every leg of its leader except where it ends
      if (legs.slice(0, -1).some(([p, q]) => rectGap(bbOf(p, q), box) < leaderGap - 0.01)) continue;
      placer.addPolyline(c.pts, t.stroke.wire);
      placer.addRect({ ...box, text: true });
      placedLabelBoxes.push(box);
      return { ...c, box };
    }
    return null;
  };
  const pointSegDist = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
  };
  const placedNetLabels = [];
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
        // Every arrowhead has the one skin size (arrow/nonuniform): it is never
        // shortened to fit. The layout makes room first (ensureArrowRoom); a run
        // still too short for the head plus a shaft is reported.
        const L = t.arrow.length;
        const minShaft = rt.arrow_min_shaft_pt ?? 1;
        if (len < L + minShaft - 0.01) diagnostics.push({ code: 'arrow/no-room', severity: 'error', message: `${variant}: net ${n.net.id} reaches ${sink.element.id}.${sink.pin.id} with a ${num(len)} pt run, shorter than the ${num(L)} pt arrowhead plus a ${num(minShaft)} pt shaft`, subject: { id: n.net.id, variant, sink: `${sink.element.id}.${sink.pin.id}` }, evidence: { run: num(len), arrow_length: L }, supportedFixes: ['increase the layer spacing for this variant', 'move the pin or the bend so the last run is longer'] });
        draw[draw.length - 1] = len > L ? { x: b.x - ux * L, y: b.y - uy * L } : { ...a };
        heads.push(arrowHead(t, `net-${n.net.id}-arrow${i}`, b, ux, uy, style.stroke));
        // Zone that labels of OTHER nets must avoid: the head plus the wire within
        // 8 pt of the tip, walked back along the polyline (a short last run
        // brings the previous segment into the zone, as arrow/label-proximity
        // measures it), clipped to 8 pt around the tip.
        const zonePts = [b];
        let budget = L + 8;
        for (let k = draw.length - 1; k > 0 && budget > 0; k -= 1) {
          const [p, q] = [pts[k], pts[k - 1]];
          const seg = Math.hypot(p.x - q.x, p.y - q.y);
          const f = seg > budget ? budget / seg : 1;
          zonePts.push({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f });
          budget -= seg;
        }
        const zx0 = Math.max(Math.min(...zonePts.map((p) => p.x)), b.x - 8);
        const zx1 = Math.min(Math.max(...zonePts.map((p) => p.x)), b.x + 8);
        const zy0 = Math.max(Math.min(...zonePts.map((p) => p.y)), b.y - 8);
        const zy1 = Math.min(Math.max(...zonePts.map((p) => p.y)), b.y + 8);
        // 0.25 pt beyond the 1.5 pt arrow/label-proximity limit, so a label never lands exactly on it.
        const grow = t.arrow.width / 2 + 1.75;
        arrowZones.push({ net: n.net.id, x0: zx0 - grow, x1: zx1 + grow, y0: zy0 - grow, y1: zy1 + grow });
        // No placer obstacle here: a net's own width label may sit next to
        // its arrow; foreign labels near an arrow are caught by arrow/label-proximity.
      }
      segs.push(el('path', { id: `net-${n.net.id}-seg${i}`, d: pathD(draw), ...style }));
      placer.addPolyline(pts, style['stroke-width']);
    });
    const dots = junctions(branches.map((b) => b.pts)).map((j, k) => el('circle', { id: `net-${n.net.id}-dot${k}`, cx: j.x, cy: j.y, r: Math.max(t.junction_diam_factor * style['stroke-width'], t.junction_min_diam ?? 0) / 2, fill: style.stroke, stroke: 'none' }));
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
  // Two or more nets between the same two blocks (either direction) cannot be
  // told apart unless named (label/unlabeled-parallel-nets): a net without a
  // label (and without printed pin labels at an end) is named from its
  // short_label or readable RTL signal and placed like a net label.
  const pinLabeled = (end) => end.element.pin_labels === true && showsDetails(ctx, end.element) && Boolean((end.element.ports || []).find((q) => q.id === end.pin?.id)?.label);
  const parallelGroups = new Map();
  for (const n of model.nets) {
    if (n.driver.error || n.sinks.length !== 1 || n.sinks[0].error) continue;
    const ends = [n.driver.element, n.sinks[0].element];
    // Only between opaque boxes: lanes into a register, mux, split or gate are told apart by the glyph.
    const opaque = (e) => ['instance', 'blackbox', 'memory'].includes(e.kind) || (e.kind === 'comb' && e.op === 'custom');
    if (!ends.every(opaque) || ends[0].id === ends[1].id) continue;
    const key = ends.map((e) => e.id).sort().join('|');
    if (!parallelGroups.has(key)) parallelGroups.set(key, []);
    parallelGroups.get(key).push(n);
  }
  const parallelNames = new Map();
  const inParallelGroup = new Set();
  for (const list of parallelGroups.values()) {
    if (list.length < 2) continue;
    for (const n of list) {
      inParallelGroup.add(n.net.id);
      if (n.net.label || pinLabeled(n.driver) || pinLabeled(n.sinks[0])) continue;
      const signal = n.net.rtl?.signal ?? n.net.rtl_unmapped?.rtl?.signal;
      const name = n.net.short_label ?? (signal ? readableIdentifier(signal) : null);
      if (name) parallelNames.set(n.net.id, name);
    }
  }
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
    // The continuation after an off-page connector carries the width labeled at the source tag.
    if (drv?.kind === 'port' && drv.connector === 'target') return false;
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
    // A bundle gets no summed width, unless the author declares it one data
    // word (net width_label: true), which is then labeled like any data net.
    const bundle = isBundleNet(n);
    if (width > 1 && (!bundle || n.net.width_label === true)) {
      const s = t.bus_slash;
      const q = s.length / 2 / Math.SQRT2;
      // A slash keeps clear of placed text by the 1 pt a width number keeps
      // from lines, plus half its stroke (geometry/text-on-line).
      const slashClear = 1 + t.stroke.wire / 2 + 0.05;
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
        // The slash may come within 0.25 pt of the arrowhead base (its thin diagonal never reaches the head).
        const hi = seg.len - q - (intoPin ? t.arrow.length + 0.25 : 0.5);
        // Preferred spots first, then a 1 pt sweep so a gap between a block
        // and a frame edge on a short wire is still found.
        const sweep = [];
        for (let o = lo; o <= hi + 1e-6; o += 1) sweep.push(o);
        const offsets = [afterSlice ? lo : s.offset, seg.len / 2, hi, ...sweep].filter((o, k, all) => o >= lo && o <= hi && all.indexOf(o) === k);
        for (const off of offsets) {
          if (seg.horizontal) {
            const cx = seg.a.x + dir * off;
            if (placer.hitsText({ x0: cx - q, y0: seg.a.y - q, x1: cx + q, y1: seg.a.y + q }, slashClear)) continue;
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
            if (placer.hitsText({ x0: seg.a.x - q, y0: cy - q, x1: seg.a.x + q, y1: cy + q }, slashClear)) continue;
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
    const autoName = parallelNames.get(n.net.id);
    if ((n.net.label || autoName) && !atConnector) {
      const lbl = n.net.label ? labelOf(ctx, n.net, n.net.id) : autoName;
      const lw = ctx.measure(lbl, S);
      const parallel = inParallelGroup.has(n.net.id);
      const candidates = [];
      for (const seg of segmentsOf(pl)) {
        if (!seg.horizontal || seg.len < lw + (parallel ? 2 : 4)) continue;
        const x0 = Math.min(seg.a.x, seg.b.x);
        const x1 = Math.max(seg.a.x, seg.b.x);
        // Parallel nets between two blocks also try right at the source pin and just before the sink's arrowhead.
        for (const x of [x0 + 2, (x0 + x1 - lw) / 2, x1 - lw - 2 - t.arrow.length, ...(parallel ? [x0 + 1, x1 - lw - 1 - t.arrow.length] : [])]) {
          candidates.push({ x, y: seg.a.y - 2.5 }, { x, y: seg.a.y + 2.5 + ctx.font.ascent * S });
        }
      }
      const spot = placeFor(n.net.id, lbl, S, candidates.filter((c) => ownAnchored(n.net.id, tbox(lbl, S, c.x, c.y))));
      // An author-allowed leader label, only when the name has no inline spot.
      const leader = !spot && ['leader', 'auto'].includes(n.net.label_placement) ? placeLeader(n.net.id, lbl, S, n.net.leader_max_pt ?? leaderMax) : null;
      if (spot) {
        children.push(text(ctx, lbl, spot.x, spot.y, 'secondary', `net-${n.net.id}-name`));
        placedNetLabels.push({ net: n.net.id, label: lbl, box: tbox(lbl, S, spot.x, spot.y) });
      } else if (leader) {
        children.push(el('path', { id: `net-${n.net.id}-leader`, d: pathD(leader.pts), fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire, 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter' }));
        children.push(text(ctx, lbl, leader.x, leader.y, 'secondary', `net-${n.net.id}-name`));
        placedNetLabels.push({ net: n.net.id, label: lbl, box: leader.box, leader: leader.pts });
        diagnostics.push({ code: 'label/leader-used', severity: 'info', message: `${variant}: the name '${lbl}' of ${n.net.id} has no room on its wire and is placed with a ${num(leader.len)} pt leader`, subject: { id: n.net.id, variant }, evidence: { length: num(leader.len), label: lbl }, supportedFixes: [] });
      }
      // A bundle is known only by its name (it has no width): the name may not disappear.
      // A bundle whose driver pin, or every sink pin, prints its pin label is named at its pins.
      else if (n.net.label && bundle && !(pinLabeled(n.driver) || (n.sinks.length && n.sinks.every(pinLabeled)))) diagnostics.push({ code: 'label/bundle-name-omitted', severity: variant === 'study' ? 'warning' : 'error', message: `${variant}: bundle ${n.net.id} has the name '${lbl}' but no free spot to print it; a bundle is read by its name`, subject: { id: n.net.id, variant }, evidence: { nets: [n.net.id], label: lbl, paper_error: true }, supportedFixes: ['give the bundle a shorter short_label', 'lengthen its wire (spacing, pin order)', 'increase the layer spacing for this variant'] });
      else if (n.net.label) diagnostics.push({ code: 'print/net-label-omitted', severity: 'warning', message: `${variant}: no free spot for net label '${lbl}' on ${n.net.id}`, subject: { id: n.net.id }, evidence: {}, supportedFixes: ['add short_label', 'use the 2col variant'] });
    }
  }
  // Parallel nets still unnamed after placement. The renderer knows the format
  // only through the variant: an error in paper variants, a warning in the
  // study variant (evidence.paper_error marks it for deliver and format).
  const namedNets = new Set(placedNetLabels.map((p) => p.net));
  for (const [key, list] of parallelGroups) {
    if (list.length < 2) continue;
    const unnamed = list.filter((n) => !namedNets.has(n.net.id) && !pinLabeled(n.driver) && !pinLabeled(n.sinks[0]));
    if (unnamed.length < 2) continue;
    const blocks = key.split('|');
    diagnostics.push({ code: 'label/unlabeled-parallel-nets', severity: variant === 'study' ? 'warning' : 'error', message: `${variant}: ${unnamed.length} of the ${list.length} nets between ${blocks[0]} and ${blocks[1]} carry no name (${unnamed.map((n) => n.net.id).join(', ')}); parallel wires between the same blocks cannot be told apart`, subject: { variant, blocks }, evidence: { nets: unnamed.map((n) => n.net.id), parallel: list.length, paper_error: true }, supportedFixes: ['label the nets (label or short_label)', 'map the nets to their RTL signals (rtl.signal) so the renderer can name them', 'bundle them into one named bus'] });
  }
  // Region frames are label obstacles too.
  for (const f of frames) placer.addPolyline([{ x: f.x0, y: f.y0 }, { x: f.x1, y: f.y0 }, { x: f.x1, y: f.y1 }, { x: f.x0, y: f.y1 }, { x: f.x0, y: f.y0 }], skin.symbols.region_frame.stroke);

  // Labels above symbols (pipeline stage names, long register names) are
  // placed after the wires so they cannot sit on one; they may overhang the
  // symbol, which keeps the bar from widening its layer.
  // The baseline sweeps upward in 0.5 pt steps from just above the symbol, so
  // a label still fits in a narrow band (e.g. between a bar and the top edge of
  // its region frame). A bar or register that has a label must print it:
  // an error in paper variants, a warning in study (print/stage-label-omitted).
  for (const o of overLabels) {
    const lw = ctx.measure(o.text, S);
    const cx = o.p.x + o.p.w / 2;
    const asc = ctx.font.ascent * S;
    const ys = [];
    for (let y = o.p.y - 1.5; y >= o.p.y - 4 - 2 * S; y -= 0.5) ys.push(y);
    const cands = ys.flatMap((y) => [cx - lw / 2, o.p.x, o.p.x + o.p.w - lw, cx - lw / 2 - 4, cx - lw / 2 + 4].map((x) => ({ x, y })));
    const spot = placer.place(o.text, S, cands.filter((c) => c.x >= 0 && c.x + lw <= W && c.y - asc >= 0));
    if (spot) o.children.push(text(ctx, o.text, spot.x, spot.y, 'secondary', `${o.gid}-label`));
    else diagnostics.push({ code: 'print/stage-label-omitted', severity: variant === 'study' ? 'warning' : 'error', message: `${variant}: no free spot above ${o.gid} for its label '${o.text}'; a pipeline stage or register label may not disappear`, subject: { id: o.gid, variant }, evidence: { label: o.text, paper_error: true }, supportedFixes: ['increase the layer spacing above the bar for this variant', 'move the wire or frame edge that runs just above the bar'] });
  }

  if (unlabeled.length) diagnostics.push({ code: 'print/width-label-omitted', severity: 'info', message: `${variant}: no room for a slash-N width label on control nets ${unlabeled.join(', ')}`, subject: { ids: unlabeled }, evidence: {}, supportedFixes: ['state the width in the caption'] });
  // Every multi-bit data net shows its width (CONVENTIONS §2.1).
  // A width carried straight through a pipeline lane is labeled once: when the
  // lane's other side shows the same width, this side is not missing it.
  const laneTwin = (id) => laneCarried(model.nets, id, widthLabeled);
  for (const { net, label, box, leader } of placedNetLabels) {
    // A leader label is anchored by its leader: the leader must start on its own net's wire.
    if (leader) {
      const own = drawn.find((d) => d.n.net.id === net);
      const onOwn = Boolean(own) && own.branches.some((br) => br.pts.slice(1).some((b, k) => pointSegDist(leader[0], br.pts[k], b) < 0.35));
      if (!onOwn) diagnostics.push({ code: 'label/ambiguous-anchor', severity: 'error', message: `${variant}: the leader of net label "${label}" of ${net} does not start on its own wire`, subject: { id: net, variant }, evidence: { reason: 'leader-off-wire', at: { x: num(leader[0].x), y: num(leader[0].y) } }, supportedFixes: ['report a renderer bug: leaders start on their own wire'] });
      continue;
    }
    const g = anchorGap(net, box);
    const problem = netLabelAnchorProblem(g, box, labelBlockRects, { maxDistance: maxLabelDistance });
    if (!problem) continue;
    const why = problem.reason === 'foreign-wire' ? `is ${num(g.own)} pt from its own wire but ${num(g.foreign)} pt from net ${g.other}; a reader would attach it to the wrong net`
      : problem.reason === 'far-from-wire' ? `is ${num(g.own)} pt from its own wire, more than ${num(maxLabelDistance)} pt (skin net_label.max_wire_distance_pt); it floats`
        : `is ${num(problem.block_distance)} pt from the outline of ${problem.block} but ${num(g.own)} pt from its own wire; it reads as that block's output`;
    diagnostics.push({ code: 'label/ambiguous-anchor', severity: 'error', message: `${variant}: net label "${label}" of ${net} ${why}`, subject: { id: net, variant }, evidence: { own: num(g.own), foreign: num(g.foreign), other: g.other, reason: problem.reason, ...(problem.block ? { block: problem.block, block_distance: num(problem.block_distance) } : {}) }, supportedFixes: ['move the label onto its own wire segment', 'give the nets more vertical separation'] });
  }
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
    ...(stageRows.length ? [el('g', { id: 'stage-table' }, [
      text(ctx, stageTableTitle, 4, stageTableTop + 2 + 0.5 * (S + 2) + ctx.base(S), 'secondary', 'stage-table-title'),
      ...stageColumns.flatMap((col, c) => col.map((l, i) => text(ctx, l, 4 + stageColumnW.slice(0, c).reduce((a, b) => a + b, 0), stageTableTop + 2 + (i + 1.5) * (S + 2) + ctx.base(S), 'secondary', `stage-table-row${c}-${i}`))),
    ])] : []),
  ]);

  const frameList = frames.map((f) => ({ ...f, members: tree.all.find((x) => x.id === f.id).inside }));
  const nodeList = [...pos].map(([id, r]) => ({ id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
  diagnostics.push(...geometryChecks(svgTree, { font: ctx.font, polygons, frames: frameList, nodes: nodeList, frameGap: rt.frame_gap_pt ?? 6 }));
  // Nets enter a region frame through the side facing their source, clear of
  // corners and of the frame label (region/entry-side).
  const regionLabel = (id) => tree.all.find((x) => x.id === id)?.label;
  const entryFrames = frameList.map((f) => {
    const lbl = regionLabel(f.id);
    return { ...f, labelH: lbl ? ctx.t.font.secondary_pt + 6 : 0, labelW: lbl ? ctx.measure(lbl, ctx.t.font.secondary_pt) : 0 };
  });
  const entries = [];
  for (const d of drawn) {
    if (d.n.driver.error) continue;
    for (const br of d.branches) {
      if (!br.sink) continue;
      for (const f of frameList) {
        const members = new Set(f.members || []);
        if (members.has(br.sink.element.id) && !members.has(d.n.driver.element.id)) entries.push({ net: d.n.net.id, region: f.id, pts: br.pts });
      }
    }
  }
  diagnostics.push(...frameEntryChecks(entryFrames, entries, { frameGap: rt.frame_gap_pt ?? 6 }).map((x) => ({ ...x, message: `${variant}: ${x.message}`, subject: { ...x.subject, variant } })));

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
  const TEXT_BOXES = new Set(['labeled-block', 'port-label', 'const-box', 'concat-box', 'extend-box', 'replicate-box', 'memory-block', 'synchronizer']);
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
  // Control (dashed) wires follow the same rule: a step shorter than a row between two runs in one direction is redundant.
  const controlJogs = dataJogs(routeNets, { minOffsetPt: rt.jog_min_offset_pt, classes: ['control'] });
  for (const j of controlJogs.jogs.filter((x) => x.kind === 'redundant')) {
    diagnostics.push({ code: 'route/control-jog', severity: 'error', message: `${variant}: control net ${j.net} has a redundant ${num(j.offset)} pt level change at (${num(j.at.x)}, ${num(j.at.y)})`, subject: { id: j.net, variant }, evidence: j, supportedFixes: ['line the port or pin up with the pin it drives', 'reorder ports so the control wires run straight'] });
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
  // Loop/connector consistency on the final routes: a returning branch routed
  // longer than ratio × the width, or any branch whose route exceeds its
  // straight distance by more than that (a wrap-around), must be a connector
  // pair, not a loop around the figure.
  // Blocks fewer than route.connector_min_layers drawn layers apart keep their
  // return as a wire (longFeedback), so their route is not a long loop.
  const partBack = part.backEdges || new Set();
  const drawnLayers = blockLayers([...pos].filter(([id]) => !symbols.get(id).isPort).map(([id, r]) => ({ id, x: r.x, w: r.w })));
  for (const d of drawn) {
    d.branches.forEach(({ pts, sink }) => {
      if (!sink || sink.element.connector || d.n.driver.error || d.n.driver.element.connector) return;
      if (layerGap(drawnLayers, d.n.driver.element.id, sink.element.id) < (connectorMinLayers ?? rt.connector_min_layers ?? 2)) return;
      const r = polylineDetour(pts);
      const back = partBack.has(`${d.n.driver.element.id}>${sink.element.id}`);
      const limit = feedbackRatio * run.contentW;
      if (back && r.length > limit) diagnostics.push({ code: 'route/long-feedback', severity: 'error', message: `${variant}: net ${d.n.net.id} returns to ${sink.element.id} over a ${num(r.length)} pt route (more than ${feedbackRatio * 100}% of the figure width) as a loop`, subject: { id: d.n.net.id, variant }, evidence: { length: num(r.length), ratio: feedbackRatio, sink: `${sink.element.id}.${sink.pin.id}` }, supportedFixes: ['draw it with named connectors (meta.style.connectors, default on)', 'reorder the blocks so the net runs forward'] });
      else if (!back && r.detour > limit) diagnostics.push({ code: 'route/long-loop', severity: 'error', message: `${variant}: net ${d.n.net.id} wraps around the figure to ${sink.element.id}: its route is ${num(r.detour)} pt longer than the direct distance (more than ${feedbackRatio * 100}% of the width)`, subject: { id: d.n.net.id, variant }, evidence: { detour: num(r.detour), ratio: feedbackRatio, sink: `${sink.element.id}.${sink.pin.id}` }, supportedFixes: ['draw it with named connectors (meta.style.connectors, default on)', 'reorder the blocks or pins so the net runs directly'] });
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
  const connectivity = connectivityChecks(svgText, { anchors, lanePairs, variant, dotArrowClearance: rt.dot_arrow_clearance ?? 8, collinearGap: rt.collinear_gap_pt ?? 1.5, wireStroke: t.stroke.wire, arrow: { length: t.arrow.length, width: t.arrow.width } });
  diagnostics.push(...connectivity.diagnostics);
  route.connectivity = connectivity.counts;
  // Every tag and port glyph has a wire (connector/orphan-tag, on the final
  // SVG); a figure input nothing reads is reported, and a port declared
  // off_page in the IR is a deliberate single-ended reference.
  const glyphs = [...model.elements.values()].filter(({ el: e }) => e.kind === 'port' && pos.has(e.id)).map(({ el: e }) => ({ ...pos.get(e.id), el: e }));
  for (const g of orphanTags(svgText, glyphs, { tolerance: t.arrow.length + 2 })) {
    if (g.el.off_page) continue;
    const drives = model.nets.some((n) => !n.driver.error && n.driver.element.id === g.el.id);
    if (g.el.dir === 'in' && !g.el.connector && !drives) diagnostics.push({ code: 'port/no-sink', severity: 'warning', message: `${variant}: figure input ${g.el.id} ("${g.el.label ?? g.el.id}") drives nothing in the figure`, subject: { variant, id: g.el.id }, evidence: {}, supportedFixes: ['remove the port', 'connect it to the element that reads it', 'declare off_page: true for a deliberate reference'] });
    else diagnostics.push({ code: 'connector/orphan-tag', severity: 'error', message: `${variant}: ${g.el.connector ? 'connector tag' : 'port'} ${g.el.id} ("${g.el.label ?? g.el.id}") has no wire attached`, subject: { variant, id: g.el.id }, evidence: { box: { x: g.x, y: g.y, w: g.w, h: g.h } }, supportedFixes: ['connect the port', 'declare off_page: true for a deliberate single-ended reference'] });
  }
  if (ctx.stageTable.length) route.stage_notes = [...new Map(ctx.stageTable.map((r) => [`${r.element}|${r.pin}`, r])).values()];
  // Readability (receipt route.readability): crossings per net and routed
  // length over direct distance; a study figure warns above the skin thresholds.
  route.readability = readabilityFromSvg(svgText);
  const readable = rt.readability ?? {};
  const limits = { max_crossings_per_net: readable.max_crossings_per_net ?? 1, max_wire_length_ratio: readable.max_wire_length_ratio ?? 1.6 };
  if (variant === 'study' && (route.readability.crossings_per_net > limits.max_crossings_per_net || route.readability.wire_length_ratio > limits.max_wire_length_ratio)) diagnostics.push({ code: 'route/readability', severity: 'warning', message: `${variant}: ${route.readability.crossings_per_net} crossings per net (limit ${limits.max_crossings_per_net}) and wires ${route.readability.wire_length_ratio}× their direct distance (limit ${limits.max_wire_length_ratio}); the figure is hard to follow`, subject: { variant }, evidence: { ...route.readability, ...limits }, supportedFixes: ['narrow the scope or lower the depth', 'draft one instance at a time and link them with detail_ref'] });

  const metrics = printMetrics(svgTree);
  if (metrics.minFont < minFontPt) diagnostics.push({ code: 'print/min-font', severity: 'error', message: `${variant}: ${metrics.minFont} pt text is below ${minFontPt} pt`, subject: { variant }, evidence: {}, supportedFixes: ['raise the skin font size'] });
  if (metrics.minStroke < minStrokePt) diagnostics.push({ code: 'print/min-stroke', severity: 'error', message: `${variant}: ${metrics.minStroke} pt stroke is below ${minStrokePt} pt`, subject: { variant }, evidence: {}, supportedFixes: ['raise the skin stroke width'] });
  if (maxHeightPt && H > maxHeightPt) diagnostics.push({ code: 'print/max-height', severity: 'error', message: `${variant}: height ${num(H)} pt exceeds ${num(maxHeightPt)} pt (${num(H - maxHeightPt)} pt over; height set by ${describeHeight(sizeReport(run))})`, subject: { variant }, evidence: { height: H, max: maxHeightPt, over: H - maxHeightPt, size_report: sizeReport(run) }, supportedFixes: ['collapse more hardware into blocks whose rtl.covers name it (never drop hardware)', 'raise meta.print.max_height_in up to the profile maximum', 'narrow meta.scope explicitly or split into sub-figures (a)/(b) linked with detail_ref'] });

  return {
    svg: svgText,
    width_pt: W,
    height_pt: H,
    content_width_pt: run.contentW,
    // What sets the size (G7, --why-size).
    size_report: sizeReport(run),
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
