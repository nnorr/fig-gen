// Falcon-trial fixes (generic fixtures only): per-input and state latency on
// controller outputs (G1), bundles expanded for latency (G3), and one uniform
// arrowhead size per figure (arrow/nonuniform, arrow room).

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCoverage } from '../lib/checks/coverage.mjs';
import { checkDatapath } from '../lib/checks/datapath.mjs';
import { checkLatency } from '../lib/checks/latency.mjs';
import { connectivityChecks } from '../lib/render/connectivity.mjs';
import { ensureArrowRoom, labelAnchorGap, loadSkin, longFeedback, polylineDetour, renderDatapath } from '../lib/render/datapath.mjs';
import { validateSchema } from '../lib/validate.mjs';

const codes = (diags, code) => diags.filter((d) => d.code === code);

// top: start, go → u_ctl (module ctl) → ready.
// ctl: state_q <= f(start, state_q)  (state register with feedback)
//      ready = g(state_q, go)        (Mealy: 1 stage from start, 0 from go)
function controllerNetlist() {
  const reg = { name: 'state_q', width: 2, clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true }, clock_root: 'clk' };
  const port = (name, dir, width = 1) => ({ name, dir, width });
  const net = (name, width = 1, kind = 'port') => ({ name, width, kind });
  return {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'top', diagnostics: [],
    hierarchy: [{ path: 'top', module: 'top' }, { path: 'top.u_ctl', module: 'ctl' }],
    modules: [
      {
        name: 'top', orig_name: 'top',
        ports: [port('clk', 'in'), port('rst_n', 'in'), port('start', 'in'), port('go', 'in'), port('ready', 'out')],
        nets: [net('clk'), net('rst_n'), net('start'), net('go'), net('ready')],
        registers: [],
        instances: [{ name: 'u_ctl', module: 'ctl', connections: ['clk', 'rst_n', 'start', 'go'].map((p) => ({ port: p, dir: 'in', expr: { kind: 'net', net: p } })).concat([{ port: 'ready', dir: 'out', expr: { kind: 'net', net: 'ready' } }]) }],
        deps: [],
      },
      {
        name: 'ctl', orig_name: 'ctl',
        ports: [port('clk', 'in'), port('rst_n', 'in'), port('start', 'in'), port('go', 'in'), port('ready', 'out')],
        nets: [net('clk'), net('rst_n'), net('start'), net('go'), net('ready'), net('state_q', 2, 'var')],
        registers: [reg],
        instances: [],
        deps: [
          { target: 'state_q', sources: ['start', 'state_q', 'rst_n'], kind: 'seq' },
          { target: 'ready', sources: ['state_q', 'go'], kind: 'comb' },
        ],
      },
    ],
  };
}

function controllerFigure(readyPort, { kind = 'controller', bundled = false } = {}) {
  const inputs = bundled
    ? [{ id: 'cmd', dir: 'in', width: 2, bundle: ['start', 'go'] }]
    : [{ id: 'start', dir: 'in', width: 1 }, { id: 'go', dir: 'in', width: 1 }];
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'controller', print: { profile: 'ieee' }, scope: { hierarchy: 'all' } }, clock_domains: [{ id: 'sys', clock: 'clk' }],
    elements: [
      ...(bundled
        ? [{ id: 'p_cmd', kind: 'port', dir: 'in', width: 2, label: 'command' }]
        : [{ id: 'p_start', kind: 'port', dir: 'in', width: 1, label: 'start' }, { id: 'p_go', kind: 'port', dir: 'in', width: 1, label: 'go ahead' }]),
      { id: 'u_ctl', kind: 'instance', module: 'ctl', level: 'block', function: { kind }, rtl: { instance: 'u_ctl' }, ports: [{ id: 'clk', dir: 'in', width: 1, class: 'clock' }, { id: 'rst_n', dir: 'in', width: 1, class: 'reset' }, ...inputs, { id: 'ready', dir: 'out', width: 1, ...readyPort }] },
      { id: 'p_ready', kind: 'port', dir: 'out', width: 1, label: 'ready' },
    ],
    nets: [
      ...(bundled
        ? [{ id: 'n_cmd', width: 2, driver: 'p_cmd', sinks: ['u_ctl.cmd'], label: 'command', bundle_of: ['start', 'go'] }]
        : [{ id: 'n_start', width: 1, driver: 'p_start', sinks: ['u_ctl.start'], rtl: { signal: 'start' } }, { id: 'n_go', width: 1, driver: 'p_go', sinks: ['u_ctl.go'], rtl: { signal: 'go' } }]),
      { id: 'n_ready', width: 1, driver: 'u_ctl.ready', sinks: ['p_ready'], rtl: { signal: 'ready' } },
    ],
  };
}

