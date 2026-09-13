// Address-map table figure generated from the microarch memory map
// (SPEC §7). Same fonts, print checks and figma-safe rules as other figures.

import { el, num, printMetrics, serialize } from '../svg.mjs';
import { loadSkin, renderContext, text } from './datapath.mjs';
import { geometryChecks } from './geometry.mjs';

export function renderAddressMap(doc, table, { variant = '2col', widthPt, minFontPt = 6, name = 'figure', skin } = {}) {
  skin = skin ?? loadSkin(doc.meta?.style?.skin);
  const diagnostics = [];
  const blocks = new Map(doc.blocks.map((b) => [b.id, b]));
  const fabrics = new Map((doc.fabrics || []).map((f) => [f.id, f]));
  const build = (mode) => {
    const ctx = renderContext(doc, skin, variant, mode);
    const cols = mode === 'short'
      ? [['Block', (r) => blocks.get(r.block)?.short_label ?? blocks.get(r.block)?.label ?? r.block], ['Base', (r) => r.base], ['Size', (r) => r.size]]
      : [['Block', (r) => blocks.get(r.block)?.label ?? r.block], ['Bus', (r) => fabrics.get(r.fabric)?.protocol ?? r.fabric], ['Base', (r) => r.base], ['End', (r) => r.end], ['Size', (r) => r.size]];
    const size = ctx.t.font.secondary_pt;
    const pad = 6;
    const widths = cols.map(([h, f]) => Math.max(ctx.measure(h, size), ...table.map((r) => ctx.measure(String(f(r)), size))) + 2 * pad);
    return { ctx, cols, size, pad, widths, total: widths.reduce((a, b) => a + b, 0) };
  };
  let layout = build('full');
  if (widthPt && layout.total > widthPt) {
    layout = build('short');
    diagnostics.push({ code: 'print/label-fallback', severity: 'info', message: `${variant}: address map uses the compact column set`, subject: { variant }, evidence: {}, supportedFixes: [] });
  }
  const { ctx, cols, size, pad, widths, total } = layout;
  if (widthPt && total > widthPt) diagnostics.push({ code: 'print/width-overflow', severity: 'error', message: `${variant}: address map is ${num(total)} pt wide`, subject: { variant }, evidence: {}, supportedFixes: ['shorten block labels'] });
  const t = ctx.t;
  const rowH = size + 5;
  const W = Math.max(widthPt ?? total, total);
  const ox = (W - total) / 2;
  const H = rowH * (table.length + 1) + 8;
  const colX = widths.map((_, i) => ox + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const baseline = (row) => 4 + rowH * row + rowH / 2 + ctx.base(size);
  const header = el('g', { id: 'addrmap-header' }, [
    ...cols.map(([h], i) => text(ctx, h, colX[i] + pad, baseline(0), 'secondary', `addrmap-h-${i}`)),
    el('path', { id: 'addrmap-rule-top', d: `M${num(ox)} ${num(4)} L${num(ox + total)} ${num(4)}`, fill: 'none', stroke: t.ink, 'stroke-width': 0.8 }),
    el('path', { id: 'addrmap-rule-head', d: `M${num(ox)} ${num(4 + rowH)} L${num(ox + total)} ${num(4 + rowH)}`, fill: 'none', stroke: t.ink, 'stroke-width': 0.5 }),
  ]);
  const rows = table.map((r, k) => el('g', { id: `addrmap-row-${r.block}` }, cols.map(([, f], i) => text(ctx, String(f(r)), colX[i] + pad, baseline(k + 1), 'secondary', `addrmap-${r.block}-${i}`))));
  const svgTree = el('svg', { xmlns: 'http://www.w3.org/2000/svg', id: `fig-${name}-addrmap-${variant}`, width: `${num(W)}pt`, height: `${num(H)}pt`, viewBox: `0 0 ${num(W)} ${num(H)}` }, [
    el('g', { id: 'frame' }, [el('rect', { x: 0, y: 0, width: W, height: H, fill: t.background, stroke: 'none' })]),
    el('g', { id: 'addrmap' }, [header, el('g', { id: 'addrmap-rows' }, rows), el('path', { id: 'addrmap-rule-bottom', d: `M${num(ox)} ${num(H - 4)} L${num(ox + total)} ${num(H - 4)}`, fill: 'none', stroke: t.ink, 'stroke-width': 0.8 })]),
  ]);
  diagnostics.push(...geometryChecks(svgTree, { font: ctx.font }));
  const metrics = printMetrics(svgTree);
  if (metrics.minFont < minFontPt) diagnostics.push({ code: 'print/min-font', severity: 'error', message: `${variant}: text below ${minFontPt} pt`, subject: { variant }, evidence: {}, supportedFixes: [] });
  return { svg: `${serialize(svgTree)}\n`, width_pt: W, height_pt: H, min_font_pt: metrics.minFont, min_stroke_pt: metrics.minStroke, font: { family: ctx.font.family, sha256: ctx.font.sha256 }, diagnostics };
}
