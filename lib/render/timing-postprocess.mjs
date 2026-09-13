// Figma-safe post-process of WaveDrom SVG (SPEC §6.4). Works on the onml tree
// WaveDrom returns (['tag', {attrs}, ...children]) and emits a fig-gen SVG tree
// (lib/svg.mjs el nodes) in pt:
// 1. inline CSS: the skin's element and single-class rules become presentation
//    attributes; any other selector fails loudly;
// 2. expand <use>/<defs>: every brick is copied with its translate composed into
//    absolute coordinates; no transform survives;
// 3. arrowheads: markers are removed and each marked path end gets an explicit
//    filled arrowhead of the one skin size along its end tangent;
// 4. text: start-anchored at the measured advance width of the skin font, no
//    xml:space, no transforms, one string per <text>;
// 5. units: the fitted scale is applied to geometry; width/height/viewBox in pt;
// 6. grayscale: WaveDrom's colours map to the skin ink, white and one gray;
// 7. layer ids: timing-axis, timing-signal-<id>, timing-edge-<from>-<to>,
//    timing-groups, timing-gaps; WaveDrom's internal ids are dropped.
// Line weights are absolute: waveform and edge strokes use stroke.wire and thin
// marks (X hatching, grid) use stroke.boundary, whatever the geometry scale.

import { el, num } from '../svg.mjs';
import { arrowHead } from './datapath.mjs';

// --- CSS ----------------------------------------------------------------------

const CSS_PROPS = new Set(['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'font-size', 'font-weight', 'font-style', 'fill-opacity', 'stroke-opacity']);

// Parse the skin <style> text into { element: {prop: v}, class: {name: {prop: v}} }.
export function parseSkinCss(cssText) {
  const out = { element: {}, class: {} };
  for (const m of String(cssText).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (/^[a-z]+$/.test(sel)) out.element[sel] = { ...(out.element[sel] || {}), ...decls };
      else if (/^\.[A-Za-z0-9_-]+$/.test(sel)) out.class[sel.slice(1)] = { ...(out.class[sel.slice(1)] || {}), ...decls };
      else throw new Error(`timing post-process: unsupported CSS selector "${sel}" in the WaveDrom skin`);
    }
  }
  return out;
}

const parseStyle = (s) => Object.fromEntries(String(s || '').split(';').map((d) => d.split(':').map((x) => x.trim())).filter((p) => p.length === 2 && p[0]));

// --- transforms -----------------------------------------------------------------

// Affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

export function parseTransform(t) {
  let m = IDENTITY;
  for (const f of String(t || '').matchAll(/(translate|scale|rotate)\s*\(([^)]*)\)/g)) {
    const a = f[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (f[1] === 'translate') m = mul(m, [1, 0, 0, 1, a[0] || 0, a[1] || 0]);
    else if (f[1] === 'scale') m = mul(m, [a[0], 0, 0, a[1] ?? a[0], 0, 0]);
    else {
      const r = ((a[0] || 0) * Math.PI) / 180;
      m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
    }
  }
  const rest = String(t || '').replace(/(translate|scale|rotate)\s*\([^)]*\)/g, '').trim();
  if (rest) throw new Error(`timing post-process: unsupported transform "${t}"`);
  return m;
}

// --- paths ----------------------------------------------------------------------

