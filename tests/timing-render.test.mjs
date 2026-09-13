// Timing figures (SPEC §6): WaveJSON checks, the WaveDrom render with its
// figma-safe post-process verified on the SVG, column fitting bounded by the
// font floor, a golden structure test pinning WaveDrom's output shape, and
// paper and study delivery with schema-valid receipts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTiming, datapathStages, expandWave, literalNumber } from '../lib/checks/timing.mjs';
import { deliver } from '../lib/deliver.mjs';
import { renderTiming } from '../lib/render/timing.mjs';
import { collect, parseSkinCss, parseTransform, pathPolylines } from '../lib/render/timing-postprocess.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-timing-'));
const codes = (list, code) => list.filter((d) => d.code === code);

// A 12-cycle valid/ready transfer with a 5-cycle latency arrow.
function sample() {
  return {
    schema_version: 1, figure_type: 'timing',
    meta: { title: 'Valid/ready transfer', print: { profile: 'ieee' } },
    wavejson: {
      signal: [
        { name: 'clk', wave: 'p...........' },
        { name: 'in_valid_i', wave: '01...0......', node: '.a..........' },
        { name: 'in_data_i', wave: 'x=...x......', data: ['0x2A'] },
        { name: 'in_ready_o', wave: '0..1.0......' },
        { name: 'out_valid_o', wave: '0.....1.0...', node: '......b.....' },
        { name: 'out_data_o', wave: 'x.....=.x...', data: ['0x55'] },
      ],
      edge: ['a~>b 5 cycles'],
      head: { tick: 0 },
    },
    clock: { name: 'clk', edge: 'pos' },
    signals: { in_data_i: { width: 8 }, out_data_o: { width: 8 } },
    latencies: [{ edge: 'a~>b', cycles: 5 }],
    handshakes: [{ valid: 'in_valid_i', ready: 'in_ready_o', data: 'in_data_i', protocol: 'valid_ready' }],
  };
}

test('checks: a clean figure passes; every timing code fires on its defect', async () => {
  assert.deepEqual(await validateSchema('timing', sample()), []);
  assert.deepEqual(checkTiming(sample()).diagnostics, []);
  const variant = (mutate, opts = {}) => { const doc = sample(); mutate(doc); return checkTiming(doc, opts).diagnostics; };
  assert.equal(codes(variant((d) => { d.wavejson.signal[0].wave = 'p..1........'; }), 'timing/clock-irregular').length, 1);
  assert.equal(codes(variant((d) => { d.wavejson.signal[3].wave = '0..1.0'; }), 'timing/wave-length').length, 1);
  assert.equal(codes(variant((d) => { d.wavejson.signal[2].wave = 'x=..=x......'; }), 'timing/bus-data-count').length, 1);
  assert.equal(codes(variant((d) => { d.signals.in_data_i.width = 4; }), 'timing/bus-width-overflow').length, 1);
  assert.equal(codes(variant((d) => { d.latencies[0].cycles = 4; }), 'timing/latency-mismatch').length, 1);
  const hs = variant((d) => { d.wavejson.signal[1].wave = '010.........'; });
  assert.equal(codes(hs, 'timing/handshake-violation').length, 1);
  assert.equal(codes(hs, 'timing/handshake-violation')[0].severity, 'warning');
  assert.equal(codes(variant((d) => { d.wavejson.signal[3].wave = '0<1>.0......'; }), 'timing/wavejson-unsupported').length, 1);
  const unreadable = (quality) => codes(variant((d) => { d.wavejson.signal[3].name = 'rd'; d.handshakes[0].ready = 'rd'; }, { quality }), 'label/unreadable');
  assert.equal(unreadable().length, 0, '"rd" reads as "read" through the dictionary');
  const cryptic = (quality) => codes(variant((d) => { d.wavejson.signal[3].name = 'q'; d.handshakes[0].ready = 'q'; }, { quality }), 'label/unreadable');
  assert.equal(cryptic()[0].severity, 'warning');
  assert.equal(cryptic('paper')[0].severity, 'error');
  // helpers
  assert.equal(expandWave({ wave: 'p.', period: 2 }).length, 4);
  assert.equal(literalNumber("8'h1f"), 31n);
  assert.equal(literalNumber('Q0'), null);
  const dp = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'datapath-pipelined-xor.json'), 'utf8'));
  assert.equal(datapathStages(dp, 'a', 'y'), 2);
});

