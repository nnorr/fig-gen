// Timing figure renderer (SPEC §6). The waveform is drawn by the pinned
// WaveDrom library (renderAny, pure Node); fig-gen adds the paper layer before
// rendering (readable lane names, width annotations, cycle axis) and the
// figma-safe post-process after it (lib/render/timing-postprocess.mjs).
//
// Column fitting (SPEC §6.3): WaveDrom's text is 11 units; the post-process
// sets lane names at the label size (8 pt) and values at the secondary size
// (7 pt), so the geometry scale may not drop below label_pt / 11 or names would
// overrun their column. Per variant the fitter tries hscale 1, 1.5, 2, 3, 4
// (WaveDrom 3.7 does not narrow cycles below hscale 1), from the declared
// fit.<variant>.hscale or the largest that fits, and scales the drawing to the
// column width. When even hscale 1 needs a scale below the floor, the figure
// does not fit: print/min-font (never shrinking text) with fixes.

import { createRequire } from 'node:module';
import { expandWave, lanesOf, laneName } from '../checks/timing.mjs';
import { walk } from '../svg.mjs';
import { printMetrics, serialize } from '../svg.mjs';
import { loadSkin, renderContext } from './datapath.mjs';
import { geometryChecks } from './geometry.mjs';
import { collect, emitFigmaSafe, parseSkinCss } from './timing-postprocess.mjs';

const require = createRequire(import.meta.url);
const wavedrom = require('wavedrom');
const waveSkin = require('wavedrom/skins/default.js');

const WAVEDROM_TEXT = 11;
const HSCALES = [1, 1.5, 2, 3, 4];
// WaveDrom units map to at most 1 pt: a short window is not blown up to fill a column.
const MAX_SCALE = 1;
const MARGIN = 2;

// A readable, id-safe token for layer ids.
export const idToken = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lane';

// The WaveJSON WaveDrom renders: printed names (readable, short in short mode,
// width appended), fit limits, and head/foot kept as authored.
export function paperWavejson(doc, { mode = 'full', hscale = 1, variant } = {}) {
  const wj = structuredClone(doc.wavejson);
  const fit = doc.fit?.[variant] || {};
  const names = [];
  const visit = (items) => items.map((item) => {
    if (Array.isArray(item)) return [item[0], ...visit(item.slice(1))];
    if (!item || typeof item !== 'object' || typeof item.wave !== 'string') return item;
    const lane = { ...item };
    if (lane.name) {
      const meta = doc.signals?.[lane.name] || {};
      let printed = laneName(doc, lane.name, { mode: fit.names === 'short' || mode === 'short' ? 'short' : 'full' });
      // A lane whose values print as names (radix label) carries no width suffix.
      if (Number.isInteger(meta.width) && meta.width > 1 && meta.radix !== 'label') printed = meta.width_style === 'range' ? `${printed}[${meta.width - 1}:0]` : `${printed} /${meta.width}`;
      names.push({ source: lane.name, printed });
      lane.name = printed;
    }
    if (Number.isInteger(fit.max_cycles) && lane.wave.length > fit.max_cycles) {
      lane.wave = lane.wave.slice(0, fit.max_cycles);
      if (lane.node) lane.node = lane.node.slice(0, fit.max_cycles);
    }
    return lane;
  });
  wj.signal = visit(wj.signal || []);
  if (Number.isInteger(fit.max_signals)) {
    let kept = 0;
    wj.signal = wj.signal.filter((item) => (Array.isArray(item) || (item && item.wave !== undefined) ? (kept += 1) <= fit.max_signals : true));
  }
  wj.config = { ...(wj.config || {}), hscale };
  return { wavejson: wj, names };
}

function renderOnce(doc, ctx, { mode, hscale, variant }) {
  const { wavejson, names } = paperWavejson(doc, { mode, hscale, variant });
  const tree = wavedrom.renderAny(0, wavejson, waveSkin);
  const styleNode = tree.find((k) => Array.isArray(k) && k[0] === 'style');
  const css = parseSkinCss(styleNode ? styleNode[2] : '');
  const parts = collect(tree, { css });
  return { parts, names, wavejson };
}

