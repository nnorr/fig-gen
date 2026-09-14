// Long detours (CONVENTIONS §1.6) on routed geometry, any net class, paper and
// study: the wrap-around shape of a study view (engine outputs returning to the
// service state along the bottom and left edges) is found, and the drawn block
// columns that decide the close-pair rule are not merged by a chain of overlaps.

import assert from 'node:assert/strict';
import test from 'node:test';
import { blockLayers, longDetour, staysLocal } from '../lib/render/datapath.mjs';

// Blocks and routes as delivered in a study view (pt): the service state on the
// left, the engine state and logic in a frame on the right, the service logic
// above them. The engine result wire leaves the engine logic to the right, runs
// under every block along the bottom channel, up the left edge and into the
// service state's west pin.
const W = 560.45;
const BLOCKS = [
  { id: 'service_logic', x: 336.45, y: 10, w: 54.02, h: 48 },
  { id: 'service_state', x: 129.64, y: 63, w: 54.91, h: 144 },
  { id: 'engine_logic', x: 374.46, y: 93, w: 38.91, h: 60 },
  { id: 'engine_state', x: 305.55, y: 128, w: 38.91, h: 84 },
];
const boxes = BLOCKS.map((b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }));
const P = (list) => list.map(([x, y]) => ({ x, y }));
const RESULT = P([[413.36, 99], [484.36, 99], [484.36, 257], [79.64, 257], [79.64, 141], [124.64, 141]]);
const READY = P([[344.46, 158], [492.36, 158], [492.36, 265], [119.64, 265], [119.64, 201], [124.64, 201]]);
const STRAIGHT = P([[61.64, 36], [218.55, 36], [218.55, 134], [300.55, 134]]);

test('block columns: a chain of partial overlaps does not merge layers', () => {
  const layers = blockLayers(BLOCKS);
  assert.equal(layers.get('service_state'), 0);
  assert.equal(layers.get('engine_state'), 1);
  assert.equal(layers.get('service_logic'), 2, 'overlaps the engine state by 8 pt of 39: its own column');
  assert.equal(layers.get('engine_logic'), 3);
  // blocks stacked in one layer (same x, different widths) still share a column
  const stacked = blockLayers([{ id: 'a', x: 100, w: 40 }, { id: 'b', x: 104, w: 30 }, { id: 'c', x: 200, w: 20 }]);
  assert.equal(stacked.get('a'), stacked.get('b'));
  assert.notEqual(stacked.get('b'), stacked.get('c'));
});

test('long detour: the wrap-around shape is found as a returning branch and as a forward net ELK routes around', () => {
  // measured as a wrap-around whether it is a layer back-edge or not (the geometry decides)
  const back = longDetour(RESULT, { width: W, blocks: boxes, back: true });
  assert.equal(back?.kind, 'wrap-around');
  // a return that is only long (1.44× direct, inside the blocks' extent) is feedback, found only as a back-edge
  const longReturn = P([[500, 100], [510, 100], [510, 20], [40, 20], [40, 100], [50, 100]]);
  assert.equal(longDetour(longReturn, { width: W, blocks: boxes, back: true })?.kind, 'feedback');
  assert.equal(longDetour(longReturn, { width: W, blocks: boxes, back: false }), null);
  const forward = longDetour(RESULT, { width: W, blocks: boxes, back: false });
  assert.equal(forward?.kind, 'wrap-around', 'a forward net routed around the figure is caught too');
  assert.ok(forward.ratio > 2.3 && forward.detour > 450, JSON.stringify(forward));
  assert.equal(longDetour(READY, { width: W, blocks: boxes })?.kind, 'wrap-around');
  assert.equal(longDetour(STRAIGHT, { width: W, blocks: boxes }), null, 'a direct route is not a detour');
});

test('long detour: ratio and outer-channel findings below the wrap-around limit', () => {
  // 4.7× its direct distance and 260 pt longer on a 560 pt figure (half the width is not exceeded)
  const ratio = P([[300, 150], [330, 150], [330, 60], [220, 60], [220, 140], [240, 140]]);
  const r = longDetour(ratio, { width: W, blocks: boxes });
  assert.equal(r?.kind, 'detour', JSON.stringify(r));
  assert.ok(r.detour < W / 2 && r.ratio > 1.8);
  // under the blocks from the engine logic to the service state: 1.79× its direct distance, 230 pt longer: outer channel
  const outer = P([[413, 140], [430, 140], [430, 225], [110, 225], [110, 141], [124, 141]]);
  assert.equal(longDetour(outer, { width: W, blocks: boxes })?.kind, 'outer-channel');
  // the same excursion on a wide figure is below every threshold
  assert.equal(longDetour(outer, { width: 2000, blocks: boxes }), null);
});

test('neighbour returns: local when the route encloses no other block, a detour when it runs around further blocks', () => {
  // two neighbouring controllers; the return leaves the right block, runs over the top and enters the left block
  const owner = { x0: 176.95, y0: 10, x1: 219.85, y1: 118 };
  const adapter = { x0: 285.86, y0: 46, x1: 322.99, y1: 94 };
  const ret = P([[322.99, 52], [379.99, 52], [379.99, 16], [224.86, 16]]);
  assert.equal(staysLocal(ret, adapter, owner, [owner, adapter]), true);
  // the engine state back to the service state, around the service and engine logic blocks
  const ready = P([[331.41, 93], [419.32, 93], [419.32, 169], [273.5, 169], [273.5, 147], [201.64, 147], [201.64, 150]]);
  const state = { x0: 292.5, y0: 80, x1: 331.41, y1: 170 };
  const service = { x0: 146.73, y0: 150, x1: 201.64, y1: 294 };
  const logic = { x0: 350, y0: 120, x1: 390, y1: 160 };
  assert.equal(staysLocal(ready, state, service, [state, service, logic]), false);
});