test('post-process units: CSS selectors, path data and transforms outside the supported forms fail loudly', () => {
  const css = parseSkinCss('text{font-size:11pt}.s1{stroke:#000;stroke-width:1}');
  assert.equal(css.class.s1.stroke, '#000');
  assert.throws(() => parseSkinCss('g text{fill:#000}'), /unsupported CSS selector/);
  const rel = pathPolylines('m 46,45 40,0 0,60');
  assert.deepEqual(rel[0].pts.at(-1), { x: 86, y: 105 });
  const curve = pathPolylines('M 46,45 c 28, 0 12, 60 40, 60');
  assert.deepEqual(curve[0].pts.at(-1), { x: 86, y: 105 });
  assert.ok(curve[0].pts.length > 2, 'curves are flattened to short lines');
  assert.throws(() => pathPolylines('M0 0 A 5 5 0 0 1 10 10'), /unsupported path command/);
  assert.throws(() => parseTransform('skewX(10)'), /unsupported transform/);
});

test('render 2col: figma-safe, named layers, uniform arrowheads, readable text, fitted to the column', async () => {
  const doc = sample();
  const r = await renderTiming(doc, { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'vr' });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.deepEqual(lintFigmaSafe(r.svg), []);
  assert.ok(r.width_pt <= 515.5 + 0.01 && r.height_pt <= 230.4);
  for (const bad of [/<use/, /<style/, /class=/, /marker/, /text-anchor/, /transform=/, /xml:space/]) assert.doesNotMatch(r.svg, bad);
  for (const id of ['timing-axis', 'timing-signals', 'timing-signal-clk', 'timing-signal-in-valid-i-wave', 'timing-edges', 'timing-edge-a-b']) assert.match(r.svg, new RegExp(`<g id="${id}"`));
  assert.doesNotMatch(r.svg, /svgcontent|wavelane|gmark/, 'WaveDrom internal ids are replaced');
  // arrowheads: the one skin size, and the shaft ends at the head's base
  const heads = [...r.svg.matchAll(/<path id="([^"]*-arrow)" d="([^"]+)"/g)];
  assert.ok(heads.length >= 1);
  for (const [, id, d] of heads) {
    const p = [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    const base = { x: (p[0].x + p[2].x) / 2, y: (p[0].y + p[2].y) / 2 };
    assert.ok(Math.abs(Math.hypot(p[1].x - base.x, p[1].y - base.y) - 5) < 0.06, id);
    assert.ok(Math.abs(Math.hypot(p[0].x - p[2].x, p[0].y - p[2].y) - 3.6) < 0.06, id);
    const segs = [...r.svg.matchAll(new RegExp(`<path id="${id.replace(/-arrow$/, '')}-seg\\d+" d="([^"]+)"`, 'g'))].map((m) => m[1]);
    const last = [...segs.at(-1).matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].at(-1);
    assert.ok(Math.hypot(Number(last[1]) - base.x, Number(last[2]) - base.y) < 0.05, `${id} shaft meets its head`);
  }
  // printed text: readable lane names with widths, values, the latency label; node letters are not printed
  const texts = [...r.svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);
  for (const expected of ['clock', 'in valid', 'in data /8', 'out data /8', '0x2A', '5 cycles']) assert.ok(texts.includes(expected), `${expected} in ${texts.join(' | ')}`);
  for (const x of texts) assert.doesNotMatch(x, /_/, x);
  assert.ok(!texts.includes('a') && !texts.includes('b'));
  // lane names at the label size, values and ticks at the secondary size
  assert.match(r.svg, /<text[^>]*font-size="8"[^>]*>clock</);
  assert.match(r.svg, /<text[^>]*font-size="7"[^>]*>0x2A</);
  assert.ok(r.min_stroke_pt >= 0.5);
});

test('fitting: a figure that needs text below the floor reports print/min-font instead of shrinking', async () => {
  const r = await renderTiming(sample(), { variant: '1col', widthPt: 252, maxHeightPt: 187.2, name: 'vr' });
  assert.equal(codes(r.diagnostics, 'print/min-font').length, 1);
  assert.ok(r.min_font_pt >= 7, 'text is never scaled down');
  // a declared hscale is the widest tried, never forced past the column
  const doc = sample();
  doc.fit = { '2col': { hscale: 4 } };
  const wide = await renderTiming(doc, { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'vr' });
  assert.deepEqual(wide.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.ok(wide.layout.hscale <= 4 && wide.width_pt <= 515.5 + 0.01);
});

test('golden: WaveDrom 3.7.0 output keeps the structure the post-process relies on', () => {
  const wavedrom = require('wavedrom');
  const skin = require('wavedrom/skins/default.js');
  assert.equal(require('wavedrom/package.json').version, '3.7.0', 'upgrading WaveDrom needs a review of the post-process');
  const tree = wavedrom.renderAny(0, sample().wavejson, skin);
  assert.equal(tree[0], 'svg');
  const style = tree.find((k) => Array.isArray(k) && k[0] === 'style');
  const css = parseSkinCss(style[2]);
  assert.deepEqual(Object.keys(css.element), ['text']);
  assert.ok(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 'info', 'muted'].every((c) => css.class[c]));
  const defs = tree.find((k) => Array.isArray(k) && k[0] === 'defs');
  const ids = new Set(defs.slice(2).map((g) => g[1]?.id));
  for (const id of ['pclk', 'nclk', '000', '111', 'xxx', 'vvv-2', 'arrowhead', 'arrowtail', 'tee', 'gap']) assert.ok(ids.has(id) || [...defs.slice(2)].some((g) => g[0] === 'marker' && g[1]?.id === id), id);
  const letters = new Set();
  (function walk(n) { if (!Array.isArray(n)) return; if (typeof n[1]?.d === 'string') for (const m of n[1].d.matchAll(/[A-Za-z]/g)) letters.add(m[0]); n.slice(2).forEach(walk); })(tree);
  assert.ok([...letters].every((c) => 'CLMclmz'.includes(c)), [...letters].join(''));
  const parts = collect(tree, { css });
  assert.equal(parts.width, 600, 'WaveDrom 3.7.0 draws the 12-cycle sample 600 units wide (name column + 40 per cycle + padding)');
  assert.ok(parts.shapes.length > 50 && parts.texts.some((x) => x.role === 'name') && parts.shapes.some((s) => s.markers.end));
});

test('delivery: paper (2col) and study write SVG and schema-valid receipts with a timing verification region', async () => {
  const dir = tmp();
  try {
    const figure = path.join(root, 'examples', 'timing-valid-ready.json');
    const paper = await deliver({ type: 'timing', figurePath: figure, outDir: path.join(dir, 'paper') });
    assert.equal(paper.ok, true, paper.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`).join('; '));
    const names = fs.readdirSync(path.join(dir, 'paper'));
    assert.ok(names.includes('timing-valid-ready.2col.svg') && names.includes('timing-valid-ready.2col.pdf') && names.includes('timing-valid-ready.receipt.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'paper', 'timing-valid-ready.receipt.json'), 'utf8'));
    assert.deepEqual(await validateSchema('receipt', receipt), []);
    assert.equal(receipt.figure.type, 'timing');
    assert.equal(receipt.verification.regions[0].kind, 'timing');
    assert.equal(receipt.verification.level, 'unverified');
    const study = await deliver({ type: 'timing', figurePath: figure, outDir: path.join(dir, 'study'), format: 'study', pdf: false });
    assert.equal(study.ok, true, study.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`).join('; '));
    assert.ok(fs.readdirSync(path.join(dir, 'study')).includes('timing-valid-ready.study.svg'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
