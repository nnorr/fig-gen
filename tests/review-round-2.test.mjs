// Review round 2: generated text is readable in every format, stage notes stay
// within two lines, block names say whose they are and fit the whole block,
// and study figures frame instances, flow left to right and report readability.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkFunctionEvidence } from '../lib/checks/function-evidence.mjs';
import { distinctInstanceNames, readableIdentifier } from '../lib/checks/labels.mjs';
import { relaxDiagnostics } from '../lib/format.mjs';
import { readabilityFromSvg } from '../lib/render/readability.mjs';
import { STAGE_NOTE_LINES, regionCrossingMarks, renderDatapath, rootRanks, stageNoteLines } from '../lib/render/datapath.mjs';

const errors = (diags) => diags.filter((d) => d.severity === 'error');
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
// Printed block names: a title wrapped over several lines (-title, -title2) joined.
const titles = (svg) => {
  const byBlock = new Map();
  for (const m of svg.matchAll(/<text[^>]*id="([^"]+)-title(\d*)"[^>]*>([^<]*)<\/text>/g)) {
    if (!byBlock.has(m[1])) byBlock.set(m[1], []);
    byBlock.get(m[1])[Number(m[2] || 1) - 1] = m[3];
  }
  return [...byBlock.values()].map((parts) => parts.join(' '));
};

// A block whose registered outputs differ in latency; its pins carry no labels.
function statusFigure({ outs, detail } = {}) {
  const outputs = outs ?? [['o_u_blk_start_ready_o', 'start_ready_o', 2], ['o_u_blk_done_o', 'done_o', 1]];
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'notes', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'value in' },
      { id: 'st', kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name: 'Status logic', ...(detail ? { detail } : {}) }, ports: [{ id: 'i_value', dir: 'in', width: 8 }, ...outputs.map(([id, , latency]) => ({ id, dir: 'out', width: 1, registered: true, ...(latency > 1 ? { latency } : {}) }))] },
      ...outputs.map(([id], k) => ({ id: `out${k}`, kind: 'port', dir: 'out', width: 1, label: `result ${k + 1}` })),
    ],
    nets: [
      { id: 'n_a', width: 8, driver: 'a', sinks: ['st.i_value'] },
      ...outputs.map(([id, signal], k) => ({ id: `n_${id}`, width: 1, driver: `st.${id}`, sinks: [`out${k}`], ...(signal ? { rtl: { signal } } : {}) })),
    ],
  };
}

test('generated text names outputs readably: stage notes use the RTL signal as words, never a pin or net id', async () => {
  assert.equal(readableIdentifier('o_u_h2p_client_start_ready_o'), 'h2p client start ready');
  assert.equal(readableIdentifier('start_ready_o'), 'start ready');
  assert.equal(readableIdentifier('c_outstanding'), 'outstanding');
  const r = await renderDatapath(statusFigure(), { variant: '2col', widthPt: 515.5, name: 'notes' });
  assert.deepEqual(errors(r.diagnostics), []);
  const t = texts(r.svg);
  assert.ok(t.includes('1 stage: done') && t.includes('2 stages: start ready'), t.join(' | '));
  assert.ok(!t.some((x) => /[a-z0-9]_[a-z0-9]/i.test(x)), 'no raw id in any text');
  assert.deepEqual(r.route.stage_notes.map((s) => [s.output, s.latency]), [['start ready', 2], ['done', 1]], 'the full per-output list is in the receipt');
});

test('an unreadable generated name is label/unreadable in every format; the study format does not relax it', async () => {
  const r = await renderDatapath(statusFigure({ outs: [['o_q', null, 2], ['o_ok_done', 'ok_done', 1]] }), { variant: '2col', widthPt: 515.5, name: 'bad' });
  const bad = r.diagnostics.filter((d) => d.code === 'label/unreadable');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 'error');
  assert.deepEqual([bad[0].evidence.generated, bad[0].evidence.text], [true, 'q']);
  const list = [...bad];
  relaxDiagnostics(list, 'study');
  assert.equal(list[0].severity, 'error', 'generated text stays an error in a study figure');
});

