// Phase 3 close polish: a guard comparison stays on one line and a one-word
// operand never stands alone; label-radix lanes print no width suffix; vcd2wave
// bit selection draws one bit of a vector as its own lane.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { wrap } from '../lib/render/fsm.mjs';
import { paperWavejson } from '../lib/render/timing.mjs';
import { parseBitSelect, sliceBits, vcdToTiming } from '../lib/timing/vcd2wave.mjs';

const NB = ' ';

test('guard wrap: a comparison stays whole and its operand is never alone on a line', () => {
  // readable names arrive with non-breaking spaces (transitionTexts)
  const guard = `enable and start and mode is not MODE${NB}RSVD and word${NB}count is not 0`;
  const lines = wrap(guard, 20).map((l) => l.replace(/ /g, ' '));
  assert.ok(lines.includes('mode is not MODE RSVD and') || lines.includes('mode is not MODE RSVD'), JSON.stringify(lines));
  assert.ok(!lines.includes('mode'), JSON.stringify(lines));
  for (const l of lines) assert.ok(!/^(\S+)$/.test(l) || !['mode', 'enable', 'start'].includes(l), `lone operand: ${JSON.stringify(lines)}`);
  // earlier guarantees hold
  assert.deepEqual(wrap('start and mode is not 3', 20), ['start and', 'mode is not 3']);
  assert.ok(wrap(guard, 20).every((l) => l !== 'and' && l !== 'or'));
  // a comparison longer than a column line with a multi-word left operand still breaks before its operator
  const long = `(seen${NB}with${NB}accept${NB}and${NB}required${NB}signal${NB}name) = required${NB}value${NB}name`;
  const parts = wrap(long, 20);
  assert.ok(parts.length >= 2 && parts[1].startsWith('='), JSON.stringify(parts));
});

test('timing: a lane whose values print as names has no width suffix', () => {
  const doc = {
    schema_version: 1, figure_type: 'timing', meta: { title: 't', print: { profile: 'ieee' } },
    wavejson: { signal: [{ name: 'clk', wave: 'p...' }, { name: 'state', wave: '=.=.', data: ['Idle', 'Run'] }, { name: 'count', wave: '=.=.', data: ['0x1', '0x2'] }] },
    signals: { state: { width: 4, radix: 'label' }, count: { width: 4, radix: 'hex' } },
  };
  const { names } = paperWavejson(doc, { variant: '2col' });
  assert.equal(names.find((n) => n.source === 'state').printed, 'state');
  assert.equal(names.find((n) => n.source === 'count').printed, 'count /4');
});

test('vcd2wave: path[i] and path[msb:lsb] select bits of a vector as their own lanes', () => {
  assert.deepEqual(parseBitSelect('tb.dut.v[0]'), { base: 'tb.dut.v', msb: 0, lsb: 0 });
  assert.deepEqual(parseBitSelect('tb.dut.v[3:2]'), { base: 'tb.dut.v', msb: 3, lsb: 2 });
  assert.equal(parseBitSelect('tb.dut.v'), null);
  assert.equal(sliceBits('0101', { width: 4, msb: 3, lsb: 0 }, 0, 0), '1');
  assert.equal(sliceBits('0101', { width: 4, msb: 3, lsb: 0 }, 3, 2), '01');
  assert.equal(sliceBits('0101', { width: 4, msb: 0, lsb: 3 }, 0, 0), '0');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-bits-'));
  try {
    // v[3:0] held before rising edges 1..4 (at #15, #25, #35, #45): 0011, 0010, 0000, 0000
    const vcd = ['$timescale 1ps $end', '$scope module tb $end', '$var wire 1 ! clk $end', '$var wire 4 " v [3:0] $end', '$upscope $end', '$enddefinitions $end',
      '#0', '0!', 'b0001 "', '#5', '1!', '#7', 'b0011 "', '#10', '0!', '#15', '1!', '#17', 'b0010 "', '#20', '0!', '#25', '1!', '#27', 'b0000 "', '#30', '0!', '#35', '1!', '#40', '0!', '#45', '1!', ''].join('\n');
    const file = path.join(dir, 'w.vcd');
    fs.writeFileSync(file, vcd);
    const { doc, diagnostics } = vcdToTiming(file, { clock: 'tb.clk', signals: ['tb.v[0]', 'tb.v[1]', 'tb.v[3:2]'], from: 0, cycles: 4 });
    assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), []);
    const lanes = Object.fromEntries(doc.wavejson.signal.map((l) => [l.name, l]));
    assert.equal(lanes['v bit 0'].wave, '10..');
    assert.equal(lanes['v bit 1'].wave, '1.0.');
    assert.equal(lanes['v bits 3 to 2'].wave, '=...');
    assert.equal(doc.provenance.rtl_map['v bit 0'], 'tb.v[0]');
    assert.equal(doc.signals['v bits 3 to 2'].width, 2);
    const bad = vcdToTiming(file, { clock: 'tb.clk', signals: ['tb.v[7]'], from: 0, cycles: 4 });
    assert.ok(bad.diagnostics.some((d) => d.code === 'timing/vcd-bit-select'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
