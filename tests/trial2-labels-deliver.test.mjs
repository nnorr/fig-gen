// Trial 2 fixes, labels and delivery: duplicate names checked on the text each
// variant prints (N3), function.name only on kind custom (N4), archive only
// after a successful delivery (N5), RTL abbreviations named with their
// expansion (N9), study relaxes route polish checks (N10), register windows
// printed base–end (O5), and PNG previews through headless Chrome.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkLabels, functionNames, nameIgnored, printedDuplicates, printedName, readableIdentifier, readableInstanceSegment, unreadableReason } from '../lib/checks/labels.mjs';
import { buildFigure, deliver } from '../lib/deliver.mjs';
import { paperOnly, relaxDiagnostics } from '../lib/format.mjs';
import { PNG_SIGNATURE, previewChrome, rasterizeSvg, svgSizePx } from '../lib/preview.mjs';
import { renderMicroarch } from '../lib/render/microarch.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'fig-gen.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-trial2-'));
const example = (name) => path.join(root, 'examples', name);
const errors = (r) => r.diagnostics.filter((d) => d.severity === 'error');

test('N10: a study receipt may record an avoidable bend (justification null) now that data-jog only warns', async () => {
  const out = tmp();
  const r = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: out, format: 'study', pdf: false });
  assert.equal(r.ok, true);
  const receipt = JSON.parse(fs.readFileSync(fs.readdirSync(out).filter((f) => f.endsWith('.receipt.json')).map((f) => path.join(out, f))[0], 'utf8'));
  const route = receipt.variants[0].route;
  route.data_bends = [...(route.data_bends || []), { wire: 'n_x__0', net: 'n_x', bends: 2, justification: null }];
  assert.deepEqual(await validateSchema('receipt', receipt), []);
});
const chrome = previewChrome();

const block = (id, fn, extra = {}) => ({ id, kind: 'comb', op: 'custom', width: 8, function: fn, ports: [{ id: 'i', dir: 'in', width: 8 }, { id: 'o', dir: 'out', width: 8 }], ...extra });
function twoBlocks(a, b) {
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'two blocks', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [{ id: 'din', kind: 'port', dir: 'in', width: 8, label: 'data in' }, a, b, { id: 'dout', kind: 'port', dir: 'out', width: 8, label: 'data out' }],
    nets: [{ id: 'n0', width: 8, driver: 'din', sinks: [`${a.id}.i`] }, { id: 'n1', width: 8, driver: `${a.id}.o`, sinks: [`${b.id}.i`] }, { id: 'n2', width: 8, driver: `${b.id}.o`, sinks: ['dout'] }],
  };
}
const writeFigure = (dir, name, doc) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(doc)); return f; };

test('N3: a long qualified name keeps its qualifier as the short name; a symbolic qualifier keeps the vocabulary word', () => {
  assert.equal(functionNames({ kind: 'controller', qualifier: 'Nonce client' }).short, 'Nonce client');
  assert.equal(functionNames({ kind: 'controller', qualifier: 'Main' }).short, 'Main controller');
  assert.equal(functionNames({ kind: 'gf_mul', qualifier: 'GF(2^8)' }).short, 'GF mul');
  assert.equal(functionNames({ kind: 'controller' }).short, 'Controller');
});

test('N3: printedName follows the label mode and per-variant overrides; printedDuplicates groups what one variant prints', () => {
  const a = block('a', { kind: 'custom', name: 'Nonce client controller', short_name: 'Controller' });
  const b = block('b', { kind: 'custom', name: 'Hash client controller', short_name: 'Controller' }, { labels: { '1col': 'full' } });
  assert.equal(printedName(a, 'full'), 'Nonce client controller');
  assert.equal(printedName(a, 'short'), 'Controller');
  assert.equal(printedName(b, 'short', { variant: '1col' }), 'Hash client controller', 'a per-variant override wins');
  assert.equal(printedName({ id: 'p', kind: 'port', label: 'x' }, 'short'), null);
  assert.equal(printedName({ id: 'm', label: 'CPU', short_label: 'Core' }, 'short', { type: 'microarch' }), 'Core');
  const doc = twoBlocks(a, b);
  assert.deepEqual(printedDuplicates(doc, 'full'), []);
  assert.deepEqual(printedDuplicates(doc, 'short'), [{ name: 'Controller', ids: ['a', 'b'] }]);
  assert.deepEqual(printedDuplicates(doc, 'short', { variant: '1col' }), []);
});