test('stage notes stay within two lines: grouped by latency when short, else the latency range; study figures add a table', async () => {
  assert.equal(STAGE_NOTE_LINES, 2);
  assert.deepEqual(stageNoteLines([{ name: 'ready', latency: 1 }, { name: 'done', latency: 2 }]), ['1 stage: ready', '2 stages: done']);
  const many = ['start ready', 'absorb ready', 'absorb done ready', 'squeeze valid', 'squeeze data', 'done'].map((name, i) => ({ name, latency: 1 + (i % 4) }));
  assert.deepEqual(stageNoteLines(many), ['outputs: 1–4 stages']);
  const long = [['o_a', 'start_ready_o', 1], ['o_b', 'absorb_ready_o', 2], ['o_c', 'absorb_done_ready_o', 3], ['o_d', 'squeeze_valid_o', 4]];
  const study = await renderDatapath(statusFigure({ outs: long }), { variant: 'study', name: 'study' });
  const t = texts(study.svg);
  assert.ok(t.includes('outputs: 1–4 stages'));
  assert.ok(t.includes('Output latency') && t.includes('Status logic — absorb done ready: 3 stages'), 'the full list is a table below the drawing');
  assert.deepEqual(study.diagnostics.filter((d) => d.code === 'label/stage-note-clutter'), []);
  // A state output has no stage count: no "16 stages" from its internal bound.
  const withState = statusFigure();
  withState.elements.find((e) => e.id === 'st').ports.find((p) => p.id === 'o_u_blk_done_o').latency = 'state';
  delete withState.elements.find((e) => e.id === 'st').ports.find((p) => p.id === 'o_u_blk_done_o').registered;
  const stateRender = await renderDatapath(withState, { variant: '2col', widthPt: 515.5, name: 'state' });
  assert.ok(texts(stateRender.svg).includes('2 stages'), texts(stateRender.svg).join(' | '));
  assert.ok(!texts(stateRender.svg).some((x) => /16/.test(x)));
  const cluttered = await renderDatapath(statusFigure({ detail: 'first line\nsecond line' }), { variant: '2col', widthPt: 515.5, name: 'clutter' });
  const clutter = cluttered.diagnostics.filter((d) => d.code === 'label/stage-note-clutter');
  assert.equal(clutter.length, 1);
  assert.equal(clutter[0].evidence.lines, 3);
});

test('distinct instance names: the last segment, widened only where it repeats', () => {
  assert.deepEqual(distinctInstanceNames(['u_nonce_client/u_stream_client', 'u_sampler_client/u_stream_client', 'u_single_engine/u_owner', 'u_single_engine/u_engine_adapter', 'u_h2p_client']), ['nonce client', 'sampler client', 'owner', 'engine adapter', 'h2p client']);
});

const port = (name, dir, width = 1) => ({ name, dir, width });
const net = (name, width = 1, kind = 'port') => ({ name, width, kind });
const conn = (port0, n, dir = 'in') => ({ port: port0, dir, expr: { kind: 'net', net: n } });
const ref = (name) => ({ op: 'ref', name });
const clocked = { clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true }, clock_root: 'clk' };

