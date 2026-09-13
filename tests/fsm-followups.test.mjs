// Checkpoint 3a follow-ups: guard wording (module-local prefixes dropped when
// unambiguous, enum items named from declared types), the verification level
// of an FSM receipt limited to the fan-in cone of its next-state logic, and
// Moore output values checked against the RTL.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crosscheckFsm, fsmCone, parseGuard } from '../lib/checks/fsm-crosscheck.mjs';
import { checkFsm } from '../lib/checks/fsm.mjs';
import { deliver } from '../lib/deliver.mjs';
import { draftFsm, enumItemLabel, strippedGuardLabel } from '../lib/draft-fsm.mjs';
import { transitionTexts } from '../lib/render/fsm.mjs';
import { validateSchema } from '../lib/validate.mjs';

const g = (text) => parseGuard(text).ast;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-fsm-follow-'));

// A 3-state controller: Idle -> Busy on sk_start && mode == Fast (an enum-typed
// signal), Busy -> Done on dec_done_q, Done -> Idle. busy_o = state == Busy.
function netlist({ modeEnum = true, stubInCone = false } = {}) {
  const modeType = { type: 'pkg::mode_e', width: 2, items: [{ name: 'ModeSlow', value: 0, literal: "2'h0" }, { name: 'ModeFast', value: 1, literal: "2'h1" }] };
  const states = [{ name: 'CtlIdle', value: "2'h0" }, { name: 'CtlBusy', value: "2'h1" }, { name: 'CtlDone', value: "2'h2" }];
  return {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'ctl', diagnostics: [],
    inputs: { files: [] },
    hierarchy: [{ path: 'ctl', module: 'ctl' }, { path: 'ctl.u_mem', module: 'mem' }, { path: 'ctl.u_mem.u_sram', module: 'sram', blackbox: true }],
    types: [{ name: 'pkg::mode_e', kind: 'enum', width: 2, items: modeType.items }],
    modules: [
      {
        name: 'ctl', orig_name: 'ctl',
        ports: [{ name: 'clk', dir: 'in', width: 1 }, { name: 'rst_n', dir: 'in', width: 1 }, { name: 'sk_start', dir: 'in', width: 1 }, { name: 'sk_abort', dir: 'in', width: 1 }, { name: 'busy_o', dir: 'out', width: 1 }, { name: 'result_o', dir: 'out', width: 8 }],
        nets: [
          { name: 'state_q', width: 2, kind: 'var' }, { name: 'state_d', width: 2, kind: 'var' },
          { name: 'mode_q', width: 2, kind: 'var', ...(modeEnum ? { type: modeType.type, enum: modeType } : {}) },
          { name: 'dec_done_q', width: 1, kind: 'var' }, { name: 'dec_count_q', width: 4, kind: 'var' }, { name: 'rdata', width: 8, kind: 'wire' },
        ],
        registers: [{ name: 'state_q', width: 2, clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true } }, { name: 'dec_done_q', width: 1, clock: { net: 'clk', edge: 'pos' } }],
        instances: [{ name: 'u_mem', module: 'mem', orig_module: 'mem', connections: [{ port: 'rdata', dir: 'out', width: 8, expr: { kind: 'net', net: 'rdata', width: 8 } }] }],
        deps: [
          { target: 'state_q', sources: ['state_d', 'rst_n'], kind: 'seq' },
          { target: 'state_d', sources: ['state_q', 'sk_start', 'mode_q', stubInCone ? 'rdata' : 'dec_done_q'], kind: 'comb' },
          { target: 'result_o', sources: ['rdata'], kind: 'comb' },
        ],
        exprs: [
          { target: 'busy_o', width: 1, expr: { op: 'eq', width: 1, args: [{ op: 'const', value: "2'h1", width: 2 }, { op: 'ref', name: 'state_q', width: 2 }] } },
        ],
        fsms: [{
          register: 'state_q', next: 'state_d', width: 2, encoding_source: 'enum', states,
          reset: { state: 'CtlIdle', net: 'rst_n', active: 'low', async: true },
          transitions: [
            { id: 't0', from: 'CtlIdle', to: 'CtlBusy', guard: { op: 'land', width: 1, args: [{ op: 'ref', name: 'sk_start', width: 1 }, { op: 'eq', width: 1, args: [{ op: 'const', value: "2'h1", width: 2 }, { op: 'ref', name: 'mode_q', width: 2 }] }] }, priority: 0 },
            { id: 't1', from: 'CtlBusy', to: 'CtlDone', guard: { op: 'ref', name: stubInCone ? 'rdata' : 'dec_done_q', width: 1 }, priority: 0 },
            { id: 't2', from: 'CtlDone', to: 'CtlIdle', guard: null, priority: 0 },
          ],
          default: { kind: 'hold' },
        }],
      },
      { name: 'mem', orig_name: 'mem', ports: [{ name: 'rdata', dir: 'out', width: 8 }], nets: [], registers: [], instances: [{ name: 'u_sram', module: 'sram', orig_module: 'sram', connections: [] }] },
      { name: 'sram', orig_name: 'sram', blackbox: { origin: 'auto', confidence: 'inferred' }, ports: [], nets: [], registers: [], instances: [] },
    ],
  };
}

