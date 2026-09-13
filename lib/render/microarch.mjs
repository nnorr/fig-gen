// Micro-architecture / SoC renderer (SPEC §7, CONVENTIONS §11).
// Deterministic row/bus layout: managers above their fabric bar,
// subordinates below, bridges chain fabrics downward, off-chip blocks in a
// row above the chip. Attachments are straight vertical drops with the
// arrowhead away from the manager. Links run in inter-row channels and a
// right-hand gutter inside the chip, so they never cross a block. Domain
// boundaries are drawn only where they discriminate (not for a single
// all-covering domain or an always-on domain) and are named in a legend.
// Monochrome, figma-safe.

import { formatHex, parseHex } from '../checks/memory-map.mjs';
import { el, num, pathD, printMetrics, serialize } from '../svg.mjs';
import { arrowHead, labelOf, loadSkin, outlineW, renderContext, text } from './datapath.mjs';
import { geometryChecks } from './geometry.mjs';
import { LabelPlacer } from './labels.mjs';

const LINK_STYLE = {
  data: { width: 'wire', dash: null, arrow: 'filled', legend: 'data' },
  control: { width: 'control', dash: [2, 1.5], arrow: 'filled', legend: 'control' },
  interrupt: { width: 'wire', dash: [0.8, 1.2], arrow: 'filled', legend: 'interrupt' },
  dma: { width: 1.4, dash: null, arrow: 'double', legend: 'DMA' },
  sideband: { width: 'wire', dash: [3, 1.5], arrow: 'filled', legend: 'sideband' },
  clock: { width: 'wire', dash: null, arrow: 'none', legend: 'clock' },
  reset: { width: 'wire', dash: [0.8, 1.2], arrow: 'none', legend: 'reset' },
  power: { width: 'wire', dash: [3, 1, 1, 1], arrow: 'none', legend: 'power' },
};
const DOMAIN_DASH = { clock: [6, 2], reset: [4, 1, 1, 1, 1, 1], power: [5, 2, 1, 2] };
const GROUP_DASH = [3, 2];

function assignRows(doc) {
  const attachments = doc.attachments || [];
  const blocks = doc.blocks || [];
  const downstream = new Map();
  for (const b of blocks.filter((x) => x.kind === 'bridge')) {
    const up = attachments.find((a) => a.block === b.id && a.role === 'subordinate')?.fabric;
    for (const a of attachments.filter((x) => x.block === b.id && x.role === 'manager')) if (up) downstream.set(a.fabric, up);
  }
  const level = new Map();
  const levelOf = (f, depth = 0) => {
    if (level.has(f)) return level.get(f);
    const l = downstream.has(f) && depth < 16 ? levelOf(downstream.get(f), depth + 1) + 1 : 0;
    level.set(f, l);
    return l;
  };
  const shift = blocks.some((b) => b.kind === 'offchip') ? 1 : 0;
  const fabricRow = new Map((doc.fabrics || []).map((f) => [f.id, 2 * levelOf(f.id) + 1 + shift]));
  const blockRow = new Map();
  for (const b of blocks) {
    const mine = attachments.filter((a) => a.block === b.id);
    const subs = mine.filter((a) => a.role === 'subordinate').map((a) => fabricRow.get(a.fabric) + 1);
    const mgrs = mine.filter((a) => a.role === 'manager').map((a) => fabricRow.get(a.fabric) - 1);
    if (b.kind === 'offchip') blockRow.set(b.id, 0);
    else if (subs.length) blockRow.set(b.id, Math.max(...subs));
    else if (mgrs.length) blockRow.set(b.id, Math.min(...mgrs));
  }
  for (const b of blocks.filter((x) => !blockRow.has(x.id))) {
    const linked = (doc.links || []).filter((l) => l.from === b.id || l.to === b.id).map((l) => blockRow.get(l.from === b.id ? l.to : l.from)).filter((r) => r !== undefined && r >= shift);
    blockRow.set(b.id, linked.length ? Math.min(...linked) : shift);
  }
  return { fabricRow, blockRow };
}