// Absolute subpaths of polylines from a path d (M m L l H h V v C c Z z, implicit
// repeats); cubic curves are flattened to short lines.
export function pathPolylines(d) {
  const tokens = String(d).match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  const polys = [];
  let cur = null;
  let pos = { x: 0, y: 0 };
  let start = pos;
  let cmd = null;
  let i = 0;
  const next = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) throw new Error(`timing post-process: path data starts without a command: "${d}"`);
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toLowerCase()) {
      case 'm': {
        const x = next(); const y = next();
        pos = rel ? { x: pos.x + x, y: pos.y + y } : { x, y };
        start = pos;
        cur = { pts: [pos], closed: false };
        polys.push(cur);
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'l': {
        const x = next(); const y = next();
        pos = rel ? { x: pos.x + x, y: pos.y + y } : { x, y };
        if (!cur) { cur = { pts: [pos], closed: false }; polys.push(cur); } else cur.pts.push(pos);
        break;
      }
      case 'h': { const x = next(); pos = { x: rel ? pos.x + x : x, y: pos.y }; cur.pts.push(pos); break; }
      case 'v': { const y = next(); pos = { x: pos.x, y: rel ? pos.y + y : y }; cur.pts.push(pos); break; }
      case 'c': {
        const v = [next(), next(), next(), next(), next(), next()];
        const p1 = rel ? { x: pos.x + v[0], y: pos.y + v[1] } : { x: v[0], y: v[1] };
        const p2 = rel ? { x: pos.x + v[2], y: pos.y + v[3] } : { x: v[2], y: v[3] };
        const p3 = rel ? { x: pos.x + v[4], y: pos.y + v[5] } : { x: v[4], y: v[5] };
        const p0 = pos;
        for (let k = 1; k <= 12; k += 1) {
          const t = k / 12; const u = 1 - t;
          cur.pts.push({ x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y });
        }
        pos = p3;
        break;
      }
      case 'z':
        if (cur) { cur.closed = true; cur.pts.push(start); }
        pos = start;
        cur = null;
        cmd = null;
        break;
      default:
        throw new Error(`timing post-process: unsupported path command "${cmd}" in "${d}"`);
    }
    if (cmd && cmd.toLowerCase() !== 'z' && !isNum() && i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])) break;
  }
  return polys.filter((p) => p.pts.length >= 2);
}

const polylineD = (pts, closed) => `${pts.map((p, k) => `${k ? 'L' : 'M'}${num(p.x)} ${num(p.y)}`).join(' ')}${closed ? ' Z' : ''}`;

// --- colours --------------------------------------------------------------------

