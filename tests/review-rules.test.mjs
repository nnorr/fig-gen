// Skill-level rules from the Phase 2 review (generic fixtures only):
// documented facts across all documents (doc/conflict, authority,
// doc/rtl-mismatch), usage-derived net line style (net/class-style),
// duplicate names and stages (label/duplicate), vocabulary names justified by
// cited RTL (label/function-justification), width notation (width/missing,
// width/product-notation), and arrow checks (arrow/marker-overlap,
// arrow/label-proximity), including interrupts entering a block on their own pin.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkFunctionEvidence } from '../lib/checks/function-evidence.mjs';
import { checkLabels, functionNames } from '../lib/checks/labels.mjs';
import { checkNetClasses } from '../lib/checks/net-class.mjs';
import { checkDocFacts } from '../lib/doc-facts.mjs';
import { loadFont } from '../lib/fonts.mjs';
import { renderDatapath, loadSkin } from '../lib/render/datapath.mjs';
import { geometryChecks } from '../lib/render/geometry.mjs';
import { renderMicroarch } from '../lib/render/microarch.mjs';
import { el } from '../lib/svg.mjs';
import { validateSchema } from '../lib/validate.mjs';

const errors = (d) => d.filter((x) => x.severity === 'error');
const codes = (d) => d.map((x) => x.code);

function gitRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-docs-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'docs');
  return { dir, revision: git('rev-parse', 'HEAD').stdout.trim() };
}

// --- documented facts ---------------------------------------------------------

const DOCS = {
  'docs/guide.md': '# Widget core integration\n\n## Slot\n\n| Property | Value |\n|---|---|\n| Slot | ACC2 |\n| Base address | `0x7000_0000` |\n| Range | `0x7000_0000` - `0x7000_0FFF` |\n\n- IRQ number: IRQ 5\n',
  'docs/tapeout.md': '# Widget core for the new tapeout\n\nThe widget core moved.\n\n| Property | Value |\n|---|---|\n| Slot number | ACC4 |\n| Base address | `0x7200_0000` |\n| Effective window | `0x7200_0000` - `0x7200_01FF` |\n| NVIC IRQ number | IRQ 9 |\n\n## Other slots\n\n    ACC3 0x7100_0000 filter\n',
};

function socFigure(repo, extra = {}) {
  const src = (line, match) => ({ file: 'docs/guide.md', line, match });
  return {
    schema_version: 1, figure_type: 'microarch',
    meta: { title: 'widget', print: { profile: 'ieee' }, repository: { root: repo.dir, revision: repo.revision } },
    blocks: [
      { id: 'cpu', kind: 'core', label: 'Processor' },
      { id: 'w', kind: 'accelerator', label: 'Widget core', slot: 'ACC2', doc_terms: ['Widget core'], source: src(7, 'ACC2'), rtl: { module: 'widget_top' }, ...(extra.block || {}) },
    ],
    fabrics: [{ id: 'bus', protocol: 'AHB-Lite', topology: 'bus' }],
    attachments: [
      { id: 'at_cpu', fabric: 'bus', block: 'cpu', role: 'manager' },
      { id: 'at_w', fabric: 'bus', block: 'w', role: 'subordinate', address: { base: '0x7000_0000', end: '0x7000_0FFF' }, source: src(9, '0x7000_0FFF'), rtl: { addr_port: 'addr' }, ...(extra.attachment || {}) },
    ],
    links: [{ id: 'irq_w', from: 'w', to: 'cpu', class: 'interrupt', irq: 5, label: 'IRQ', source: src(11, 'IRQ 5'), ...(extra.link || {}) }],
  };
}

