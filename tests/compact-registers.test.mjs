// Compact registers (CONVENTIONS §5.1, §5.6): a register or register bank is a
// narrow storage box of the skin's register width with a clock wedge, and no
// name is printed inside or beside it (its ports and nets say what it holds).

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSkin, renderDatapath } from '../lib/render/datapath.mjs';

const figure = () => ({
  schema_version: 1, figure_type: 'datapath',
  meta: { title: 'compact', print: { profile: 'ieee' } },
  clock_domains: [{ id: 'sys', clock: 'clk' }],
  elements: [
    { id: 'p_a', kind: 'port', dir: 'in', width: 8, label: 'input a' },
    { id: 'p_b', kind: 'port', dir: 'in', width: 8, label: 'input b' },
    { id: 'p_load', kind: 'port', dir: 'in', width: 1, label: 'load', role: 'enable' },
    { id: 'p_c', kind: 'port', dir: 'in', width: 8, label: 'input c' },
    { id: 'p_cload', kind: 'port', dir: 'in', width: 1, label: 'accept', role: 'enable' },
    { id: 'bank', kind: 'register', domain: 'sys', label: 'operand registers', enable: true, lanes: [{ id: 'a', width: 8 }, { id: 'b', width: 8 }] },
    { id: 'one', kind: 'register', domain: 'sys', width: 8, label: 'carry register', enable: true },
    { id: 'p_qa', kind: 'port', dir: 'out', width: 8, label: 'output a' },
    { id: 'p_qb', kind: 'port', dir: 'out', width: 8, label: 'output b' },
    { id: 'p_qc', kind: 'port', dir: 'out', width: 8, label: 'output c' },
  ],
  nets: [
    { id: 'n_a', width: 8, driver: 'p_a', sinks: ['bank.d_a'] },
    { id: 'n_b', width: 8, driver: 'p_b', sinks: ['bank.d_b'] },
    { id: 'n_load', width: 1, driver: 'p_load', sinks: ['bank.en'] },
    { id: 'n_c', width: 8, driver: 'p_c', sinks: ['one.d'] },
    { id: 'n_cload', width: 1, driver: 'p_cload', sinks: ['one.en'] },
    { id: 'n_qa', width: 8, driver: 'bank.q_a', sinks: ['p_qa'] },
    { id: 'n_qb', width: 8, driver: 'bank.q_b', sinks: ['p_qb'] },
    { id: 'n_qc', width: 8, driver: 'one.q', sinks: ['p_qc'] },
  ],
});

const rect = (svg, id) => {
  const m = new RegExp(`<rect id="${id}" x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"`).exec(svg);
  return m && { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
};

test('compact registers: the skin width, lane height, a clock wedge and no printed name', async () => {
  const skin = loadSkin('netlist-mono');
  const width = skin.symbols.register.width_pt;
  const pitch = skin.symbols.pipeline_register.lane_pitch;
  assert.ok(width >= 12 && width <= 16, `register width token ${width} pt`);
  const r = await renderDatapath(figure(), { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'compact' });
  const bank = rect(r.svg, 'reg-bank-body');
  const one = rect(r.svg, 'reg-one-body');
  assert.ok(bank && one, 'both registers drawn');
  assert.equal(bank.w, width, 'the bank is the register width, not its name');
  assert.equal(one.w, width, 'a single register is the register width');
  assert.equal(bank.h, 2 * pitch + pitch, 'bank height: 2 lanes × pitch plus margins');
  // no name inside, above or beside: the element labels stay in the IR only
  assert.doesNotMatch(r.svg, />operand registers</);
  assert.doesNotMatch(r.svg, />carry register</);
  assert.doesNotMatch(r.svg, /id="reg-(bank|one)-label/);
  // the wedge stays at the bottom edge
  assert.match(r.svg, new RegExp(`<path d="M${bank.x + width / 2 - 3} ${bank.y + bank.h} L${bank.x + width / 2} `));
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`), []);
});