test('N3: label/duplicate is an error on the variant whose printed short labels collide, naming the variant', async () => {
  const dir = tmp();
  try {
    const force = { labels: { '2col': 'short' } };
    const doc = twoBlocks(block('a', { kind: 'custom', name: 'Nonce client controller', short_name: 'Controller' }, force), block('b', { kind: 'custom', name: 'Hash client controller', short_name: 'Controller' }, force));
    const r = await buildFigure({ type: 'datapath', figurePath: writeFigure(dir, 'collide', doc), variants: ['2col'] });
    const dup = r.diagnostics.filter((d) => d.code === 'label/duplicate');
    assert.equal(dup.length, 1, JSON.stringify(dup));
    assert.equal(dup[0].severity, 'error');
    assert.match(dup[0].message, /^2col: 2 blocks print the same name "Controller"/);
    assert.deepEqual(dup[0].subject, { variant: '2col', ids: ['a', 'b'] });
    assert.equal(r.ok, false);
    // Distinct short names print fine.
    doc.elements[2].function.short_name = 'Hash client';
    const ok = await buildFigure({ type: 'datapath', figurePath: writeFigure(dir, 'distinct', doc), variants: ['2col'] });
    assert.deepEqual(ok.diagnostics.filter((d) => d.code === 'label/duplicate'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('N4: function.name on a vocabulary kind is a schema error with a label/name-ignored hint to use qualifier and short_label', async () => {
  const doc = twoBlocks(block('a', { kind: 'controller', name: 'Nonce client controller' }), block('b', { kind: 'custom', name: 'Output stage' }));
  const schema = await validateSchema('datapath', doc);
  assert.ok(schema.some((d) => d.code === 'schema/invalid' && d.subject.path === '/elements/1/function'), JSON.stringify(schema.map((d) => d.message)));
  const hint = nameIgnored(doc);
  assert.equal(hint.length, 1);
  assert.equal(hint[0].code, 'label/name-ignored');
  assert.match(hint[0].message, /function\.name "Nonce client controller" is ignored for kind controller; the block would print "Controller"/);
  assert.match(hint[0].supportedFixes[0], /qualifier "Nonce client".*short_label/);
  const dir = tmp();
  try {
    const r = await buildFigure({ type: 'datapath', figurePath: writeFigure(dir, 'named', doc) });
    assert.ok(errors(r).some((d) => d.code === 'label/name-ignored'));
    assert.ok(errors(r).some((d) => d.code === 'schema/invalid'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(await validateSchema('datapath', twoBlocks(block('a', { kind: 'controller', qualifier: 'Nonce client' }), block('b', { kind: 'custom', name: 'Output stage' }))), []);
});

test('N5: a failed delivery leaves the last good outputs and receipt; the next good one archives them', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'out');
    const good = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: out });
    assert.deepEqual(errors(good), []);
    const before = Object.fromEntries(fs.readdirSync(out).map((f) => [f, fs.readFileSync(path.join(out, f)).toString('base64')]));
    const doc = JSON.parse(fs.readFileSync(example('datapath-pipelined-xor.json'), 'utf8'));
    doc.elements.find((e) => e.kind === 'port').width = 'wide';
    fs.mkdirSync(path.join(dir, 'broken'));
    const failed = await deliver({ type: 'datapath', figurePath: writeFigure(path.join(dir, 'broken'), 'datapath-pipelined-xor', doc), outDir: out });
    assert.equal(failed.ok, false);
    assert.equal(failed.archived, undefined);
    assert.deepEqual(Object.fromEntries(fs.readdirSync(out).map((f) => [f, fs.readFileSync(path.join(out, f)).toString('base64')])), before, 'byte-identical last good outputs');
    assert.equal(fs.existsSync(path.join(dir, 'archive')), false);
    const again = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: out });
    assert.ok(again.archived);
    assert.deepEqual(fs.readdirSync(again.archived).filter((f) => f !== 'README.md').sort(), Object.keys(before).sort());
    assert.equal(fs.readdirSync(out).some((f) => f.includes('.tmp-')), false, 'no staged temp file is left');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('N9: RTL abbreviations inside multi-word labels are flagged with the word to write', () => {
  for (const [bad, word] of [['Nonce cmd', 'command'], ['Hash rsp valid', 'response'], ['Write req', 'request'], ['cfg register', 'configuration'], ['Frame len', 'length'], ['Bit cnt', 'count'], ['Base addr', 'address'], ['Read ptr', 'pointer'], ['Ctrl logic', 'control'], ['Output vld', 'valid'], ['Input rdy', 'ready'], ['Slot idx', 'index'], ['Line buf', 'buffer']]) {
    assert.match(unreadableReason(bad) || '', new RegExp(`RTL abbreviation .*write "${word}"`), bad);
  }
  for (const good of ['Command buffer', 'Response valid', 'Address decoder', 'Enable', 'Frame length', 'GF mul', 'AXI slave', 'Open request', 'Selected index', 'Ready', 'Content', 'Bufferless path', 'FIFO', 'CPU']) {
    assert.equal(unreadableReason(good), null, good);
  }
  assert.match(unreadableReason('nonce_cmd_o'), /raw RTL port/, 'snake_case keeps its own reason');
  assert.equal(readableInstanceSegment('u_ctrl'), 'control', 'names generated from RTL identifiers are written out');
  assert.equal(readableIdentifier('rd_ptr_q'), 'read pointer');
  assert.equal(readableIdentifier('axi_awaddr'), 'axi awaddr', 'only whole words are expanded');
  const doc = { elements: [{ id: 'p', kind: 'port', dir: 'in', width: 8, label: 'Nonce cmd' }], nets: [] };
  const [d] = checkLabels(doc, 'datapath');
  assert.equal(d.code, 'label/unreadable');
  assert.deepEqual([d.evidence.abbreviation, d.evidence.expansion], ['cmd', 'command']);
  assert.equal(d.supportedFixes[0], 'write "command" for "cmd" ("Nonce command")');
});

test('N10: study turns route/data-jog and route/edge-hugging into warnings; correctness checks stay errors', () => {
  assert.equal(paperOnly('route/data-jog')?.study, 'warning');
  assert.equal(paperOnly('route/edge-hugging')?.study, 'warning');
  const list = () => ['route/data-jog', 'route/edge-hugging', 'wire/detached', 'route/overlap', 'label/duplicate'].map((code) => ({ code, severity: 'error', message: code, subject: {}, evidence: {}, supportedFixes: [] }));
  const study = list();
  relaxDiagnostics(study, 'study');
  assert.deepEqual(study.map((d) => [d.code, d.severity]), [['route/data-jog', 'warning'], ['route/edge-hugging', 'warning'], ['wire/detached', 'error'], ['route/overlap', 'error'], ['label/duplicate', 'error']]);
  const paper = list();
  relaxDiagnostics(paper, 'paper');
  assert.ok(paper.every((d) => d.severity === 'error'));
});

test('O5: a subordinate block prints its address window base–end in every label mode', async () => {
  const doc = JSON.parse(fs.readFileSync(example('microarch-soc-accelerator.json'), 'utf8'));
  const windows = (doc.attachments || []).filter((a) => a.role === 'subordinate' && a.address?.base);
  assert.ok(windows.length > 0);
  for (const widthPt of [515.5, 241]) {
    const r = await renderMicroarch(doc, { variant: widthPt > 300 ? '2col' : '1col', widthPt, name: 'soc', minFontPt: 6, minStrokePt: 0.5 });
    for (const a of windows) {
      const line = (suffix) => new RegExp(`id="block-${a.block}-${suffix}"[^>]*>([^<]*)<`).exec(r.svg)?.[1] ?? '';
      const printed = line('addr') + line('addr-end');
      const short = r.layout?.labels === 'short';
      assert.match(printed, short ? /^0x[0-9A-F]{4}_[0-9A-F]{4}–[0-9A-F]{4}_[0-9A-F]{4}$/ : /^0x[0-9A-F]{4}_[0-9A-F]{4}–0x[0-9A-F]{4}_[0-9A-F]{4}$/, `${widthPt} (${r.layout?.labels}): ${a.block} prints "${printed}"`);
      if (short) assert.ok(line('addr-end').startsWith('–'), 'short labels put the end on its own line');
    }
  }
});

test('preview: the command reports a clear error when Chrome is unavailable', async () => {
  const dir = tmp();
  try {
    const svg = path.join(dir, 'x.svg');
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="20pt" height="10pt"/>');
    const run = spawnSync(process.execPath, [cli, 'preview', svg], { encoding: 'utf8', env: { ...process.env, FIGGEN_CHROME: path.join(dir, 'no-such-chrome') } });
    assert.equal(run.status, 1, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.ok, false);
    assert.match(out.diagnostics[0], /^error preview\/chrome-missing: a PNG preview needs headless Chrome: FIGGEN_CHROME=.*no-such-chrome did not run/);
    assert.ok(out.fix.some((f) => /fig-gen doctor/.test(f)));
    assert.equal(fs.existsSync(path.join(dir, 'x.png')), false);
    const lib = await rasterizeSvg('<svg width="1pt" height="1pt"/>', path.join(dir, 'y.png'), { chrome: { available: false, reason: 'none here', fix: 'install Chrome' } });
    assert.equal(lib.ok, false);
    assert.equal(lib.diagnostics[0].code, 'preview/chrome-missing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preview: SVG canvas size in pixels', () => {
  assert.deepEqual(svgSizePx('<svg width="30pt" height="15pt">'), { width: 40, height: 20 });
  assert.deepEqual(svgSizePx('<svg viewBox="0 0 12 7">'), { width: 12, height: 7 });
  assert.equal(svgSizePx('<svg>'), null);
});

test('preview: a figure JSON and deliver --preview write PNGs through headless Chrome', { skip: chrome.available ? false : `Chrome unavailable: ${chrome.reason}` }, async () => {
  const dir = tmp();
  try {
    const target = path.join(dir, 'fig.png');
    const run = spawnSync(process.execPath, [cli, 'preview', example('datapath-pipelined-xor.json'), '--out', target, '--scale', '1'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(fs.readFileSync(target).subarray(0, 8).equals(PNG_SIGNATURE));
    const out = path.join(dir, 'out');
    const r = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: out, format: 'study', pdf: false, preview: { scale: 1 } });
    assert.deepEqual(errors(r), []);
    const png = path.join(out, 'datapath-pipelined-xor.study.png');
    assert.ok(fs.readFileSync(png).subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(r.receipt.variants[0].preview.path, 'datapath-pipelined-xor.study.png');
    // A later delivery archives the preview with the rest.
    const again = await deliver({ type: 'datapath', figurePath: example('datapath-pipelined-xor.json'), outDir: out, format: 'study', pdf: false });
    assert.ok(fs.readdirSync(again.archived).includes('datapath-pipelined-xor.study.png'));
    assert.equal(fs.existsSync(png), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
