// Checkpoint 3b follow-ups on simulated waveforms: enum values read through
// the netlist print as readable names (the prefix shared by the items is
// dropped, as for FSM state labels), and a bus value wider than its segment
// never spills over its lane's name.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { vcdToTiming } from '../lib/timing/vcd2wave.mjs';
import { renderTiming } from '../lib/render/timing.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-3b-'));

test('vcd2wave: enum values print as readable names without the prefix all items share', () => {
  const dir = tmp();
  try {
    // clock period 10 ps; state 0, 1, 2, 1 held before each rising edge
    const vcd = [
      '$timescale 1ps $end',
      '$scope module tb $end',
      '$var wire 1 ! clk $end',
      '$var wire 2 " st [1:0] $end',
      '$upscope $end',
      '$enddefinitions $end',
      '#0', '0!', 'b00 "',
      '#5', '1!',
      '#7', 'b01 "',
      '#10', '0!',
      '#15', '1!',
      '#17', 'b10 "',
      '#20', '0!',
      '#25', '1!',
      '#27', 'b01 "',
      '#30', '0!',
      '#35', '1!',
      '#40', '0!',
      '#45', '1!',
      '',
    ].join('\n');
    const file = path.join(dir, 'w.vcd');
    fs.writeFileSync(file, vcd);
    const netlist = {
      modules: [{ name: 'tb', orig_name: 'tb', nets: [{ name: 'st', width: 2, kind: 'var', type: 'tb.st_e' }] }],
      types: [{ name: 'tb.st_e', kind: 'enum', width: 2, items: [{ name: 'CtlIdle', value: 0 }, { name: 'CtlRun', value: 1 }, { name: 'CtlDone', value: 2 }] }],
    };
    const { doc, diagnostics } = vcdToTiming(file, { clock: 'tb.clk', signals: ['tb.st'], from: 0, cycles: 4, radix: { 'tb.st': 'label' }, netlist });
    assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), []);
    const lane = doc.wavejson.signal.flat().find((l) => l && l.name && l.name !== 'clock');
    assert.ok(lane.data.length >= 3, JSON.stringify(lane));
    for (const v of lane.data) assert.ok(['Idle', 'Run', 'Done'].includes(v), `readable value, got ${v}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timing render: a bus value wider than its first segment never overlaps its lane name', async () => {
  const doc = {
    schema_version: 1, figure_type: 'timing',
    meta: { title: 'Wide first value', print: { profile: 'ieee' } },
    wavejson: {
      signal: [
        { name: 'clk', wave: 'p.......' },
        { name: 'response_result_long', wave: '=.=.....', data: ['0x0000000000000000', '0x4000000000000000'] },
        { name: 'request_address_word', wave: '==......', data: ['0x0000000000000000', '0x3FF0000000000000'] },
      ],
    },
    signals: { response_result_long: { width: 64 }, request_address_word: { width: 64 } },
  };
  for (const opts of [{ variant: 'study' }, { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4 }]) {
    const r = await renderTiming(doc, { ...opts, name: 'wide' });
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    assert.deepEqual(errors.map((d) => d.message), [], opts.variant);
    // every value text starts at or right of the leftmost waveform point
    const waveXs = [...r.svg.matchAll(/<g id="timing-signal-[^"]+-wave"[^>]*>([\s\S]*?)<\/g>/g)].flatMap((m) => [...m[1].matchAll(/[ML]\s*(-?[\d.]+)\s+-?[\d.]+/g)].map((q) => Number(q[1])));
    const valueXs = [...r.svg.matchAll(/<text x="([\d.-]+)"[^>]*id="timing-signal-[^"]+-value-\d+"/g)].map((m) => Number(m[1]));
    assert.ok(waveXs.length && valueXs.length);
    assert.ok(Math.min(...valueXs) >= Math.min(...waveXs), `values start at ${Math.min(...valueXs)}, wave at ${Math.min(...waveXs)}`);
  }
});

test('timing render: a value wider than its segment prints its lossless short form, and is reported when still too wide', async () => {
  const doc = (data) => ({
    schema_version: 1, figure_type: 'timing',
    meta: { title: 'Segment fit', print: { profile: 'ieee' } },
    wavejson: { signal: [{ name: 'clk', wave: 'p.........' }, { name: 'word', wave: '==........', data }] },
    signals: { word: { width: 64 } },
  });
  const opts = { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'fit' };
  // leading zeros only: "0x0" fits one cycle, and the printed form is recorded
  const zero = await renderTiming(doc(['0x0000000000000000', '0x3FF0000000000000']), opts);
  assert.deepEqual(zero.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message), []);
  assert.ok(zero.diagnostics.some((d) => d.code === 'timing/value-compacted' && d.evidence.printed === '0x0'));
  assert.match(zero.svg, />0x0<\/text>/);
  assert.match(zero.svg, />0x3FF0000000000000<\/text>/);
  // no lossless short form: an error names the value and its segment, never a silent overprint
  const wide = await renderTiming(doc(['0x4000000000000001', '0x3FF0000000000000']), opts);
  const overflow = wide.diagnostics.filter((d) => d.code === 'timing/value-overflow');
  assert.equal(overflow.length, 1);
  assert.match(overflow[0].message, /0x4000000000000001/);
});

test('geometry: an exempt line never hides a real strike on the same text', async () => {
  const { el } = await import('../lib/svg.mjs');
  const { geometryChecks } = await import('../lib/render/geometry.mjs');
  const { loadSkin, renderContext } = await import('../lib/render/datapath.mjs');
  const skin = loadSkin('netlist-mono');
  const ctx = renderContext({ schema_version: 1, figure_type: 'timing', meta: { title: 't', print: { profile: 'ieee' } } }, skin, '2col', 'full');
  const line = (id, x) => el('path', { id, d: `M${x} 0 L${x} 20`, stroke: '#000000', 'stroke-width': 0.9, fill: 'none' });
  const tree = el('svg', {}, [
    el('g', { id: 'timing-axis' }, [line('timing-axis-0', 12)]),
    el('g', { id: 'lane' }, [line('lane-wave-0', 20)]),
    el('text', { id: 'lane-value-0', x: 10, y: 12, 'font-size': 7 }, ['0x0000']),
  ]);
  const hits = geometryChecks(tree, { font: ctx.font, ignoreLine: (id) => /^timing-axis/.test(id) }).filter((d) => d.code === 'geometry/text-on-line');
  assert.deepEqual(hits.map((d) => d.subject.line), ['lane-wave-0']);
});