test('G1: a controller output declares latency per input (or "state"); one number cannot describe it', async () => {
  const nl = controllerNetlist();
  const single = checkLatency(controllerFigure({ registered: true }), nl);
  assert.equal(codes(single.diagnostics, 'latency/hidden-register').length, 1, 'registered (1 stage) contradicts the 0-stage path from go');

  const perInput = controllerFigure({ latency: { start: 1, go: 0 } });
  assert.deepEqual(await validateSchema('datapath', perInput), []);
  assert.deepEqual(codes(checkDatapath(perInput).diagnostics, 'latency/controller-only'), []);
  const r = checkLatency(perInput, nl);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.report.pairs_checked, 2);
  assert.equal(r.report.mismatches, 0);

  const wrong = checkLatency(controllerFigure({ latency: { start: 2, go: 0 } }), nl);
  assert.equal(wrong.report.mismatches, 1);
  const missing = checkLatency(controllerFigure({ latency: { start: 1 } }), nl);
  assert.match(missing.diagnostics[0].message, /not for input pin go/);

  const state = controllerFigure({ latency: 'state' });
  assert.deepEqual(await validateSchema('datapath', state), []);
  const s = checkLatency(state, nl);
  assert.deepEqual(s.diagnostics.filter((d) => d.severity === 'error'), [], '"state" is not an error (it warns latency/state-escape where a map is measurable)');
  assert.equal(s.report.state_pairs, 2);

  const notController = controllerFigure({ latency: { start: 1, go: 0 } }, { kind: 'custom' });
  notController.elements[2].function = { kind: 'custom', name: 'Glue logic' };
  assert.equal(codes(checkDatapath(notController).diagnostics, 'latency/controller-only').length, 1);
  const unknownPin = controllerFigure({ latency: { start: 1, nope: 0 } });
  assert.equal(codes(checkDatapath(unknownPin).diagnostics, 'latency/unknown-input').length, 1);
});

test('G1: a net drawn without an RTL mapping on purpose is counted with its reason', () => {
  const doc = controllerFigure({ latency: 'state' });
  delete doc.nets[1].rtl;
  doc.nets[1].rtl_unmapped = { reason: 'latency varies by input' };
  const r = checkLatency(doc, controllerNetlist());
  assert.deepEqual(r.report.excluded_unmapped, [{ net: 'n_go', reason: 'latency varies by input' }]);
});

test('G3: bundle nets are expanded to their members for latency, not skipped', async () => {
  const nl = controllerNetlist();
  const doc = controllerFigure({ latency: { cmd: 0 } }, { bundled: true });
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const r = checkLatency(doc, nl);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.report.pairs_checked, 1, 'the bundle pair is checked');
  assert.equal(r.report.bundled_pairs_checked, 1);
  assert.equal(r.report.member_pairs_checked, 2);
  const late = checkLatency(controllerFigure({ latency: { cmd: 2 } }, { bundled: true }), nl);
  assert.equal(late.report.mismatches, 1, 'the minimum member latency (0) is compared');
  const ghost = controllerFigure({ latency: { cmd: 0 } }, { bundled: true });
  ghost.nets[0].bundle_of = ['start', 'not_a_signal'];
  assert.equal(checkLatency(ghost, nl).report.pairs_skipped_bundled, 1);
});

test('G2: an instance output read back inside the instance is represented even when a port covers it', () => {
  // ctl.state_q depends on ctl.ready (its own output): the transfer ready → state_q lies inside u_ctl.
  const nl = controllerNetlist();
  const ctl = nl.modules.find((m) => m.name === 'ctl');
  ctl.deps.find((d) => d.target === 'state_q').sources.push('ready');
  const doc = controllerFigure({ latency: 'state' });
  const r = checkCoverage(doc, nl);
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'coverage/dropped-hardware'), []);
  assert.equal(r.report.totals.transfers.represented, r.report.totals.transfers.total);

  // A transfer that really is missing names both owners and why: a top-level
  // register loaded from the instance output, covered by a block with no wire from it.
  const top = nl.modules.find((m) => m.name === 'top');
  top.nets.push({ name: 'seen_q', width: 1, kind: 'var' });
  top.registers.push({ name: 'seen_q', width: 1, clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true }, clock_root: 'clk' });
  top.deps.push({ target: 'seen_q', sources: ['ready', 'rst_n'], kind: 'seq' });
  const loose = structuredClone(doc);
  loose.elements.push({ id: 'b_seen', kind: 'comb', op: 'custom', width: 1, function: { kind: 'custom', name: 'Seen flag' }, rtl: { covers: ['seen_q'] }, ports: [{ id: 'o', dir: 'out', width: 1 }] });
  const r2 = checkCoverage(loose, nl);
  const dropped = r2.diagnostics.filter((d) => d.code === 'coverage/dropped-hardware' && d.subject.kind === 'transfer');
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].message, /no drawn wire leads from net n_ready to comb b_seen/);
});

