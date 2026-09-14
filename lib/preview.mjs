// PNG previews of rendered figures (fig-gen preview, deliver --preview). A
// preview is for looking at a figure; the SVG and PDF stay the deliverables.
//
// Rasterisers:
// - resvg (default): @resvg/resvg-js, a prebuilt native renderer, no browser.
//   It sees only fig-gen's bundled fonts (system fonts off) and every
//   font-family is mapped to the face layout measured with (fontKeyFor), so
//   PNG text has the faces and metrics of layout and the outlined PDF.
// - chrome (optional): headless Chrome, found the same way doctor finds it
//   (lib/env/chrome.mjs). Used only when selected (--rasterizer chrome or
//   FIGGEN_RASTERIZER=chrome) or when resvg cannot load on this platform.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome } from './env/chrome.mjs';
import { FONT_FILES, bundledSfntFiles, fontKeyFor } from './fonts.mjs';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const DEFAULT_SCALE = 2;
export const RASTERIZERS = Object.freeze(['resvg', 'chrome']);

const require = createRequire(import.meta.url);
const err = (code, message, supportedFixes = [], evidence = {}, severity = 'error') => ({ code, severity, message, subject: {}, evidence, supportedFixes });

// resvg-js loads a native binary for this platform; a missing one throws.
export function loadResvg() {
  try {
    const { Resvg } = require('@resvg/resvg-js');
    return { available: true, Resvg, version: require('@resvg/resvg-js/package.json').version };
  } catch (error) {
    return {
      available: false,
      reason: `@resvg/resvg-js did not load on ${process.platform}-${process.arch}: ${String(error?.message ?? error).split('\n')[0]}`,
      fix: 'run npm ci in the fig-gen directory (it installs the prebuilt resvg binary for this platform)',
    };
  }
}

// Chrome for previews. An explicit FIGGEN_CHROME that does not run is an
// error, never a silent fall back to another browser.
export function previewChrome({ env = process.env, platform = process.platform } = {}) {
  const found = findChrome({ env, platform });
  if (found.available && env.FIGGEN_CHROME && path.resolve(found.executable) !== path.resolve(env.FIGGEN_CHROME)) {
    return { available: false, reason: `FIGGEN_CHROME=${env.FIGGEN_CHROME} did not run`, fix: 'point FIGGEN_CHROME at a working Chrome/Chromium executable, or unset it' };
  }
  return found;
}

export function chromeMissing(chrome) {
  return err('preview/chrome-missing', `the chrome rasterizer was requested but headless Chrome is unavailable: ${chrome.reason}`,
    [chrome.fix, 'or use the default rasterizer, resvg (no browser): drop --rasterizer chrome and unset FIGGEN_RASTERIZER', 'run fig-gen doctor to check the environment'], { reason: chrome.reason });
}

// Choose the rasterizer: `requested` (--rasterizer), else FIGGEN_RASTERIZER,
// else resvg. Chrome is probed only when chosen or when resvg cannot load.
// Resolves to { ok, name, version, resvg?, chrome?, diagnostics }.
export function selectRasterizer({ requested, env = process.env, platform = process.platform, resvg = loadResvg, chrome = () => previewChrome({ env, platform }) } = {}) {
  const via = requested !== undefined ? '--rasterizer' : 'FIGGEN_RASTERIZER';
  const name = requested ?? (env.FIGGEN_RASTERIZER || undefined);
  if (name !== undefined && !RASTERIZERS.includes(name)) {
    return { ok: false, diagnostics: [err('preview/rasterizer', `${via} must be one of ${RASTERIZERS.join(', ')}, got ${name}`, ['--rasterizer resvg', 'unset FIGGEN_RASTERIZER'])] };
  }
  if (name === 'chrome') {
    const c = chrome();
    return c.available ? { ok: true, name: 'chrome', version: c.version, chrome: c, diagnostics: [] } : { ok: false, diagnostics: [chromeMissing(c)] };
  }
  const r = resvg();
  if (r.available) return { ok: true, name: 'resvg', version: r.version, resvg: r, diagnostics: [] };
  if (name === 'resvg') {
    return { ok: false, diagnostics: [err('preview/resvg-unavailable', `a PNG preview needs resvg: ${r.reason}`, [r.fix, 'or use headless Chrome: --rasterizer chrome', 'run fig-gen doctor to check the environment'], { reason: r.reason })] };
  }
  const c = chrome();
  if (c.available) {
    return { ok: true, name: 'chrome', version: c.version, chrome: c, diagnostics: [err('preview/resvg-fallback', `resvg could not load (${r.reason}); rasterising with headless Chrome instead, whose fonts may differ from layout`, [r.fix], { reason: r.reason }, 'warning')] };
  }
  return { ok: false, diagnostics: [err('preview/resvg-unavailable', `a PNG preview needs resvg, which did not load (${r.reason}), and no headless Chrome was found to fall back to (${c.reason})`, [r.fix, c.fix, 'run fig-gen doctor to check the environment'], { reason: r.reason, chrome: c.reason })] };
}

