import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import verilator from '../lib/rtl/verilator.mjs';
import { validateSchema } from '../lib/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'rtl', 'tiny');
const detected = await verilator.detect();

test('verilator adapter extracts the tiny fixture with an auto blackbox', { skip: !detected.available && 'verilator not installed' }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-test-'));
  const before = fs.readdirSync(fixture).sort();
  try {
    const netlist = await verilator.extract({ files: [path.join(fixture, 'tiny_top.sv')], top: 'tiny_top', work_dir: workDir, source_root: fixture });
    assert.deepEqual(await validateSchema('rtl-netlist', netlist), []);
    assert.deepEqual(fs.readdirSync(fixture).sort(), before, 'fixture directory must stay untouched');

    const byOrig = (n) => netlist.modules.find((m) => m.orig_name === n);
    const mem = byOrig('ext_mem');
    assert.deepEqual(mem.blackbox, { origin: 'auto', confidence: 'inferred' });
    const port = (n) => mem.ports.find((p) => p.name === n);
    assert.deepEqual([port('CK').dir, port('CK').width], ['in', 1]);
    assert.deepEqual([port('ADR').dir, port('ADR').width], ['in', 4]);
    assert.deepEqual([port('DI').dir, port('DI').width], ['in', 8]);
    assert.deepEqual([port('DO').dir, port('DO').width], ['out', 8]);
    assert.deepEqual([port('WE').dir, port('WE').width], ['in', 1]);

    const top = byOrig('tiny_top');
    const reg = (n) => top.registers.find((r) => r.name === n);
    assert.deepEqual(reg('s0_q').clock, { net: 'clk_a', edge: 'pos' });
    // `if (!rst_n) q <= 0; else q <= d;` is folded by the front-end into a
    // conditional assignment, so the reset is found structurally via COND.
    assert.deepEqual(reg('s0_q').reset, { net: 'rst_n', active: 'low', async: true, inferred_by: 'condition' });
    assert.equal(reg('s1_q').reset, undefined);
    assert.equal(reg('s1_q').clock.net, 'clk_b');
    assert.equal(reg('s2_q').clock_root, 'clk_b');

    const stage = byOrig('tiny_stage');
    assert.equal(stage.params.W, 8);
    assert.equal(stage.registers[0].width, 8);
    assert.equal(stage.registers[0].clock_root, 'clk_a');

    const uMem = top.instances.find((i) => i.name === 'u_mem');
    assert.deepEqual(uMem.connections.find((c) => c.port === 'ADR').expr, { kind: 'slice', net: 's0_q', msb: 3, lsb: 0, width: 4 });
    assert.deepEqual(netlist.hierarchy.map((h) => h.path), ['tiny_top', 'tiny_top.u_mem', 'tiny_top.u_stage']);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