// Edge endpoints in wavejson.edge order ("a~>b label" → {from: a, to: b}).
const edgeIdsOf = (wj) => (wj.edge || []).map((e) => { const m = /^\s*([A-Za-z0-9])\s*[-~<>|+]+\s*([A-Za-z0-9])/.exec(e); return m ? { from: m[1], to: m[2] } : { from: 'x', to: 'y' }; });

export async function renderTiming(doc, { variant = '2col', widthPt, maxHeightPt, minFontPt = 6, minStrokePt = 0.5, name = 'figure', skin } = {}) {
  skin = skin ?? loadSkin(doc.meta?.style?.skin);
  const diagnostics = [];
  const floor = skin.tokens.font.label_pt / WAVEDROM_TEXT;
  const lanes = lanesOf(doc.wavejson);
  const laneIds = lanes.map(({ lane }, i) => `${idToken(lane.name || `lane-${i}`)}`);
  const nodeLetters = new Set(lanes.flatMap(({ lane }) => [...String(lane.node || '')].filter((c) => c !== '.')));
  const declared = doc.fit?.[variant]?.hscale ?? doc.wavejson?.config?.hscale ?? null;
  const tried = [];
  let chosen = null;
  for (const mode of widthPt ? ['full', 'short'] : ['full']) {
    // A column tries the widest cycles that fit; a declared hscale is the widest
    // tried, never forced past the column. The study format keeps the declared
    // (or unit) cycle width.
    const candidates = widthPt
      ? [...new Set([...(declared ? [declared] : []), ...HSCALES.filter((h) => !declared || h <= declared)])].sort((a, b) => b - a)
      : [declared ?? 1];
    for (const hscale of candidates) {
      const ctx = renderContext(doc, skin, variant, mode);
      const r = renderOnce(doc, ctx, { mode, hscale, variant });
      // The largest scale that fits the column width, the maximum height and 1 pt per unit.
      const fitScale = Math.min(widthPt ? (widthPt - 2 * MARGIN) / r.parts.width : Infinity, maxHeightPt ? (maxHeightPt - 2 * MARGIN) / r.parts.height : Infinity, MAX_SCALE);
      tried.push({ labels: mode, hscale, scale: Math.round(fitScale * 1000) / 1000, wavedrom_size: [r.parts.width, r.parts.height] });
      if (!widthPt) { chosen = { ctx, r, scale: floor, hscale, mode }; break; }
      if (fitScale >= floor - 1e-9) { chosen = { ctx, r, scale: fitScale, hscale, mode }; break; }
    }
    if (chosen) break;
  }
  if (!chosen) {
    // Nothing fits at the text floor: draw at the floor (the candidate with the
    // most room) and report instead of shrinking text.
    const best = tried.reduce((a, b) => (b.scale > a.scale ? b : a));
    const ctx = renderContext(doc, skin, variant, best.labels);
    const r = renderOnce(doc, ctx, { mode: best.labels, hscale: best.hscale, variant });
    chosen = { ctx, r, scale: floor, hscale: best.hscale, mode: best.labels };
    const widthNeed = widthPt ? (widthPt - 2 * MARGIN) / r.parts.width : Infinity;
    const heightNeed = maxHeightPt ? (maxHeightPt - 2 * MARGIN) / r.parts.height : Infinity;
    if (widthNeed < floor) diagnostics.push({ code: 'print/min-font', severity: 'error', message: `${variant}: the waveform needs a scale of ${Math.round(widthNeed * 1000) / 1000} to fit ${widthPt} pt, below the ${Math.round(floor * 1000) / 1000} that keeps lane names at ${skin.tokens.font.label_pt} pt; text is never shrunk`, subject: { variant }, evidence: { tried, floor }, supportedFixes: ['shorten lane names with signals.<name>.short_name', 'show fewer cycles (fit.<variant>.max_cycles) or split the window', 'move the figure to the 2col variant'] });
    if (heightNeed < floor && widthNeed >= floor) diagnostics.push({ code: 'print/min-font', severity: 'error', message: `${variant}: the waveform needs a scale of ${Math.round(heightNeed * 1000) / 1000} to fit ${maxHeightPt} pt of height, below the ${Math.round(floor * 1000) / 1000} that keeps lane names at ${skin.tokens.font.label_pt} pt; text is never shrunk`, subject: { variant }, evidence: { tried, floor }, supportedFixes: ['show fewer lanes (fit.<variant>.max_signals)', 'raise meta.print.max_height_in for this variant'] });
  }
  const { ctx, r, scale, hscale, mode } = chosen;
  const laneWaves = lanesOf(r.wavejson).map(({ lane }) => ({ name: lane.name, cycles: expandWave(lane) }));
  const out = emitFigmaSafe(r.parts, { ctx, scale, laneIds, laneWaves, nodeLetters, edgeIds: edgeIdsOf(r.wavejson), name, variant, margin: MARGIN, canvasWidth: widthPt });
  const svgTree = out.svgTree;
  diagnostics.push(...(out.diagnostics || []));
  if (widthPt && out.width > widthPt + 0.01) diagnostics.push({ code: 'print/width-overflow', severity: 'error', message: `${variant}: content ${out.width} pt exceeds column ${widthPt} pt`, subject: { variant }, evidence: {}, supportedFixes: ['show fewer cycles', 'shorten lane names'] });
  if (maxHeightPt && out.height > maxHeightPt + 0.01) diagnostics.push({ code: 'print/max-height', severity: 'error', message: `${variant}: height ${out.height} pt exceeds ${maxHeightPt} pt`, subject: { variant }, evidence: {}, supportedFixes: ['show fewer lanes (fit.<variant>.max_signals)', 'raise meta.print.max_height_in for this variant'] });
  diagnostics.push(...geometryChecks(svgTree, { font: ctx.font, ignoreLine: (id) => /^timing-axis/.test(id) }));
  const metrics = printMetrics(svgTree);
  if (metrics.minFont < minFontPt) diagnostics.push({ code: 'print/min-font', severity: 'error', message: `${variant}: ${metrics.minFont} pt text below ${minFontPt} pt`, subject: { variant }, evidence: {}, supportedFixes: [] });
  if (metrics.minStroke < minStrokePt) diagnostics.push({ code: 'print/min-stroke', severity: 'error', message: `${variant}: ${metrics.minStroke} pt stroke below ${minStrokePt} pt`, subject: { variant }, evidence: {}, supportedFixes: [] });
  // arrowheads uniform (arrow/nonuniform)
  const t = skin.tokens;
  walk(svgTree, (n) => {
    if (n.name !== 'path' || !/-(arrow|tail)$/.test(n.attrs.id || '')) return;
    const p = [...n.attrs.d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    const base = { x: (p[0].x + p[2].x) / 2, y: (p[0].y + p[2].y) / 2 };
    const length = Math.hypot(p[1].x - base.x, p[1].y - base.y);
    const width = Math.hypot(p[0].x - p[2].x, p[0].y - p[2].y);
    if (Math.abs(length - t.arrow.length) > 0.05 || Math.abs(width - t.arrow.width) > 0.05) diagnostics.push({ code: 'arrow/nonuniform', severity: 'error', message: `${variant}: ${n.attrs.id} is ${Math.round(length * 100) / 100} × ${Math.round(width * 100) / 100} pt`, subject: { id: n.attrs.id, variant }, evidence: {} });
  });
  return {
    svg: `${serialize(svgTree)}\n`, width_pt: out.width, height_pt: out.height, content_width_pt: out.width,
    min_font_pt: metrics.minFont, min_stroke_pt: metrics.minStroke,
    layout: { labels: mode, spacing_scale: 1, spread: false, centered: false, hscale, scale: Math.round(scale * 1000) / 1000, plans: tried },
    font: { family: ctx.font.family, sha256: ctx.font.sha256 },
    short_labels_used: mode === 'short' ? r.names.filter((n) => doc.signals?.[n.source]?.short_name).map((n) => n.source) : [],
    route: undefined,
    diagnostics,
    timing: { hscale, scale: Math.round(scale * 1000) / 1000, lanes: lanes.length, names: r.names },
  };
}
