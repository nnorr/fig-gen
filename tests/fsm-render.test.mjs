// FSM figures (SPEC §5): guard language, semantic checks, the renderer
// verified on the final SVG geometry and text, and delivery in paper and
// study formats with a schema-valid receipt.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkFsm, stateNames } from '../lib/checks/fsm.mjs';
import { parseGuard as rtlGuard } from '../lib/checks/fsm-crosscheck.mjs';
import { deliver } from '../lib/deliver.mjs';
import { guardIdentifiers, guardsOverlap, normalizeGuard, parseGuard, printGuard } from '../lib/fsm/guard.mjs';
import { readableIdentifier } from '../lib/checks/labels.mjs';
import { encodingText, renderFsm, wrap } from '../lib/render/fsm.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { validateFigure, validateSchema } from '../lib/validate.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-fsm-'));
const codes = (list, code) => list.filter((d) => d.code === code);
const ast = (src) => { const r = parseGuard(src); assert.ok(r.ok, r.error); return r.ast; };

// A mixed machine: reset arc, self-loop, any-state arc, Moore outputs and a Mealy action.
function sample() {
  return {
    schema_version: 1, figure_type: 'fsm',
    meta: { title: 'Sample controller', print: { profile: 'ieee' } },
    machine: { name: 'ctrl.state_q', state_width: 2, encoding: 'binary', kind: 'mixed', default: 'hold' },
    inputs: [{ name: 'start_i', width: 1 }, { name: 'is_last_word', width: 1 }, { name: 'soft_reset', width: 1 }, { name: 'mode_q', width: 2 }],
    outputs: [{ name: 'busy_o', width: 1, type: 'moore' }, { name: 'flush_load', width: 1, type: 'mealy' }],
    reset: { state: 'S_IDLE', condition: '!rst_n', async: true },
    states: [
      { id: 'S_IDLE', encoding: "2'b00", outputs: { busy_o: '0' } },
      { id: 'S_RUN', encoding: "2'b01", outputs: { busy_o: '1' } },
      { id: 'S_FLUSH', encoding: "2'b10", outputs: { busy_o: '1' } },
      { id: 'S_DONE', encoding: "2'b11" },
    ],
    transitions: [
      { id: 't0', from: 'S_IDLE', to: 'S_RUN', guard: "start_i && mode_q != 2'b11" },
      { id: 't1', from: 'S_RUN', to: 'S_RUN', guard: '!is_last_word' },
      { id: 't2', from: 'S_RUN', to: 'S_FLUSH', guard: 'is_last_word', actions: { flush_load: '1' } },
      { id: 't3', from: 'S_FLUSH', to: 'S_DONE' },
      { id: 't4', from: 'S_DONE', to: 'S_IDLE' },
      { id: 't5', from: '*', to: 'S_IDLE', guard: 'soft_reset', except: ['S_IDLE'], style: 'any_state' },
    ],
  };
}

