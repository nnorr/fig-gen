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

// Link classes name skin tokens only (tokens.stroke.<width>, tokens.dash.<dash>):
// no stroke width, dash or arrow size is written in the renderer.
const LINK_STYLE = {
  data: { width: 'wire', dash: null, arrow: 'filled', legend: 'data' },
  control: { width: 'control', dash: 'control', arrow: 'filled', legend: 'control' },
  interrupt: { width: 'wire', dash: 'interrupt', arrow: 'filled', legend: 'interrupt' },
  dma: { width: 'emphasis', dash: null, arrow: 'double', legend: 'DMA' },
  sideband: { width: 'wire', dash: 'sideband', arrow: 'filled', legend: 'sideband' },
  clock: { width: 'wire', dash: null, arrow: 'none', legend: 'clock' },
  reset: { width: 'wire', dash: 'reset', arrow: 'none', legend: 'reset' },
  power: { width: 'wire', dash: 'power', arrow: 'none', legend: 'power' },
  // Point-to-point stream interface (valid/ready): solid with an open head, so it
  // reads apart from a data link (filled head) in grayscale.
  stream: { width: 'wire', dash: null, arrow: 'open', legend: 'stream (valid/ready)' },
};
const linkStroke = (t, ls) => t.stroke[ls.width] ?? t.stroke.wire;
const linkDash = (t, ls) => (ls.dash ? t.dash[ls.dash] : null);
const domainDash = (t, kind) => t.dash[`domain_${kind}`];
const boundaryStroke = (t) => t.stroke.boundary ?? t.stroke.wire;

// Links plus point-to-point interfaces (G13): an interface is routed like a
// link in its own `stream` class, never as a fabric bar.
export function allLinks(doc) {
  return [
    ...(doc.links || []),
    ...(doc.interfaces || []).map((i) => ({ id: i.id, from: i.from, to: i.to, class: 'stream', label: i.label ?? i.protocol, short_label: i.short_label, width: i.data_width, interface: true })),
  ];
}