// WaveDrom colours to grayscale tokens: the ink for lines and the info/edge
// blue, white for fills (bus values stay white), one gray for muted marks.
function gray(value, t, role) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'none') return 'none';
  if (v === '#fff' || v === '#ffffff' || v === 'white') return t.background;
  if (role === 'fill' && /^#(ffffb4|ffe0b9|b9e0ff|ccfdfe|cdfdc5|f0c1fb|f5c2c0)$/.test(v)) return t.background;
  if (/^#(aaa|aaaaaa|888|888888|999)$/.test(v)) return t.fill.bar;
  return t.ink;
}

// --- walk ---------------------------------------------------------------------

// Style of an onml element: element rule, then class rules, then style attr, then attributes.
function resolveStyle(tag, attrs, css, inherited) {
  const s = { ...inherited };
  if (css.element[tag]) Object.assign(s, css.element[tag]);
  for (const c of String(attrs.class || '').split(/\s+/).filter(Boolean)) {
    if (!css.class[c] && !/^WaveDrom$/.test(c)) throw new Error(`timing post-process: class "${c}" has no rule in the WaveDrom skin`);
    Object.assign(s, css.class[c] || {});
  }
  Object.assign(s, parseStyle(attrs.style));
  for (const k of CSS_PROPS) if (attrs[k] !== undefined) s[k] = String(attrs[k]);
  if (attrs['text-anchor'] !== undefined) s['text-anchor'] = attrs['text-anchor'];
  return s;
}

const textOf = (node) => (Array.isArray(node) ? node.slice(2).map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : '');

// Collect drawables from the WaveDrom tree with absolute geometry.
// Returns { shapes: [{kind:'poly', layer, pts, closed, style, markers}], texts: [{layer, x, y, value, anchor, style, rotated, role}], rects: [...] }.
export function collect(tree, { css }) {
  const [, rootAttrs, ...kids] = tree;
  const defs = new Map();
  for (const k of kids) if (Array.isArray(k) && k[0] === 'defs') for (const g of k.slice(2)) if (Array.isArray(g) && g[1]?.id) defs.set(g[1].id, g);
  const shapes = [];
  const texts = [];
  const rects = [];
  const visit = (node, m, style, layer) => {
    if (!Array.isArray(node)) return;
    const [tag, attrs = {}, ...children] = node;
    if (tag === 'defs' || tag === 'style' || tag === 'marker') return;
    const id = attrs.id || '';
    let lay = layer;
    if (/^gmarks_/.test(id)) lay = { kind: 'axis' };
    else if (/^wavelane_\d+_/.test(id)) lay = { kind: 'lane', index: Number(/^wavelane_(\d+)_/.exec(id)[1]) };
    else if (/^wavearcs_/.test(id)) lay = { kind: 'edges' };
    else if (/^groups_/.test(id)) lay = { kind: 'groups' };
    else if (/^wavegaps_/.test(id)) lay = { kind: 'gaps' };
    const mm = attrs.transform ? mul(m, parseTransform(attrs.transform)) : m;
    const st = resolveStyle(tag, attrs, css, style);
    if (tag === 'use') {
      const ref = String(attrs['xlink:href'] || attrs.href || '').replace(/^#/, '');
      const brick = defs.get(ref);
      if (!brick) throw new Error(`timing post-process: <use> references unknown brick "${ref}"`);
      for (const c of brick.slice(2)) visit(c, mm, st, lay);
      return;
    }
    if (tag === 'path') {
      const markers = { end: /url\(#arrowhead\)/.test(st['marker-end'] || ''), start: /url\(#arrowtail\)/.test(st['marker-start'] || ''), tee: /url\(#tee\)/.test(`${st['marker-end'] || ''}${st['marker-start'] || ''}`) };
      for (const p of pathPolylines(attrs.d)) shapes.push({ layer: lay, pts: p.pts.map((q) => apply(mm, q)), closed: p.closed, style: st, markers, arc: lay?.kind === 'edges', id });
      return;
    }
    if (tag === 'line') {
      const a = apply(mm, { x: Number(attrs.x1), y: Number(attrs.y1) });
      const b = apply(mm, { x: Number(attrs.x2), y: Number(attrs.y2) });
      shapes.push({ layer: lay, pts: [a, b], closed: false, style: st, markers: {}, grid: lay?.kind === 'axis', id });
      return;
    }
    if (tag === 'rect') {
      const x = Number(attrs.x || 0); const y = Number(attrs.y || 0);
      const p0 = apply(mm, { x, y });
      const p1 = apply(mm, { x: x + Number(attrs.width || 0), y: y + Number(attrs.height || 0) });
      rects.push({ layer: lay, x0: Math.min(p0.x, p1.x), y0: Math.min(p0.y, p1.y), x1: Math.max(p0.x, p1.x), y1: Math.max(p0.y, p1.y), style: st, id });
      return;
    }
    if (tag === 'text') {
      const value = textOf(node);
      if (!value.trim()) return;
      const p = apply(mm, { x: Number(attrs.x || 0), y: Number(attrs.y || 0) });
      texts.push({ layer: lay, x: p.x, y: p.y, value, anchor: st['text-anchor'] || 'start', style: st, rotated: Math.abs(mm[1]) > 1e-6, role: lay?.kind === 'lane' && Number(attrs.x) < 0 ? 'name' : lay?.kind === 'lane' ? 'value' : lay?.kind === 'axis' ? 'tick' : lay?.kind === 'edges' ? 'edge-label' : 'other' });
      return;
    }
    for (const c of children) visit(c, mm, st, lay);
  };
  visit(tree, IDENTITY, {}, null);
  return { width: Number(rootAttrs.width), height: Number(rootAttrs.height), shapes, texts, rects };
}

// --- emit -------------------------------------------------------------------------

// Build the figma-safe SVG tree. opts: { ctx, scale, laneIds: [readable id per lane index],
// nodeLetters: Set, edgeIds: [{from, to}] in wavejson.edge order, name, variant, margin }.
// canvasWidth: a column width to centre a narrower drawing in (paper variants).
export function emitFigmaSafe(parts, { ctx, scale, laneIds, laneWaves = [], nodeLetters = new Set(), edgeIds = [], name, variant, margin = 2, canvasWidth }) {
  const t = ctx.t;
  const L = t.font.label_pt;
  const S = t.font.secondary_pt;
  const content = parts.width * scale + 2 * margin;
  const W = Math.round(Math.max(content, canvasWidth ?? 0) * 100) / 100;
  const ox = Math.max(0, (W - content) / 2);
  const H = Math.round((parts.height * scale + 2 * margin) * 100) / 100;
  const P = (p) => ({ x: p.x * scale + margin + ox, y: p.y * scale + margin });
  const layers = { axis: [], groups: [], gaps: [], edges: new Map(), lanes: new Map() };
  const laneGroup = (idx) => {
    if (!layers.lanes.has(idx)) layers.lanes.set(idx, { name: [], wave: [], values: [] });
    return layers.lanes.get(idx);
  };

  // Lane bands (the drawn y extent of each lane's wave) and the free channels
  // between them: edge labels sit in a channel, never on a waveform.
  const bandMap = new Map();
  for (const s of parts.shapes.filter((x) => x.layer?.kind === 'lane')) {
    const b = bandMap.get(s.layer.index) || { y0: Infinity, y1: -Infinity };
    for (const q of s.pts) { const y = P(q).y; b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); }
    bandMap.set(s.layer.index, b);
  }
  const bands = [...bandMap.values()].sort((a, b) => a.y0 - b.y0);
  const channels = bands.slice(1).map((b, k) => ({ y0: bands[k].y1, y1: b.y0 })).filter((c) => c.y1 > c.y0);
  // The left edge of the waveform area: lane names sit left of it, and a bus
  // value wider than its segment never spills over its lane's name.
  const waveXs = parts.shapes.filter((s) => s.layer?.kind === 'lane').flatMap((s) => s.pts.map((q) => P(q).x));
  const waveLeft = waveXs.length ? Math.min(...waveXs) : null;
  const diagnostics = [];
  // Each lane's horizontal extent and transition width (the slanted strokes
  // that start on a cycle boundary), for fitting bus values into their segments.
  const laneGeom = new Map();
  for (const s of parts.shapes.filter((x) => x.layer?.kind === 'lane')) {
    const g = laneGeom.get(s.layer.index) || { x0: Infinity, x1: -Infinity, slants: [] };
    const pts = s.pts.map(P);
    for (const q of pts) { g.x0 = Math.min(g.x0, q.x); g.x1 = Math.max(g.x1, q.x); }
    if (s.style?.stroke && s.style.stroke !== 'none') {
      for (let k = 1; k < pts.length; k += 1) if (Math.abs(pts[k].x - pts[k - 1].x) > 0.01 && Math.abs(pts[k].y - pts[k - 1].y) > 0.01) g.slants.push([Math.min(pts[k].x, pts[k - 1].x), Math.max(pts[k].x, pts[k - 1].x)]);
    }
    laneGeom.set(s.layer.index, g);
  }
  // The segment a value belongs to: from the end of the transition that starts
  // it to the start of the next one (wave characters other than '.').
  const segmentOf = (index, cx) => {
    const g = laneGeom.get(index);
    const cycles = laneWaves?.[index]?.cycles;
    if (!g || !cycles?.length || !(g.x1 > g.x0)) return null;
    const period = (g.x1 - g.x0) / cycles.length;
    const k = Math.min(cycles.length - 1, Math.max(0, Math.floor((cx - g.x0) / period)));
    let s = k;
    while (s > 0 && cycles[s] === '.') s -= 1;
    let e = k + 1;
    while (e < cycles.length && cycles[e] === '.') e += 1;
    const start = g.x0 + s * period;
    // (WaveDrom leads a transition with a short flat stub, so its slant starts inside the cycle)
    const tw = s > 0 ? Math.max(0, ...g.slants.filter(([a]) => a > start - 0.5 && a < start + period / 2).map(([, b]) => b - start)) : 0;
    return { x0: start + tw, x1: g.x0 + e * period, cycles: e - s };
  };
  const PAD = 1;

  // Text first: every text box knocks the edge arcs out behind it.
  const knockouts = [];
  const textNodes = [];
  for (const tx of parts.texts) {
    const role = tx.role;
    if (role === 'edge-label' && nodeLetters.has(tx.value.trim())) continue; // node letters are anchors, not text
    const size = role === 'name' ? L : S;
    const p = P(tx);
    // A bus value wider than its segment prints in its shortest lossless form
    // (leading zeros dropped; the lane name keeps the width). Wider still: reported.
    let value = tx.value;
    const seg = role === 'value' && !tx.rotated && tx.layer?.kind === 'lane' ? segmentOf(tx.layer.index, tx.anchor === 'middle' ? p.x : p.x + ctx.measure(value, size) / 2) : null;
    if (seg && ctx.measure(value, size) > seg.x1 - seg.x0 - 2 * PAD) {
      const compact = value.replace(/^(0[xX])0+(?=[0-9A-Fa-f])/, '$1').replace(/^(0[bB])0+(?=[01])/, '$1');
      const lane = laneWaves?.[tx.layer.index]?.name ?? `lane ${tx.layer.index}`;
      if (compact !== value) diagnostics.push({ code: 'timing/value-compacted', severity: 'info', message: `${variant}: "${value}" on ${lane} prints as "${compact}" to fit its ${seg.cycles}-cycle segment`, subject: { lane, variant }, evidence: { value, printed: compact }, supportedFixes: [] });
      value = compact;
      if (ctx.measure(value, size) > seg.x1 - seg.x0 - 2 * PAD) diagnostics.push({ code: 'timing/value-overflow', severity: 'error', message: `${variant}: value "${value}" on ${lane} is ${Math.round(ctx.measure(value, size) * 10) / 10} pt wide; its ${seg.cycles}-cycle segment has ${Math.round((seg.x1 - seg.x0 - 2 * PAD) * 10) / 10} pt`, subject: { lane, variant }, evidence: { value, segment_pt: Math.round((seg.x1 - seg.x0) * 100) / 100 }, supportedFixes: ['widen the cycles with fit.<variant>.hscale', 'show fewer cycles or lanes so the column scale grows', 'use a shorter radix (signals.<name>.radix) or relabel the value', 'move the figure to the study format'] });
    }
    const w = ctx.measure(value, size);
    let x = tx.anchor === 'middle' ? p.x - w / 2 : tx.anchor === 'end' ? p.x - w : p.x;
    if (seg) x = Math.max(seg.x0 + PAD, Math.min((seg.x0 + seg.x1) / 2 - w / 2, seg.x1 - PAD - w));
    if (role !== 'name' && role !== 'edge-label' && !tx.rotated && tx.layer?.kind === 'lane' && waveLeft !== null) x = Math.max(x, waveLeft + 1);
    let y = p.y;
    if (tx.rotated) {
      // WaveDrom sets group names vertically beside their bracket; ours are
      // horizontal, right-aligned 2 pt left of the bracket, centred on it.
      const bracket = parts.shapes.filter((s) => s.layer?.kind === 'groups').map((s) => s.pts.map(P)).find((pp) => pp.some((q) => Math.abs(q.y - p.y) < 1e6) && Math.min(...pp.map((q) => q.y)) <= p.y + 0.5 && Math.max(...pp.map((q) => q.y)) >= p.y - 0.5);
      const left = bracket ? Math.min(...bracket.map((q) => q.x)) : p.x;
      x = Math.max(margin, left - 2 - w);
      y = p.y + (ctx.font.ascent * size) / 2;
    }
    const up = ctx.font.ascent * size;
    const down = ctx.font.descent * size * 0.6;
    if (role === 'edge-label') {
      // WaveDrom centres its 11-unit label on y - 3; place ours in the nearest free lane channel.
      const centre = p.y - 3 * scale;
      const fit = channels.filter((c) => c.y1 - c.y0 >= up + down + 1).sort((a, b) => Math.abs((a.y0 + a.y1) / 2 - centre) - Math.abs((b.y0 + b.y1) / 2 - centre))[0];
      const mid = fit ? (fit.y0 + fit.y1) / 2 : centre;
      y = mid + (up - down) / 2;
    }
    knockouts.push({ x0: x - 1.2, x1: x + w + 1.2, y0: y - up - 1.2, y1: y + down + 1.2 });
    const node = el('text', { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, 'font-family': ctx.family, 'font-size': size, fill: t.ink }, [value]);
    textNodes.push({ node, tx });
  }

  // shapes
  const edgeGroups = new Map();
  let arcIndex = -1;
  let lastArcId = null;
  for (const sh of parts.shapes) {
    const pts = sh.pts.map(P);
    const stroke = gray(sh.style.stroke, t, 'stroke');
    const fill = sh.closed ? gray(sh.style.fill, t, 'fill') : 'none';
    const thin = Number(sh.style['stroke-width'] || 1) < 1 || sh.grid;
    const attrs = {
      d: polylineD(pts, sh.closed),
      fill,
      stroke,
      'stroke-width': stroke === 'none' ? undefined : thin ? t.stroke.boundary : t.stroke.wire,
      ...(sh.style['stroke-dasharray'] && sh.style['stroke-dasharray'] !== 'none' ? { 'stroke-dasharray': sh.style['stroke-dasharray'].split(/[\s,]+/).map((v) => num(Number(v) * (thin ? 1 : t.stroke.wire))).join(' ') } : {}),
      ...(stroke !== 'none' ? { 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter' } : {}),
    };
    if (sh.arc) {
      if (sh.id !== lastArcId || sh.pts === undefined) { arcIndex += 1; lastArcId = sh.id + arcIndex; }
      const e = edgeIds[arcIndex] ?? { from: 'x', to: `${arcIndex}` };
      const gid = `timing-edge-${e.from}-${e.to}${edgeIds.filter((x, k) => k < arcIndex && x.from === e.from && x.to === e.to).length ? `-${arcIndex}` : ''}`;
      if (!edgeGroups.has(gid)) edgeGroups.set(gid, []);
      // knock the arc out behind text it crosses, but never at its ends (node anchors, arrowhead)
      const reach = t.arrow.length + 2;
      const nearEnd = (b) => [pts[0], pts[pts.length - 1]].some((q) => q.x > b.x0 - reach && q.x < b.x1 + reach && q.y > b.y0 - reach && q.y < b.y1 + reach);
      const pieces = cutAround(pts, knockouts.filter((b) => !nearEnd(b)));
      let head = null;
      pieces.forEach((piece, k) => {
        if (piece.length < 2) return;
        const kidAttrs = { ...attrs, d: polylineD(piece, false), fill: 'none', stroke: t.ink, 'stroke-width': t.stroke.wire };
        edgeGroups.get(gid).push(el('path', { id: `${gid}-seg${edgeGroups.get(gid).filter((n) => /-seg\d+$/.test(n.attrs.id)).length}`, ...kidAttrs }));
        if (k === pieces.length - 1) head = piece;
      });
      if (sh.markers.end && head) {
        const a = pts[pts.length - 2]; const b = pts[pts.length - 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        edgeGroups.get(gid).push(arrowHead(t, `${gid}-arrow`, b, (b.x - a.x) / len, (b.y - a.y) / len, t.ink));
        // the shaft ends at the arrowhead base
        const segs = edgeGroups.get(gid).filter((n) => /-seg\d+$/.test(n.attrs.id));
        const lastSeg = segs[segs.length - 1];
        const shaft = [...head.slice(0, -1), { x: b.x - ((b.x - a.x) / len) * t.arrow.length, y: b.y - ((b.y - a.y) / len) * t.arrow.length }];
        lastSeg.attrs.d = polylineD(shaft, false);
      }
      if (sh.markers.start) {
        const a = pts[1]; const b = pts[0];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        edgeGroups.get(gid).push(arrowHead(t, `${gid}-tail`, b, (b.x - a.x) / len, (b.y - a.y) / len, t.ink));
      }
      continue;
    }
    const target = sh.layer?.kind === 'lane' ? laneGroup(sh.layer.index).wave : sh.layer?.kind === 'axis' ? layers.axis : sh.layer?.kind === 'groups' ? layers.groups : sh.layer?.kind === 'gaps' ? layers.gaps : layers.axis;
    if (sh.layer?.kind === 'axis' && sh.grid) { attrs.stroke = t.fill.bar; attrs['stroke-width'] = t.stroke.boundary; attrs['stroke-dasharray'] = `${num(t.stroke.boundary)} ${num(t.stroke.boundary * 3)}`; }
    target.push(el('path', attrs));
  }
  for (const r of parts.rects) {
    if (r.layer?.kind === 'edges') continue; // label backgrounds: arcs are knocked out instead
    if (r.x0 <= 0.5 && r.y0 <= 0.5 && r.x1 >= parts.width - 0.5) continue; // WaveDrom's page background
    const p0 = P({ x: r.x0, y: r.y0 });
    const p1 = P({ x: r.x1, y: r.y1 });
    layers.axis.push(el('rect', { x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y, fill: gray(r.style.fill, t, 'fill'), stroke: 'none' }));
  }
  for (const { node, tx } of textNodes) {
    if (tx.layer?.kind === 'lane') laneGroup(tx.layer.index)[tx.role === 'name' ? 'name' : 'values'].push(node);
    else if (tx.layer?.kind === 'edges') {
      const k = [...edgeGroups.keys()];
      const gid = k.find((g) => edgeGroups.get(g).labelled !== true) ?? k.at(-1) ?? 'timing-edge-labels';
      if (!edgeGroups.has(gid)) edgeGroups.set(gid, []);
      edgeGroups.get(gid).push(node);
      edgeGroups.get(gid).labelled = true;
    } else if (tx.layer?.kind === 'groups') layers.groups.push(node);
    else layers.axis.push(node);
  }

  // ids: text ids per layer
  const withIds = (prefix, nodes) => nodes.map((n, k) => { if (!n.attrs.id) n.attrs.id = `${prefix}-${k}`; return n; });
  const laneNodes = [...layers.lanes.entries()].sort((a, b) => a[0] - b[0]).map(([idx, g]) => {
    const id = `timing-signal-${laneIds[idx] ?? `lane${idx}`}`;
    return el('g', { id }, [
      el('g', { id: `${id}-name` }, withIds(`${id}-name`, g.name)),
      el('g', { id: `${id}-wave` }, withIds(`${id}-wave`, g.wave)),
      el('g', { id: `${id}-values` }, withIds(`${id}-value`, g.values)),
    ]);
  });
  const edgeNodes = [...edgeGroups.entries()].map(([gid, nodes]) => el('g', { id: gid }, nodes.map((n, k) => { if (!n.attrs.id) n.attrs.id = `${gid}-label${k ? `-${k}` : ''}`; return n; })));
  const svgTree = el('svg', { xmlns: 'http://www.w3.org/2000/svg', id: `fig-${name}-${variant}`, width: `${num(W)}pt`, height: `${num(H)}pt`, viewBox: `0 0 ${num(W)} ${num(H)}` }, [
    el('g', { id: 'frame' }, [el('rect', { x: 0, y: 0, width: W, height: H, fill: t.background, stroke: 'none' })]),
    el('g', { id: 'timing-axis' }, withIds('timing-axis', layers.axis)),
    el('g', { id: 'timing-signals' }, laneNodes),
    el('g', { id: 'timing-gaps' }, withIds('timing-gap', layers.gaps)),
    el('g', { id: 'timing-groups' }, withIds('timing-group', layers.groups)),
    el('g', { id: 'timing-edges' }, edgeNodes),
  ]);
  return { svgTree, width: W, height: H, diagnostics };
}

// Split a polyline where it passes through any knock-out box.
function cutAround(pts, boxes) {
  if (!boxes.length) return [pts];
  const inside = (p) => boxes.some((b) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1);
  // resample each segment finely so the cut follows the box edge
  const dense = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]; const b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
    for (let k = 0; k < n; k += 1) dense.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, corner: k === 0 });
  }
  dense.push({ ...pts[pts.length - 1], corner: true });
  const pieces = [];
  let cur = [];
  for (const p of dense) {
    if (inside(p)) { if (cur.length) pieces.push(cur); cur = []; continue; }
    cur.push(p);
  }
  if (cur.length) pieces.push(cur);
  // keep corners and piece ends only
  return pieces.map((piece) => piece.filter((p, k) => p.corner || k === 0 || k === piece.length - 1).map(({ x, y }) => ({ x, y })));
}