test('F2: a module-local prefix is dropped from a guard name only when it is a prefix and the result is unambiguous', () => {
  const names = ['sk_start', 'sk_abort', 'dec_done_q', 'dec_count_q', 'is_last', 'is_first', 'cmd_valid', 'cmd_ready', 'solo_x'];
  assert.deepEqual(strippedGuardLabel('sk_start', names), { token: 'sk', label: 'start' });
  assert.deepEqual(strippedGuardLabel('dec_done_q', names), { token: 'dec', label: 'done' });
  assert.equal(strippedGuardLabel('is_last', names), null, 'an English word is not a prefix');
  assert.equal(strippedGuardLabel('cmd_valid', names), null, 'a dictionary abbreviation carries meaning');
  assert.equal(strippedGuardLabel('xy_z', ['xy_z']), null, 'a prefix needs two signals');
  const { doc, notes } = draftFsm(netlist(), { scope: 'ctl', state: 'state_q' });
  assert.equal(doc.inputs.find((i) => i.name === 'sk_start').label, 'start');
  assert.ok(notes.some((n) => /prefix sk_ dropped/.test(n)));
  // the renderer prints the declared label
  const texts = [...transitionTexts(doc).transitions.values()].map((x) => x.replace(/ /g, ' '));
  assert.ok(texts.some((x) => /^start and mode = /.test(x)), texts.join(' | '));
});

test('F2: a stripped name that collides with another printed name keeps its prefix', () => {
  const nl = netlist();
  // a state named Done makes "done" ambiguous
  const { doc, notes } = draftFsm(nl, { scope: 'ctl', state: 'state_q' });
  const done = doc.inputs.find((i) => i.name === 'dec_done_q');
  // "Done" (state label) collides with "done" only by case-insensitive compare: kept
  assert.equal(done.label, 'dec done');
  assert.ok(notes.some((n) => /dec_done_q keeps its prefix/.test(n)));
});

