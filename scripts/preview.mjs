#!/usr/bin/env node
// Rasterise one or more SVG figures at physical size × scale into one PNG for
// human review, each under its file name (lib/preview.mjs: resvg with the
// bundled fonts, no browser; --rasterizer chrome or FIGGEN_RASTERIZER=chrome
// uses headless Chrome).
// Usage: node scripts/preview.mjs --out preview.png [--scale 2.5] [--rasterizer resvg|chrome] a.svg b.svg ...

import fs from 'node:fs';
import path from 'node:path';
import { contactSheetSvg, rasterizeSvg, selectRasterizer } from '../lib/preview.mjs';

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const out = take('out');
const scale = Number(take('scale', '2.5'));
const requested = take('rasterizer');
const files = args.map((f) => path.resolve(f));
if (!out || !files.length) {
  console.error('usage: node scripts/preview.mjs --out preview.png [--scale 2.5] [--rasterizer resvg|chrome] a.svg b.svg ...');
  process.exit(2);
}
const rasterizer = selectRasterizer({ requested });
for (const d of rasterizer.diagnostics) console.error(`${d.severity} ${d.code}: ${d.message}`);
if (!rasterizer.ok) process.exit(2);
const sheet = contactSheetSvg(files.map((f) => {
  const svg = fs.readFileSync(f, 'utf8');
  const w = Number(/width="([\d.]+)pt"/.exec(svg)?.[1] ?? 0);
  const h = Number(/height="([\d.]+)pt"/.exec(svg)?.[1] ?? 0);
  return { caption: `${path.basename(f)} (${w} × ${h} pt) at ${scale}x`, svg };
}));
const shot = await rasterizeSvg(sheet, path.resolve(out), { scale, rasterizer });
if (!shot.ok) {
  console.error(`preview failed: ${shot.diagnostics.map((d) => d.message).join('; ')}`);
  process.exit(1);
}
console.log(`preview written: ${out}`);