// One row per fabric (CONVENTIONS §11). Fabrics are ordered so that a fabric
// whose subordinate manages another fabric (a bridge, or any block that is
// subordinate on A and manager on B) comes before that fabric. Among
// independent fabrics, one with an off-chip manager comes first and one with
// off-chip subordinates last (document order otherwise). Fabric k's bar is a
// row of its own; its managers sit in the row above and its subordinates in
// the row below, which is also the manager row of fabric k+1, so a bar never
// shares a row with blocks or with another bar. Off-chip blocks take a row
// above everything (managers, unattached) or below everything (subordinates
// of the later fabrics), so they never sit inside a chip group. Empty rows
// are dropped.
export function assignRows(doc) {
  const attachments = doc.attachments || [];
  const blocks = doc.blocks || [];
  const fabrics = doc.fabrics || [];
  const offchip = new Set(blocks.filter((b) => b.kind === 'offchip').map((b) => b.id));
  const attOf = (id) => attachments.filter((a) => a.block === id);
  const index = new Map(fabrics.map((f, i) => [f.id, i]));
  const after = new Map(fabrics.map((f) => [f.id, new Set()]));
  for (const b of blocks) {
    const subs = attOf(b.id).filter((a) => a.role === 'subordinate' && index.has(a.fabric)).map((a) => a.fabric);
    const mgrs = attOf(b.id).filter((a) => a.role === 'manager' && index.has(a.fabric)).map((a) => a.fabric);
    for (const s of subs) for (const m of mgrs) if (s !== m) after.get(s).add(m);
  }
  const weight = (f) => {
    const on = attachments.filter((a) => a.fabric === f.id);
    if (on.some((a) => a.role === 'manager' && offchip.has(a.block))) return 0;
    return on.some((a) => a.role === 'subordinate' && offchip.has(a.block)) ? 2 : 1;
  };
  const indeg = new Map(fabrics.map((f) => [f.id, 0]));
  for (const set of after.values()) for (const g of set) indeg.set(g, indeg.get(g) + 1);
  const ready = fabrics.filter((f) => indeg.get(f.id) === 0);
  const order = [];
  while (ready.length) {
    ready.sort((x, y) => weight(x) - weight(y) || index.get(x.id) - index.get(y.id));
    const f = ready.shift();
    order.push(f.id);
    for (const g of after.get(f.id)) {
      indeg.set(g, indeg.get(g) - 1);
      if (indeg.get(g) === 0) ready.push(fabrics[index.get(g)]);
    }
  }
  for (const f of fabrics) if (!order.includes(f.id)) order.push(f.id); // a fabric cycle keeps document order
  const n = order.length;
  const k = new Map(order.map((id, i) => [id, i]));
  // Raw rows: 0 off-chip top; fabric i: managers 1+2i, bar 2+2i, subordinates 3+2i; 2n+2 off-chip bottom.
  const raw = { bar: (f) => 2 + 2 * k.get(f), mgr: (f) => 1 + 2 * k.get(f), sub: (f) => 3 + 2 * k.get(f) };
  const top = 0;
  const bottom = 2 * n + 2;
  const blockRaw = new Map();
  for (const b of blocks) {
    const mine = attOf(b.id).filter((a) => index.has(a.fabric));
    if (offchip.has(b.id)) {
      if (!mine.length) { blockRaw.set(b.id, top); continue; }
      // near the fabric it attaches to: the first half above the chip, the second half below
      const at = Math.min(...mine.map((a) => k.get(a.fabric)));
      blockRaw.set(b.id, n > 1 && at >= n / 2 ? bottom : top);
      continue;
    }
    const subs = mine.filter((a) => a.role === 'subordinate').map((a) => raw.sub(a.fabric));
    const mgrs = mine.filter((a) => a.role === 'manager').map((a) => raw.mgr(a.fabric));
    if (subs.length) blockRaw.set(b.id, Math.max(...subs));
    else if (mgrs.length) blockRaw.set(b.id, Math.min(...mgrs));
  }
  // Unattached on-chip blocks join the nearest on-chip row of the blocks they link to.
  const onChipRow = (r) => { const c = Math.min(Math.max(r, 1), 2 * n + 1); return c % 2 === 0 ? c + 1 : c; };
  const links = allLinks(doc);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const b of blocks.filter((x) => !blockRaw.has(x.id) || (pass === 1 && blockRaw.get(x.id) === undefined))) {
      const linked = links.filter((l) => l.from === b.id || l.to === b.id).map((l) => (l.from === b.id ? l.to : l.from)).filter((id) => !offchip.has(id) && blockRaw.has(id)).map((id) => blockRaw.get(id));
      if (linked.length) blockRaw.set(b.id, onChipRow(Math.min(...linked)));
      else if (pass === 1) blockRaw.set(b.id, onChipRow(1));
    }
  }
  const used = [...new Set([...blockRaw.values(), ...order.map(raw.bar)])].sort((a, b) => a - b);
  const compact = new Map(used.map((r, i) => [r, i]));
  const fabricRow = new Map(order.map((f) => [f, compact.get(raw.bar(f))]));
  const blockRow = new Map([...blockRaw].map(([id, r]) => [id, compact.get(r)]));
  return { fabricRow, blockRow, order };
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
  const links = allLinks(doc);
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
  // A block below its bar has its attachment arrow on the top edge, a block above it on the bottom edge.
  const takenTop = (id) => attachments.some((a) => a.block === id && fabricRow.has(a.fabric) && blockRow.get(id) > fabricRow.get(a.fabric));
  const takenBottom = (id) => attachments.some((a) => a.block === id && fabricRow.has(a.fabric) && blockRow.get(id) < fabricRow.get(a.fabric));
  const plans = links.map((l) => {
    const rs = blockRow.get(l.from);
    const rt = blockRow.get(l.to);
    if (rs === rt) {
      // In the channel above or below the row: the side where the target's edge
      // carries no bus attachment arrow, else the side with fewer channels.
      const canBelow = !takenBottom(l.to);
      const canAbove = !takenTop(l.to);
      const below = canBelow && (!canAbove || gapSlots[rs + 1] <= gapSlots[rs]) ? true : !canAbove;
      const g = below ? rs + 1 : rs;
      const slot = gapSlots[g]++;
      return { l, rs, rt, exitGap: g, entryGap: g, exitSlot: slot, entrySlot: slot, gutter: false, below };
    }
    const down = rt > rs;
    const rightmost = (id, r) => rowBlocks[r][rowBlocks[r].length - 1]?.id === id;
    // An edge that carries the block's bus attachment arrow is not used: a
    // rightmost block leaves or enters on its east side, straight into the
    // gutter, and books no channel.
    const sideExit = (down ? takenBottom(l.from) : takenTop(l.from)) && rightmost(l.from, rs);
    const sideEntry = (down ? takenTop(l.to) : takenBottom(l.to)) && rightmost(l.to, rt);
    const exitGap = down ? rs + 1 : rs;
    const entryGap = down ? rt : rt + 1;
    const exitSlot = sideExit ? null : gapSlots[exitGap]++;
    const entrySlot = sideEntry ? null : gapSlots[entryGap]++;
    return { l, rs, rt, exitGap, entryGap, exitSlot, entrySlot, gutter: true, sideExit, sideEntry };
  });
  const gutterLinks = plans.filter((p) => p.gutter);
  gutterLinks.forEach((p, k) => { p.gutterIndex = k; });
  const channel = 5.5;
  const gutterW = gutterLinks.length ? 4 + gutterLinks.length * channel : 0;
  const chipLabelH = hasChip ? S + 4 : 0;

  const rowTop = [];
  const rowH = [];
  const gapTop = [];
  // Channels keep a full arrowhead plus 3 pt from every row edge they enter,
  // so no arrowhead meets another link's channel (arrowheads are never shortened).
  const edgeClear = t.arrow.length + 3;
  // A chip boundary drawn around channels next to a non-member row (a fabric
  // bar, an off-chip row) needs the dashed frame gap from the channels plus
  // 2 pt from that row: add what the arrow clearance does not already give.
  const frameRoom = Math.max(0, (t.route?.frame_gap_pt ?? 6) * 1.5 + 0.5 + 2 - edgeClear);
  const chipRows = new Set((doc.groups || []).filter((g) => g.style === 'chip' || g.style === undefined).flatMap((g) => g.members.map((id) => blockRow.get(id))));
  const gapExtraTop = Array.from({ length: rowCount + 1 }, (_, g) => (gapSlots[g] && chipRows.has(g) && !chipRows.has(g - 1) ? frameRoom : 0));
  const gapExtraBottom = Array.from({ length: rowCount + 1 }, (_, g) => (gapSlots[g] && chipRows.has(g - 1) && !chipRows.has(g) ? frameRoom : 0));
  const innerGap = (n, g) => (n ? 2 * edgeClear + (n - 1) * channel + gapExtraTop[g] + gapExtraBottom[g] : Math.max(9, t.arrow.length + 5));
  // The chip label row is reserved at the top only when the first row holds chip members.
  let y = pad + (chipRows.has(0) ? chipLabelH : 0);
  gapTop[0] = y;
  y += gapSlots[0] ? 3 + (gapSlots[0] - 1) * channel + edgeClear + gapExtraTop[0] : 0;
  for (let r = 0; r < rowCount; r += 1) {
    if (r > 0) {
      gapTop[r] = y;
      y += innerGap(gapSlots[r], r);
    }
    rowTop[r] = y;
    rowH[r] = rowFabric[r] ? 10 : Math.max(0, ...rowBlocks[r].map((b) => size.get(b.id).h + size.get(b.id).rep));
    y += rowH[r];
  }
  gapTop[rowCount] = y;
  y += gapSlots[rowCount] ? edgeClear + (gapSlots[rowCount] - 1) * channel + 3 + gapExtraBottom[rowCount] : 0;
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
  // Gutter channels outside a chip boundary keep the dashed frame gap from it (region/wire-hugs-frame).
  const frameClear = (t.route?.frame_gap_pt ?? 6) * 1.5 + 0.5;
  const gutterRight = left + innerW + 4 + (gutterW && hasChip ? 5 + frameClear : 0);
  const gutterX = (k) => gutterRight + 2 + k * channel;
  const chanY = (g, slot) => gapTop[g] + (g === 0 ? 3 : edgeClear) + gapExtraTop[g] + slot * channel;
  const sideUse = new Map();
  const routes = plans.map((p) => {
    const s = center(p.l.from);
    const d = center(p.l.to);
    const sx = s.cx + offsetFor(p.l.from);
    const tx = d.cx + offsetFor(p.l.to);
    if (!p.gutter) {
      const yc = chanY(p.exitGap, p.exitSlot);
      const edge = (c) => (p.below ? c.bottom : c.top);
      return { plan: p, pts: [{ x: sx, y: edge(s) }, { x: sx, y: yc }, { x: tx, y: yc }, { x: tx, y: edge(d) }] };
    }
    const down = p.rt > p.rs;
    const xg = gutterX(p.gutterIndex);
    // Side pins on the east edge: the middle first, then 3 pt steps either side.
    const sideY = (id) => {
      const q = pos.get(id);
      const k = sideUse.get(id) ?? 0;
      sideUse.set(id, k + 1);
      return q.y + q.rep + q.h / 2 + (k % 2 === 0 ? 1 : -1) * channel * Math.ceil(k / 2);
    };
    const east = (id) => { const q = pos.get(id); return q.x + q.w; };
    const yExit = p.sideExit ? null : chanY(p.exitGap, p.exitSlot);
    const yEntry = p.sideEntry ? null : chanY(p.entryGap, p.entrySlot);
    const head = p.sideExit
      ? (() => { const ym = sideY(p.l.from); return [{ x: east(p.l.from), y: ym }, { x: xg, y: ym }]; })()
      : [{ x: sx, y: down ? s.bottom : s.top }, { x: sx, y: yExit }, { x: xg, y: yExit }];
    const tail = p.sideEntry
      ? (() => { const ym = sideY(p.l.to); return [{ x: xg, y: ym }, { x: east(p.l.to), y: ym }]; })()
      : [{ x: xg, y: yEntry }, { x: tx, y: yEntry }, { x: tx, y: down ? d.top : d.bottom }];
    return { plan: p, sideEntry: p.sideEntry, pts: [...head, ...tail] };
  });

  const contentW = gutterRight + gutterW + pad;
  const legendItems = [];
  for (const d of domainsDrawn) legendItems.push({ label: `${d.kind} domain: ${d.label ?? d.id}`, dash: domainDash(t, d.kind), width: boundaryStroke(t), id: `domain-${d.id}` });
  const classes = [...new Set(links.map((l) => l.class))];
  if (classes.length > 1 || classes.some((c) => c !== 'data')) {
    for (const c of classes) {
      const ls = LINK_STYLE[c];
      legendItems.push({ label: ls.legend, dash: linkDash(t, ls), width: linkStroke(t, ls), arrow: ls.arrow, id: `class-${c}` });
    }
  }
  const legendRows = [];
  let lineW = 0;
  for (const item of legendItems) {
    const w = 21 + ctx.measure(item.label, S) + 12;
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
    children.push(el('rect', { id: `block-${b.id}-body`, x, y, width: p.w, height: p.h, fill: t.fill[fillKey], stroke: t.ink, 'stroke-width': b.emphasis ? (t.stroke.emphasis ?? outlineW(t, b.kind)) : outlineW(t, b.kind) }));
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

  // Attachment arrow between a block and its bar, on whichever side of the bar
  // the block sits; the head points away from the manager.
  const attachmentGeom = (a) => {
    const p = pos.get(a.block);
    const bar = bars.get(a.fabric);
    const cx = X(p.x + p.w / 2);
    const above = p.y + p.rep + p.h <= bar.y0 + 0.01;
    const blockEdge = above ? p.y + p.rep + p.h : p.y + p.rep;
    const barEdge = above ? bar.y0 : bar.y1;
    return a.role === 'manager' ? { cx, from: { x: cx, y: blockEdge }, to: { x: cx, y: barEdge } } : { cx, from: { x: cx, y: barEdge }, to: { x: cx, y: blockEdge } };
  };
  // A bar label sits on its bar clear of every attachment arrow and link that
  // crosses the bar's row; when no gap fits, the bar grows to the right.
  const verticalsThrough = (y0, y1) => [
    ...(doc.attachments || []).map((a) => { const g = attachmentGeom(a); return { x: g.cx, y0: Math.min(g.from.y, g.to.y), y1: Math.max(g.from.y, g.to.y), hw: t.arrow.width / 2 + 1.5 }; }),
    ...routes.flatMap((r) => r.pts.slice(1).map((b, i) => ({ a: r.pts[i], b })).filter((s) => Math.abs(s.a.x - s.b.x) < 0.01).map((s) => ({ x: X(s.a.x), y0: Math.min(s.a.y, s.b.y), y1: Math.max(s.a.y, s.b.y), hw: 1.5 }))),
  ].filter((v) => v.y0 < y1 - 0.01 && v.y1 > y0 + 0.01);
  const fabricGroups = (doc.fabrics || []).map((f) => {
    const bar = bars.get(f.id);
    const label = fabricLabel.get(f.id);
    const lw = ctx.measure(label, S);
    const blocked = verticalsThrough(bar.y0, bar.y1).map((v) => [v.x - v.hw, v.x + v.hw]);
    const clear = (x) => blocked.every(([a, b]) => x + lw + 1 < a || x - 1 > b);
    let lx = null;
    for (let x = X(bar.x0) + 4; x + lw <= X(bar.x1) - 4; x += 1) if (clear(x)) { lx = x; break; }
    if (lx === null) {
      lx = Math.max(X(bar.x0) + 4, ...blocked.filter(([a]) => a <= X(bar.x1)).map(([, b]) => b + 2));
      bar.x1 = Math.max(bar.x1, lx - ox + lw + 4);
    }
    placer.addRect({ x0: X(bar.x0), y0: bar.y0, x1: X(bar.x1), y1: bar.y1 });
    return el('g', { id: `fabric-${f.id}` }, [
      el('rect', { id: `fabric-${f.id}-body`, x: X(bar.x0), y: bar.y0, width: bar.x1 - bar.x0, height: bar.y1 - bar.y0, fill: t.fill.bar, stroke: 'none' }),
      text(ctx, label, lx, bar.y0 + 5 + ctx.base(S), 'secondary', `fabric-${f.id}-label`),
    ]);
  });

  const attachmentGroups = (doc.attachments || []).map((a) => {
    const { from, to } = attachmentGeom(a);
    const dir = Math.sign(to.y - from.y) || 1;
    placer.addPolyline([from, to], t.stroke.wire);
    return el('g', { id: `att-${a.id}` }, [
      el('path', { id: `att-${a.id}-seg0`, d: pathD([from, { x: to.x, y: to.y - dir * t.arrow.length }]), fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire }),
      arrowHead(t, `att-${a.id}-arrow`, to, 0, dir, t.ink),
    ]);
  });
  // Arrowheads and the last stretch of each attachment arrow are label obstacles.
  for (const a of doc.attachments || []) {
    const { cx, to } = attachmentGeom(a);
    placer.addRect({ x0: cx - t.arrow.width / 2 - 1.5, x1: cx + t.arrow.width / 2 + 1.5, y0: to.y - 9.5, y1: to.y + 9.5 });
  }

  const linkGroups = [];
  const linkLabels = [];
  for (const { plan, pts: raw } of routes) {
    const l = plan.l;
    const pts = raw.map((q) => ({ x: X(q.x), y: q.y }));
    const ls = LINK_STYLE[l.class];
    const strokeW = linkStroke(t, ls);
    const dash = linkDash(t, ls);
    const style = { fill: 'none', stroke: t.ink, 'stroke-width': strokeW, 'stroke-linejoin': 'miter', ...(dash ? { 'stroke-dasharray': dash.join(' ') } : {}) };
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
    placer.addPolyline([{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 }, { x: box.x0, y: box.y0 }], boundaryStroke(t));
    return el('rect', { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0, fill: 'none', stroke: t.ink, ...attrs });
  };
  const domainBoxes = new Map();
  // Every drawn boundary box with the blocks it must hold, for the shared frame checks.
  const frameList = [];
  domainsDrawn.forEach((d, i) => {
    const domainRuns = runs(d.members);
    const boxes = domainRuns.map((ids) => boxFor(ids, 3 + 3 * i));
    domainBoxes.set(d.id, boxes);
    boxes.forEach((box, k) => frameList.push({ id: `domain-${d.id}-outline${k}`, ...box, members: new Set(domainRuns[k]) }));
    const domainAttrs = { rx: 2, 'stroke-width': boundaryStroke(t), 'stroke-dasharray': domainDash(t, d.kind).join(' ') };
    boundaryGroups.push(el('g', { id: `domain-${d.id}` }, boxes.map((box, k) => { const r = outline(box, domainAttrs); r.attrs = { id: `domain-${d.id}-outline${k}`, ...r.attrs }; return r; })));
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
      // Links between members stay inside the boundary, channels included.
      const internalYs = routes.filter((r) => memberSet.has(r.plan.l.from) && memberSet.has(r.plan.l.to)).flatMap((r) => r.pts.map((q) => q.y));
      const clearFrame = (t.route?.frame_gap_pt ?? 6) * 1.5 + 0.5;
      boxes = [{
        x0: X(Math.min(...ps.map((p) => p.x), ...barsIn.map((b) => b.x0))) - chipPad,
        y0: Math.min(Math.min(...ps.map((p) => p.y)) - chipPad - chipLabelH, ...internalYs.map((v) => v - clearFrame)),
        x1: Math.max(X(Math.max(...ps.map((p) => p.x + p.w + p.rep), ...barsIn.map((b) => b.x1))) + chipPad, gutterLinksInside ? X(gutterRight + gutterW) + 2 : 0),
        y1: Math.max(Math.max(...ps.map((p) => p.y + p.h + p.rep)) + chipPad, ...internalYs.map((v) => v + clearFrame)),
      }];
    } else {
      boxes = runs(g.members).map((ids) => boxFor(ids, chipPad));
    }
    const boxMembers = clean ? [g.members] : runs(g.members);
    boxes.forEach((box, k) => frameList.push({ id: `group-${g.id}-outline${k}`, ...box, members: new Set(boxMembers[k]) }));
    const children = boxes.map((box, k) => { const r = outline(box, { rx: 3, 'stroke-width': boundaryStroke(t), 'stroke-dasharray': t.dash.boundary.join(' ') }); r.attrs = { id: `group-${g.id}-outline${k}`, ...r.attrs }; return r; });
    if (g.label) {
      // Inside the top edge, clear of every wire and arrow crossing it; else inside the bottom edge.
      const b0 = boxes[0];
      const lw = ctx.measure(g.label, S);
      const candidates = [];
      for (const ly of [b0.y0 + S + 1.5, b0.y1 - 2.5]) for (let lx = b0.x0 + 3; lx + lw <= b0.x1 - 3; lx += 2) candidates.push({ x: lx, y: ly });
      const spot = placer.place(g.label, S, candidates) ?? { x: b0.x0 + 3, y: b0.y0 + S + 1.5 };
      children.push(text(ctx, g.label, spot.x, spot.y, 'secondary', `group-${g.id}-label`));
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
    // A link-class sample carries its arrowhead (filled or open), so data and stream differ in the legend too.
    const headed = item.arrow && item.arrow !== 'none';
    const tip = { x: X(item.x + 16), y };
    const lineEnd = headed && item.arrow !== 'open' ? tip.x - t.arrow.length : tip.x;
    return [
      el('path', { id: `legend-${item.id}-sample`, d: `M${num(X(item.x))} ${num(y)} L${num(lineEnd)} ${num(y)}`, fill: 'none', stroke: t.ink, 'stroke-width': item.width, ...(item.dash ? { 'stroke-dasharray': item.dash.join(' ') } : {}) }),
      ...(headed ? [arrowHead(t, `legend-${item.id}-head`, tip, 1, 0, t.ink, { open: item.arrow === 'open' })] : []),
      text(ctx, item.label, X(item.x + 21), y + ctx.base(S), 'secondary', `legend-${item.id}-label`),
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

  // Group and domain boundaries follow the region-frame rules: they hold exactly
  // their blocks (an off-chip block never sits inside a chip boundary), and no
  // wire runs along them (region/frame-*, region/wire-hugs-frame).
  const blockRects = doc.blocks.map((b) => { const p = pos.get(b.id); return { id: b.id, x0: X(p.x), y0: p.y, x1: X(p.x + p.w + p.rep), y1: p.y + p.h + p.rep }; });
  diagnostics.push(...geometryChecks(svgTree, { font: ctx.font, frames: frameList, nodes: blockRects, frameGap: t.route?.frame_gap_pt ?? 6 }));
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