// What a report or receipt records about the rasterizer (no local paths).
export const rasterizerInfo = (r) => ({ name: r.name, ...(r.version ? { version: r.version } : {}) });

// Canvas size of an SVG in CSS pixels (1 pt = 4/3 px).
export function svgSizePx(svg) {
  const open = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const attr = (name) => new RegExp(`\\s${name}="([\\d.]+)(pt|px)?"`).exec(open);
  const w = attr('width');
  const h = attr('height');
  if (w && h) {
    const px = (m) => Number(m[1]) * (m[2] === 'px' ? 1 : m[2] === 'pt' ? 4 / 3 : 1);
    return { width: Math.ceil(px(w)), height: Math.ceil(px(h)) };
  }
  const vb = /\sviewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/.exec(open);
  return vb ? { width: Math.ceil(Number(vb[1])), height: Math.ceil(Number(vb[2])) } : null;
}

const stripXmlDecl = (svg) => svg.replace(/^﻿?\s*<\?xml[^>]*>\s*/, '');

// The SVG as resvg sees it: the root sized in CSS pixels (as the Chrome page
// sizes it) and every font family, attribute or CSS, replaced by the bundled
// face layout measured it with, so no other font can stand in.
export function resvgReadySvg(svg, size) {
  const family = (list) => FONT_FILES[fontKeyFor(list)].family;
  return stripXmlDecl(svg)
    .replace(/<svg\b[^>]*>/, (open) => open.replace(/\s(width|height)="[^"]*"/g, '').replace(/^<svg\b/, `<svg width="${size.width}" height="${size.height}"`))
    .replace(/(\sfont-family=)(["'])(.*?)\2/g, (m, attr, q, list) => `${attr}${q}${family(list)}${q}`)
    .replace(/(font-family\s*:\s*)([^;}"<]+)/g, (m, prop, list) => `${prop}${family(list)}`);
}

// Render with a loaded resvg: { png, pixels (RGBA), size }.
export function renderWithResvg(resvg, svg, size, scale) {
  const families = { sans: FONT_FILES.sans.family, serif: FONT_FILES.serif.family };
  const image = new resvg.Resvg(resvgReadySvg(svg, size), {
    fitTo: { mode: 'zoom', value: Number(scale) },
    background: '#ffffff',
    font: {
      loadSystemFonts: false,
      fontFiles: bundledSfntFiles().map((f) => f.path),
      defaultFontFamily: families.sans,
      sansSerifFamily: families.sans,
      serifFamily: families.serif,
      monospaceFamily: families.sans,
      cursiveFamily: families.sans,
      fantasyFamily: families.sans,
    },
    logLevel: 'off',
  }).render();
  return { png: image.asPng(), pixels: image.pixels, size: { width: image.width, height: image.height } };
}

// A PNG is complete once its IEND chunk is written.
const completePng = (buf) => buf.length > 20 && buf.subarray(0, 8).equals(PNG_SIGNATURE) && buf.subarray(-8, -4).toString('latin1') === 'IEND';

// Run Chrome until the screenshot is complete, then stop it: a headless
// Chrome (and the updater it wakes) may keep running after writing the file,
// so waiting for the process to exit can hang.
function screenshot(executable, args, shot, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    let stderr = '';
    let exited = null;
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => { exited = { error }; });
    child.on('exit', (code) => { exited ??= { code }; });
    const stop = () => {
      try { if (child.exitCode === null) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* already gone */ }
      child.stderr.destroy();
    };
    const started = Date.now();
    const poll = setInterval(() => {
      const png = fs.existsSync(shot) ? fs.readFileSync(shot) : null;
      if (png && completePng(png)) { clearInterval(poll); stop(); resolve({ png, stderr }); return; }
      if (exited?.error || (exited && !png) || Date.now() - started > timeoutMs) {
        clearInterval(poll); stop();
        resolve({ png: null, stderr, error: exited?.error?.message ?? (exited ? `exit ${exited.code}` : `no screenshot after ${Math.round(timeoutMs / 1000)} s`) });
      }
    }, 100);
  });
}

async function rasterizeChrome(chrome, svg, size, scale, timeoutMs) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-preview-'));
  try {
    const page = path.join(work, 'figure.html');
    const shot = path.join(work, 'figure.png');
    fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}svg{display:block;width:${size.width}px;height:${size.height}px}</style></head><body>${stripXmlDecl(svg)}</body></html>`);
    const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(work, 'profile')}`,
      `--force-device-scale-factor=${scale}`, `--window-size=${size.width},${size.height}`, `--screenshot=${shot}`, pathToFileURL(page).href];
    const { png, stderr, error } = await screenshot(chrome.executable, args, shot, timeoutMs);
    return png
      ? { png, size: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) } }
      : { error: err('preview/rasterise-failed', `headless Chrome did not write a PNG (${error})`, ['run fig-gen doctor', 'set FIGGEN_CHROME to another Chrome/Chromium', 'or use the default rasterizer, resvg'], { stderr: stderr.split('\n').slice(-5).join('\n') }) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Rasterise SVG text to a PNG file with a rasterizer from selectRasterizer.
// Resolves to { ok, diagnostics, bytes, size, rasterizer }.
export async function rasterizeSvg(svg, outPath, { scale = DEFAULT_SCALE, rasterizer = selectRasterizer(), timeoutMs = 60000 } = {}) {
  if (!rasterizer.ok) return { ok: false, diagnostics: rasterizer.diagnostics };
  if (!(Number(scale) > 0)) return { ok: false, diagnostics: [err('preview/scale', `--scale must be a positive number, got ${scale}`, ['--scale 2'])] };
  const size = svgSizePx(svg);
  if (!size) return { ok: false, diagnostics: [err('preview/svg-size', 'the SVG has no width/height or viewBox to size the preview', ['render the figure with fig-gen render first'])] };
  let shot;
  if (rasterizer.name === 'resvg') {
    try {
      shot = renderWithResvg(rasterizer.resvg, svg, size, scale);
    } catch (error) {
      shot = { error: err('preview/rasterise-failed', `resvg could not rasterise the SVG (${String(error?.message ?? error).split('\n')[0]})`, ['check the SVG with fig-gen lint-svg', 'or try --rasterizer chrome']) };
    }
  } else {
    shot = await rasterizeChrome(rasterizer.chrome, svg, size, Number(scale), timeoutMs);
  }
  if (shot.error) return { ok: false, diagnostics: [shot.error] };
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, shot.png);
  return { ok: true, diagnostics: [], bytes: shot.png.length, size: shot.size, rasterizer: rasterizerInfo(rasterizer) };
}

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Several SVG figures stacked on one SVG page, each under a caption, for a
// single review PNG (scripts/preview.mjs, scripts/render-theme-sample.mjs).
export function contactSheetSvg(items, { margin = 16, gap = 14, captionPx = 11 } = {}) {
  let y = margin;
  let width = 0;
  const parts = [];
  for (const { caption, svg } of items) {
    const size = svgSizePx(svg);
    if (!size) throw new Error(`${caption}: the SVG has no width/height or viewBox`);
    y += captionPx;
    parts.push(`<text x="${margin}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${captionPx}" fill="#444444">${escXml(caption)}</text>`);
    y += 5;
    parts.push(`<rect x="${margin - 0.5}" y="${y - 0.5}" width="${size.width + 1}" height="${size.height + 1}" fill="none" stroke="#cccccc"/>`);
    parts.push(stripXmlDecl(svg).replace(/<svg\b[^>]*>/, (open) => open.replace(/\s(x|y|width|height)="[^"]*"/g, '').replace(/^<svg\b/, `<svg x="${margin}" y="${y}" width="${size.width}" height="${size.height}"`)));
    y += size.height + gap;
    width = Math.max(width, size.width);
  }
  const w = width + 2 * margin;
  const h = y - gap + margin;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${parts.join('')}</svg>`;
}