// top: u_rx and u_tx, each with a u_ctrl state machine and local logic that
// compares against zero (zero) and selects (pick); rx's busy starts tx.
function twoSidesNetlist() {
  const ctrl = {
    name: 'side_ctrl', orig_name: 'side_ctrl',
    ports: [port('clk', 'in'), port('rst_n', 'in'), port('go', 'in'), port('busy', 'out')],
    nets: [net('clk'), net('rst_n'), net('go'), net('busy'), net('state_q', 2, 'var')],
    registers: [{ name: 'state_q', width: 2, ...clocked, enum: { type: 'side_e', width: 2, items: [{ name: 'Idle', value: 0 }, { name: 'Run', value: 1 }] } }],
    instances: [],
    deps: [{ target: 'state_q', sources: ['go', 'state_q', 'rst_n'], kind: 'seq' }, { target: 'busy', sources: ['state_q'], kind: 'comb' }],
    exprs: [{ target: 'busy', expr: { op: 'ne', args: [ref('state_q'), { op: 'const', value: '0' }] } }],
  };
  const side = (name) => ({
    name, orig_name: name,
    ports: [port('clk', 'in'), port('rst_n', 'in'), port('go', 'in'), port('a', 'in', 8), port('b', 'in', 8), port('sel', 'in'), port('busy', 'out'), port('zero', 'out'), port('pick', 'out', 8)],
    nets: [net('clk'), net('rst_n'), net('go'), net('a', 8), net('b', 8), net('sel'), net('busy'), net('zero'), net('pick', 8)],
    registers: [],
    instances: [{ name: 'u_ctrl', module: 'side_ctrl', connections: [conn('clk', 'clk'), conn('rst_n', 'rst_n'), conn('go', 'go'), conn('busy', 'busy', 'out')] }],
    deps: [{ target: 'zero', sources: ['a'], kind: 'comb' }, { target: 'pick', sources: ['sel', 'a', 'b'], kind: 'comb' }],
    exprs: [{ target: 'zero', expr: { op: 'eq', args: [ref('a'), { op: 'const', value: '0' }] } }, { target: 'pick', expr: { op: 'cond', args: [ref('sel'), ref('a'), ref('b')] } }],
  });
  const inst = (name, module, goNet, outs) => ({ name, module, connections: [conn('clk', 'clk'), conn('rst_n', 'rst_n'), conn('go', goNet), conn('a', 'a'), conn('b', 'b'), conn('sel', 'sel'), ...outs.map(([p, n]) => conn(p, n, 'out'))] });
  return {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'top', diagnostics: [],
    hierarchy: [{ path: 'top', module: 'top' }, { path: 'top.u_rx', module: 'side_rx' }, { path: 'top.u_rx.u_ctrl', module: 'side_ctrl' }, { path: 'top.u_tx', module: 'side_tx' }, { path: 'top.u_tx.u_ctrl', module: 'side_ctrl' }],
    modules: [
      {
        name: 'top', orig_name: 'top',
        ports: [port('clk', 'in'), port('rst_n', 'in'), port('go', 'in'), port('a', 'in', 8), port('b', 'in', 8), port('sel', 'in'), port('rx_zero', 'out'), port('rx_pick', 'out', 8), port('tx_busy', 'out'), port('tx_zero', 'out'), port('tx_pick', 'out', 8)],
        nets: [net('clk'), net('rst_n'), net('go'), net('a', 8), net('b', 8), net('sel'), net('rx_zero'), net('rx_pick', 8), net('tx_busy'), net('tx_zero'), net('tx_pick', 8), net('rx_busy', 1, 'wire')],
        registers: [],
        instances: [
          inst('u_rx', 'side_rx', 'go', [['busy', 'rx_busy'], ['zero', 'rx_zero'], ['pick', 'rx_pick']]),
          inst('u_tx', 'side_tx', 'rx_busy', [['busy', 'tx_busy'], ['zero', 'tx_zero'], ['pick', 'tx_pick']]),
        ],
        deps: [],
      },
      side('side_rx'), side('side_tx'), ctrl,
    ],
  };
}