// A block with many RTL pins (the trial's "Client bus packing" shape).
function packingFigure(extra = {}) {
  const pins = ['req_a', 'req_b', 'req_c', 'rsp_packed', 'rsp_status'];
  return {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'packing', print: { profile: 'ieee' }, ...(extra.pin_labels ? { style: { block_details: true } } : {}) }, clock_domains: [],
    elements: [
      ...pins.map((p) => ({ id: `p_${p}`, kind: 'port', dir: 'in', width: 4, label: `${p.replace('_', ' ')} in` })),
      { id: 'pack', kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name: 'Client bus packing' }, ports: [{ id: 'clk', dir: 'in', width: 1, class: 'clock' }, ...pins.map((p) => ({ id: p, dir: 'in', width: 4 })), { id: 'req_out', dir: 'out', width: 8 }], ...extra },
      { id: 'q', kind: 'port', dir: 'out', width: 8, label: 'packed requests' },
    ],
    nets: [...pins.map((p) => ({ id: `n_${p}`, width: 4, driver: `p_${p}`, sinks: [`pack.${p}`] })), { id: 'n_out', width: 8, driver: 'pack.req_out', sinks: ['q'] }],
  };
}

test('(B) no pin names inside boxes by default; opt-in labels print only readable words, never ids or clock/reset', async () => {
  const plain = await renderDatapath(packingFigure(), { variant: '2col', widthPt: 515.5, name: 'pack' });
  assert.doesNotMatch(plain.svg, /id="[^"]*-pin-/, 'no pin text by default, even with 6 pins');
  assert.doesNotMatch(plain.svg, />req_a<|>rsp_packed<|>clk</);

  const opt = packingFigure({ pin_labels: true });
  opt.meta.style = { ...(opt.meta.style || {}), block_details: true }; // pin labels are a detail: opted in per figure
  const block = opt.elements.find((e) => e.id === 'pack');
  block.ports.find((p) => p.id === 'req_a').label = 'minuend';
  block.ports.find((p) => p.id === 'clk').label = 'clock';
  const r = await renderDatapath(opt, { variant: '2col', widthPt: 515.5, name: 'pack' });
  assert.match(r.svg, />minuend</);
  assert.doesNotMatch(r.svg, />req_b<|>rsp_status<|>clock</, 'unlabeled pins and clock pins never print');
});

test('(B) label/pin-clutter: at most 4 readable pin labels, none on clock/reset, and only with a label to print', async () => {
  const { checkLabels } = await import('../lib/checks/labels.mjs');
  const clutter = (doc, quality) => checkLabels(doc, 'datapath', { quality }).filter((d) => d.code === 'label/pin-clutter');
  const ok = packingFigure({ pin_labels: true });
  ok.elements.find((e) => e.id === 'pack').ports.find((p) => p.id === 'req_a').label = 'minuend';
  assert.deepEqual(clutter(ok, 'paper'), []);

  const five = packingFigure({ pin_labels: true });
  five.elements.find((e) => e.id === 'pack').ports.filter((p) => p.dir === 'in' && p.class !== 'clock').forEach((p, i) => { p.label = ['first', 'second', 'third', 'fourth', 'fifth'][i]; });
  assert.equal(clutter(five, 'paper').length, 1);
  assert.equal(clutter(five, 'paper')[0].severity, 'error');
  assert.equal(clutter(five)[0].severity, 'warning');

  const mnemonic = packingFigure({ pin_labels: true });
  mnemonic.elements.find((e) => e.id === 'pack').ports.find((p) => p.id === 'req_a').label = 'req_h2p';
  assert.match(clutter(mnemonic, 'paper')[0].message, /not a readable word/);

  const clock = packingFigure({ pin_labels: true });
  const pk = clock.elements.find((e) => e.id === 'pack');
  pk.ports.find((p) => p.id === 'clk').label = 'clock';
  pk.ports.find((p) => p.id === 'req_a').label = 'minuend';
  assert.match(clutter(clock, 'paper')[0].message, /clock pin clk has a label/);

  assert.match(clutter(packingFigure({ pin_labels: true }), 'paper')[0].message, /no pin has a readable label/);
});