test('F2: a literal compared with an enum-typed signal is written as the enum item; without type evidence the literal stays', async () => {
  const { doc } = draftFsm(netlist(), { scope: 'ctl', state: 'state_q' });
  assert.deepEqual(doc.constants, [{ name: 'ModeFast', value: 1, type: 'pkg::mode_e', label: 'Fast mode' }]);
  assert.match(doc.transitions.find((t) => t.from === 'CtlIdle').guard, /mode_q == ModeFast/);
  assert.deepEqual(await validateSchema('fsm', doc), []);
  assert.deepEqual(checkFsm(doc).diagnostics.filter((d) => d.severity === 'error'), []);
  assert.deepEqual(crosscheckFsm(doc, netlist()).diagnostics, []);
  const texts = [...transitionTexts(doc).transitions.values()].map((x) => x.replace(/ /g, ' '));
  assert.ok(texts.some((x) => x.includes('mode = Fast mode')), texts.join(' | '));
  const plain = draftFsm(netlist({ modeEnum: false }), { scope: 'ctl', state: 'state_q' }).doc;
  assert.equal(plain.constants, undefined);
  assert.match(plain.transitions.find((t) => t.from === 'CtlIdle').guard, /mode_q == 2'h1/);
  assert.equal(enumItemLabel({ items: [{ name: 'ShakeClientKeygenPrng', value: 0 }, { name: 'ShakeClientH2p', value: 1 }, { name: 'ShakeClientSignNonce', value: 2 }] }, { name: 'ShakeClientH2p', value: 1 }), 'H2P client');
});

test('F5: Moore output values are checked against the RTL; a value that depends on other signals is not Moore; an asserted value left out is reported', () => {
  const nl = netlist();
  const { doc } = draftFsm(nl, { scope: 'ctl', state: 'state_q' });
  assert.deepEqual(doc.outputs.map((o) => o.name), ['busy_o']);
  const clean = crosscheckFsm(doc, nl, { quality: 'paper' });
  assert.deepEqual(clean.diagnostics, []);
  assert.equal(clean.stats.outputs_checked, 3);
  const wrong = structuredClone(doc);
  wrong.states.find((s) => s.id === 'CtlBusy').outputs.busy_o = '0';
  assert.equal(crosscheckFsm(wrong, nl).diagnostics.filter((d) => d.code === 'fsm/rtl-output-mismatch').length, 1);
  const omitted = structuredClone(doc);
  delete omitted.states.find((s) => s.id === 'CtlBusy').outputs.busy_o;
  const undrawn = crosscheckFsm(omitted, nl).diagnostics.filter((d) => d.code === 'fsm/undrawn-output');
  assert.equal(undrawn.length, 1);
  assert.equal(undrawn[0].severity, 'warning');
  assert.equal(crosscheckFsm(omitted, nl, { quality: 'paper' }).diagnostics.find((d) => d.code === 'fsm/undrawn-output').severity, 'error');
  const notMoore = structuredClone(nl);
  notMoore.modules[0].exprs[0].expr = { op: 'land', width: 1, args: [{ op: 'ref', name: 'sk_start', width: 1 }, notMoore.modules[0].exprs[0].expr] };
  assert.equal(crosscheckFsm(doc, notMoore).diagnostics.filter((d) => d.code === 'fsm/rtl-output-not-moore').length, 1, 'only the Busy state still depends on sk_start');
});

test('F3: the cone of a machine\'s next-state logic decides whether a stub counts', () => {
  assert.deepEqual([...fsmCone(netlist(), { module: 'ctl', state_register: 'state_q' }).stubs], []);
  const inCone = fsmCone(netlist({ stubInCone: true }), { module: 'ctl', state_register: 'state_q' });
  assert.deepEqual(inCone.instances, ['u_mem']);
  assert.deepEqual([...inCone.stubs], ['sram']);
});

test('F3: an FSM receipt is structural-only with an out-of-cone stub (listed in not_in_cone) and not with an in-cone stub', async () => {
  for (const stubInCone of [false, true]) {
    const dir = tmp();
    try {
      const rtl = path.join(dir, 'ctl.sv');
      fs.writeFileSync(rtl, 'module ctl(input logic clk);\nendmodule\n');
      const nl = netlist({ stubInCone });
      nl.inputs.files = [{ path: rtl, sha256: createHash('sha256').update(fs.readFileSync(rtl)).digest('hex'), role: 'rtl' }];
      assert.deepEqual(await validateSchema('rtl-netlist', nl), []);
      const netPath = path.join(dir, 'netlist.json');
      fs.writeFileSync(netPath, JSON.stringify(nl));
      const { doc } = draftFsm(nl, { scope: 'ctl', state: 'state_q' });
      const figure = path.join(dir, 'ctl.fsm.json');
      fs.writeFileSync(figure, JSON.stringify(doc));
      const r = await deliver({ type: 'fsm', figurePath: figure, outDir: path.join(dir, 'out'), netlistPath: netPath, format: 'study', pdf: false });
      assert.equal(r.ok, true, r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`).join('; '));
      assert.deepEqual(await validateSchema('receipt', r.receipt), []);
      if (stubInCone) {
        assert.notEqual(r.receipt.verification.level, 'structural-only');
        assert.ok(r.receipt.verification.regions.some((x) => x.id === 'stub:sram'));
      } else {
        assert.equal(r.receipt.verification.level, 'structural-only');
        assert.deepEqual(r.receipt.verification.not_in_cone.map((x) => x.id), ['stub:sram']);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
