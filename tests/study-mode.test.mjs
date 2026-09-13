// Study / free-size format (lib/format.mjs, SPEC §9.6): one figure sized to
// its content, correctness checks kept, print-only checks relaxed; paper stays
// the default and is unchanged. Also: superseded outputs are archived.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deliver } from '../lib/deliver.mjs';
import { PAPER_ONLY_CHECKS, formatReceipt, paperOnly, relaxDiagnostics, resolveFormat, withFormat } from '../lib/format.mjs';
import { pdfHasFonts } from '../lib/pdf.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = (r) => r.diagnostics.filter((d) => d.severity === 'error');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-study-'));
const example = (name) => path.join(root, 'examples', name);
const receiptOf = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.receipt.json`), 'utf8'));
const svgSize = (svg) => { const m = /<svg[^>]*width="([\d.]+)pt" height="([\d.]+)pt"/.exec(svg); return [Number(m[1]), Number(m[2])]; };
const pdfPage = (buf) => { const m = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(buf.toString('latin1')); return [Number(m[1]), Number(m[2])]; };

// A chain of ten named stages: far wider than any printed column.
function wideFigure(extra = {}) {
  const names = ['Input stage', 'Second stage', 'Third stage', 'Fourth stage', 'Fifth stage', 'Sixth stage', 'Seventh stage', 'Eighth stage', 'Ninth stage', 'Output stage'];
  const block = (i) => ({ id: `b${i}`, kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name: names[i] }, ports: [{ id: 'i', dir: 'in', width: 8 }, { id: 'o', dir: 'out', width: 8 }] });
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'wide chain', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [{ id: 'din', kind: 'port', dir: 'in', width: 8, label: 'data in' }, ...names.map((_, i) => block(i)), { id: 'dout', kind: 'port', dir: 'out', width: 8, label: 'data out' }],
    nets: [
      { id: 'n_in', width: 8, driver: 'din', sinks: ['b0.i'] },
      ...names.slice(1).map((_, i) => ({ id: `n_${i}`, width: 8, driver: `b${i}.o`, sinks: [`b${i + 1}.i`] })),
      { id: 'n_out', width: 8, driver: 'b9.o', sinks: ['dout'] },
    ],
    ...extra,
  };
}
const writeFigure = (dir, name, doc) => { const file = path.join(dir, `${name}.json`); fs.writeFileSync(file, JSON.stringify(doc)); return file; };

test('the paper-only list relaxes print checks and never a correctness check', () => {
  for (const code of ['schema/invalid', 'width/mismatch', 'width/missing', 'coverage/dropped-hardware', 'latency/hidden-register', 'rtl/port-missing', 'wire/detached', 'wire/touching', 'symbol/bubble-detached', 'route/dot-near-arrow', 'net/stroke-uniform', 'glyph/distinguishable', 'evidence/self-authored', 'arrow/missing', 'region/frame-foreign-block']) {
    assert.equal(paperOnly(code), null, `${code} must stay enforced in study`);
  }
  for (const c of PAPER_ONLY_CHECKS) assert.ok(['skip', 'warning'].includes(c.study) && c.reason, c.code);
  const diags = () => [
    { code: 'print/width-overflow', severity: 'error' }, { code: 'deliver/does-not-fit', severity: 'error' },
    { code: 'label/unreadable', severity: 'error' }, { code: 'width/mismatch', severity: 'error' }, { code: 'route/crossings', severity: 'warning' },
  ];
  const paper = diags();
  relaxDiagnostics(paper, 'paper');
  assert.deepEqual(paper, diags(), 'paper is untouched');
  const study = diags();
  const tally = relaxDiagnostics(study, 'study');
  assert.deepEqual(study.map((d) => [d.code, d.severity]), [['label/unreadable', 'warning'], ['width/mismatch', 'error']]);
  relaxDiagnostics(study, 'study', tally);
  assert.deepEqual(formatReceipt('study', tally, 'study').relaxed, [
    { code: 'deliver/does-not-fit', treatment: 'skip', count: 1 }, { code: 'label/unreadable', treatment: 'warning', count: 1 },
    { code: 'print/width-overflow', treatment: 'skip', count: 1 }, { code: 'route/crossings', treatment: 'skip', count: 1 },
  ], 'counted once even when relaxed again');
  assert.equal(resolveFormat({ meta: { print: { format: 'study' } } }).format, 'study');
  assert.equal(resolveFormat({ meta: { print: { format: 'study' } } }, 'paper').format, 'paper', 'the CLI flag wins');
  assert.equal(resolveFormat({}, 'poster').diagnostics[0].code, 'format/unknown');
});

test('paper stays the default: pipelined example delivers 1col + 2col with a paper format receipt', async () => {
  const out = tmp();
  try {
    const r = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: out });
    assert.deepEqual(errors(r), []);
    const receipt = receiptOf(out, 'datapath-pipelined-xor');
    assert.deepEqual(await validateSchema('receipt', receipt), []);
    assert.deepEqual(receipt.variants.map((v) => v.id), ['1col', '2col']);
    assert.deepEqual(receipt.format, { name: 'paper', profile: 'ieee', skipped_checks: [], downgraded_checks: [], relaxed: [] });
    assert.equal(receipt.checks.quality, 'paper');
    assert.equal(receipt.variants.find((v) => v.id === '2col').svg.width_pt, 515.5);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('study: a figure too wide for any column fails paper and delivers one variant sized to its content', async () => {
  const dir = tmp();
  try {
    const file = writeFigure(dir, 'wide', wideFigure());
    const paper = await deliver({ type: 'datapath', figurePath: file, outDir: path.join(dir, 'paper') });
    assert.equal(paper.ok, false);
    assert.ok(paper.diagnostics.some((d) => d.code === 'deliver/does-not-fit'));

    const out = path.join(dir, 'study');
    const r = await deliver({ type: 'datapath', figurePath: file, outDir: out, format: 'study' });
    assert.deepEqual(errors(r), []);
    assert.deepEqual(fs.readdirSync(out).sort(), ['wide.receipt.json', 'wide.study.pdf', 'wide.study.svg']);
    const svg = fs.readFileSync(path.join(out, 'wide.study.svg'), 'utf8');
    assert.deepEqual(lintFigmaSafe(svg), []);
    const [w, h] = svgSize(svg);
    assert.ok(w > 515.5 * 1.3, `canvas ${w} pt is the content width, not a column`);
    const pdf = fs.readFileSync(path.join(out, 'wide.study.pdf'));
    assert.equal(pdfHasFonts(pdf), false);
    const [pw, ph] = pdfPage(pdf);
    assert.ok(Math.abs(pw - w) < 0.01 && Math.abs(ph - h) < 0.01, 'the PDF page is the content size');
    assert.ok(!r.diagnostics.some((d) => ['print/width-overflow', 'deliver/does-not-fit', 'print/label-fallback'].includes(d.code)));

    const receipt = receiptOf(out, 'wide');
    assert.deepEqual(await validateSchema('receipt', receipt), []);
    assert.deepEqual(receipt.variants.map((v) => v.id), ['study']);
    assert.equal(receipt.format.name, 'study');
    assert.equal(receipt.format.profile, 'study');
    assert.equal(receipt.checks.quality, 'study');
    assert.equal(receipt.variant_status.study.status, 'delivered');
    for (const code of ['print/width-overflow', 'print/max-height', 'deliver/does-not-fit', 'route/crossings']) assert.ok(receipt.format.skipped_checks.includes(code), code);
    for (const code of ['label/unreadable', 'print/min-font', 'view/caption']) assert.ok(receipt.format.downgraded_checks.includes(code), code);
    assert.equal(receipt.variants[0].short_labels_used.length, 0, 'full labels: never shortened to fit');

    // the same through the IR: meta.print.format study, no print profile needed
    const doc = wideFigure();
    doc.meta.print = { format: 'study' };
    assert.deepEqual(await validateSchema('datapath', doc), []);
    const viaIr = await deliver({ type: 'datapath', figurePath: writeFigure(dir, 'wide-ir', doc), outDir: path.join(dir, 'ir') });
    assert.deepEqual(errors(viaIr), []);
    assert.equal(viaIr.receipt.format.name, 'study');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('study keeps correctness checks and turns readability checks into warnings', async () => {
  const dir = tmp();
  try {
    const broken = wideFigure();
    broken.nets.find((n) => n.id === 'n_out').width = 16;
    const bad = await deliver({ type: 'datapath', figurePath: writeFigure(dir, 'broken', broken), outDir: path.join(dir, 'b'), format: 'study' });
    assert.equal(bad.ok, false, 'a width mismatch still fails a study delivery');
    assert.ok(errors(bad).some((d) => d.code.startsWith('width/')));

    const terse = wideFigure();
    terse.elements.find((e) => e.id === 'b3').label = 'cls';
    const file = writeFigure(dir, 'terse', terse);
    const paper = await deliver({ type: 'datapath', figurePath: file, outDir: path.join(dir, 'p'), quality: 'paper' });
    assert.ok(errors(paper).some((d) => d.code === 'label/unreadable'));
    const study = await deliver({ type: 'datapath', figurePath: file, outDir: path.join(dir, 's'), quality: 'paper', format: 'study' });
    assert.deepEqual(errors(study), []);
    assert.ok(study.diagnostics.some((d) => d.code === 'label/unreadable' && d.severity === 'warning'));
    assert.deepEqual(study.receipt.format.relaxed.find((x) => x.code === 'label/unreadable'), { code: 'label/unreadable', treatment: 'warning', count: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('microarch in both formats: paper column variants, study one figure plus its address map at content size', async () => {
  const dir = tmp();
  try {
    const paper = await deliver({ type: 'microarch', figurePath: example('microarch-soc-accelerator.json'), outDir: path.join(dir, 'paper') });
    assert.deepEqual(errors(paper), []);
    assert.ok(paper.receipt.variants.some((v) => v.id === '2col'));
    assert.equal(paper.receipt.format.name, 'paper');

    const out = path.join(dir, 'study');
    const r = await deliver({ type: 'microarch', figurePath: example('microarch-soc-accelerator.json'), outDir: out, format: 'study' });
    assert.deepEqual(errors(r), []);
    assert.deepEqual(r.receipt.variants.map((v) => v.id), ['study', 'addrmap.study']);
    assert.deepEqual(await validateSchema('receipt', r.receipt), []);
    for (const v of r.receipt.variants) {
      const svg = fs.readFileSync(path.join(out, v.svg.path), 'utf8');
      assert.deepEqual(lintFigmaSafe(svg), []);
      const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 0.01);
      assert.ok(near(svgSize(svg), [v.svg.width_pt, v.svg.height_pt]), `${v.id}: canvas is the content size`);
      assert.ok(near(pdfPage(fs.readFileSync(path.join(out, v.pdf.path))), [v.svg.width_pt, v.svg.height_pt]), `${v.id}: PDF page is the content size`);
    }
    assert.equal(r.receipt.format.name, 'study');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('study --no-pdf writes the SVG and a valid receipt without a PDF; paper always writes the PDF', async () => {
  const dir = tmp();
  try {
    const file = writeFigure(dir, 'wide', wideFigure());
    const r = await deliver({ type: 'datapath', figurePath: file, outDir: path.join(dir, 'study'), format: 'study', pdf: false });
    assert.deepEqual(errors(r), []);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'study')).sort(), ['wide.receipt.json', 'wide.study.svg']);
    assert.equal(r.receipt.variants[0].pdf, undefined);
    assert.deepEqual(await validateSchema('receipt', r.receipt), []);
    const paperReceipt = structuredClone(r.receipt);
    paperReceipt.format = { name: 'paper', profile: 'ieee', skipped_checks: [], downgraded_checks: [] };
    assert.ok((await validateSchema('receipt', paperReceipt)).length > 0, 'a paper receipt must list a PDF per variant');
    const paper = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: path.join(dir, 'paper'), pdf: false });
    assert.ok(paper.receipt.variants.every((v) => v.pdf));
    assert.ok(paper.diagnostics.some((d) => d.code === 'format/pdf-required'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: validate --format study relaxes label/unreadable; draft --format writes meta.print.format', async () => {
  const dir = tmp();
  try {
    const terse = wideFigure();
    terse.elements.find((e) => e.id === 'b3').label = 'cls';
    const file = writeFigure(dir, 'terse', terse);
    const run = (...args) => spawnSync(process.execPath, [path.join(root, 'bin', 'fig-gen.mjs'), 'validate', 'datapath', file, '--quality', 'paper', '--json', ...args], { encoding: 'utf8' });
    const paper = run();
    assert.equal(paper.status, 1);
    assert.ok(JSON.parse(paper.stdout).diagnostics.some((d) => d.code === 'label/unreadable' && d.severity === 'error'));
    const study = run('--format', 'study');
    assert.equal(study.status, 0, study.stdout);
    const out = JSON.parse(study.stdout);
    assert.ok(out.diagnostics.some((d) => d.code === 'label/unreadable' && d.severity === 'warning'));
    assert.equal(out.checks.format.name, 'study');
    const unknown = run('--format', 'poster');
    assert.equal(unknown.status, 1);
    assert.ok(JSON.parse(unknown.stdout).diagnostics.some((d) => d.code === 'format/unknown'));

    const drafted = withFormat(wideFigure(), 'study');
    assert.equal(drafted.meta.print.format, 'study');
    assert.deepEqual(await validateSchema('datapath', drafted), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('re-delivery archives the previous outputs of the figure beside the output directory', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'out');
    const first = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: out });
    assert.deepEqual(errors(first), []);
    assert.equal(first.archived, undefined, 'nothing to archive the first time');
    fs.writeFileSync(path.join(out, 'datapath-pipelined-xor.2col.preview.png'), 'png');
    fs.writeFileSync(path.join(out, 'other-figure.2col.svg'), '<svg/>');
    const second = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: out });
    assert.deepEqual(errors(second), []);
    assert.ok(second.archived && fs.existsSync(second.archived));
    assert.equal(path.dirname(second.archived), path.join(dir, 'archive'));
    assert.match(path.basename(second.archived), /^\d{4}-\d{2}-\d{2}-datapath-pipelined-xor-[0-9a-f]{8}$/);
    const archivedFiles = fs.readdirSync(second.archived).sort();
    assert.deepEqual(archivedFiles, ['README.md', 'datapath-pipelined-xor.1col.pdf', 'datapath-pipelined-xor.1col.svg', 'datapath-pipelined-xor.2col.pdf', 'datapath-pipelined-xor.2col.preview.png', 'datapath-pipelined-xor.2col.svg', 'datapath-pipelined-xor.receipt.json']);
    assert.match(fs.readFileSync(path.join(second.archived, 'README.md'), 'utf8'), /datapath-pipelined-xor[\s\S]*superseded by a new delivery/);
    assert.deepEqual(fs.readdirSync(out).sort(), ['datapath-pipelined-xor.1col.pdf', 'datapath-pipelined-xor.1col.svg', 'datapath-pipelined-xor.2col.pdf', 'datapath-pipelined-xor.2col.svg', 'datapath-pipelined-xor.receipt.json', 'other-figure.2col.svg']);
    assert.equal(receiptOf(out, 'datapath-pipelined-xor').archived, path.relative(out, second.archived));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a variant that is no longer produced is archived, not left beside the current outputs', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'out');
    const file = writeFigure(dir, 'chain', wideFigure({ meta: { title: 'short chain', print: { profile: 'ieee' } } }));
    await deliver({ type: 'datapath', figurePath: file, outDir: out, format: 'study' });
    fs.writeFileSync(path.join(out, 'chain.1col.svg'), '<svg/>');
    const r = await deliver({ type: 'datapath', figurePath: file, outDir: out, format: 'study', pdf: false });
    assert.deepEqual(errors(r), []);
    assert.deepEqual(fs.readdirSync(out).sort(), ['chain.receipt.json', 'chain.study.svg']);
    assert.ok(fs.readdirSync(r.archived).includes('chain.1col.svg'));
    assert.ok(fs.readdirSync(r.archived).includes('chain.study.pdf'), 'the PDF this delivery no longer writes is archived');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed delivery archives stale outputs of the same figure so they never look current', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'out');
    const good = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: out });
    assert.deepEqual(errors(good), []);
    const brokenDir = path.join(dir, 'broken');
    fs.mkdirSync(brokenDir);
    const doc = JSON.parse(fs.readFileSync(example('datapath-pipelined-xor.json'), 'utf8'));
    doc.nets = 'not a list';
    const failed = await deliver({ type: 'datapath', figurePath: writeFigure(brokenDir, 'datapath-pipelined-xor', doc), outDir: out });
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.written, []);
    assert.deepEqual(fs.readdirSync(out), [], 'no stale deliverable remains');
    assert.ok(fs.existsSync(path.join(failed.archived, 'datapath-pipelined-xor.receipt.json')));
    assert.match(fs.readFileSync(path.join(failed.archived, 'README.md'), 'utf8'), /superseded by a new delivery/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