test('(A) a constant printed as a raw literal and repeated net labels do not pass under paper', async () => {
  const { checkLabels } = await import('../lib/checks/labels.mjs');
  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'tie', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      // an authored label in literal syntax prints as-is; a bare value prints "0" in the value box
      { id: 'c0', kind: 'const', value: "1'b0", label: "1'b0" },
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'requests' },
      { id: 'b', kind: 'port', dir: 'in', width: 8, label: 'more requests' },
      { id: 'blk', kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name: 'Client' }, ports: [{ id: 'last', dir: 'in', width: 1 }, { id: 'x', dir: 'in', width: 8 }, { id: 'y', dir: 'in', width: 8 }, { id: 'o', dir: 'out', width: 8 }, { id: 'p', dir: 'out', width: 8 }] },
      { id: 'o1', kind: 'port', dir: 'out', width: 8, label: 'responses' },
      { id: 'o2', kind: 'port', dir: 'out', width: 8, label: 'other responses' },
    ],
    nets: [
      { id: 'nc', width: 1, driver: 'c0', sinks: ['blk.last'] },
      { id: 'na', width: 8, driver: 'a', sinks: ['blk.x'], label: 'client command' },
      { id: 'nb', width: 8, driver: 'b', sinks: ['blk.y'], label: 'client command' },
      { id: 'no', width: 8, driver: 'blk.o', sinks: ['o1'], label: 'responses' },
      { id: 'np', width: 8, driver: 'blk.p', sinks: ['o2'] },
    ],
  };
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const diags = checkLabels(doc, 'datapath', { quality: 'paper' });
  assert.equal(codes(diags, 'label/constant-as-port-label').length, 1);
  const bare = structuredClone(doc);
  delete bare.elements[0].label;
  assert.equal(codes(checkLabels(bare, 'datapath', { quality: 'paper' }), 'label/constant-as-port-label').length, 0);
  const dup = codes(diags, 'label/duplicate-net-label');
  assert.equal(dup.length, 2, 'two nets share "client command"; net no repeats its port label');
  assert.ok(dup.every((d) => d.severity === 'error'));
  const fixed = structuredClone(doc);
  fixed.elements[0].label = 'tied low';
  fixed.nets[1].label = 'hash-to-point command';
  delete fixed.nets[3].label;
  const clean = checkLabels(fixed, 'datapath', { quality: 'paper' });
  assert.deepEqual([...codes(clean, 'label/constant-as-port-label'), ...codes(clean, 'label/duplicate-net-label')], []);
});

// top: go → u_ctrl (enum state machine) → ready; a, b → u_mul (a*b) → p; p, a → u_x (p^a) → y.
function draftNetlist() {
  const port = (name, dir, width = 1) => ({ name, dir, width });
  const net = (name, width = 1, kind = 'port') => ({ name, width, kind });
  const conn = (port0, n, dir = 'in') => ({ port: port0, dir, expr: { kind: 'net', net: n } });
  const ref = (name) => ({ op: 'ref', name });
  return {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'top', diagnostics: [],
    hierarchy: [{ path: 'top', module: 'top' }, { path: 'top.u_ctrl', module: 'ctrl' }, { path: 'top.u_mul', module: 'mulblk' }, { path: 'top.u_x', module: 'xorblk' }],
    modules: [
      {
        name: 'top', orig_name: 'top',
        ports: [port('clk', 'in'), port('rst_n', 'in'), port('go', 'in'), port('a', 'in', 8), port('b', 'in', 8), port('ready', 'out'), port('y', 'out', 8)],
        nets: [net('clk'), net('rst_n'), net('go'), net('a', 8), net('b', 8), net('ready'), net('y', 8), net('p', 8, 'wire')],
        registers: [],
        instances: [
          { name: 'u_ctrl', module: 'ctrl', connections: [conn('clk', 'clk'), conn('rst_n', 'rst_n'), conn('go', 'go'), conn('ready', 'ready', 'out')] },
          { name: 'u_mul', module: 'mulblk', connections: [conn('a', 'a'), conn('b', 'b'), conn('p', 'p', 'out')] },
          { name: 'u_x', module: 'xorblk', connections: [conn('p', 'p'), conn('a', 'a'), conn('y', 'y', 'out')] },
        ],
        deps: [],
      },
      {
        name: 'ctrl', orig_name: 'ctrl',
        ports: [port('clk', 'in'), port('rst_n', 'in'), port('go', 'in'), port('ready', 'out')],
        nets: [net('clk'), net('rst_n'), net('go'), net('ready'), net('state_q', 2, 'var')],
        registers: [{ name: 'state_q', width: 2, clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true }, clock_root: 'clk', enum: { type: 'state_e', width: 2, items: [{ name: 'Idle', value: 0 }, { name: 'Busy', value: 1 }, { name: 'Done', value: 2 }] } }],
        instances: [],
        deps: [{ target: 'state_q', sources: ['go', 'state_q', 'rst_n'], kind: 'seq' }, { target: 'ready', sources: ['state_q'], kind: 'comb' }],
        exprs: [{ target: 'ready', expr: { op: 'eq', args: [ref('state_q'), { op: 'const', value: '2' }] } }],
      },
      {
        name: 'mulblk', orig_name: 'mulblk',
        ports: [port('a', 'in', 8), port('b', 'in', 8), port('p', 'out', 8)],
        nets: [net('a', 8), net('b', 8), net('p', 8)], registers: [], instances: [],
        deps: [{ target: 'p', sources: ['a', 'b'], kind: 'comb' }],
        exprs: [{ target: 'p', expr: { op: 'mul', args: [ref('a'), ref('b')] } }],
      },
      {
        name: 'xorblk', orig_name: 'xorblk',
        ports: [port('p', 'in', 8), port('a', 'in', 8), port('y', 'out', 8)],
        nets: [net('p', 8), net('a', 8), net('y', 8)], registers: [], instances: [],
        deps: [{ target: 'y', sources: ['p', 'a'], kind: 'comb' }],
        exprs: [{ target: 'y', expr: { op: 'xor', args: [ref('p'), ref('a')] } }],
      },
    ],
  };
}

