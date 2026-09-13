import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMemoryMap, formatHex, parseHex } from '../lib/checks/memory-map.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = () => JSON.parse(fs.readFileSync(path.join(root, 'examples', 'microarch-soc-accelerator.json'), 'utf8'));
const codes = (r) => r.diagnostics.map((d) => d.code);

test('hex parsing and formatting', () => {
  assert.equal(parseHex('0x5A00_0FFF'), 0x5a000fffn);
  assert.equal(parseHex('5A00'), null);
  assert.equal(formatHex(0x5a000000n), '0x5A00_0000');
});

test('example SoC memory map is clean and produces a sorted table', () => {
  const r = checkMemoryMap(load());
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.table.map((e) => [e.block, e.base, e.end]), [
    ['sram', '0x0000_0000', '0x0000_FFFF'],
    ['uart', '0x4000_0000', '0x4000_0FFF'],
    ['timer', '0x4000_1000', '0x4000_1FFF'],
    ['acc', '0x5A00_0000', '0x5A00_0FFF'],
  ]);
});

test('overlapping subordinates on the same fabric are errors', () => {
  const doc = load();
  doc.attachments.find((a) => a.id === 'at_timer').address = { base: '0x4000_0800', size: '0x1000' };
  const r = checkMemoryMap(doc);
  assert.ok(codes(r).includes('memmap/overlap'));
  assert.ok(codes(r).includes('memmap/misaligned'));
});

test('ranges behind a bridge must lie inside its window', () => {
  const doc = load();
  doc.attachments.find((a) => a.id === 'at_uart').address = { base: '0x5000_0000', size: '0x1000' };
  assert.ok(codes(checkMemoryMap(doc)).includes('memmap/bridge-window'));
});

test('end below base and malformed hex are format errors', () => {
  const doc = load();
  doc.attachments.find((a) => a.id === 'at_acc').address = { base: '0x5A00_0000', end: '0x59FF_FFFF' };
  doc.attachments.find((a) => a.id === 'at_sram').address = { base: '0xZZ', size: '0x10' };
  assert.deepEqual(codes(checkMemoryMap(doc)).filter((c) => c === 'memmap/format').length, 2);
});
