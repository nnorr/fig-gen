// Terminal runs of different nets on top of each other (wire/collinear-overlap):
// the riser bounding one run slides toward that run's pin, past the other run.

import assert from 'node:assert/strict';
import test from 'node:test';
import { unstackTerminalRuns } from '../lib/render/datapath.mjs';

// A lane leaves its bank pin at x 156 (y 295) and branches at a riser x 174 to two
// mux inputs; another net's branch turns at x 170 into a pin at x 186, 1 pt above.
const scene = () => {
  const edgePts = new Map([
    ['dr__0', [{ x: 156, y: 295 }, { x: 174, y: 295 }, { x: 174, y: 271 }, { x: 186, y: 271 }]],
    ['dr__1', [{ x: 156, y: 295 }, { x: 174, y: 295 }, { x: 174, y: 330 }, { x: 186, y: 330 }]],
    ['yi__0', [{ x: 139, y: 235 }, { x: 186, y: 235 }]],
    ['yi__1', [{ x: 139, y: 235 }, { x: 170, y: 235 }, { x: 170, y: 294 }, { x: 186, y: 294 }]],
  ]);
  const edges = [...edgePts.keys()].map((id) => ({ id, net: id.split('__')[0] }));
  return { edgePts, edges };
};

test('terminal runs: the lane riser and both branches slide back toward the bank pin, clearing the overlap', () => {
  const { edgePts, edges } = scene();
  const moves = unstackTerminalRuns(edgePts, edges, { minGap: 4, clearance: 8, arrowLen: 5 });
  assert.deepEqual(moves, [{ net: 'dr', side: 'first', from: 174, to: 166 }]);
  for (const id of ['dr__0', 'dr__1']) {
    const q = edgePts.get(id);
    assert.equal(q[1].x, 166);
    assert.equal(q[2].x, 166);
    assert.equal(q[0].x, 156, 'the pin end stays');
  }
  // the other net is untouched
  assert.deepEqual(edgePts.get('yi__1')[1], { x: 170, y: 235 });
});

test('terminal runs: no move when the junction would lose its clearance from the pin', () => {
  const { edgePts, edges } = scene();
  // the bank pin moves right to x 160: a riser at 166 would sit 6 pt from it
  for (const id of ['dr__0', 'dr__1']) edgePts.get(id)[0].x = 160;
  assert.deepEqual(unstackTerminalRuns(edgePts, edges, { minGap: 4, clearance: 8, arrowLen: 5 }).filter((m) => m.net === 'dr'), []);
  assert.equal(edgePts.get('dr__0')[1].x, 174);
});