test('G4: draft names come from structure — enum state register → controller, multiply → arithmetic unit, XOR alone is not a GF adder', async () => {
  const { draftFigure } = await import('../lib/draft.mjs');
  const { doc } = draftFigure(draftNetlist(), { preset: 'block', scope: '' });
  const fn = (id) => doc.elements.find((e) => e.id === id)?.function;
  assert.equal(fn('u_ctrl').kind, 'controller');
  assert.equal(fn('u_mul').kind, 'arithmetic_unit');
  assert.deepEqual(fn('u_x'), { kind: 'custom', name: 'Xorblk' }, 'weak evidence falls back to the module name');
  assert.ok(!doc.elements.some((e) => e.function?.kind?.startsWith('gf_')));
});

test('G5: a block view of the netlist top drafts, has no doubled ids, never sinks into an input port, and passes its own checks', async () => {
  const { draftFigure } = await import('../lib/draft.mjs');
  const { draftResiduals } = await import('../lib/draft-check.mjs');
  const { checkView } = await import('../lib/view.mjs');
  const nl = draftNetlist();
  const { doc } = draftFigure(nl, { preset: 'block', scope: '' });
  assert.deepEqual(await validateSchema('datapath', doc), []);
  assert.deepEqual(checkView(doc, { netlist: nl }).diagnostics.filter((d) => d.code === 'view/preset-violation'), [], 'block view of the top is allowed');
  const ids = doc.elements.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.ok(!ids.some((id) => /^u_u_/.test(id)), 'no doubled u_ prefix');
  const inputPorts = new Set(doc.elements.filter((e) => e.kind === 'port' && e.dir !== 'out').map((e) => e.id));
  assert.ok(doc.nets.every((n) => n.sinks.every((s) => !inputPorts.has(String(s).split('.')[0]))), 'no net sinks into an input port');
  assert.deepEqual(await draftResiduals(doc, nl), []);
});

