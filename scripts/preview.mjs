#!/usr/bin/env node
// Screenshot one or more SVG figures at physical size × scale into a PNG for
// human review (headless Chrome/Chromium; set FIGGEN_CHROME to override).
// Usage: node scripts/preview.mjs --out preview.png [--scale 2.5] a.svg b.svg ...

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome } from '../lib/env/chrome.mjs';

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const out = take('out');
const scale = Number(take('scale', '2.5'));
const files = args.map((f) => path.resolve(f));
if (!out || !files.length) {
  console.error('usage: node scripts/preview.mjs --out preview.png [--scale 2.5] a.svg b.svg ...');
  process.exit(2);
}
const chrome = findChrome();
if (!chrome.available) {
  console.error(`preview skipped: ${chrome.reason}`);
  process.exit(2);
}
const px = (pt) => Math.round(pt * scale * (96 / 72));
const blocks = [];
let width = 0;
let height = 40;
for (const f of files) {
  const svg = fs.readFileSync(f, 'utf8');
  const w = Number(/width="([\d.]+)pt"/.exec(svg)?.[1] ?? 0);
  const h = Number(/height="([\d.]+)pt"/.exec(svg)?.[1] ?? 0);
  width = Math.max(width, px(w));
  height += px(h) + 40;
  blocks.push(`<div style="font:14px sans-serif;margin:10px 0 4px">${path.basename(f)} (${w} × ${h} pt) at ${scale}x</div><img src="file://${f}" style="width:${px(w)}px;height:${px(h)}px;border:1px solid #ccc">`);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-preview-'));
const html = path.join(work, 'preview.html');
fs.writeFileSync(html, `<html><body style="margin:0;padding:10px 20px;background:#fff">${blocks.join('')}</body></html>`);
const run = spawnSync(chrome.executable, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars',
  `--screenshot=${path.resolve(out)}`, `--window-size=${width + 60},${height}`, `file://${html}`], { encoding: 'utf8' });
fs.rmSync(work, { recursive: true, force: true });
if (run.status !== 0) {
  console.error(`preview failed: ${run.stderr.slice(0, 500)}`);
  process.exit(1);
}
console.log(`preview written: ${out}`);