test('draft names say whose block it is and fit the whole block: "Rx controller", "Rx logic", never "Controller 2" or a zero detector for a hub', async () => {
  const { draftFigure } = await import('../lib/draft.mjs');
  const { doc, notes } = draftFigure(twoSidesNetlist(), { format: 'study', scope: '' });
  const labelOf = (id) => { const e = doc.elements.find((x) => x.id === id); return e.label ?? e.function?.name ?? e.function?.kind; };
  assert.equal(labelOf('u_rx_u_ctrl'), 'Rx controller');
  assert.equal(labelOf('u_tx_u_ctrl'), 'Tx controller');
  assert.equal(doc.elements.find((x) => x.id === 'u_rx_u_ctrl').function.kind, 'controller', 'the kind stays');
  const logic = doc.elements.filter((e) => e.kind === 'comb' && e.op === 'custom' && e.function?.kind !== 'controller');
  assert.deepEqual(logic.map((e) => e.function.name).sort(), ['Rx logic', 'Tx logic'], 'a compare on one of two outputs does not make a zero detector');
  assert.ok(notes.some((n) => /Zero detector would describe only part of the block \(1 of 2 outputs/.test(n)));
  // Study frames: one per expanded instance, named readably.
  assert.deepEqual((doc.regions || []).map((r) => [r.label, r.level]), [['Rx', 'block'], ['Tx', 'block']]);
  // Verified on the drawing, not the IR.
  const r = await renderDatapath(doc, { variant: 'study', name: 'sides' });
  const t = texts(r.svg);
  const names = titles(r.svg);
  for (const name of ['Rx controller', 'Tx controller', 'Rx logic', 'Tx logic']) assert.ok(names.includes(name), `${name} printed (${names.join(' | ')})`);
  for (const frame of ['Rx', 'Tx']) assert.ok(t.includes(frame), `frame ${frame} labeled`);
  assert.ok(!names.some((x) => /^(?:Controller|Comparator|Zero detector)(?: \d+)?$/.test(x)), names.join(' | '));
  assert.ok(!t.some((x) => /[a-z0-9]_[a-z0-9]/i.test(x)), 'no raw id printed');
  const frameX = (id) => Number(new RegExp(`id="region-${id}-frame" x="([\\d.]+)"`).exec(r.svg)[1]);
  assert.ok(frameX('r_u_rx') < frameX('r_u_tx'), 'rx drives tx, so rx is drawn left of tx');
  assert.ok(typeof r.route.readability.crossings_per_net === 'number');
});

function gitRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-hub-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'rtl');
  return { dir, revision: git('rev-parse', 'HEAD').stdout.trim() };
}