test('G5: the draft command prints its residual checks', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-residual-'));
  // The netlist records its (user) RTL input, as check-rtl does, so the evidence guard accepts it.
  const rtl = path.join(dir, 'top.sv');
  fs.writeFileSync(rtl, 'module top; endmodule\n');
  const nl = draftNetlist();
  nl.inputs = { source_root: dir, files: [{ role: 'rtl', path: 'top.sv', sha256: createHash('sha256').update(fs.readFileSync(rtl)).digest('hex') }] };
  const nlFile = path.join(dir, 'netlist.json');
  fs.writeFileSync(nlFile, JSON.stringify(nl));
  const bin = new URL('../bin/fig-gen.mjs', import.meta.url).pathname;
  // Paper (default): residuals are judged at paper quality, so one-letter RTL port names are listed.
  const paper = spawnSync(process.execPath, [bin, 'draft', '--view', 'block', '--scope', '', '--netlist', nlFile, '--out', path.join(dir, 'draft.json')], { encoding: 'utf8' });
  assert.equal(paper.status, 0, paper.stderr);
  assert.match(paper.stderr, /^residual: label\/unreadable: port p_go: label "go"/m);
  assert.match(paper.stderr, /note: the draft still fails 4 of its own checks/);
  // Study: readability is a warning, so the same draft passes its own checks.
  const study = spawnSync(process.execPath, [bin, 'draft', '--view', 'block', '--scope', '', '--netlist', nlFile, '--format', 'study', '--out', path.join(dir, 'draft-study.json')], { encoding: 'utf8' });
  assert.equal(study.status, 0, study.stderr);
  assert.doesNotMatch(study.stderr, /^residual: /m);
  assert.match(study.stderr, /note: the draft passes its own checks/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('G8 / (A): connectors follow the routed detour, not the layer span; adjacent feedback stays a wire', () => {
  const model = { nets: [
    { net: { id: 'wrap' }, driver: { element: { id: 'a' } }, sinks: [{ element: { id: 'b' } }] },
    { net: { id: 'near' }, driver: { element: { id: 'c' } }, sinks: [{ element: { id: 'd' } }] },
    { net: { id: 'far' }, driver: { element: { id: 'e' } }, sinks: [{ element: { id: 'f' } }] },
  ] };
  const sec = (pts) => [{ startPoint: pts[0], bendPoints: pts.slice(1, -1), endPoint: pts.at(-1) }];
  const run = {
    contentW: 100,
    part: { backEdges: new Set(['c>d', 'e>f']) },
    laid: { edges: [
      // forward net that wraps around the figure: route 215, direct 95
      { id: 'wrap__0', sections: sec([{ x: 0, y: 0 }, { x: 0, y: 60 }, { x: 90, y: 60 }, { x: 90, y: 0 }, { x: 95, y: 0 }]) },
      // feedback between neighbours: 20 pt route
      { id: 'near__0', sections: sec([{ x: 40, y: 10 }, { x: 40, y: 20 }, { x: 30, y: 20 }]) },
      // feedback across the figure: 110 pt route
      { id: 'far__0', sections: sec([{ x: 95, y: 10 }, { x: 95, y: 30 }, { x: 5, y: 30 }]) },
    ] },
  };
  assert.deepEqual(polylineDetour([{ x: 0, y: 0 }, { x: 0, y: 60 }, { x: 90, y: 60 }, { x: 90, y: 0 }, { x: 95, y: 0 }]), { length: 215, detour: 120 });
  const marks = longFeedback(model, run, 0.5);
  assert.deepEqual(marks.map((m) => [m.net, m.kind]).sort(), [['far', 'feedback'], ['wrap', 'wrap-around']]);
});

test('G8: label/ambiguous-anchor — a net label must sit closer to its own wire than to another', () => {
  const nets = [
    { id: 'owner_status', polylines: [[{ x: 0, y: 20 }, { x: 100, y: 20 }]] },
    { id: 'client_ready', polylines: [[{ x: 0, y: 30 }, { x: 100, y: 30 }]] },
  ];
  // "owner status" placed just above client_ready (the trial's 5b case)
  const wrong = labelAnchorGap({ x0: 10, x1: 50, y0: 23, y1: 28 }, nets, 'owner_status');
  assert.ok(wrong.own > wrong.foreign - 0.5);
  assert.equal(wrong.other, 'client_ready');
  const right = labelAnchorGap({ x0: 10, x1: 50, y0: 12, y1: 17.5 }, nets, 'owner_status');
  assert.ok(right.own <= right.foreign - 0.5);
});

test('G7: identical splits of one bus are drawn once (pure simplification, no hardware dropped)', async () => {
  const { mergeDuplicateSplits } = await import('../lib/ir/canonical.mjs');
  const doc = {
    elements: [
      { id: 'p', kind: 'port', dir: 'in', width: 4 },
      { id: 'sa', kind: 'comb', op: 'split', width: 4, slices: ['3', '2'] },
      { id: 'sb', kind: 'comb', op: 'split', width: 4, slices: ['3', '2'] },
      { id: 'g1', kind: 'comb', op: 'and', width: 1, inputs: 2 },
      { id: 'g2', kind: 'comb', op: 'or', width: 1, inputs: 2 },
    ],
    nets: [
      { id: 'n', width: 4, driver: 'p', sinks: ['sa.in0', 'sb.in0'] },
      { id: 'a3', width: 1, driver: 'sa.out0', sinks: ['g1.in0'] },
      { id: 'a2', width: 1, driver: 'sa.out1', sinks: ['g1.in1'] },
      { id: 'b3', width: 1, driver: 'sb.out0', sinks: ['g2.in0'] },
      { id: 'b2', width: 1, driver: 'sb.out1', sinks: ['g2.in1'] },
    ],
    regions: [{ id: 'r', level: 'gate', members: ['sa', 'sb', 'g1', 'g2'] }],
  };
  const { doc: out, merged } = mergeDuplicateSplits(doc);
  assert.deepEqual(merged, [{ kept: 'sa', removed: 'sb' }]);
  assert.ok(!out.elements.some((e) => e.id === 'sb'));
  assert.deepEqual(out.nets.find((n) => n.id === 'n').sinks, ['sa.in0']);
  assert.deepEqual(out.nets.find((n) => n.id === 'a3').sinks, ['g1.in0', 'g2.in0']);
  assert.deepEqual(out.nets.find((n) => n.id === 'a2').sinks, ['g1.in1', 'g2.in1']);
  assert.deepEqual(out.regions[0].members, ['sa', 'g1', 'g2']);
  assert.equal(mergeDuplicateSplits(out).merged.length, 0);
});

test('G7: the fit report says how far over and which layers and columns set the size', async () => {
  const { sizeReport } = await import('../lib/render/datapath.mjs');
  const run = { contentW: 100, contentH: 60, nodes: new Map([['a', { x: 0, width: 20, height: 10 }], ['b', { x: 5, width: 10, height: 30 }], ['c', { x: 40, width: 30, height: 10 }]]) };
  const s = sizeReport(run);
  assert.equal(s.layers, 2);
  assert.equal(s.spacing_pt, 50);
  assert.equal(s.widest_layers[0].width_pt, 30);
  assert.match(s.widest_layers[0].nodes[0], /^c /);
  assert.equal(s.tallest_columns[0].height_pt, 40);
  assert.match(s.tallest_columns[0].nodes[0], /^b /);

  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'wide', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'a rather long input label' },
      { id: 'blk', kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name: 'An extremely wide block title' }, ports: [{ id: 'i', dir: 'in', width: 8 }, { id: 'o', dir: 'out', width: 8 }] },
      { id: 'q', kind: 'port', dir: 'out', width: 8, label: 'a rather long output label' },
    ],
    nets: [{ id: 'n0', width: 8, driver: 'a', sinks: ['blk.i'] }, { id: 'n1', width: 8, driver: 'blk.o', sinks: ['q'] }],
  };
  const r = await renderDatapath(doc, { variant: '1col', widthPt: 120, name: 'wide' });
  const over = r.diagnostics.find((d) => d.code === 'print/width-overflow');
  assert.ok(over, 'the figure overflows the narrow column');
  assert.match(over.message, /pt over; width set by \d+ layers/);
  assert.ok(over.evidence.size_report.widest_layers.length >= 1);
  assert.ok(r.size_report.layers >= 3);
});