test('doc/conflict: every document is scanned and each differing source is listed (error)', () => {
  const repo = gitRepo(DOCS);
  try {
    const { diagnostics, report } = checkDocFacts(socFigure(repo), { figureDir: repo.dir });
    const conflicts = diagnostics.filter((d) => d.code === 'doc/conflict');
    assert.deepEqual(conflicts.map((d) => [d.subject.attribute, d.severity]).sort(), [['base', 'error'], ['irq', 'error'], ['slot', 'error']]);
    const slot = conflicts.find((d) => d.subject.attribute === 'slot');
    assert.deepEqual(slot.evidence.conflicting.map((c) => `${c.file}:${c.line}=${c.value}`), ['docs/tapeout.md:7=ACC4']);
    assert.match(slot.message, /docs\/guide\.md:7/);
    // a slot line of another block under an unrelated heading is not a fact about this block
    assert.ok(!JSON.stringify(report).includes('ACC3'));
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('an explicit authority resolves the conflict; the report lists the overridden sources', () => {
  const repo = gitRepo(DOCS);
  try {
    const authority = { file: 'docs/guide.md', reason: 'user-selected' };
    const { diagnostics, report } = checkDocFacts(socFigure(repo, { block: { authority }, attachment: { authority }, link: { authority } }), { figureDir: repo.dir });
    assert.deepEqual(errors(diagnostics), []);
    assert.ok(diagnostics.filter((d) => d.code === 'doc/conflict').every((d) => d.severity === 'warning'));
    const irq = report.facts.find((f) => f.attribute === 'irq');
    assert.deepEqual(irq.authority, authority);
    assert.deepEqual(irq.overridden, [{ file: 'docs/tapeout.md', line: 10, value: '9' }]);
    // an authority that does not state the figure's value is rejected
    const wrong = { file: 'docs/tapeout.md', reason: 'x' };
    const bad = checkDocFacts(socFigure(repo, { block: { authority: wrong } }), { figureDir: repo.dir });
    assert.ok(bad.diagnostics.some((d) => d.code === 'doc/authority-mismatch'));
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('doc/rtl-mismatch: a documented effective window the RTL address port cannot decode (warning)', () => {
  const repo = gitRepo(DOCS);
  try {
    const netlist = { top: 'widget_top', modules: [{ orig_name: 'widget_top', ports: [{ name: 'addr', dir: 'in', width: 12 }] }] };
    const { diagnostics } = checkDocFacts(socFigure(repo), { figureDir: repo.dir, netlist });
    const mm = diagnostics.filter((d) => d.code === 'doc/rtl-mismatch');
    assert.equal(mm.length, 1);
    assert.equal(mm[0].severity, 'warning');
    assert.deepEqual([mm[0].evidence.documented_bytes, mm[0].evidence.rtl_bytes], [512, 4096]);
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('figures that do not take facts from documents are not scanned', () => {
  const doc = socFigure({ dir: '/nonexistent', revision: '0'.repeat(40) });
  delete doc.meta.repository;
  delete doc.blocks[1].source; delete doc.blocks[1].doc_terms; delete doc.blocks[1].slot;
  delete doc.attachments[1].source; delete doc.links[0].source;
  assert.deepEqual(checkDocFacts(doc).diagnostics, []);
});

// --- line style from usage ----------------------------------------------------

function styleFigure() {
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'style', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'value A' },
      { id: 'b', kind: 'port', dir: 'in', width: 8, label: 'value B' },
      { id: 'cmp', kind: 'comb', op: 'custom', width: 1, pin_labels: false, function: { kind: 'comparator' }, ports: [{ id: 'x', dir: 'in', width: 8 }, { id: 'y', dir: 'in', width: 8 }, { id: 'eq', dir: 'out', width: 1 }] },
      { id: 'sel', kind: 'port', dir: 'in', width: 1, label: 'select' },
      { id: 'm', kind: 'mux', inputs: 2, width: 8 },
      { id: 'out', kind: 'port', dir: 'out', width: 8, label: 'result' },
      { id: 'flag', kind: 'port', dir: 'out', width: 1, label: 'values equal' },
    ],
    nets: [
      { id: 'na', width: 8, driver: 'a', sinks: ['cmp.x', 'm.in0'] },
      { id: 'nb', width: 8, driver: 'b', sinks: ['cmp.y', 'm.in1'] },
      { id: 'neq', width: 1, driver: 'cmp.eq', sinks: ['flag'], class: 'control' },
      { id: 'nsel', width: 1, driver: 'sel', sinks: ['m.sel'] },
      { id: 'nm', width: 8, driver: 'm.out', sinks: ['out'] },
    ],
  };
}

test('net/class-style: a 1-bit computed flag is data (solid); only select/enable/handshake sinks make control', async () => {
  const doc = styleFigure();
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const d = checkNetClasses(doc).diagnostics;
  assert.deepEqual(d.map((x) => [x.code, x.severity, x.subject.id]), [['net/class-style', 'error', 'neq']]);
  const reasoned = styleFigure();
  reasoned.nets.find((n) => n.id === 'neq').class_reason = 'drawn as a steering signal on purpose';
  assert.deepEqual(errors(checkNetClasses(reasoned).diagnostics), []);
  const clean = styleFigure();
  delete clean.nets.find((n) => n.id === 'neq').class;
  // one signal feeding both a value input and a select: the whole net is solid
  clean.nets.find((n) => n.id === 'neq').sinks = ['flag'];
  const r = await renderDatapath(clean, { variant: '2col', widthPt: 515.5, name: 'style' });
  assert.deepEqual(errors(r.diagnostics), []);
  assert.doesNotMatch(r.svg, /id="net-neq-seg0"[^>]*stroke-dasharray/);
  assert.match(r.svg, /id="net-nsel-seg0"[^>]*stroke-dasharray/);
});

// --- names ------------------------------------------------------------------

test('label/duplicate: shared primary names are errors unless declared stages', () => {
  const block = (id, fn) => ({ id, kind: 'comb', op: 'custom', width: 8, function: fn, ports: [{ id: 'i', dir: 'in', width: 8 }, { id: 'o', dir: 'out', width: 8 }] });
  const doc = { elements: [block('p1', { kind: 'gf_poly_eval' }), block('p2', { kind: 'gf_poly_eval' })], nets: [] };
  assert.deepEqual(checkLabels(doc, 'datapath').filter((d) => d.code === 'label/duplicate').map((d) => d.severity), ['error']);
  doc.elements[0].function.stage = '1/2';
  doc.elements[1].function.stage = '2/2';
  assert.equal(checkLabels(doc, 'datapath').filter((d) => d.code === 'label/duplicate').length, 0);
  assert.equal(functionNames(doc.elements[0].function).display, 'GF polynomial evaluator (stage 1/2)');
});

test('label/function-justification: the cited RTL must show the structure the name requires', () => {
  const repo = gitRepo({ 'rtl/pos.sv': 'module pos;\n  assign hit[g] = (loc == pow_tab[g]);\n  assign y = gf_mul(a, 8\'h02) ^ b;\nendmodule\n' });
  try {
    const cited = (line) => ({ source: { file: 'rtl/pos.sv', line, match: line === 2 ? 'pow_tab' : 'gf_mul' }, structure: 'x' });
    const doc = {
      meta: { repository: { root: repo.dir, revision: repo.revision } },
      elements: [
        { id: 'pm', kind: 'comb', op: 'custom', function: { kind: 'position_match', basis: cited(2) } },
        { id: 'ch', kind: 'comb', op: 'custom', function: { kind: 'chien_search', basis: cited(2) } },
        { id: 'nb', kind: 'comb', op: 'custom', function: { kind: 'chien_search' } },
        { id: 'ev', kind: 'comb', op: 'custom', function: { kind: 'gf_poly_eval', basis: cited(3) } },
      ],
      nets: [],
    };
    const { diagnostics, report } = checkFunctionEvidence(doc, { figureDir: repo.dir });
    assert.deepEqual(diagnostics.map((d) => [d.subject.id, d.severity]).sort(), [['ch', 'warning'], ['nb', 'warning']]);
    assert.match(diagnostics.find((d) => d.subject.id === 'ch').supportedFixes.join(' '), /comparator/);
    assert.deepEqual(report.map((x) => x.id).sort(), ['ev', 'pm']);
    assert.ok(checkFunctionEvidence(doc, { figureDir: repo.dir, quality: 'paper' }).diagnostics.every((d) => d.severity === 'error'));
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

// --- widths -------------------------------------------------------------------

test('width/product-notation: net and mux labels never write a width as a product', () => {
  const doc = { elements: [{ id: 'm', kind: 'mux', inputs: 2, width: 48, input_labels: { 0: '6 x 8-bit' } }], nets: [{ id: 'n', width: 48, label: 'data 6×8', driver: 'a', sinks: [] }] };
  assert.deepEqual(checkLabels(doc, 'datapath').filter((d) => d.code === 'width/product-notation').map((d) => d.subject.id).sort(), ['m', 'n']);
});

test('rendered widths are single integers, and a multi-bit data net without a width label is an error', async () => {
  const doc = styleFigure();
  delete doc.nets.find((n) => n.id === 'neq').class;
  const m = doc.elements.find((e) => e.id === 'm');
  m.lanes = 2;
  m.width = 8;
  doc.nets.find((n) => n.id === 'nsel').width = 2;
  doc.elements.find((e) => e.id === 'sel').width = 2;
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'w' });
  assert.deepEqual(errors(r.diagnostics), []);
  for (const t of r.svg.matchAll(/id="net-[^"]+-width"[^>]*>([^<]*)</g)) assert.match(t[1], /^\d+$/);
  const skin = loadSkin();
  skin.tokens.bus_slash.length = 400; // no wire can hold a slash
  const r2 = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'w', skin });
  assert.ok(r2.diagnostics.some((d) => d.code === 'width/missing' && d.severity === 'error' && d.subject.id === 'na'));
});

// --- arrows -------------------------------------------------------------------

test('arrow/marker-overlap and arrow/label-proximity on generic geometry', async () => {
  const font = await loadFont('Arial');
  const head = (id, x, y) => el('path', { id, d: `M${x - 4.5} ${y + 1.6} L${x} ${y} L${x - 4.5} ${y - 1.6} Z`, fill: '#000', stroke: 'none' });
  const wire = (id, pts) => el('path', { id, d: pts.map((p, k) => `${k ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' '), fill: 'none', stroke: '#000', 'stroke-width': 0.6 });
  const txt = (id, x, y, s) => el('text', { id, x, y, 'font-size': 7, 'font-family': 'Arial' }, [s]);
  const tree = el('svg', {}, [
    wire('net-a-seg0', [[0, 10], [45.5, 10]]), head('net-a-arrow0', 50, 10),
    wire('net-b-seg0', [[0, 11], [46, 11]]), head('net-b-arrow0', 50.5, 11),
    wire('link-c-seg0', [[100, 0], [100, 25.5]]), head('link-c-arrow', 100, 30),
    txt('link-d-label', 101.5, 28, 'IRQ 7'),
    txt('link-c-label', 104, 12, 'own'),
  ]);
  const d = geometryChecks(tree, { font });
  assert.ok(d.some((x) => x.code === 'arrow/marker-overlap' && /net-a-arrow0/.test(x.message)));
  assert.ok(d.some((x) => x.code === 'arrow/label-proximity' && x.subject.label === 'link-d-label'));
  assert.ok(!d.some((x) => x.code === 'arrow/label-proximity' && x.subject.label === 'link-c-label'));
});

test('an interrupt into a block whose bus edge is taken enters on a pin of its own, with no arrow collisions', async () => {
  const doc = {
    schema_version: 1, figure_type: 'microarch', meta: { title: 'irq', print: { profile: 'ieee' } },
    blocks: [{ id: 'cpu', kind: 'core', label: 'Processor' }, { id: 'mem', kind: 'memory', label: 'Memory' }, { id: 'acc', kind: 'accelerator', label: 'Accelerator' }],
    fabrics: [{ id: 'bus', protocol: 'AHB-Lite', topology: 'bus' }],
    attachments: [{ id: 'a0', fabric: 'bus', block: 'cpu', role: 'manager' }, { id: 'a1', fabric: 'bus', block: 'mem', role: 'subordinate' }, { id: 'a2', fabric: 'bus', block: 'acc', role: 'subordinate' }],
    links: [{ id: 'irq', from: 'acc', to: 'cpu', class: 'interrupt', irq: 7, label: 'IRQ' }],
  };
  assert.deepEqual(await validateSchema('microarch', doc), []);
  const r = await renderMicroarch(doc, { variant: '2col', widthPt: 515.5 });
  assert.deepEqual(codes(errors(r.diagnostics)), []);
  const d = /id="link-irq-seg0" d="([^"]+)"/.exec(r.svg)[1];
  const pts = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const [p, q] = pts.slice(-2);
  assert.equal(p[1], q[1], 'the interrupt enters horizontally (side pin), not through the bus edge');
  const body = /<rect id="block-cpu-body" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(r.svg);
  assert.ok(q[0] > Number(body[1]) + Number(body[2]), 'it stops at the arrowhead just outside the east edge');
});
