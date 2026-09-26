// RTL front end: packed enum/struct widths with enum encodings and struct
// members kept in the netlist, dependencies through function bodies and port
// aliases (no false rtl/input-unused), and check-rtl dependency resolution
// from search paths with duplicate-definition reporting.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crosscheckDatapath } from '../lib/rtl/crosscheck.mjs';
import { expandSearchPath, formatFilelist, globToRegExp, insideAny, parseFilelist, resolveDependencies } from '../lib/rtl/deps.mjs';
import { backwardReach, flattenNetlist } from '../lib/rtl/flatten.mjs';
import { summaryLines } from '../lib/rtl/summary.mjs';
import verilator from '../lib/rtl/verilator.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = path.join(root, 'tests', 'fixtures', 'rtl-frontend');
const rel = (f) => path.relative(fx, f).split(path.sep).join('/');
const detected = await verilator.detect();
const skip = !detected.available && 'verilator not installed';

let cached = null;
async function fixtureNetlist() {
  if (!cached) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-fe-'));
    try {
      const r = resolveDependencies({ top: 'gen_fsm_top', searchPaths: [path.join(fx, '**')] });
      cached = await verilator.extract({ files: r.files, include_dirs: r.includeDirs, top: 'gen_fsm_top', work_dir: work });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  return cached;
}

// --- dependency resolution ---------------------------------------------------

test('search paths resolve the module, package and include closure of the top, packages first', () => {
  const r = resolveDependencies({ top: 'gen_fsm_top', searchPaths: [path.join(fx, '**')] });
  assert.deepEqual(r.files.map(rel), ['pkg/gen_pkg.sv', 'src/gen_fsm_top.sv', 'src/gen_worker.sv']);
  assert.ok(r.includeDirs.map(rel).includes('include'), 'the include directory of `include "gen_defs.svh" is added');
  assert.deepEqual(r.resolution.unresolved, []);
  assert.equal(r.resolution.duplicates.length, 1);
  const dup = r.resolution.duplicates[0];
  assert.equal(dup.name, 'gen_worker');
  assert.deepEqual(dup.candidates.map(rel), ['alt/gen_worker_stub.sv', 'src/gen_worker.sv']);
  assert.equal(rel(dup.chosen), 'src/gen_worker.sv');
  assert.match(dup.reason, /not a stub/);
  const d = r.diagnostics.find((x) => x.code === 'rtl/duplicate-definition');
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /gen_worker_stub\.sv/);
  assert.match(d.message, /src\/gen_worker\.sv/);
});

test('the duplicate choice is deterministic and follows --prefer and --exclude', () => {
  const args = { top: 'gen_fsm_top', searchPaths: [path.join(fx, '**')] };
  assert.deepEqual(resolveDependencies(args).files, resolveDependencies(args).files);
  const preferred = resolveDependencies({ ...args, prefer: [path.join(fx, 'alt', 'gen_worker_stub.sv')] });
  assert.ok(preferred.files.map(rel).includes('alt/gen_worker_stub.sv'));
  assert.equal(preferred.resolution.duplicates[0].reason, 'named by --prefer');
  const excluded = resolveDependencies({ ...args, excludes: [path.join(fx, 'alt', '**')] });
  assert.deepEqual(excluded.resolution.duplicates, []);
  assert.deepEqual(excluded.diagnostics, []);
  assert.deepEqual(excluded.files.map(rel), ['pkg/gen_pkg.sv', 'src/gen_fsm_top.sv', 'src/gen_worker.sv']);
});

