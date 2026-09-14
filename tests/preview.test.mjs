// PNG previews: resvg by default with the bundled fonts and no browser;
// headless Chrome only when selected or as the fallback when resvg cannot
// load; no other code path reaches Chrome.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import { deliver } from '../lib/deliver.mjs';
import { FONT_FILES, bundledSfntFiles, loadFont, woffToSfnt } from '../lib/fonts.mjs';
import { PNG_SIGNATURE, contactSheetSvg, rasterizeSvg, renderWithResvg, resvgReadySvg, selectRasterizer, svgSizePx } from '../lib/preview.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'fig-gen.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-preview-test-'));
const example = (name) => path.join(root, 'examples', name);
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
// Environment with no usable Chrome and no rasterizer choice.
const noChromeEnv = (dir) => {
  const env = { ...process.env, FIGGEN_CHROME: path.join(dir, 'no-such-chrome') };
  delete env.FIGGEN_RASTERIZER;
  return env;
};
const runCli = (args, env) => {
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
  return { status: run.status, out: JSON.parse(run.stdout), stderr: run.stderr };
};
const unavailable = (reason) => () => ({ available: false, reason, fix: `fix ${reason}` });
const never = (what) => () => { throw new Error(`${what} must not be probed`); };

test('preview: SVG canvas size in pixels', () => {
  assert.deepEqual(svgSizePx('<svg width="30pt" height="15pt">'), { width: 40, height: 20 });
  assert.deepEqual(svgSizePx('<svg viewBox="0 0 12 7">'), { width: 12, height: 7 });
  assert.equal(svgSizePx('<svg>'), null);
});

