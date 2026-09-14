// Redundant level changes (SPEC §9.4): a step shorter than a row between two
// runs in the same direction is redundant on control (dashed) wires as on data wires.

import assert from 'node:assert/strict';
import test from 'node:test';
import { dataJogs } from '../lib/render/route-metrics.mjs';
import { routeScore } from '../lib/render/straighten.mjs';

const stepped = (id, cls) => ({ id, cls, polylines: [[{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 13 }, { x: 40, y: 13 }]] });

test('control jogs: a 3 pt step on a dashed wire is redundant, found only when control nets are checked', () => {
  const nets = [stepped('n_sel', 'control'), stepped('n_data', 'data')];
  assert.deepEqual(dataJogs(nets).jogs.filter((j) => j.kind === 'redundant').map((j) => j.net), ['n_data'], 'data only by default');
  const control = dataJogs(nets, { classes: ['control'] }).jogs.filter((j) => j.kind === 'redundant');
  assert.deepEqual(control.map((j) => [j.net, j.offset]), [['n_sel', 3]]);
  // a full-row step on a control wire is a legitimate bend
  const row = { id: 'n_en', cls: 'control', polylines: [[{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 22 }, { x: 40, y: 22 }]] };
  assert.equal(dataJogs([row], { classes: ['control'] }).redundant, 0);
});

test('control jogs: the straightening score counts them, so a move that removes one is preferred', () => {
  const edge = (pts) => [{ id: 'n_sel__0', net: 'n_sel', cls: 'control', pts }];
  const jogged = routeScore(edge([{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 13 }, { x: 40, y: 13 }]), 12);
  const straight = routeScore(edge([{ x: 0, y: 10 }, { x: 40, y: 10 }]), 12);
  assert.equal(jogged.redundant, 1);
  assert.equal(straight.redundant, 0);
  assert.ok(straight.value < jogged.value);
});