test('a missing top is an error; file lists round-trip; globs; output inside the RTL tree is detected', () => {
  const missing = resolveDependencies({ top: 'no_such_top', searchPaths: [path.join(fx, '**')] });
  assert.deepEqual(missing.files, []);
  assert.equal(missing.diagnostics[0].code, 'rtl/top-not-found');

  const r = resolveDependencies({ top: 'gen_fsm_top', searchPaths: [path.join(fx, '**')] });
  const back = parseFilelist(formatFilelist(r), '/');
  assert.deepEqual(back.files, r.files);
  assert.deepEqual(back.includeDirs, r.includeDirs);

  const re = globToRegExp('/a/**/*.sv');
  assert.ok(re.test('/a/x.sv') && re.test('/a/b/c/x.sv'));
  assert.ok(!re.test('/a/x.v'));
  assert.deepEqual(expandSearchPath(fx).files, [], 'a directory is not searched recursively');
  assert.deepEqual(expandSearchPath(path.join(fx, 'src')).files.map(rel), ['src/gen_fsm_top.sv', 'src/gen_worker.sv']);
  assert.ok(insideAny(path.join(fx, 'src', 'netlist.json'), [path.join(fx, 'src')]));
  assert.equal(insideAny(path.join(os.tmpdir(), 'netlist.json'), [fx]), null);
});

// --- packed types --------------------------------------------------------------

test('enum and packed struct widths resolve; enum encodings and struct members are kept in the netlist', { skip }, async () => {
  const netlist = await fixtureNetlist();
  assert.deepEqual(await validateSchema('rtl-netlist', netlist), []);
  assert.deepEqual(netlist.diagnostics.filter((d) => d.code === 'rtl/width-unresolved'), []);
  const top = netlist.modules.find((m) => m.orig_name === 'gen_fsm_top');
  const reg = (n) => top.registers.find((r) => r.name === n);
  const items = [
    { name: 'StIdle', value: 0, literal: "3'h0" },
    { name: 'StLoad', value: 3, literal: "3'h3" },
    { name: 'StRun', value: 4, literal: "3'h4" },
    { name: 'StDone', value: 7, literal: "3'h7" },
  ];
  assert.equal(reg('c_state').width, 3);
  assert.deepEqual(reg('c_state').enum, { type: 'gen_pkg::state_e', width: 3, items });
  assert.deepEqual(top.nets.find((n) => n.name === 'n_state').enum.items, items);
  assert.equal(top.ports.find((p) => p.name === 'state_o').type, 'gen_pkg::state_e');

  const members = [
    { name: 'busy', width: 1, msb: 7, lsb: 7 },
    { name: 'count', width: 4, msb: 6, lsb: 3 },
    { name: 'tag', width: 3, msb: 2, lsb: 0 },
  ];
  assert.equal(reg('c_st').width, 8);
  assert.deepEqual(reg('c_st').struct, { type: 'gen_pkg::status_t', kind: 'struct', width: 8, members });
  assert.equal(top.ports.find((p) => p.name === 'st_o').width, 8);
  assert.equal(reg('c_pair').width, 16, 'a packed array of the struct');
  assert.deepEqual(reg('c_pair').packed_array, { dims: ['1:0'], element_width: 8, element_type: 'gen_pkg::status_t' });
  assert.deepEqual(netlist.types.map((t) => [t.name, t.kind, t.width]), [['gen_pkg::state_e', 'enum', 3], ['gen_pkg::status_t', 'struct', 8]]);

  const lines = summaryLines(netlist);
  assert.ok(lines.some((l) => /^module gen_fsm_top \S+ ports=11 instances=1 registers=4 width-unresolved=0$/.test(l)), lines.join('\n'));
  assert.equal(lines.filter((l) => l.startsWith('module ')).length, netlist.modules.length);
});