test('label/function-justification rejects a vocabulary name whose structure is in the cone of only some outputs', () => {
  const repo = gitRepo({ 'rtl/hub.sv': 'module hub;\n  assign z = (a == 0);\n  assign m = sel ? a : b;\nendmodule\n' });
  try {
    const netlist = {
      schema_version: 1, kind: 'rtl-netlist', top: 'hub', hierarchy: [{ path: 'hub', module: 'hub' }],
      modules: [{
        name: 'hub', orig_name: 'hub',
        ports: [port('a', 'in', 8), port('b', 'in', 8), port('sel', 'in'), port('z', 'out'), port('m', 'out', 8)],
        nets: [net('a', 8), net('b', 8), net('sel'), net('z'), net('m', 8)], registers: [], instances: [],
        deps: [{ target: 'z', sources: ['a'], kind: 'comb' }, { target: 'm', sources: ['sel', 'a', 'b'], kind: 'comb' }],
        exprs: [{ target: 'z', expr: { op: 'eq', args: [ref('a'), { op: 'const', value: '0' }] } }, { target: 'm', expr: { op: 'cond', args: [ref('sel'), ref('a'), ref('b')] } }],
      }],
    };
    const doc = {
      meta: { repository: { root: repo.dir, revision: repo.revision } },
      elements: [{ id: 'hub', kind: 'comb', op: 'custom', function: { kind: 'zero_detect', basis: { source: { file: 'rtl/hub.sv', line: 2, match: '== 0' }, structure: 'compare against zero' } } }],
      nets: [
        { id: 'n_a', driver: 'pa', sinks: ['hub.a'], rtl: { signal: 'a' } },
        { id: 'n_z', driver: 'hub.z', sinks: ['o1'], rtl: { signal: 'z' } },
        { id: 'n_m', driver: 'hub.m', sinks: ['o2'], rtl: { signal: 'm' } },
      ],
    };
    const partial = checkFunctionEvidence(doc, { figureDir: repo.dir, netlist, quality: 'paper' }).diagnostics;
    assert.equal(partial.length, 1);
    assert.equal(partial[0].severity, 'error');
    assert.match(partial[0].message, /describes only part of the block: 1 of 2 outputs \(n_m\) lack compare-zero/);
    doc.nets = doc.nets.filter((n) => n.id !== 'n_m');
    assert.deepEqual(checkFunctionEvidence(doc, { figureDir: repo.dir, netlist, quality: 'paper' }).diagnostics, [], 'a block that is all zero test keeps the name');
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('study flow: root units are layered along the flow, feedback found depth-first from the inputs', () => {
  const doc = { elements: [{ id: 'p' }, { id: 'x' }, { id: 'y' }] };
  const tree = { roots: [{ id: 'A', parent: null }, { id: 'B', parent: null }], all: [{ id: 'A', parent: null }, { id: 'B', parent: null }], owner: new Map([['x', 'A'], ['y', 'B']]) };
  const end = (id) => ({ element: { id } });
  const model = { nets: [{ driver: end('p'), sinks: [end('x')] }, { driver: end('x'), sinks: [end('y')] }, { driver: end('y'), sinks: [end('x')] }] };
  const ranks = rootRanks(doc, model, tree);
  assert.deepEqual([ranks.get('p'), ranks.get('region:A'), ranks.get('region:B')], [0, 1, 2]);
});

test('study connectors: a net whose route crosses a frame holding neither end becomes a connector pair', () => {
  const end = (id) => ({ element: { id } });
  const model = { nets: [{ net: { id: 'far' }, driver: end('x'), sinks: [end('z')] }, { net: { id: 'near' }, driver: end('x'), sinks: [end('y')] }] };
  const box = (id, x) => ({ id: `region:${id}`, x, y: 0, width: 10, height: 10, children: [] });
  const run = {
    laid: {
      children: [box('A', 0), box('B', 20), box('C', 40)],
      edges: [
        { id: 'far__0', sections: [{ startPoint: { x: 5, y: 5 }, endPoint: { x: 45, y: 5 } }] },
        { id: 'near__0', sections: [{ startPoint: { x: 5, y: 5 }, endPoint: { x: 25, y: 5 } }] },
      ],
    },
    tree: { all: [{ id: 'A', inside: new Set(['x']) }, { id: 'B', inside: new Set(['y']) }, { id: 'C', inside: new Set(['z']) }] },
  };
  assert.deepEqual(regionCrossingMarks(model, run), [{ net: 'far', sink: 0, span: 1, kind: 'inter-region' }]);
  // Frames stacked in columns: no route passes a frame, but x → z skips the
  // flow layer of B, so it is a connector; x → y joins neighbouring layers.
  const stacked = {
    laid: {
      children: [box('A', 0), { ...box('B', 20), y: 40 }, { ...box('C', 40), y: 80 }],
      edges: [
        { id: 'far__0', sections: [{ startPoint: { x: 10, y: 5 }, bendPoints: [{ x: 15, y: 5 }, { x: 15, y: 85 }], endPoint: { x: 40, y: 85 } }] },
        { id: 'near__0', sections: [{ startPoint: { x: 10, y: 5 }, bendPoints: [{ x: 15, y: 5 }, { x: 15, y: 45 }], endPoint: { x: 20, y: 45 } }] },
      ],
    },
    tree: { ...run.tree, all: run.tree.all.map((n) => ({ ...n, parent: null })), owner: new Map([['x', 'A'], ['y', 'B'], ['z', 'C']]) },
    ranks: new Map([['region:A', 1], ['region:B', 2], ['region:C', 3]]),
  };
  assert.deepEqual(regionCrossingMarks(model, stacked), [{ net: 'far', sink: 0, span: 1, kind: 'inter-region' }]);
});

test('readability is measured on the SVG: crossings per net and routed over direct length', () => {
  const svg = '<svg><path id="net-a-seg0" d="M0 10 L100 10"/><path id="net-b-seg0" d="M50 0 L50 20"/><path id="net-c-seg0" d="M0 30 L0 40 L20 40 L20 30"/><path id="net-a-arrow0" d="M1 1 L2 2"/></svg>';
  assert.deepEqual(readabilityFromSvg(svg), { nets: 3, crossings: 1, crossings_per_net: 0.33, wire_length_pt: 160, direct_length_pt: 140, wire_length_ratio: 1.14 });
});