test('guard language: parse, identifiers, readable printing and normal form', () => {
  const g = ast("(cmd_valid_i && cmd_ready_o) && (cmd_logn_i == 4'd9 || cmd_logn_i == 4'd10) && cmd_op_i <= FalconOpVerify");
  assert.deepEqual([...guardIdentifiers(g)].sort(), ['FalconOpVerify', 'cmd_logn_i', 'cmd_op_i', 'cmd_ready_o', 'cmd_valid_i']);
  const printed = printGuard(g, { name: readableIdentifier });
  assert.equal(printed, 'command valid and command ready and (command logn = 9 or command logn = 10) and command op <= FalconOpVerify');
  assert.doesNotMatch(printed, /_|&&|\|\||'d/);
  assert.equal(printGuard(ast("!a || b[3] != 1'b1"), { name: (s) => s }), 'not a or b[3] is not 1');
  assert.equal(printGuard(ast("x ? y : c_owner[1:0]"), { name: (s) => s }), 'if x then y else c_owner[1:0]');
  assert.equal(printGuard(ast("a && (b || c)"), { name: (s) => s }), 'a and (b or c)');
  assert.equal(printGuard(ast("32'h1000"), {}), '0x1000');
  assert.equal(normalizeGuard(ast('b && a')), normalizeGuard(ast('(a) && b')));
  for (const bad of ['a &&', 'a + b', '(a', 'a ==']) assert.equal(parseGuard(bad).ok, false, bad);
  assert.equal(parseGuard('').ast, null);
  assert.equal(guardsOverlap(ast("m == 2'd1"), ast("m == 2'd2")), false);
  assert.equal(guardsOverlap(ast('a && b'), ast('a')), true);
  assert.equal(guardsOverlap(ast('a'), ast('!a')), false);
});

test('generated state names drop the shared prefix and stay readable; labels win', () => {
  const names = stateNames({ states: [{ id: 'OwnerIdle' }, { id: 'OwnerMetaCounter0' }, { id: 'OwnerZeroize', label: 'Zeroize engine' }] });
  assert.deepEqual([...names.values()].map((n) => n.text), ['Idle', 'Meta counter 0', 'Zeroize engine']);
  assert.equal(names.get('OwnerIdle').generated, true);
  assert.deepEqual([...stateNames({ states: [{ id: 'S_IDLE' }, { id: 'S_RUN' }] }).values()].map((n) => n.text), ['Idle', 'Run']);
  assert.equal(encodingText("3'h2", 3), '010');
  assert.equal(encodingText("12'h0ff", 12), '0xFF');
  // a comparison stays whole with its left operand
  assert.deepEqual(wrap('start and mode is not 3', 20), ['start and', 'mode is not 3']);
  assert.deepEqual(wrap('is last word / flush load = 1', 20), ['is last word', '/ flush load = 1']);
  // conjunctions never stand alone; a long glued comparison breaks before its operator
  assert.ok(wrap('mode is not MODE RSVD and word count is not 0', 20).every((l) => l !== 'and' && l !== 'or'));
  assert.ok(wrap('command valid and command ready and not ((command logn = 9 or command logn = 10) and command op <= 2)', 20).every((l) => l !== 'not'));
  assert.ok(wrap('(seen with accept & required) = required', 20).every((l) => l.length <= 24));
});

test('semantic checks: every fsm code fires on its defect and a clean machine passes', async () => {
  assert.deepEqual(await validateSchema('fsm', sample()), []);
  assert.deepEqual(checkFsm(sample()).diagnostics, []);
  const variant = (mutate) => { const doc = sample(); mutate(doc); return checkFsm(doc, { quality: 'paper' }).diagnostics; };
  assert.equal(codes(variant((d) => { d.transitions = d.transitions.filter((t) => t.id !== 't2'); }), 'fsm/unreachable').length, 2, 'FLUSH and DONE');
  assert.equal(codes(variant((d) => { d.states[1].encoding = "3'b001"; }), 'fsm/encoding-width').length, 1);
  assert.equal(codes(variant((d) => { d.states[1].encoding = "2'b00"; }), 'fsm/encoding-duplicate').length, 1);
  assert.equal(codes(variant((d) => { d.transitions[0].guard = 'start_i &&'; }), 'fsm/guard-parse').length, 1);
  assert.equal(codes(variant((d) => { d.transitions[0].guard = 'start_i && bogus_q'; }), 'fsm/guard-unknown-identifier').length, 1);
  assert.equal(codes(variant((d) => { d.states[1].outputs = { flush_load: '1' }; }), 'fsm/output-kind').length, 1);
  assert.equal(codes(variant((d) => { d.transitions[2].actions = { busy_o: '1' }; }), 'fsm/output-kind').length, 1);
  assert.equal(codes(variant((d) => { d.transitions[0].to = 'S_NOWHERE'; }), 'fsm/unknown-state').length, 1);
  assert.equal(codes(variant((d) => { d.transitions.push({ ...d.transitions[3], id: 't3b' }); }), 'fsm/duplicate-transition').length, 1);
  const ambiguous = variant((d) => { d.transitions.push({ id: 't6', from: 'S_RUN', to: 'S_DONE', guard: 'is_last_word && start_i' }); });
  assert.equal(codes(ambiguous, 'fsm/ambiguous-guards').length, 1);
  assert.equal(codes(ambiguous, 'fsm/ambiguous-guards')[0].severity, 'warning');
  assert.equal(codes(variant((d) => { d.transitions.push({ id: 't6', from: 'S_RUN', to: 'S_DONE', guard: 'is_last_word && start_i', priority: 1 }); }), 'fsm/ambiguous-guards').length, 0, 'priority disambiguates');
  const unreadable = variant((d) => { d.states[2].label = 'flsh_st'; });
  assert.equal(codes(unreadable, 'label/unreadable').length, 1);
  const validated = await validateFigure('fsm', sample());
  assert.equal(validated.ok, true);
  assert.equal(validated.checks.semantic.status, 'pass');
});

// Polylines of drawn transitions (shaft plus arrow tip) and state rectangles, parsed from the SVG.
function geometry(svg) {
  const num = (s) => Number(s);
  const states = [...svg.matchAll(/<rect id="fsm-state-([A-Za-z0-9_]+)-body" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .map((m) => ({ id: m[1], x0: num(m[2]), y0: num(m[3]), x1: num(m[2]) + num(m[4]), y1: num(m[3]) + num(m[5]) }));
  const pts = (d) => [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({ x: num(m[1]), y: num(m[2]) }));
  const edges = [...svg.matchAll(/<path id="(fsm-(?:edge-[A-Za-z0-9_]+|reset|other))-seg0" d="([^"]+)"/g)].map((m) => ({ id: m[1], pts: pts(m[2]) }));
  const heads = [...svg.matchAll(/<path id="(fsm-(?:edge-[A-Za-z0-9_]+|reset|other))-arrow" d="([^"]+)"/g)].map((m) => ({ id: m[1], pts: pts(m[2]) }));
  return { states, edges, heads };
}
const onRect = (p, r, tol = 0.35) => {
  const inX = p.x >= r.x0 - tol && p.x <= r.x1 + tol;
  const inY = p.y >= r.y0 - tol && p.y <= r.y1 + tol;
  return inX && inY && Math.min(Math.abs(p.x - r.x0), Math.abs(p.x - r.x1), Math.abs(p.y - r.y0), Math.abs(p.y - r.y1)) <= tol;
};

test('renderer: the RTL default-recovery arc is one dashed arc from an "other codes" marker; guard names never break across lines', async () => {
  const doc = sample();
  doc.machine.show_default_recovery = true;
  doc.transitions.push({ id: 'r0', from: '*', to: 'S_IDLE', recovery: true });
  doc.transitions[0].guard = "start_i && mode_q != 2'b11 && is_last_word";
  const r = await renderFsm(doc, { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'rec' });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.match(r.svg, /<path id="fsm-edge-r0-seg0"[^>]*stroke-dasharray/);
  const texts = [...r.svg.matchAll(/<text id="([^"]+)"[^>]*>([^<]*)</g)].map((m) => ({ id: m[1], text: m[2] }));
  assert.ok(texts.some((x) => /^fsm-other-r0-caption/.test(x.id) && x.text === 'other codes'), texts.map((x) => x.id).join(' '));
  assert.equal(texts.filter((x) => x.text === 'any state').length, 1, 'only the soft-reset arc is an any-state arc');
  // a readable identifier stays on one line: no label line ends inside "is last word"
  const lines = texts.filter((x) => x.id.startsWith('fsm-label-t0')).map((x) => x.text);
  assert.ok(lines.some((l) => l.includes('is last word')), lines.join(' | '));
  assert.ok(texts.every((x) => !x.text.includes(' ')));
});

test('renderer: a long machine never loses a transition silently (drawn, or fsm/edge-unrouted / fsm/edge-detached)', async () => {
  // An 11-state chain with a skip arc, two returns and a recovery-like arc back
  // to the start: wide enough that the renderer tries wrapped rows at 2col.
  const ids = Array.from({ length: 11 }, (_, i) => `S_${String.fromCharCode(65 + i)}`);
  const doc = {
    schema_version: 1, figure_type: 'fsm',
    meta: { title: 'Long chain', print: { profile: 'ieee' } },
    machine: { name: 'chain.state_q', state_width: 4, encoding: 'binary', kind: 'moore', default: 'hold' },
    inputs: [{ name: 'step', width: 1 }, { name: 'skip', width: 1 }, { name: 'abort', width: 1 }],
    outputs: [],
    reset: { state: ids[0], condition: '!rst_n', async: true },
    states: ids.map((id, i) => ({ id, encoding: `4'd${i}` })),
    transitions: [
      ...ids.slice(0, -1).map((id, i) => ({ id: `c${i}`, from: id, to: ids[i + 1], guard: 'step' })),
      { id: 'skip1', from: ids[1], to: ids[8], guard: 'skip && !step' },
      { id: 'ret9', from: ids[9], to: ids[10], guard: 'abort && !step' },
      { id: 'back', from: ids[10], to: ids[0], guard: 'abort' },
    ],
  };
  assert.deepEqual(await validateSchema('fsm', doc), []);
  const r = await renderFsm(doc, { variant: '2col', widthPt: 515.5, maxHeightPt: 432, name: 'chain' });
  const drawn = new Set([...r.svg.matchAll(/<path id="fsm-edge-([A-Za-z0-9_]+)-seg0"/g)].map((m) => m[1]));
  const reported = new Set(r.diagnostics.filter((d) => d.code === 'fsm/edge-unrouted').map((d) => d.subject.id));
  for (const t of doc.transitions) assert.ok(drawn.has(t.id) || reported.has(t.id), `transition ${t.id} is drawn or reported unrouted`);
  // a drawn arc that does not reach its target is an error, never a silent pass
  const g = geometry(r.svg);
  for (const head of g.heads.filter((h) => h.id.startsWith('fsm-edge-'))) {
    const t = doc.transitions.find((x) => `fsm-edge-${x.id}` === head.id);
    const rect = g.states.find((s) => s.id === t.to);
    if (!onRect(head.pts[1], rect)) assert.ok(r.diagnostics.some((d) => d.code === 'fsm/edge-detached' && d.subject.id === t.id), `${t.id} off target without fsm/edge-detached`);
  }
});

test('renderer: states, reset, self-loop, any-state arc and Mealy action verified on the SVG', async () => {
  const doc = sample();
  const r = await renderFsm(doc, { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'sample' });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.deepEqual(lintFigmaSafe(r.svg), []);
  assert.ok(r.width_pt <= 515.5 + 0.01 && r.height_pt <= 230.4);
  const g = geometry(r.svg);
  assert.equal(g.states.length, 4);
  // one drawn arc per transition, one reset arc, one any-state arc (never one per state)
  assert.equal(g.edges.filter((e) => /^fsm-edge-/.test(e.id)).length, doc.transitions.length);
  assert.equal(g.edges.filter((e) => e.id === 'fsm-reset').length, 1);
  assert.equal((r.svg.match(/id="fsm-any-t5"/g) || []).length, 1);
  const targetOf = (id) => (id === 'fsm-reset' ? doc.reset.state : doc.transitions.find((t) => `fsm-edge-${t.id}` === id).to);
  for (const head of g.heads) {
    const tip = head.pts[1];
    const rect = g.states.find((s) => s.id === targetOf(head.id));
    assert.ok(onRect(tip, rect), `${head.id} tip (${tip.x}, ${tip.y}) on the outline of ${rect.id}`);
    // arrowheads uniform: length 5, width 3.6 (skin)
    const base = { x: (head.pts[0].x + head.pts[2].x) / 2, y: (head.pts[0].y + head.pts[2].y) / 2 };
    assert.ok(Math.abs(Math.hypot(tip.x - base.x, tip.y - base.y) - 5) < 0.06);
    assert.ok(Math.abs(Math.hypot(head.pts[0].x - head.pts[2].x, head.pts[0].y - head.pts[2].y) - 3.6) < 0.06);
    // the shaft ends at the head's base
    const shaft = g.edges.find((e) => e.id === head.id).pts.at(-1);
    assert.ok(Math.hypot(shaft.x - base.x, shaft.y - base.y) < 0.02, `${head.id} shaft meets its head`);
  }
  // self-loop starts and ends on the same state
  const loop = g.edges.find((e) => e.id === 'fsm-edge-t1');
  const run = g.states.find((s) => s.id === 'S_RUN');
  assert.ok(onRect(loop.pts[0], run));
  const texts = [...r.svg.matchAll(/<text id="([^"]+)"[^>]*>([^<]*)</g)].map((m) => ({ id: m[1], text: m[2] }));
  const all = texts.map((x) => x.text).join(' | ');
  for (const expected of ['Idle', 'Run', 'Flush', 'Done', 'busy = 1', 'reset', 'any state', 'except Idle', 'soft reset', 'not is last word', '/ flush load = 1']) assert.ok(all.includes(expected), `${expected} in ${all}`);
  // Moore output printed only when asserted; no raw ids or RTL syntax in any text
  assert.equal(texts.filter((x) => x.id.startsWith('fsm-state-S_IDLE-out')).length, 0);
  for (const x of texts) assert.doesNotMatch(x.text, /_|&&|\|\||'[bdh]|S_IDLE|!/, x.id);
});

test('delivery: paper (2col required) and study formats write SVG, PDF and a schema-valid receipt', async () => {
  const dir = tmp();
  try {
    const figure = path.join(dir, 'sample.fsm.json');
    fs.writeFileSync(figure, JSON.stringify(sample()));
    const paper = await deliver({ type: 'fsm', figurePath: figure, outDir: path.join(dir, 'paper') });
    assert.equal(paper.ok, true, paper.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('; '));
    const names = fs.readdirSync(path.join(dir, 'paper'));
    assert.ok(names.includes('sample.2col.svg') && names.includes('sample.2col.pdf') && names.includes('sample.receipt.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'paper', 'sample.receipt.json'), 'utf8'));
    assert.deepEqual(await validateSchema('receipt', receipt), []);
    assert.equal(receipt.figure.type, 'fsm');
    assert.equal(receipt.verification.level, 'unverified');
    assert.equal(receipt.verification.regions[0].kind, 'fsm');
    const study = await deliver({ type: 'fsm', figurePath: figure, outDir: path.join(dir, 'study'), format: 'study', pdf: false });
    assert.equal(study.ok, true, study.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('; '));
    const studyReceipt = JSON.parse(fs.readFileSync(path.join(dir, 'study', 'sample.receipt.json'), 'utf8'));
    assert.deepEqual(await validateSchema('receipt', studyReceipt), []);
    assert.equal(studyReceipt.format.name, 'study');
    assert.ok(fs.readdirSync(path.join(dir, 'study')).includes('sample.study.svg'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delivery with a netlist records the machine as structural-only through the FSM cross-check', async () => {
  const dir = tmp();
  try {
    const figure = path.join(dir, 'sample.fsm.json');
    fs.writeFileSync(figure, JSON.stringify(sample()));
    // A minimal schema-valid netlist of the controller (state register only),
    // recording a user RTL file outside the fig-gen tree as its evidence; the
    // FSM cross-check itself is exercised by its own tests.
    const rtl = path.join(dir, 'ctrl.sv');
    fs.writeFileSync(rtl, 'module ctrl(input logic clk, input logic rst_n, input logic start_i);\n  logic [1:0] state_q;\nendmodule\n');
    const netlist = {
      schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'ctrl', diagnostics: [],
      inputs: { files: [{ path: rtl, sha256: createHash('sha256').update(fs.readFileSync(rtl)).digest('hex'), role: 'rtl' }] },
      hierarchy: [{ path: 'ctrl', module: 'ctrl' }],
      modules: [{
        name: 'ctrl', orig_name: 'ctrl',
        ports: [{ name: 'clk', dir: 'in', width: 1 }, { name: 'rst_n', dir: 'in', width: 1 }, { name: 'start_i', dir: 'in', width: 1 }],
        nets: [{ name: 'clk', width: 1, kind: 'port' }, { name: 'rst_n', width: 1, kind: 'port' }, { name: 'start_i', width: 1, kind: 'port' }, { name: 'state_q', width: 2, kind: 'var' },
          { name: 'is_last_word', width: 1, kind: 'wire' }, { name: 'soft_reset', width: 1, kind: 'wire' }, { name: 'mode_q', width: 2, kind: 'var' }],
        registers: [{ name: 'state_q', width: 2, clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true }, clock_root: 'clk' }],
        instances: [],
        // The extracted state machine the sample figure draws (as check-rtl records it).
        fsms: [{
          register: 'state_q', next: null, width: 2, encoding_source: 'localparam',
          states: [{ name: 'S_IDLE', value: "2'h0" }, { name: 'S_RUN', value: "2'h1" }, { name: 'S_FLUSH', value: "2'h2" }, { name: 'S_DONE', value: "2'h3" }],
          reset: { state: 'S_IDLE', net: 'rst_n', active: 'low', async: true },
          transitions: [
            { id: 'o0', from: '*', to: 'S_IDLE', guard: rtlGuard('soft_reset').ast, priority: -1, sync_override: true },
            { id: 'c0', from: 'S_IDLE', to: 'S_RUN', guard: rtlGuard("start_i && mode_q != 2'b11").ast, priority: 0 },
            { id: 'c1', from: 'S_RUN', to: 'S_FLUSH', guard: rtlGuard('is_last_word').ast, priority: 0 },
            { id: 'c2', from: 'S_FLUSH', to: 'S_DONE', guard: null, priority: 0 },
            { id: 'c3', from: 'S_DONE', to: 'S_IDLE', guard: null, priority: 0 },
          ],
          overrides: ['o0'],
          default: { kind: 'hold' },
        }],
      }],
    };
    const netPath = path.join(dir, 'netlist.json');
    fs.writeFileSync(netPath, JSON.stringify(netlist));
    assert.deepEqual(await validateSchema('rtl-netlist', netlist), []);
    const r = await deliver({ type: 'fsm', figurePath: figure, outDir: path.join(dir, 'out'), netlistPath: netPath });
    assert.equal(r.ok, true, r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`).join('; '));
    assert.equal(r.receipt.verification.level, 'structural-only');
    assert.ok(r.receipt.verification.structural.fsm_figure_sha256);
    assert.deepEqual(await validateSchema('receipt', r.receipt), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