test('resolved if-generate BEGIN scopes keep branch-local registers and assignments', { skip }, async () => {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-generate-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-generate-work-'));
  try {
    const src = path.join(user, 'generated_history.sv');
    fs.writeFileSync(src, `module generated_history #(parameter bit HISTORY = 1'b1) (
  input logic clk, input logic d_i, output logic q_o
);
  generate
    if (HISTORY) begin : g_history
      logic history_r;
      always_ff @(posedge clk) history_r <= d_i;
      assign q_o = history_r;
    end else begin : g_direct
      assign q_o = d_i;
    end
  endgenerate
endmodule\n`);
    const netlist = await verilator.extract({ files: [src], top: 'generated_history', work_dir: work, params: { HISTORY: 1 } });
    const top = netlist.modules.find((m) => m.orig_name === 'generated_history');
    // Named with its generate scope, the same name the net list gives it.
    assert.ok(top.registers.some((r) => r.name === 'g_history.history_r'), 'register inside the resolved generate branch is retained');
    assert.ok(top.nets.some((n) => n.name === 'g_history.history_r'));
    const q = top.deps.find((d) => d.target === 'q_o');
    assert.ok(q?.sources.includes('g_history.history_r'), 'assignment inside the resolved generate branch is retained');
  } finally {
    fs.rmSync(user, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// --- dependencies ----------------------------------------------------------------

test('dependencies see through function bodies, aliases and submodule ports; a truly unused input is still reported', { skip }, async () => {
  const netlist = await fixtureNetlist();
  const top = netlist.modules.find((m) => m.orig_name === 'gen_fsm_top');
  assert.deepEqual(top.deps.find((d) => d.target === 'request_op').sources, ['a_i', 'b_i', 'c_inv', 'sel_i'], 'operand_for() reads sel_i, a_i and b_i in its body');

  const flat = flattenNetlist(netlist);
  const comb = backwardReach(flat, 'gen_fsm_top.request_op', { maxSeq: 0 });
  for (const s of ['a_i', 'b_i', 'sel_i', 'inverse_i']) assert.ok(comb.has(`gen_fsm_top.${s}`), s);
  const staged = backwardReach(flat, 'gen_fsm_top.c_part', { maxSeq: 1 });
  assert.ok(staged.has('gen_fsm_top.inverse_i'), 'through the worker instance ports');
  assert.ok(!staged.has('gen_fsm_top.spare_i'));

  const inPort = (id, width) => ({ id, kind: 'port', dir: 'in', width });
  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 'front end' }, clock_domains: [],
    elements: [
      inPort('p_inv', 1), inPort('p_sel', 1), inPort('p_a', 8), inPort('p_b', 8), inPort('p_spare', 1),
      { id: 'pick', kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name: 'Operand select' }, ports: [{ id: 'inv', dir: 'in', width: 1 }, { id: 's', dir: 'in', width: 1 }, { id: 'a', dir: 'in', width: 8 }, { id: 'b', dir: 'in', width: 8 }, { id: 'spare', dir: 'in', width: 1 }, { id: 'op', dir: 'out', width: 8 }] },
      { id: 'bank', kind: 'comb', op: 'custom', width: 8, function: { kind: 'custom', name: 'Partial result' }, ports: [{ id: 'resp', dir: 'in', width: 8 }, { id: 'part', dir: 'out', width: 8, registered: true }] },
      { id: 'p_op', kind: 'port', dir: 'out', width: 8 },
      { id: 'p_y', kind: 'port', dir: 'out', width: 8 },
      inPort('p_resp', 8),
    ],
    nets: [
      { id: 'n_inv', width: 1, driver: 'p_inv', sinks: ['pick.inv'], rtl: { signal: 'inverse_i' } },
      { id: 'n_sel', width: 1, driver: 'p_sel', sinks: ['pick.s'], rtl: { signal: 'sel_i' } },
      { id: 'n_a', width: 8, driver: 'p_a', sinks: ['pick.a'], rtl: { signal: 'a_i' } },
      { id: 'n_b', width: 8, driver: 'p_b', sinks: ['pick.b'], rtl: { signal: 'b_i' } },
      { id: 'n_spare', width: 1, driver: 'p_spare', sinks: ['pick.spare'], rtl: { signal: 'spare_i' } },
      { id: 'n_op', width: 8, driver: 'pick.op', sinks: ['p_op'], rtl: { signal: 'request_op' } },
      { id: 'n_resp', width: 8, driver: 'p_resp', sinks: ['bank.resp'], rtl: { signal: 'response' } },
      { id: 'n_part', width: 8, driver: 'bank.part', sinks: ['p_y'], rtl: { signal: 'c_part' } },
    ],
  };
  const r = crosscheckDatapath(doc, netlist);
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'rtl/no-structural-path'), []);
  const unused = r.diagnostics.filter((d) => d.code === 'rtl/input-unused').map((d) => d.message);
  assert.equal(unused.length, 1, unused.join('\n'));
  assert.match(unused[0], /spare_i/);
});