// Domains worth drawing: not always-on, not covering every on-chip block,
// and not the only domain of their kind.
export function drawnDomains(doc) {
  const onChip = doc.blocks.filter((b) => b.kind !== 'offchip').map((b) => b.id);
  const domains = doc.domains || [];
  return domains.filter((d) => {
    if (d.always_on) return false;
    if (onChip.every((id) => d.members.includes(id))) return false;
    return domains.filter((x) => x.kind === d.kind).length > 1 || d.members.length < onChip.length;
  });
}

function blockLines(ctx, doc, b) {
  const at = (doc.attachments || []).find((a) => a.block === b.id && a.role === 'subordinate' && a.address);
  let address;
  if (at) {
    const base = parseHex(at.address.base);
    const last = at.address.size ? base + parseHex(at.address.size) - 1n : parseHex(at.address.end);
    address = ctx.mode === 'short' ? formatHex(base) : `${formatHex(base)}–${formatHex(last)}`;
  }
  return { title: labelOf(ctx, b, b.id), sub: b.sublabel, address };
}

function layout(doc, skin, variant, mode) {
  const ctx = renderContext(doc, skin, variant, mode);
  const t = ctx.t;
  const L = t.font.label_pt;
  const S = t.font.secondary_pt;
  const blocks = doc.blocks;
  const links = doc.links || [];
  const attachments = doc.attachments || [];
  const diagnostics = [];
  const { fabricRow, blockRow } = assignRows(doc);
  const domainsDrawn = drawnDomains(doc);

  const size = new Map();
  for (const b of blocks) {
    const lines = blockLines(ctx, doc, b);
    const w = Math.max(34, ctx.measure(lines.title, L), lines.sub ? ctx.measure(lines.sub, S) : 0, lines.address ? ctx.measure(lines.address, S) : 0) + 10;
    const h = 8 + L + (lines.sub ? S + 2.5 : 0) + (lines.address ? S + 2.5 : 0);
    size.set(b.id, { w, h, rep: b.replicate ? 6 : 0, lines });
  }
  const rowCount = Math.max(...[...blockRow.values(), ...fabricRow.values()]) + 1;
  const rowBlocks = Array.from({ length: rowCount }, () => []);
  for (const b of blocks) rowBlocks[blockRow.get(b.id)].push(b);
  const rowFabric = Array.from({ length: rowCount }, () => null);
  for (const [f, r] of fabricRow) {
    if (rowFabric[r] || rowBlocks[r].length) diagnostics.push({ code: 'render/row-conflict', severity: 'error', message: `fabric ${f} shares layout row ${r} with other content`, subject: { id: f }, evidence: {}, supportedFixes: ['connect independent fabrics through a bridge', 'split the figure'] });
    rowFabric[r] = f;
  }

  const gapX = 12;
  const rowWidth = rowBlocks.map((list) => list.reduce((a, b) => a + size.get(b.id).w + size.get(b.id).rep, 0) + gapX * Math.max(0, list.length - 1));
  const fabricLabel = new Map((doc.fabrics || []).map((f) => [f.id, labelOf(ctx, { ...f, label: f.label ?? f.protocol }, f.protocol)]));
  const innerW = Math.max(...rowWidth, ...[...fabricLabel.values()].map((l) => ctx.measure(l, S) + 40));
  const hasChip = (doc.groups || []).length > 0;
  const pad = 4 + domainsDrawn.length * 3 + (hasChip ? 5 : 0);

  const gapSlots = Array.from({ length: rowCount + 1 }, () => 0);
  const plans = links.map((l) => {
    const rs = blockRow.get(l.from);
    const rt = blockRow.get(l.to);
    if (rs === rt) {
      const g = rs + 1;
      const slot = gapSlots[g]++;
      return { l, rs, rt, exitGap: g, entryGap: g, exitSlot: slot, entrySlot: slot, gutter: false };
    }
    const exitGap = rt > rs ? rs + 1 : rs;
    const entryGap = rt > rs ? rt : rt + 1;
    const exitSlot = gapSlots[exitGap]++;
    const entrySlot = gapSlots[entryGap]++;
    return { l, rs, rt, exitGap, entryGap, exitSlot, entrySlot, gutter: true };
  });
  const gutterLinks = plans.filter((p) => p.gutter);
  gutterLinks.forEach((p, k) => { p.gutterIndex = k; });
  const channel = 5.5;
  const gutterW = gutterLinks.length ? 4 + gutterLinks.length * channel : 0;
  const chipLabelH = hasChip ? S + 4 : 0;

  const rowTop = [];
  const rowH = [];
  const gapTop = [];
  let y = pad + chipLabelH;
  gapTop[0] = y;
  y += gapSlots[0] ? 3 + gapSlots[0] * channel : 0;
  for (let r = 0; r < rowCount; r += 1) {
    if (r > 0) {
      gapTop[r] = y;
      y += 9 + gapSlots[r] * channel;
    }
    rowTop[r] = y;
    rowH[r] = rowFabric[r] ? 10 : Math.max(0, ...rowBlocks[r].map((b) => size.get(b.id).h + size.get(b.id).rep));
    y += rowH[r];
  }
  gapTop[rowCount] = y;
  y += gapSlots[rowCount] ? 3 + gapSlots[rowCount] * channel : 0;
  const contentBottom = y + pad;

  const left = pad;
  const pos = new Map();
  for (let r = 0; r < rowCount; r += 1) {
    let x = left + (innerW - rowWidth[r]) / 2;
    for (const b of rowBlocks[r]) {
      const s = size.get(b.id);
      pos.set(b.id, { x, y: rowTop[r] + (rowH[r] - s.h - s.rep), w: s.w, h: s.h, rep: s.rep, row: r });
      x += s.w + s.rep + gapX;
    }
  }
  const center = (id) => { const p = pos.get(id); return { cx: p.x + p.w / 2, top: p.y + p.rep, bottom: p.y + p.rep + p.h }; };

  const bars = new Map();
  for (const f of doc.fabrics || []) {
    const r = fabricRow.get(f.id);
    const xs = attachments.filter((a) => a.fabric === f.id).map((a) => center(a.block).cx);
    const labelW = ctx.measure(fabricLabel.get(f.id), S) + 10;
    let x0 = Math.min(...xs, left + innerW / 2) - 16;
    let x1 = Math.max(...xs, left + innerW / 2) + 16;
    if (x1 - x0 < labelW + 20) x1 = x0 + labelW + 20;
    x0 = Math.max(x0, left - 2);
    bars.set(f.id, { x0, x1, y0: rowTop[r], y1: rowTop[r] + 10 });
  }

  const used = new Map();
  const offsetFor = (id) => {
    const k = used.get(id) ?? 0;
    used.set(id, k + 1);
    const step = Math.min(7, pos.get(id).w / 6);
    return (k % 2 === 0 ? 1 : -1) * step * (Math.floor(k / 2) + 1);
  };
  const gutterRight = left + innerW + 4;
  const gutterX = (k) => gutterRight + 2 + k * channel;
  const chanY = (g, slot) => gapTop[g] + (g === 0 ? 3 : 4.5) + slot * channel;
  const routes = plans.map((p) => {
    const s = center(p.l.from);
    const d = center(p.l.to);
    const sx = s.cx + offsetFor(p.l.from);
    const tx = d.cx + offsetFor(p.l.to);
    if (!p.gutter) {
      const yc = chanY(p.exitGap, p.exitSlot);
      return { plan: p, pts: [{ x: sx, y: s.bottom }, { x: sx, y: yc }, { x: tx, y: yc }, { x: tx, y: d.bottom }] };
    }
    const down = p.rt > p.rs;
    const yExit = chanY(p.exitGap, p.exitSlot);
    const yEntry = chanY(p.entryGap, p.entrySlot);
    const xg = gutterX(p.gutterIndex);
    // A link must not enter through the edge that already carries the
    // block's bus attachment arrow: when that edge is taken and the block is
    // the rightmost in its row, enter from its east side on a pin of its own.
    const tp = pos.get(p.l.to);
    const entryEdgeTaken = attachments.some((a) => a.block === p.l.to && ((a.role === 'manager') === !down));
    const rightmost = rowBlocks[tp.row][rowBlocks[tp.row].length - 1]?.id === p.l.to;
    if (entryEdgeTaken && rightmost) {
      const ym = tp.y + tp.rep + tp.h / 2;
      return { plan: p, sideEntry: true, pts: [{ x: sx, y: down ? s.bottom : s.top }, { x: sx, y: yExit }, { x: xg, y: yExit }, { x: xg, y: ym }, { x: tp.x + tp.w, y: ym }] };
    }
    return { plan: p, pts: [{ x: sx, y: down ? s.bottom : s.top }, { x: sx, y: yExit }, { x: xg, y: yExit }, { x: xg, y: yEntry }, { x: tx, y: yEntry }, { x: tx, y: down ? d.top : d.bottom }] };
  });

  const contentW = left + innerW + 4 + gutterW + pad;
  const legendItems = [];
  for (const d of domainsDrawn) legendItems.push({ label: `${d.kind} domain: ${d.label ?? d.id}`, dash: DOMAIN_DASH[d.kind], width: 0.6, id: `domain-${d.id}` });
  const classes = [...new Set(links.map((l) => l.class))];
  if (classes.length > 1 || classes.some((c) => c !== 'data')) {
    for (const c of classes) {
      const ls = LINK_STYLE[c];
      legendItems.push({ label: ls.legend, dash: ls.dash, width: typeof ls.width === 'number' ? ls.width : t.stroke[ls.width], id: `class-${c}` });
    }
  }
  const legendRows = [];
  let lineW = 0;
  for (const item of legendItems) {
    const w = 18 + ctx.measure(item.label, S) + 12;
    if (!legendRows.length || lineW + w > contentW - 2 * pad) { legendRows.push([]); lineW = 0; }
    legendRows[legendRows.length - 1].push({ ...item, x: pad + lineW, w });
    lineW += w;
  }
  const legendTop = contentBottom + 2;
  const H = legendTop + legendRows.length * (S + 4) + (legendRows.length ? 2 : 0);

  return { ctx, diagnostics, pos, size, bars, routes, fabricLabel, rowBlocks, legendRows, legendTop, contentW, H, pad, chipLabelH, gutterRight, gutterW, domainsDrawn };
}

