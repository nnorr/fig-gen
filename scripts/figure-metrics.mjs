#!/usr/bin/env node
// Routing/label quality metrics of rendered datapath SVGs (works on any
// renderer version that uses the net-<id>-seg<i> / nets-control group ids).
// Usage: node scripts/figure-metrics.mjs [--json] a.svg [b.svg ...]

import fs from 'node:fs';
import path from 'node:path';
import { loadFont } from '../lib/fonts.mjs';
import { crossingCounts, dataJogs, textLineCollisions } from '../lib/render/route-metrics.mjs';
import { scanTags } from '../lib/svg/figma-safe-lint.mjs';

const parsePath = (d) => {
  const polys = [];
  let cur = null;
  for (const m of d.matchAll(/([MLHV])\s*(-?[\d.]+)(?:\s+(-?[\d.]+))?/g)) {
    const last = cur?.[cur.length - 1];
    if (m[1] === 'M') { cur = [{ x: Number(m[2]), y: Number(m[3]) }]; polys.push(cur); } else if (m[1] === 'L') cur.push({ x: Number(m[2]), y: Number(m[3]) });
    else if (m[1] === 'H') cur.push({ x: Number(m[2]), y: last.y });
    else if (m[1] === 'V') cur.push({ x: last.x, y: Number(m[2]) });
  }
  return polys;
};

export async function svgMetrics(svg, { fontFamily = 'Arial' } = {}) {
  const tags = scanTags(svg);
  const ctrlStart = tags.find((t) => !t.closing && t.attrs.id === 'nets-control')?.offset ?? Infinity;
  const ctrlEnd = tags.find((t) => !t.closing && t.attrs.id === 'datapath')?.offset ?? Infinity;
  const nets = new Map();
  const lines = [];
  for (const t of tags.filter((x) => !x.closing)) {
    const id = t.attrs.id || '';
    const hw = Number(t.attrs['stroke-width'] || 0) / 2;
    if (t.lower === 'path' && t.attrs.d && t.attrs.stroke && t.attrs.stroke !== 'none' && !/-hatch/.test(id)) {
      for (const pl of parsePath(t.attrs.d)) for (let k = 1; k < pl.length; k += 1) lines.push({ id, a: pl[k - 1], b: pl[k], hw });
    }
    if (t.lower === 'rect' && t.attrs.stroke && t.attrs.stroke !== 'none' && !/^frame|-hatch/.test(id)) {
      const x = Number(t.attrs.x); const y = Number(t.attrs.y); const w = Number(t.attrs.width); const h = Number(t.attrs.height);
      const c = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
      c.forEach((p, k) => lines.push({ id, a: p, b: c[(k + 1) % 4], hw }));
    }
    const m = /^net-(.+)-seg\d+$/.exec(id);
    if (t.lower === 'path' && m) {
      if (!nets.has(m[1])) nets.set(m[1], { id: m[1], cls: t.offset > ctrlStart && t.offset < ctrlEnd ? 'control' : 'data', polylines: [] });
      nets.get(m[1]).polylines.push(...parsePath(t.attrs.d));
    }
  }
  const font = await loadFont(fontFamily);
  const texts = [];
  const re = /<text\b([^>]*)>([^<]*)<\/text>/g;
  for (const mm of svg.matchAll(re)) {
    const a = Object.fromEntries([...mm[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((q) => [q[1], q[2]]));
    const size = Number(a['font-size']);
    const value = mm[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const x = Number(a.x); const y = Number(a.y);
    texts.push({ id: a.id, text: value, x0: x, x1: x + font.measure(value, size), y0: y - font.ascent * size, y1: y + font.descent * size * 0.6 });
  }
  const list = [...nets.values()];
  const crossings = crossingCounts(list);
  const jogs = dataJogs(list);
  const collisions = textLineCollisions(texts, lines);
  // Bar-like glyphs: filled rects without stroke, grouped by element kind prefix.
  const filledBars = {};
  for (const t of tags.filter((x) => !x.closing && x.lower === 'rect' && /-body$/.test(x.attrs.id || '') && (x.attrs.stroke === 'none' || !x.attrs.stroke))) {
    const kind = t.attrs.id.split('-')[0];
    filledBars[kind] = (filledBars[kind] || 0) + 1;
  }
  return {
    crossings: crossings.counts,
    data_nets_straight: jogs.straight, data_nets_total: jogs.total, data_jogs_redundant: jogs.redundant, data_jogs_unavoidable: jogs.unavoidable,
    text_line_collisions: collisions.length, collisions, filled_bar_kinds: filledBars, jogs: jogs.jogs,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter((a) => a !== '--json');
  const result = {};
  for (const f of files) {
    const m = await svgMetrics(fs.readFileSync(f, 'utf8'));
    result[path.basename(f)] = m;
    if (!json) {
      console.log(`${path.basename(f)}: crossings data ${m.crossings.data}, control ${m.crossings.control}, mixed ${m.crossings.mixed}; data nets straight ${m.data_nets_straight}/${m.data_nets_total}; jogs redundant ${m.data_jogs_redundant}, unavoidable ${m.data_jogs_unavoidable}; text-line collisions ${m.text_line_collisions}; filled bars ${JSON.stringify(m.filled_bar_kinds)}`);
      for (const c of m.collisions) console.log(`  collision: "${c.text}" × ${c.line}`);
    }
  }
  if (json) console.log(JSON.stringify(result, null, 2));
}