test('(C) region/entry-side: a net enters a frame through the side facing its source, clear of corners and the label', async () => {
  const { frameEntryChecks } = await import('../lib/render/geometry.mjs');
  const frames = [{ id: 'gates', x0: 100, y0: 50, x1: 200, y1: 150, labelW: 60, labelH: 13 }];
  const src = { x: 20, y: 120 }; // left of the frame, within its vertical span: only the west side faces it
  const entry = (pts) => frameEntryChecks(frames, [{ net: 'logn', region: 'gates', pts }], { frameGap: 6 });
  // climbs over the top-left and drops in through the north edge (the trial's fig 3 shape)
  const north = entry([src, { x: 60, y: 120 }, { x: 60, y: 30 }, { x: 130, y: 30 }, { x: 130, y: 80 }]);
  assert.equal(north.length, 1);
  assert.match(north[0].message, /north side, which does not face its source/);
  // west side, but 5 pt below the top-left corner
  assert.match(entry([src, { x: 60, y: 120 }, { x: 60, y: 55 }, { x: 140, y: 55 }])[0].message, /from a corner/);
  // west side, mid-edge but through the label band (y < y0 + labelH)
  assert.match(entry([src, { x: 60, y: 120 }, { x: 60, y: 62 }, { x: 140, y: 62 }])[0].message, /label band/);
  // west side, mid-edge: fine
  assert.deepEqual(entry([src, { x: 140, y: 120 }]), []);
});