test('preview: the command rasterises with resvg when no Chrome exists, at the Chrome page size × scale', () => {
  const dir = tmp();
  try {
    const svg = path.join(dir, 'x.svg');
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="20pt" height="10pt" viewBox="0 0 20 10"><rect x="1" y="1" width="18" height="8" fill="none" stroke="#000"/></svg>');
    const { status, out, stderr } = runCli(['preview', svg, '--scale', '2'], noChromeEnv(dir));
    assert.equal(status, 0, stderr + JSON.stringify(out));
    assert.deepEqual(out.rasterizer, { name: 'resvg', version: '2.6.2' });
    assert.deepEqual(out.diagnostics, []);
    const png = fs.readFileSync(path.join(dir, 'x.png'));
    assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
    // 20 pt = 26.67 px → 27 px canvas (as the Chrome page), × 2.
    assert.deepEqual(pngSize(png), { width: 54, height: 28 });
    assert.deepEqual(out.size_px, { width: 54, height: 28 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preview: a missing Chrome is an error only when chrome is requested (--rasterizer or FIGGEN_RASTERIZER)', async () => {
  const dir = tmp();
  try {
    const svg = path.join(dir, 'x.svg');
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="20pt" height="10pt"/>');
    for (const [args, env] of [[['--rasterizer', 'chrome'], noChromeEnv(dir)], [[], { ...noChromeEnv(dir), FIGGEN_RASTERIZER: 'chrome' }]]) {
      const { status, out } = runCli(['preview', svg, ...args], env);
      assert.equal(status, 1);
      assert.equal(out.ok, false);
      assert.match(out.diagnostics[0], /^error preview\/chrome-missing: the chrome rasterizer was requested but headless Chrome is unavailable: FIGGEN_CHROME=.*no-such-chrome did not run/);
      assert.ok(out.fix.some((f) => /default rasterizer, resvg/.test(f)));
      assert.ok(out.fix.some((f) => /fig-gen doctor/.test(f)));
      assert.equal(fs.existsSync(path.join(dir, 'x.png')), false);
    }
    const bad = runCli(['preview', svg, '--rasterizer', 'inkscape'], noChromeEnv(dir));
    assert.equal(bad.status, 1);
    assert.match(bad.out.diagnostics[0], /^error preview\/rasterizer: --rasterizer must be one of resvg, chrome, got inkscape/);
    const lib = await rasterizeSvg('<svg width="1pt" height="1pt"/>', path.join(dir, 'y.png'), { rasterizer: selectRasterizer({ requested: 'chrome', chrome: unavailable('none here') }) });
    assert.equal(lib.ok, false);
    assert.equal(lib.diagnostics[0].code, 'preview/chrome-missing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preview: rasterizer selection — resvg by default without probing Chrome; Chrome as a diagnosed fallback', () => {
  const resvgOk = () => ({ available: true, version: '2.6.2', Resvg: class {} });
  const chromeOk = () => ({ available: true, executable: '/opt/chrome', version: 'Chromium 1' });
  const env = {};
  const def = selectRasterizer({ env, resvg: resvgOk, chrome: never('Chrome') });
  assert.equal(def.ok, true);
  assert.equal(def.name, 'resvg');
  assert.deepEqual(def.diagnostics, []);
  assert.equal(selectRasterizer({ env: { FIGGEN_RASTERIZER: 'resvg' }, resvg: resvgOk, chrome: never('Chrome') }).name, 'resvg');
  assert.equal(selectRasterizer({ requested: 'chrome', env: { FIGGEN_RASTERIZER: 'resvg' }, resvg: never('resvg'), chrome: chromeOk }).name, 'chrome', '--rasterizer wins over the environment');

  const fallback = selectRasterizer({ env, resvg: unavailable('no binary for this platform'), chrome: chromeOk });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.name, 'chrome');
  assert.equal(fallback.diagnostics.length, 1);
  assert.equal(fallback.diagnostics[0].code, 'preview/resvg-fallback');
  assert.equal(fallback.diagnostics[0].severity, 'warning');
  assert.match(fallback.diagnostics[0].message, /resvg could not load \(no binary for this platform\); rasterising with headless Chrome/);

  const none = selectRasterizer({ env, resvg: unavailable('no binary'), chrome: unavailable('no Chrome') });
  assert.equal(none.ok, false);
  assert.equal(none.diagnostics[0].code, 'preview/resvg-unavailable');
  assert.match(none.diagnostics[0].message, /needs resvg, which did not load \(no binary\), and no headless Chrome was found to fall back to \(no Chrome\)/);

  const explicit = selectRasterizer({ requested: 'resvg', env, resvg: unavailable('no binary'), chrome: never('Chrome') });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.diagnostics[0].code, 'preview/resvg-unavailable');
});

test('preview: WOFF fonts unwrap to sfnt files with the same glyph metrics layout uses', () => {
  const files = bundledSfntFiles();
  assert.deepEqual(files.map((f) => f.key).sort(), Object.keys(FONT_FILES).sort());
  for (const f of files) {
    const bytes = fs.readFileSync(f.path);
    assert.ok(['00010000', '4f54544f', '74727565'].includes(bytes.subarray(0, 4).toString('hex')), `${f.path} is an sfnt file`);
    assert.ok(bytes.equals(woffToSfnt(fs.readFileSync(path.join(root, FONT_FILES[f.key].file)))));
    const sfnt = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const layout = loadFont(FONT_FILES[f.key].css);
    assert.equal(sfnt.getEnglishName('fontFamily'), f.family);
    for (const text of ['Syndrome 0x1F', 'WAVE ×']) assert.equal(sfnt.getAdvanceWidth(text, 10, { kerning: true }), layout.measure(text, 10));
  }
  assert.equal(bundledSfntFiles(), files, 'cached per process');
  const plain = Buffer.from('not woff');
  assert.equal(woffToSfnt(plain).toString(), 'not woff');
});

test('preview: every font family is replaced by the bundled face layout measured with', () => {
  const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="30pt" height="15pt" viewBox="0 0 30 15">'
    + '<text font-family="Arial, Helvetica, sans-serif">a</text><text font-family=\'"Times New Roman", Times, serif\'>b</text>'
    + '<text font-family="Libertinus Serif, serif">c</text><text style="font-size:7px;font-family:Helvetica, sans-serif">d</text>'
    + '<text font-family="Comic Sans MS">e</text></svg>';
  const ready = resvgReadySvg(svg, svgSizePx(svg));
  assert.match(ready, /^<svg width="40" height="20" xmlns="[^"]+" viewBox="0 0 30 15">/);
  assert.deepEqual([...ready.matchAll(/font-family(?:=["']|:)([^"';]+)/g)].map((m) => m[1]), ['Arimo', 'Tinos', 'Libertinus Serif', 'Arimo', 'Arimo']);
});

test('preview: resvg draws text in the bundled faces with system fonts off (pixels match the layout/PDF glyph outlines)', () => {
  const rasterizer = selectRasterizer({ requested: 'resvg' });
  assert.equal(rasterizer.ok, true, JSON.stringify(rasterizer.diagnostics));
  // A string whose outline is finite in every bundled face (opentype.js pair
  // positioning yields NaN for some Libertinus pairs, e.g. "Sy").
  const text = 'BLOCK 0x1F';
  const page = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="60" viewBox="0 0 420 60">${body}</svg>`;
  const render = (svg) => renderWithResvg(rasterizer.resvg, svg, svgSizePx(svg), 1).pixels;
  // <text> as resvg draws it, and the same string as the outline the PDF gets.
  const asText = (family) => render(page(`<text x="10" y="45" font-family="${family}" font-size="40" fill="#000">${text}</text>`));
  const asOutline = (family) => {
    const d = loadFont(family).outline(text, 10, 45, 40);
    assert.doesNotMatch(d, /NaN/, `${family} outline of ${text}`);
    return render(page(`<path d="${d}" fill="#000"/>`));
  };
  const differing = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 96) n += 1;
    return n;
  };
  const families = ['Arial, Helvetica, sans-serif', 'Times New Roman, Times, serif', 'Libertinus Serif, serif'];
  for (const family of families) {
    const own = differing(asText(family), asOutline(family));
    for (const other of families.filter((f) => f !== family)) {
      const foreign = differing(asText(family), asOutline(other));
      assert.ok(own * 5 < foreign, `${family}: ${own} px differ from its own outline, ${foreign} px from ${other}`);
    }
    assert.ok(own < 60, `${family}: ${own} px differ from the layout outline`);
  }
  // A family no bundled font carries falls back to the layout default (Arimo), not a system font.
  assert.ok(differing(asText('Comic Sans MS'), asOutline('Arial')) < 60);
});

test('preview: a figure JSON and deliver --preview write PNGs with resvg, recorded in the receipt', async () => {
  const dir = tmp();
  try {
    const target = path.join(dir, 'fig.png');
    const { status, out, stderr } = runCli(['preview', example('datapath-pipelined-xor.json'), '--out', target, '--scale', '1'], noChromeEnv(dir));
    assert.equal(status, 0, stderr + JSON.stringify(out));
    assert.equal(out.rasterizer.name, 'resvg');
    assert.ok(fs.readFileSync(target).subarray(0, 8).equals(PNG_SIGNATURE));
    const outDir = path.join(dir, 'out');
    const r = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir, format: 'study', pdf: false, preview: { scale: 1 } });
    assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error' || d.code.startsWith('preview/')), []);
    const png = path.join(outDir, 'datapath-pipelined-xor.study.png');
    assert.ok(fs.readFileSync(png).subarray(0, 8).equals(PNG_SIGNATURE));
    const entry = r.receipt.variants[0].preview;
    assert.equal(entry.path, 'datapath-pipelined-xor.study.png');
    assert.deepEqual(entry.rasterizer, { name: 'resvg', version: '2.6.2' });
    const svgSize = svgSizePx(fs.readFileSync(path.join(outDir, 'datapath-pipelined-xor.study.svg'), 'utf8'));
    assert.deepEqual(pngSize(fs.readFileSync(png)), svgSize);
    assert.deepEqual(await validateSchema('receipt', r.receipt), []);
    // A later delivery archives the preview with the rest.
    const again = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir, format: 'study', pdf: false });
    assert.ok(fs.readdirSync(again.archived).includes('datapath-pipelined-xor.study.png'));
    assert.equal(fs.existsSync(png), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preview: deliver --preview with an unavailable requested rasterizer still delivers, with a warning', async () => {
  const dir = tmp();
  const saved = process.env.FIGGEN_CHROME;
  process.env.FIGGEN_CHROME = path.join(dir, 'no-such-chrome');
  try {
    const r = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: path.join(dir, 'out'), format: 'study', pdf: false, preview: { scale: 1, rasterizer: 'chrome' } });
    assert.equal(r.ok, true);
    const warnings = r.diagnostics.filter((d) => d.code === 'preview/chrome-missing');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'warning');
    assert.equal(r.receipt.variants[0].preview, undefined);
  } finally {
    if (saved === undefined) delete process.env.FIGGEN_CHROME; else process.env.FIGGEN_CHROME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preview: a contact sheet stacks figures under captions into one PNG', async () => {
  const dir = tmp();
  try {
    const a = '<svg xmlns="http://www.w3.org/2000/svg" width="30pt" height="15pt" viewBox="0 0 30 15"><rect width="30" height="15"/></svg>';
    const b = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="60" height="10" viewBox="0 0 60 10"/>';
    const sheet = contactSheetSvg([{ caption: 'a <2col>', svg: a }, { caption: 'b', svg: b }]);
    assert.match(sheet, /a &lt;2col&gt;/);
    assert.equal((sheet.match(/<\?xml/g) || []).length, 0);
    assert.deepEqual(svgSizePx(sheet), { width: 60 + 32, height: 16 + 11 + 5 + 20 + 14 + 11 + 5 + 10 + 16 });
    const shot = await rasterizeSvg(sheet, path.join(dir, 'sheet.png'), { scale: 1, rasterizer: selectRasterizer({ requested: 'resvg' }) });
    assert.equal(shot.ok, true, JSON.stringify(shot.diagnostics));
    assert.deepEqual(pngSize(fs.readFileSync(path.join(dir, 'sheet.png'))), svgSizePx(sheet));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preview: only lib/preview.mjs rasterises with Chrome; doctor only probes it', () => {
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(mjs|cjs|js)$/.test(entry.name)) sources.push(rel);
    }
  };
  for (const dir of ['bin', 'lib', 'scripts']) walk(dir);
  const text = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const importers = sources.filter((f) => /env\/chrome\.mjs/.test(text(f))).sort();
  assert.deepEqual(importers, ['bin/fig-gen.mjs', 'lib/preview.mjs']);
  const spawnsChrome = sources.filter((f) => /--headless|--screenshot|--print-to-pdf/.test(text(f)));
  assert.deepEqual(spawnsChrome, ['lib/preview.mjs']);
  const bin = text('bin/fig-gen.mjs');
  const doctor = bin.slice(bin.indexOf('async function cmdDoctor'));
  assert.equal(bin.split('findChrome(').length - 1, 1);
  assert.ok(doctor.slice(0, doctor.indexOf('\n}\n')).includes('findChrome('), 'findChrome is called only by doctor');
});

test('doctor: resvg is reported for previews and Chrome as optional', () => {
  const run = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8' });
  const { checks } = JSON.parse(run.stdout);
  assert.equal(checks.resvg.available, true);
  assert.equal(checks.resvg.version, '2.6.2');
  assert.match(checks.resvg.required_for, /previews/);
  assert.equal(checks.chrome.required, false);
  assert.doesNotMatch(JSON.stringify(checks), /visual-check/);
});

// Opt-in: exercises the Chrome path on machines that have it (FIGGEN_TEST_CHROME=1).
test('preview: --rasterizer chrome writes the same canvas size', { skip: process.env.FIGGEN_TEST_CHROME === '1' ? false : 'set FIGGEN_TEST_CHROME=1 to run the optional Chrome path' }, async () => {
  const dir = tmp();
  try {
    const svg = '<svgxmlns="http://www.w3.org/2000/svg" width="20pt" height="10pt" viewBox="0 0 20 10"><rect x="1" y="1" width="18" height="8" fill="none" stroke="#000"/></svg>';
    const shot = await rasterizeSvg(svg, path.join(dir, 'c.png'), { scale: 2, rasterizer: selectRasterizer({ requested: 'chrome' }) });
    assert.equal(shot.ok, true, JSON.stringify(shot.diagnostics));
    assert.deepEqual(pngSize(fs.readFileSync(path.join(dir, 'c.png'))), { width: 54, height: 28 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
