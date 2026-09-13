// FSM extraction from the Verilator front-end (modules[].fsms), the FSM RTL
// cross-check and `draft --type fsm`, on three self-written fixtures: an
// enum-typed controller with a default recovery branch, a localparam machine
// with a combinational case (conditional assignment, multi-label item, an
// unreachable state) and a machine written directly in the clocked block.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import verilator from '../lib/rtl/verilator.mjs';
import { crosscheckFsm, equivalentGuards, parseGuard, printGuard } from '../lib/checks/fsm-crosscheck.mjs';
import { draftFsm, stateLabels } from '../lib/draft-fsm.mjs';
import { validateSchema } from '../lib/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'rtl', 'fsm');
const detected = await verilator.detect();
const skip = !detected.available && 'verilator not installed';

const cache = new Map();
async function extract(file, top) {
  if (cache.has(top)) return cache.get(top);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-fsm-'));
  try {
    const netlist = await verilator.extract({ files: [path.join(fixtures, file)], top, work_dir: workDir, source_root: fixtures });
    cache.set(top, netlist);
    return netlist;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
const fsmOf = (netlist, top) => netlist.modules.find((m) => m.orig_name === top).fsms[0];
const byEdge = (fsm) => Object.fromEntries(fsm.transitions.map((t) => [`${t.from}>${t.to}`, printGuard(t.guard) ?? null]));
const codes = (r) => r.diagnostics.map((d) => d.code);

test('guards: parse, print and compare by truth table (no simulator)', () => {
  const g = (s) => { const p = parseGuard(s); assert.equal(p.error, null, s); return p.ast; };
  assert.ok(equivalentGuards(g('!a && b'), g('!(a || !b)')).equivalent);
  assert.ok(!equivalentGuards(g('a && b'), g('a || b')).equivalent);
  // 1-bit & and | are the logical operators; a comparison may put its constant on either side.
  assert.ok(equivalentGuards(g('a & b & (mode != 2\'b11)'), g('(mode != 2\'b11) && b && a')).equivalent);
  assert.ok(equivalentGuards(g('cnt <= 2\'d1'), { op: 'gte', args: [{ op: 'const', value: "2'h1" }, { op: 'ref', name: 'cnt', width: 2 }] }, { width: (n) => (n === 'cnt' ? 2 : 1), param: () => null }).equivalent);
  assert.ok(equivalentGuards(g('cnt > 2\'d1'), g('!(cnt <= 2\'d1)'), { width: () => 2, param: () => null }).equivalent);
  // A named constant equals its value.
  assert.ok(equivalentGuards(g('mode != MODE_OFF'), { op: 'neq', args: [{ op: 'const', value: "2'h3", param: 'MODE_OFF' }, { op: 'ref', name: 'mode', width: 2 }] }, { width: (n) => (n === 'mode' ? 2 : 1), param: (n) => (n === 'MODE_OFF' ? 3n : null) }).equivalent);
  const cmp = equivalentGuards(g('a'), g('b'));
  assert.equal(cmp.equivalent, false);
  assert.ok(cmp.counterexample);
  assert.equal(printGuard({ op: 'and', width: 1, args: [{ op: 'ref', name: 'go', width: 1 }, { op: 'neq', width: 1, args: [{ op: 'const', value: "2'h3", param: 'MODE_OFF' }, { op: 'ref', name: 'mode', width: 2 }] }] }), 'go && mode != MODE_OFF');
  assert.ok(parseGuard('a && (b').error);
  assert.deepEqual(stateLabels(['OwnerIdle', 'OwnerMetaCounter0']), ['Idle', 'Meta counter 0']);
  assert.deepEqual(stateLabels(['S_IDLE', 'S_RUN']), ['Idle', 'Run']);
});

test('extraction: enum-typed controller with if/else guards and a default recovery branch', { skip }, async () => {
  const netlist = await extract('fsm_enum.sv', 'fsm_enum');
  assert.deepEqual(await validateSchema('rtl-netlist', netlist), []);
  const fsm = fsmOf(netlist, 'fsm_enum');
  assert.equal(fsm.register, 'c_state');
  assert.equal(fsm.next, 'n_state');
  assert.equal(fsm.encoding_source, 'enum');
  assert.match(fsm.enum_type, /st_e$/);
  assert.deepEqual(fsm.states, [{ name: 'StIdle', value: "2'h0" }, { name: 'StWork', value: "2'h1" }, { name: 'StFlush', value: "2'h2" }]);
  assert.deepEqual(fsm.reset, { state: 'StIdle', net: 'rst_n', active: 'low', async: true });
  assert.deepEqual(fsm.default, { kind: 'to', state: 'StFlush' });
  assert.deepEqual(byEdge(fsm), { 'StIdle>StWork': 'start_i', 'StWork>StIdle': 'abort_i', 'StWork>StFlush': '!abort_i && done_i', 'StFlush>StIdle': null });
  assert.deepEqual(fsm.transitions.filter((t) => t.from === 'StWork').map((t) => t.priority), [0, 1]);
});

test('extraction: localparam machine with a combinational case, a conditional assignment and a multi-label item', { skip }, async () => {
  const fsm = fsmOf(await extract('fsm_lparam.v', 'fsm_lparam'), 'fsm_lparam');
  assert.equal(fsm.next, 'state_d');
  assert.equal(fsm.encoding_source, 'localparam');
  assert.deepEqual(fsm.states.map((s) => s.name), ['S_IDLE', 'S_RUN', 'S_DRAIN', 'S_DONE']);
  assert.deepEqual(fsm.default, { kind: 'to', state: 'S_IDLE' });
  // S_RUN stays in S_RUN on !last: a hold, not an edge; S_DRAIN and S_DONE share one item.
  assert.deepEqual(byEdge(fsm), { 'S_IDLE>S_RUN': 'go && mode != MODE_OFF', 'S_RUN>S_DRAIN': 'last', 'S_DRAIN>S_IDLE': '!go', 'S_DONE>S_IDLE': '!go' });
});

test('extraction: a machine written in the clocked block, with a synchronous reset', { skip }, async () => {
  const fsm = fsmOf(await extract('fsm_seq.sv', 'fsm_seq'), 'fsm_seq');
  assert.equal(fsm.next, null);
  assert.deepEqual(fsm.reset, { state: 'WAIT', net: 'rst', active: 'high', async: false });
  assert.deepEqual(byEdge(fsm), { 'WAIT>GRANT': 'req', 'GRANT>HOLD': 'ack', 'HOLD>WAIT': '!req' });
  assert.equal(fsm.overrides, undefined);
});

test('draft --type fsm round-trips through the RTL cross-check', { skip }, async () => {
  for (const [file, top] of [['fsm_enum.sv', 'fsm_enum'], ['fsm_lparam.v', 'fsm_lparam'], ['fsm_seq.sv', 'fsm_seq']]) {
    const netlist = await extract(file, top);
    const { doc, notes } = draftFsm(netlist, { scope: top });
    assert.deepEqual(await validateSchema('fsm', doc), [], top);
    const r = crosscheckFsm(doc, netlist);
    assert.deepEqual(codes(r), [], `${top}: ${r.diagnostics.map((d) => d.message).join('; ')}`);
    assert.ok(notes.length);
    if (top === 'fsm_enum') {
      assert.deepEqual(doc.states.map((s) => s.label), ['Idle', 'Work', 'Flush']);
      assert.deepEqual(doc.outputs.map((o) => o.name).sort(), ['busy_o', 'idle_o']);
      assert.equal(doc.states.find((s) => s.id === 'StWork').outputs.busy_o, '1');
      assert.equal(doc.machine.show_default_recovery, true);
      assert.ok(doc.transitions.some((t) => t.recovery && t.to === 'StFlush'));
    }
    if (top === 'fsm_lparam') {
      // S_DONE is never entered: left out with the reason, its edge omitted with it.
      assert.deepEqual(doc.machine.scope.omit_states, ['S_DONE']);
      assert.deepEqual(r.stats.unreachable, ['S_DONE']);
      assert.equal(doc.params.MODE_OFF, 3);
    }
  }
});

test('cross-check reports each mismatch between the figure and the RTL', { skip }, async () => {
  const netlist = await extract('fsm_lparam.v', 'fsm_lparam');
  const { doc } = draftFsm(netlist, { scope: 'fsm_lparam' });
  const mutate = (f) => { const d = structuredClone(doc); f(d); return codes(crosscheckFsm(d, netlist)); };
  assert.ok(mutate((d) => { d.states[1].id = 'S_WORK'; }).includes('fsm/rtl-state-missing'));
  assert.ok(mutate((d) => { d.states[1].id = 'S_WORK'; }).includes('fsm/undrawn-state'));
  assert.deepEqual(mutate((d) => { d.states[2].encoding = "2'b11"; }), ['fsm/rtl-encoding-mismatch']);
  assert.deepEqual(mutate((d) => { d.transitions.push({ id: 'tx', from: 'S_DRAIN', to: 'S_RUN', guard: 'go' }); }), ['fsm/rtl-transition-missing']);
  assert.deepEqual(mutate((d) => { d.transitions.find((t) => t.from === 'S_IDLE').guard = 'go'; }), ['fsm/rtl-guard-mismatch']);
  assert.deepEqual(mutate((d) => { d.transitions = d.transitions.filter((t) => t.from !== 'S_RUN'); }), ['fsm/undrawn-transition']);
  assert.deepEqual(mutate((d) => { d.reset.state = 'S_RUN'; }), ['fsm/rtl-reset-mismatch']);
  // Drawing the unreachable state.
  assert.ok(mutate((d) => { delete d.machine.scope; d.states.push({ id: 'S_DONE', label: 'Done', encoding: "2'b11" }); d.transitions.push({ id: 'td', from: 'S_DONE', to: 'S_IDLE', guard: '!go' }); }).includes('fsm/unreachable'));
  // An if/else written with priorities: the lower-priority guard is implicitly guarded by the negation of the earlier one.
  const enumNet = await extract('fsm_enum.sv', 'fsm_enum');
  const e = draftFsm(enumNet, { scope: 'fsm_enum' }).doc;
  const t1 = e.transitions.find((t) => t.from === 'StWork' && t.to === 'StIdle');
  const t2 = e.transitions.find((t) => t.from === 'StWork' && t.to === 'StFlush');
  Object.assign(t1, { priority: 0, guard: 'abort_i' });
  Object.assign(t2, { priority: 1, guard: 'done_i' });
  for (const t of e.transitions.filter((x) => x !== t1 && x !== t2 && x.from !== '*')) t.priority = 0;
  assert.deepEqual(codes(crosscheckFsm(e, enumNet)), []);
  delete t1.priority;
  delete t2.priority;
  assert.deepEqual(codes(crosscheckFsm(e, enumNet)), ['fsm/rtl-guard-mismatch']);
});
