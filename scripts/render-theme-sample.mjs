#!/usr/bin/env node
// Renders examples/datapath-theme-sample.json with the prototype renderer in
// the netlist-mono theme for both column variants, lints the SVGs as
// figma-safe, and writes docs/samples/.
//
// Usage: node scripts/render-theme-sample.mjs [--mux-style bar|trapezoid]
//          [--mux-indices] [--prefix theme-sample] [--preview <file.png>] [--no-svg]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../lib/env/chrome.mjs';
import { renderDatapathPrototype } from '../lib/render/datapath-proto.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { validateFigure } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);

const doc = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'datapath-theme-sample.json'), 'utf8'));
doc.meta.style = { ...doc.meta.style, ...(opt('mux-style') ? { mux_style: opt('mux-style') } : {}), ...(flag('mux-indices') ? { mux_indices: true } : {}) };
const profiles = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'print-profiles.json'), 'utf8'));
const prefix = opt('prefix') || 'theme-sample';
const outDir = path.join(root, 'docs', 'samples');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-sample-'));
fs.mkdirSync(outDir, { recursive: true });

const schema = await validateFigure('datapath', doc);
if (!schema.ok) {
  console.error(JSON.stringify(schema.diagnostics, null, 2));
  process.exitCode = 1;
} else {
  const profile = profiles.profiles[doc.meta.print.profile];
  const report = [];
  const svgFiles = {};
  for (const variant of doc.meta.print.variants) {
    const v = profile.variants[variant];
    const result = await renderDatapathPrototype(doc, { variant, widthPt: v.width_pt, name: prefix });
    const lint = lintFigmaSafe(result.svg);
    const file = flag('no-svg') ? path.join(workDir, `${prefix}.${variant}.svg`) : path.join(outDir, `${prefix}.${variant}.svg`);
    fs.writeFileSync(file, result.svg);
    svgFiles[variant] = { file, width: result.width_pt };
    const print = [];
    if (result.min_font_pt < v.min_font_pt) print.push('print/min-font');
    if (result.min_stroke_pt < v.min_stroke_pt) print.push('print/min-stroke');
    if (result.height_pt > v.max_height_pt) print.push('print/max-height');
    report.push({
      variant,
      file: path.relative(root, file),
      style: { mux_style: doc.meta.style.mux_style ?? 'skin default', mux_indices: doc.meta.style.mux_indices ?? 'skin default' },
      size_pt: [Number(result.width_pt.toFixed(2)), Number(result.height_pt.toFixed(2))],
      content_width_pt: Number(result.content_width_pt.toFixed(2)),
      min_font_pt: result.min_font_pt,
      min_stroke_pt: result.min_stroke_pt,
      svg_lint: lint.length ? lint.map((d) => d.code) : 'pass',
      print_checks: print.length ? print : 'pass',
      diagnostics: result.diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message}`),
    });
  }

  const preview = opt('preview');
  if (preview) {
    const chrome = findChrome();
    if (!chrome.available) {
      console.error(`preview skipped: ${chrome.reason}`);
    } else {
      const scale = 2.5;
      const html = path.join(workDir, 'preview.html');
      const blocks = Object.entries(svgFiles).sort(([a], [b]) => (a < b ? 1 : -1)).map(([variant, { file, width }]) => (
        `<div style="font:14px sans-serif;margin:12px 0 4px">${prefix} ${variant} (${width} pt) at ${scale}x</div>`
        + `<img src="file://${file}" style="width:${Math.round(width * scale * (96 / 72))}px;border:1px solid #ccc">`));
      fs.writeFileSync(html, `<html><body style="margin:0;padding:12px 20px;background:#fff">${blocks.join('')}</body></html>`);
      const widest = Math.max(...Object.values(svgFiles).map((f) => f.width));
      const target = path.resolve(root, preview);
      const run = spawnSync(chrome.executable, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars',
        `--screenshot=${target}`, `--window-size=${Math.round(widest * scale * (96 / 72)) + 60},760`, `file://${html}`], { encoding: 'utf8' });
      console.error(run.status === 0 ? `preview written: ${path.relative(root, target)}` : `preview failed: ${run.stderr.slice(0, 400)}`);
      if (run.status !== 0) process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.some((r) => r.svg_lint !== 'pass' || r.print_checks !== 'pass' || r.diagnostics.some((d) => d.startsWith('error')))) process.exitCode = 1;
}
fs.rmSync(workDir, { recursive: true, force: true });
