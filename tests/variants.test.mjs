// 2col is the required deliverable; 1col is best effort (SPEC §9.5).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deliver } from '../lib/deliver.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-variants-'));

// A generic five-stage chain that is too wide for one column but fits two.
function wideChain() {
  const stages = ['Input framing stage', 'Bit reversal stage', 'Symbol mapping stage', 'Output packing stage'];
  const elements = [{ id: 'din', kind: 'port', dir: 'in', width: 16, label: 'data in' }, { id: 'dout', kind: 'port', dir: 'out', width: 16, label: 'data out' }];
  const nets = [];
  let prev = 'din';
  stages.forEach((label, i) => {
    elements.push({ id: `s${i}`, kind: 'comb', op: 'custom', width: 16, function: { kind: 'custom', name: label }, ports: [{ id: 'a', dir: 'in', width: 16 }, { id: 'y', dir: 'out', width: 16 }] });
    nets.push({ id: `n${i}`, width: 16, driver: prev, sinks: [`s${i}.a`] });
    prev = `s${i}.y`;
  });
  nets.push({ id: 'n_out', width: 16, driver: prev, sinks: ['dout'] });
  return { schema_version: 1, figure_type: 'datapath', meta: { title: 'wide chain', print: { profile: 'ieee' } }, clock_domains: [], elements, nets };
}

test('a figure that fits one column delivers both variants', async () => {
  const out = tmp();
  try {
    const r = await deliver({ type: 'datapath', figurePath: path.join(root, 'examples', 'datapath-pipelined-xor.json'), outDir: out });
    assert.equal(r.ok, true);
    assert.deepEqual(r.receipt.variant_status['1col'].status, 'delivered');
    assert.deepEqual(r.receipt.variant_status['2col'].status, 'delivered');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a figure too wide for one column skips 1col and still delivers 2col', async () => {
  const out = tmp();
  const file = path.join(out, 'chain.datapath.json');
  fs.writeFileSync(file, JSON.stringify(wideChain()));
  try {
    const r = await deliver({ type: 'datapath', figurePath: file, outDir: path.join(out, 'delivered') });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error')));
    const skipped = r.diagnostics.find((d) => d.code === 'variant/1col-skipped');
    assert.ok(skipped);
    assert.equal(skipped.severity, 'info');
    assert.ok(skipped.evidence.measured.content_width_pt > 252);
    const names = fs.readdirSync(path.join(out, 'delivered')).sort();
    assert.deepEqual(names, ['chain.2col.pdf', 'chain.2col.svg', 'chain.receipt.json']);
    assert.equal(r.receipt.variant_status['1col'].status, 'skipped');
    assert.match(r.receipt.variant_status['1col'].reason, /exceeds column/);
    assert.deepEqual(await validateSchema('receipt', r.receipt), []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('forcing --variants 1col turns the overflow into a delivery failure', async () => {
  const out = tmp();
  const file = path.join(out, 'chain.datapath.json');
  fs.writeFileSync(file, JSON.stringify(wideChain()));
  try {
    const r = await deliver({ type: 'datapath', figurePath: file, outDir: path.join(out, 'delivered'), variants: ['1col'] });
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'print/width-overflow' && d.severity === 'error'));
    assert.equal(fs.existsSync(path.join(out, 'delivered')), false);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
