// PNG previews of rendered figures (fig-gen preview, deliver --preview): the
// SVG is rasterised by headless Chrome, found the same way doctor finds it
// (lib/env/chrome.mjs). A preview is for looking at a figure; the SVG and PDF
// stay the deliverables.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome } from './env/chrome.mjs';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const DEFAULT_SCALE = 2;

const err = (code, message, supportedFixes = [], evidence = {}) => ({ code, severity: 'error', message, subject: {}, evidence, supportedFixes });

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
  return err('preview/chrome-missing', `a PNG preview needs headless Chrome: ${chrome.reason}`, [chrome.fix, 'run fig-gen doctor to check the environment'], { reason: chrome.reason });
}

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

// Rasterise SVG text to a PNG file. Resolves to { ok, diagnostics, bytes, size }.
export async function rasterizeSvg(svg, outPath, { scale = DEFAULT_SCALE, chrome = previewChrome(), timeoutMs = 60000 } = {}) {
  if (!chrome.available) return { ok: false, diagnostics: [chromeMissing(chrome)] };
  if (!(Number(scale) > 0)) return { ok: false, diagnostics: [err('preview/scale', `--scale must be a positive number, got ${scale}`, ['--scale 2'])] };
  const size = svgSizePx(svg);
  if (!size) return { ok: false, diagnostics: [err('preview/svg-size', 'the SVG has no width/height or viewBox to size the preview', ['render the figure with fig-gen render first'])] };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-preview-'));
  try {
    const page = path.join(work, 'figure.html');
    const shot = path.join(work, 'figure.png');
    fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}svg{display:block;width:${size.width}px;height:${size.height}px}</style></head><body>${svg.replace(/^<\?xml[^>]*>\s*/, '')}</body></html>`);
    const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(work, 'profile')}`,
      `--force-device-scale-factor=${scale}`, `--window-size=${size.width},${size.height}`, `--screenshot=${shot}`, pathToFileURL(page).href];
    const { png, stderr, error } = await screenshot(chrome.executable, args, shot, timeoutMs);
    if (!png) {
      return { ok: false, diagnostics: [err('preview/rasterise-failed', `headless Chrome did not write a PNG (${error})`, ['run fig-gen doctor', 'set FIGGEN_CHROME to another Chrome/Chromium'], { stderr: stderr.split('\n').slice(-5).join('\n') })] };
    }
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, png);
    return { ok: true, diagnostics: [], bytes: png.length, size: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) } };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
