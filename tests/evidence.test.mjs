// Hard rule (SPEC §12.2): figures are verified only against the user's own
// RTL. Files in tests/fixtures, the fig-gen installation, or a fig-gen work
// directory must be rejected as evidence.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deliver } from '../lib/deliver.mjs';
import { checkNetlistEvidence, markWorkDir, selfAuthoredReason } from '../lib/evidence.mjs';
import verilator from '../lib/rtl/verilator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests', 'fixtures', 'rtl', 'tiny', 'tiny_top.sv');
const detected = await verilator.detect();
const skip = !detected.available && 'verilator not installed';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'bin', 'fig-gen.mjs'), ...args], { encoding: 'utf8' });

test('paths in the installation, tests/fixtures or a marked work dir are self-authored', () => {
  assert.match(selfAuthoredReason(fixture), /fig-gen installation/);
  const work = tmp('figgen-work-');
  try {
    markWorkDir(work);
    fs.writeFileSync(path.join(work, 'made_up.sv'), 'module made_up; endmodule\n');
    assert.match(selfAuthoredReason(path.join(work, 'made_up.sv')), /work directory/);
    const user = tmp('figgen-user-');
    fs.writeFileSync(path.join(user, 'real.sv'), 'module real; endmodule\n');
    assert.equal(selfAuthoredReason(path.join(user, 'real.sv')), null);
    fs.rmSync(user, { recursive: true, force: true });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('check-rtl refuses tests/fixtures and agent-written files as RTL evidence', { skip }, () => {
  const work = tmp('figgen-work-');
  try {
    const r1 = cli('check-rtl', '--top', 'tiny_top', '--files', fixture, '--work-dir', work, '--quiet');
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /evidence\/self-authored/);

    markWorkDir(work);
    const copy = path.join(work, 'tiny_top.sv');
    fs.copyFileSync(fixture, copy);
    const r2 = cli('check-rtl', '--top', 'tiny_top', '--files', copy, '--work-dir', tmp('figgen-work2-'), '--quiet');
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /evidence\/self-authored/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('check-rtl keeps every output path outside an explicit source root', () => {
  const user = tmp('figgen-source-root-');
  const external = tmp('figgen-external-');
  try {
    const src = path.join(user, 'real.sv');
    fs.writeFileSync(src, 'module real; endmodule\n');
    const cases = [
      ['--out', path.join(user, 'netlist.json')],
      ['--work-dir', path.join(user, 'work')],
      ['--emit-filelist', path.join(user, 'files.f')],
    ];
    for (const [flag, target] of cases) {
      const args = ['check-rtl', '--top', 'real', '--files', src, '--source-root', user,
        '--work-dir', path.join(external, `work-${flag.slice(2)}`), '--out', path.join(external, `${flag.slice(2)}.json`),
        flag, target, '--quiet'];
      const r = cli(...args);
      assert.equal(r.status, 1, `${flag} should be rejected`);
      assert.match(r.stderr, /evidence\/output-in-rtl-tree/);
    }
  } finally {
    fs.rmSync(user, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('Verilator extraction detects any mutation of an RTL input', async () => {
  const user = tmp('figgen-immutable-');
  const work = tmp('figgen-immutable-work-');
  try {
    const src = path.join(user, 'real.sv');
    const fake = path.join(user, 'fake-verilator');
    fs.writeFileSync(src, 'module real; endmodule\n');
    fs.writeFileSync(fake, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Verilator 5.000"
  exit 0
fi
echo '// mutated by fake extractor' >> '${src}'
echo '%Error: deliberate fake failure' >&2
exit 1
`);
    fs.chmodSync(fake, 0o755);
    await assert.rejects(
      () => verilator.extract({ files: [src], top: 'real', work_dir: work }, { env: { ...process.env, FIGGEN_VERILATOR: fake } }),
      /rtl\/source-mutated/,
    );
  } finally {
    fs.rmSync(user, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a netlist built from fixtures cannot verify a real figure', { skip }, async () => {
  const work = tmp('figgen-work-');
  const out = tmp('figgen-out-');
  try {
    const netlist = await verilator.extract({ files: [fixture], top: 'tiny_top', work_dir: work });
    assert.ok(checkNetlistEvidence(netlist).diagnostics.some((d) => d.code === 'evidence/self-authored'));
    const netlistPath = path.join(out, 'netlist.json');
    fs.writeFileSync(netlistPath, JSON.stringify(netlist));
    const figure = path.join(out, 'tiny.datapath.json');
    fs.copyFileSync(path.join(root, 'tests', 'fixtures', 'rtl', 'tiny', 'tiny.datapath.json'), figure);
    const r = await deliver({ type: 'datapath', figurePath: figure, outDir: path.join(out, 'delivered'), netlistPath });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'evidence/self-authored'));
    assert.equal(fs.existsSync(path.join(out, 'delivered')), false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('user RTL outside the installation is accepted and its origin recorded', { skip }, async () => {
  const user = tmp('figgen-user-');
  const work = tmp('figgen-work-');
  try {
    const src = path.join(user, 'tiny_top.sv');
    fs.copyFileSync(fixture, src);
    const cliRun = cli('check-rtl', '--top', 'tiny_top', '--files', src, '--work-dir', work, '--out', path.join(user, 'netlist.json'), '--quiet');
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const netlist = JSON.parse(fs.readFileSync(path.join(user, 'netlist.json'), 'utf8'));
    const { diagnostics, evidence } = checkNetlistEvidence(netlist);
    assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), []);
    assert.ok(diagnostics.some((d) => d.code === 'evidence/untracked'));
    const rtl = evidence.find((e) => e.role === 'rtl');
    assert.equal(fs.realpathSync(rtl.path), fs.realpathSync(src));
    assert.match(rtl.sha256, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(user, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});