export async function renderMicroarch(doc, { variant = '2col', widthPt, maxHeightPt, minFontPt = 6, minStrokePt = 0.5, name = 'figure', skin } = {}) {
  skin = skin ?? loadSkin(doc.meta?.style?.skin);
  let lay = layout(doc, skin, variant, 'full');
  let labels = 'full';
  if (widthPt && lay.contentW > widthPt) {
    lay = layout(doc, skin, variant, 'short');
    labels = 'short';
  }
  const { ctx, pos, size, bars, routes, fabricLabel, legendRows, legendTop, contentW, H, chipLabelH, gutterRight, gutterW, domainsDrawn } = lay;
  const diagnostics = [...lay.diagnostics];
  const t = ctx.t;
  const L = t.font.label_pt;
  const S = t.font.secondary_pt;
  if (labels === 'short') diagnostics.push({ code: 'print/label-fallback', severity: 'info', message: `${variant}: short labels used to fit ${widthPt} pt`, subject: { variant }, evidence: {}, supportedFixes: [] });
  if (widthPt && contentW > widthPt + 0.01) diagnostics.push({ code: 'print/width-overflow', severity: 'error', message: `${variant}: content ${num(contentW)} pt exceeds column ${num(widthPt)} pt`, subject: { variant }, evidence: {}, supportedFixes: ['add short_label to wide blocks', 'drop this variant for this figure'] });
  const W = Math.max(widthPt ?? contentW, contentW);
  const ox = Math.max(0, (W - contentW) / 2);
  const X = (x) => x + ox;
  const placer = new LabelPlacer(ctx.font);

  const blockGroups = doc.blocks.map((b) => {
    const p = pos.get(b.id);
    const { lines } = size.get(b.id);
    const fillKey = b.kind === 'memory' ? 'storage' : b.kind === 'offchip' ? 'offchip' : 'logic';
    const x = X(p.x);
    const y = p.y + p.rep;
    const children = [];
    if (p.rep) {
      children.push(el('rect', { id: `block-${b.id}-stack2`, x: x + 6, y: p.y, width: p.w, height: p.h, fill: t.fill[fillKey], stroke: t.ink, 'stroke-width': outlineW(t, b.kind) }));
      children.push(el('rect', { id: `block-${b.id}-stack1`, x: x + 3, y: p.y + 3, width: p.w, height: p.h, fill: t.fill[fillKey], stroke: t.ink, 'stroke-width': outlineW(t, b.kind) }));
    }
    children.push(el('rect', { id: `block-${b.id}-body`, x, y, width: p.w, height: p.h, fill: t.fill[fillKey], stroke: t.ink, 'stroke-width': b.emphasis ? 1.4 : outlineW(t, b.kind) }));
    if (b.kind === 'memory') children.push(el('path', { d: `M${num(x + 2.5)} ${num(y)} L${num(x + 2.5)} ${num(y + p.h)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }));
    let cy = y + 4 + ctx.font.ascent * L;
    const centered = (s, sz) => x + (p.w - ctx.measure(s, sz)) / 2;
    children.push(text(ctx, lines.title, centered(lines.title, L), cy, 'label', `block-${b.id}-title`));
    if (lines.sub) { cy += S + 2.5; children.push(text(ctx, lines.sub, centered(lines.sub, S), cy, 'secondary', `block-${b.id}-sub`)); }
    if (lines.address) { cy += S + 2.5; children.push(text(ctx, lines.address, centered(lines.address, S), cy, 'secondary', `block-${b.id}-addr`)); }
    if (b.replicate) {
      const label = `×${b.replicate.count}`;
      children.push(text(ctx, label, x + p.w - ctx.measure(label, S) - 2, y + p.h - 2.5, 'secondary', `block-${b.id}-count`));
    }
    placer.addRect({ x0: x, y0: p.y, x1: x + p.w + p.rep, y1: p.y + p.h + p.rep });
    return el('g', { id: `block-${b.id}` }, children);
  });

  const fabricGroups = (doc.fabrics || []).map((f) => {
    const bar = bars.get(f.id);
    placer.addRect({ x0: X(bar.x0), y0: bar.y0, x1: X(bar.x1), y1: bar.y1 });
    return el('g', { id: `fabric-${f.id}` }, [
      el('rect', { id: `fabric-${f.id}-body`, x: X(bar.x0), y: bar.y0, width: bar.x1 - bar.x0, height: bar.y1 - bar.y0, fill: t.fill.bar, stroke: 'none' }),
      text(ctx, fabricLabel.get(f.id), X(bar.x0) + 4, bar.y0 + 5 + ctx.base(S), 'secondary', `fabric-${f.id}-label`),
    ]);
  });

  const attachmentGroups = (doc.attachments || []).map((a) => {
    const p = pos.get(a.block);
    const bar = bars.get(a.fabric);
    const cx = X(p.x + p.w / 2);
    const manager = a.role === 'manager';
    const from = manager ? { x: cx, y: p.y + p.rep + p.h } : { x: cx, y: bar.y1 };
    const to = manager ? { x: cx, y: bar.y0 } : { x: cx, y: p.y + p.rep };
    const dir = Math.sign(to.y - from.y) || 1;
    placer.addPolyline([from, to], t.stroke.wire);
    return el('g', { id: `att-${a.id}` }, [
      el('path', { id: `att-${a.id}-seg0`, d: pathD([from, { x: to.x, y: to.y - dir * t.arrow.length }]), fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }),
      arrowHead(t, `att-${a.id}-arrow`, to, 0, dir, t.ink),
    ]);
  });
  // Arrowheads and the last stretch of each attachment arrow are label obstacles.
  for (const a of doc.attachments || []) {
    const p = pos.get(a.block);
    const bar = bars.get(a.fabric);
    const cx = X(p.x + p.w / 2);
    const tipY = a.role === 'manager' ? bar.y0 : p.y + p.rep;
    placer.addRect({ x0: cx - t.arrow.width / 2 - 1.5, x1: cx + t.arrow.width / 2 + 1.5, y0: tipY - 9.5, y1: tipY + 9.5 });
  }

  const linkGroups = [];
  const linkLabels = [];
  for (const { plan, pts: raw } of routes) {
    const l = plan.l;
    const pts = raw.map((q) => ({ x: X(q.x), y: q.y }));
    const ls = LINK_STYLE[l.class];
    const strokeW = typeof ls.width === 'number' ? ls.width : t.stroke[ls.width];
    const style = { fill: 'none', stroke: t.ink, 'stroke-width': strokeW, 'stroke-linejoin': 'miter', ...(ls.dash ? { 'stroke-dasharray': ls.dash.join(' ') } : {}) };
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const len = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
    const ux = (last.x - prev.x) / len;
    const uy = (last.y - prev.y) / len;
    const draw = pts.map((q) => ({ ...q }));
    const children = [];
    if (ls.arrow !== 'none') {
      const back = ls.arrow === 'open' ? 0 : ls.arrow === 'double' ? t.arrow.length * 1.8 : t.arrow.length;
      draw[draw.length - 1] = { x: last.x - ux * back, y: last.y - uy * back };
      children.push(arrowHead(t, `link-${l.id}-arrow`, last, ux, uy, t.ink, { open: ls.arrow === 'open' }));
      if (ls.arrow === 'double') children.push(arrowHead(t, `link-${l.id}-arrow2`, { x: last.x - ux * t.arrow.length * 0.9, y: last.y - uy * t.arrow.length * 0.9 }, ux, uy, t.ink));
    }
    children.unshift(el('path', { id: `link-${l.id}-seg0`, d: pathD(draw), ...style }));
    placer.addPolyline(pts, strokeW);
    if (ls.arrow !== 'none') placer.addRect({ x0: Math.min(last.x, last.x - ux * 9) - 3, x1: Math.max(last.x, last.x - ux * 9) + 3, y0: Math.min(last.y, last.y - uy * 9) - 3, y1: Math.max(last.y, last.y - uy * 9) + 3 });
    linkGroups.push({ l, children, pts });
    const label = l.irq !== undefined ? `${labelOf(ctx, l, 'irq')} ${l.irq}` : (l.label ? labelOf(ctx, l, l.label) : null);
    if (label) linkLabels.push({ l, label, pts });
  }

  // boundaries before labels, so labels avoid the outlines too
  const boundaryGroups = [];
  const runs = (members) => {
    const set = new Set(members);
    const out = [];
    for (const row of lay.rowBlocks) {
      let cur = [];
      for (const b of row) {
        if (set.has(b.id)) cur.push(b.id);
        else if (cur.length) { out.push(cur); cur = []; }
      }
      if (cur.length) out.push(cur);
    }
    return out;
  };
  const boxFor = (ids, padBox) => {
    const ps = ids.map((id) => pos.get(id));
    return { x0: X(Math.min(...ps.map((p) => p.x))) - padBox, y0: Math.min(...ps.map((p) => p.y)) - padBox, x1: X(Math.max(...ps.map((p) => p.x + p.w + p.rep))) + padBox, y1: Math.max(...ps.map((p) => p.y + p.h + p.rep)) + padBox };
  };
  const outline = (box, attrs) => {
    placer.addPolyline([{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 }, { x: box.x0, y: box.y0 }], 0.6);
    return el('rect', { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0, fill: 'none', stroke: t.ink, ...attrs });
  };
  const domainBoxes = new Map();
  domainsDrawn.forEach((d, i) => {
    const boxes = runs(d.members).map((ids) => boxFor(ids, 3 + 3 * i));
    domainBoxes.set(d.id, boxes);
    boundaryGroups.push(el('g', { id: `domain-${d.id}` }, boxes.map((box, k) => ({ ...outline(box, { rx: 2, 'stroke-width': 0.6, 'stroke-dasharray': DOMAIN_DASH[d.kind].join(' ') }), attrs: { id: `domain-${d.id}-outline${k}`, ...outline(box, { rx: 2, 'stroke-width': 0.6, 'stroke-dasharray': DOMAIN_DASH[d.kind].join(' ') }).attrs } }))));
  });
  for (const g of doc.groups || []) {
    const memberSet = new Set(g.members);
    const clean = doc.blocks.every((b) => memberSet.has(b.id) || b.kind === 'offchip');
    const chipPad = 5 + 3 * domainsDrawn.length;
    let boxes;
    if (clean) {
      const ps = g.members.map((id) => pos.get(id));
      const barsIn = (doc.fabrics || []).filter((f) => (doc.attachments || []).filter((a) => a.fabric === f.id).every((a) => memberSet.has(a.block))).map((f) => bars.get(f.id));
      const gutterLinksInside = routes.some((r) => r.plan.gutter && memberSet.has(r.plan.l.from) && memberSet.has(r.plan.l.to));
      boxes = [{
        x0: X(Math.min(...ps.map((p) => p.x), ...barsIn.map((b) => b.x0))) - chipPad,
        y0: Math.min(...ps.map((p) => p.y)) - chipPad - chipLabelH,
        x1: Math.max(X(Math.max(...ps.map((p) => p.x + p.w + p.rep), ...barsIn.map((b) => b.x1))) + chipPad, gutterLinksInside ? X(gutterRight + gutterW) + 2 : 0),
        y1: Math.max(...ps.map((p) => p.y + p.h + p.rep)) + chipPad,
      }];
    } else {
      boxes = runs(g.members).map((ids) => boxFor(ids, chipPad));
    }
    const children = boxes.map((box, k) => { const r = outline(box, { rx: 3, 'stroke-width': 0.6, 'stroke-dasharray': GROUP_DASH.join(' ') }); r.attrs = { id: `group-${g.id}-outline${k}`, ...r.attrs }; return r; });
    if (g.label) {
      const lx = boxes[0].x0 + 3;
      const ly = boxes[0].y0 + S + 1.5;
      children.push(text(ctx, g.label, lx, ly, 'secondary', `group-${g.id}-label`));
      placer.addRect(placer.box(g.label, S, lx, ly));
    }
    boundaryGroups.push(el('g', { id: `group-${g.id}` }, children));
    for (const b of doc.blocks.filter((x) => x.kind === 'offchip')) {
      const p = pos.get(b.id);
      for (const box of boxes) {
        if (X(p.x) < box.x1 && X(p.x + p.w) > box.x0 && p.y < box.y1 && p.y + p.h > box.y0) diagnostics.push({ code: 'geometry/offchip-inside-boundary', severity: 'error', message: `off-chip block ${b.id} overlaps boundary of group ${g.id}`, subject: { id: b.id }, evidence: {}, supportedFixes: ['remove the block from the chip group'] });
      }
    }
  }

  for (const { l, label, pts } of linkLabels) {
    const lw = ctx.measure(label, S);
    const candidates = [];
    for (let k = pts.length - 1; k >= 1; k -= 1) {
      const a = pts[k - 1];
      const b = pts[k];
      if (Math.abs(a.y - b.y) < 0.01) {
        const x0 = Math.min(a.x, b.x);
        const x1 = Math.max(a.x, b.x);
        for (const x of [x0 + 3, x1 - lw - 3, (x0 + x1 - lw) / 2]) candidates.push({ x, y: a.y - 1.8 }, { x, y: a.y + 1.8 + ctx.font.ascent * S });
      } else {
        const my = (a.y + b.y) / 2 + ctx.base(S);
        candidates.push({ x: a.x + 2.5, y: my }, { x: a.x - 2.5 - lw, y: my });
      }
    }
    const spot = placer.place(label, S, candidates);
    const group = linkGroups.find((g) => g.l.id === l.id);
    if (spot) group.children.push(text(ctx, label, spot.x, spot.y, 'secondary', `link-${l.id}-label`));
    else diagnostics.push({ code: 'print/link-label-omitted', severity: 'warning', message: `${variant}: no free spot for label '${label}' on link ${l.id}`, subject: { id: l.id }, evidence: {}, supportedFixes: ['shorten the label', 'use the 2col variant'] });
  }

  for (const c of doc.crossings || []) {
    if (!c.link) continue;
    const g = linkGroups.find((x) => x.l.id === c.link);
    const boxes = [...(domainBoxes.get(c.to) || []), ...(domainBoxes.get(c.from) || [])];
    for (const box of boxes) {
      const hit = crossingPoint(g.pts, box);
      if (hit) {
        g.children.push(el('path', { id: `link-${c.link}-crossing`, d: hit.horizontal ? `M${num(hit.x - 1.5)} ${num(hit.y - 3)} L${num(hit.x - 1.5)} ${num(hit.y + 3)} M${num(hit.x + 1.5)} ${num(hit.y - 3)} L${num(hit.x + 1.5)} ${num(hit.y + 3)}` : `M${num(hit.x - 3)} ${num(hit.y - 1.5)} L${num(hit.x + 3)} ${num(hit.y - 1.5)} M${num(hit.x - 3)} ${num(hit.y + 1.5)} L${num(hit.x + 3)} ${num(hit.y + 1.5)}`, fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }));
        break;
      }
    }
  }

  const legendChildren = legendRows.flatMap((row, r) => row.flatMap((item) => {
    const y = legendTop + r * (S + 4) + S / 2 + 1;
    return [
      el('path', { id: `legend-${item.id}-sample`, d: `M${num(X(item.x))} ${num(y)} L${num(X(item.x + 16))} ${num(y)}`, fill: 'none', stroke: t.ink, 'stroke-width': item.width, ...(item.dash ? { 'stroke-dasharray': item.dash.join(' ') } : {}) }),
      text(ctx, item.label, X(item.x + 19), y + ctx.base(S), 'secondary', `legend-${item.id}-label`),
    ];
  }));

  const svgTree = el('svg', { xmlns: 'http://www.w3.org/2000/svg', id: `fig-${name}-${variant}`, width: `${num(W)}pt`, height: `${num(H)}pt`, viewBox: `0 0 ${num(W)} ${num(H)}` }, [
    el('g', { id: 'frame' }, [el('rect', { x: 0, y: 0, width: W, height: H, fill: t.background, stroke: 'none' })]),
    el('g', { id: 'boundaries' }, boundaryGroups),
    el('g', { id: 'attachments' }, attachmentGroups),
    el('g', { id: 'links' }, linkGroups.map((g) => el('g', { id: `link-${g.l.id}` }, g.children))),
    el('g', { id: 'fabrics' }, fabricGroups),
    el('g', { id: 'blocks' }, blockGroups),
    ...(legendChildren.length ? [el('g', { id: 'legend' }, legendChildren)] : []),
  ]);

  diagnostics.push(...geometryChecks(svgTree, { font: ctx.font }));
  const metrics = printMetrics(svgTree);
  if (metrics.minFont < minFontPt) diagnostics.push({ code: 'print/min-font', severity: 'error', message: `${variant}: ${metrics.minFont} pt text below ${minFontPt} pt`, subject: { variant }, evidence: {}, supportedFixes: [] });
  if (metrics.minStroke < minStrokePt) diagnostics.push({ code: 'print/min-stroke', severity: 'error', message: `${variant}: ${metrics.minStroke} pt stroke below ${minStrokePt} pt`, subject: { variant }, evidence: {}, supportedFixes: [] });
  if (maxHeightPt && H > maxHeightPt) diagnostics.push({ code: 'print/max-height', severity: 'error', message: `${variant}: height ${num(H)} pt exceeds ${num(maxHeightPt)} pt`, subject: { variant }, evidence: {}, supportedFixes: ['reduce rows or links', 'raise meta.print.max_height_in for this variant'] });

  return {
    svg: `${serialize(svgTree)}\n`, width_pt: W, height_pt: H, content_width_pt: contentW,
    min_font_pt: metrics.minFont, min_stroke_pt: metrics.minStroke, layout: { labels, spacing_scale: 1, spread: false, centered: W > contentW },
    font: { family: ctx.font.family, sha256: ctx.font.sha256 },
    short_labels_used: labels === 'short' ? doc.blocks.filter((b) => b.short_label).map((b) => b.id) : [],
    diagnostics,
  };
}

function crossingPoint(pts, box) {
  for (let k = 1; k < pts.length; k += 1) {
    const a = pts[k - 1];
    const b = pts[k];
    if (Math.abs(a.x - b.x) < 0.01) {
      for (const yEdge of [box.y0, box.y1]) if ((a.y - yEdge) * (b.y - yEdge) < 0 && a.x > box.x0 && a.x < box.x1) return { x: a.x, y: yEdge, horizontal: false };
    } else {
      for (const xEdge of [box.x0, box.x1]) if ((a.x - xEdge) * (b.x - xEdge) < 0 && a.y > box.y0 && a.y < box.y1) return { x: xEdge, y: a.y, horizontal: true };
    }
  }
  return null;
}