const headSvg = (w2) => `<svg xmlns="http://www.w3.org/2000/svg" width="60pt" height="40pt" viewBox="0 0 60 40"><g id="nets"><g id="nets-data">
<g id="net-a"><path id="net-a-seg0" d="M0 10 L44.6 10" fill="none" stroke="#000000" stroke-width="0.9" stroke-linejoin="miter"/><path id="net-a-arrow0" d="M44.6 8.1 L50 10 L44.6 11.9 Z" fill="#000000" stroke="none"/></g>
<g id="net-b"><path id="net-b-seg0" d="M0 30 L46 30" fill="none" stroke="#000000" stroke-width="0.9" stroke-linejoin="miter"/><path id="net-b-arrow0" d="M46 ${30 - w2} L50 30 L46 ${30 + w2} Z" fill="#000000" stroke="none"/></g>
</g></g></svg>`;

test('arrow/nonuniform: every arrowhead in a figure has the skin length and width', async () => {
  const arrow = { length: 5.4, width: 3.8 };
  const uniform = connectivityChecks(headSvg(1.9).replace('M46 28.1 L50 30 L46 31.9', 'M44.6 28.1 L50 30 L44.6 31.9').replace('M0 30 L46 30', 'M0 30 L44.6 30'), { arrow });
  assert.deepEqual(codes(uniform.diagnostics, 'arrow/nonuniform'), []);
  assert.equal(uniform.counts.arrows_checked, 2);
  const shortened = connectivityChecks(headSvg(1.6), { arrow });
  const hits = codes(shortened.diagnostics, 'arrow/nonuniform');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].subject.id, 'net b arrow 0');

  // A rendered figure: every head matches the skin; the receipt counts them.
  const skin = loadSkin();
  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'arrows', print: { profile: 'ieee' } }, clock_domains: [],
    elements: [
      { id: 'a', kind: 'port', dir: 'in', width: 8, label: 'value A' }, { id: 'b', kind: 'port', dir: 'in', width: 8, label: 'value B' },
      { id: 's', kind: 'port', dir: 'in', width: 1, class: 'control', label: 'select' }, { id: 'm', kind: 'mux', inputs: 2, width: 8 },
      { id: 'q', kind: 'port', dir: 'out', width: 8, label: 'result' },
    ],
    nets: [{ id: 'na', width: 8, driver: 'a', sinks: ['m.in0'] }, { id: 'nb', width: 8, driver: 'b', sinks: ['m.in1'] }, { id: 'ns', width: 1, class: 'control', driver: 's', sinks: ['m.sel'] }, { id: 'nm', width: 8, driver: 'm.out', sinks: ['q'] }],
  };
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'arrows' });
  assert.deepEqual(r.diagnostics.filter((d) => /^arrow\//.test(d.code)), []);
  assert.ok(r.route.connectivity.arrows_checked >= 4);
  assert.equal(r.route.connectivity.arrow_nonuniform, 0);
  for (const m of r.svg.matchAll(/id="net-[^"]+-arrow\d+" d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)/g)) {
    const [x0, y0, tx, ty, x2, y2] = m.slice(1).map(Number);
    const base = { x: (x0 + x2) / 2, y: (y0 + y2) / 2 };
    assert.ok(Math.abs(Math.hypot(tx - base.x, ty - base.y) - skin.tokens.arrow.length) < 0.05);
  }
});

test('arrow room: a sink run shorter than the head plus a shaft moves its bend back; the head is never shortened', () => {
  const pts = new Map([['n__0', [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 23, y: 10 }]]]);
  assert.equal(ensureArrowRoom(pts, [{ id: 'n__0', net: 'n' }], { arrowLen: 5.4, minShaft: 1 }), 1);
  assert.deepEqual(pts.get('n__0').map((p) => Math.round(p.x * 10) / 10), [0, 16.6, 16.6, 23]);
  // A block in the way: the bend moves past it to the nearest position that neither enters nor hugs it (4 pt gap).
  const detour = new Map([['n__0', [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 23, y: 10 }]]]);
  assert.equal(ensureArrowRoom(detour, [{ id: 'n__0', net: 'n' }], { arrowLen: 5.4, minShaft: 1, minGap: 4, rects: [{ x0: 10, y0: 2, x1: 18, y1: 8 }] }), 1);
  assert.deepEqual(detour.get('n__0').map((p) => Math.round(p.x * 10) / 10), [0, 5.6, 5.6, 23]);
  // Every position enters or hugs a block: kept, and reported by the renderer as arrow/no-room.
  const blocked = new Map([['n__0', [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 23, y: 10 }]]]);
  assert.equal(ensureArrowRoom(blocked, [{ id: 'n__0', net: 'n' }], { arrowLen: 5.4, minShaft: 1, minGap: 4, rects: [{ x0: 1, y0: 2, x1: 18, y1: 8 }] }), 0);
  assert.deepEqual(blocked.get('n__0').map((p) => p.x), [0, 20, 20, 23]);
});
