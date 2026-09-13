import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMicroarch } from '../lib/checks/microarch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = [['examples/microarch-soc-accelerator.json', 'examples'], ['tests/fixtures/soc/soc-min.microarch.json', 'tests/fixtures/soc']];
const load = (i) => JSON.parse(fs.readFileSync(path.join(root, cases[i][0]), 'utf8'));
const errors = (doc, i = 0) => checkMicroarch(doc, { figureDir: path.join(root, cases[i][1]) }).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

cases.forEach(([file], i) => test(`${file} passes SoC checks`, () => assert.deepEqual(errors(load(i), i), [])));

test('duplicate IRQ lines and non-controller targets are errors', () => {
  const doc = load(0);
  doc.links.find((l) => l.id === 'irq_uart').irq = 5;
  doc.links.push({ id: 'irq_bad', from: 'acc', to: 'uart', class: 'interrupt' });
  const found = errors(doc);
  assert.ok(found.includes('irq/duplicate-line'));
  assert.ok(found.includes('irq/target-kind'));
});

test('undeclared domain crossings are errors', () => {
  const doc = load(0);
  doc.crossings = doc.crossings.filter((c) => c.link !== 'irq_acc');
  assert.ok(errors(doc).includes('domain/crossing-unmarked'));
});

test('bridges need both sides; fabrics need a manager; refs must resolve', () => {
  const doc = load(1);
  doc.attachments = doc.attachments.filter((a) => a.id !== 'at_br_m');
  doc.links.push({ id: 'l_bad', from: 'nope', to: 'cpu', class: 'sideband' });
  const found = errors(doc, 1);
  for (const c of ['soc/bridge-shape', 'soc/fabric-roles', 'soc/unknown-ref']) assert.ok(found.includes(c), c);
});

test('a DMA link needs a bus-mastering source; detail refs must exist', () => {
  const doc = load(1);
  doc.links.push({ id: 'dma0', from: 'acc', to: 'sram', class: 'dma' });
  doc.blocks.find((b) => b.id === 'acc').detail_ref = { figure: 'missing.json' };
  // unit-test figure only; real figures never reference tests/fixtures
  const found = errors(doc, 1);
  assert.ok(found.includes('dma/no-manager'));
  assert.ok(found.includes('detail/ref-unresolved'));
});
