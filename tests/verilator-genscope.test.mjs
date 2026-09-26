import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import verilator from '../lib/rtl/verilator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'rtl', 'genscope');
const detected = await verilator.detect();

// Regression: a register declared in a generate block was listed in `nets` as
// `gen_w1.hold` but in `registers`/`deps` as `hold`, so coverage saw the net
// as read by nothing and excluded live registers as dead logic.
test('generate-block signals keep one name across nets, registers and deps', { skip: !detected.available && 'verilator not installed' }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-test-'));
  try {
    const netlist = await verilator.extract({ files: [path.join(fixture, 'gen_top.sv')], top: 'gen_top', work_dir: workDir, source_root: fixture });
    const top = netlist.modules.find((m) => m.orig_name === 'gen_top');
    const nets = new Set(top.nets.map((n) => n.name));
    assert.deepEqual(top.registers.map((r) => r.name), ['gen_w1.hold']);
    assert.equal(top.registers[0].width, 4);
    for (const d of top.deps) {
      assert.ok(nets.has(d.target), `dep target ${d.target} is a listed net`);
      for (const s of d.sources) assert.ok(nets.has(s), `dep source ${s} of ${d.target} is a listed net`);
    }
    assert.deepEqual(top.deps.find((d) => d.target === 'q').sources, ['gen_w1.inv']);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
