// A connector tag packed against its driver slides right into free space so the
// junction before it keeps its clearance from the arrowhead (route/dot-near-arrow).

import assert from 'node:assert/strict';
import test from 'node:test';
import { nudgeConnectorTags } from '../lib/render/datapath.mjs';

const scene = ({ blocker = null } = {}) => {
  // driver pin at x 100; branch to a register goes down at x 109; tag arrow tip at x 114
  const edgePts = new Map([
    ['n__0', [{ x: 100, y: 50 }, { x: 109, y: 50 }, { x: 109, y: 120 }, { x: 130, y: 120 }]],
    ['n__1', [{ x: 100, y: 50 }, { x: 114, y: 50 }]],
    ...(blocker ? [['m__0', blocker]] : []),
  ]);
  const edges = [{ id: 'n__0', net: 'n', sink: 'reg' }, { id: 'n__1', net: 'n', sink: 'tag' }, ...(blocker ? [{ id: 'm__0', net: 'm', sink: 'x' }] : [])];
  const pos = new Map([['tag', { x: 114, y: 45, w: 30, h: 10 }], ['reg', { x: 130, y: 100, w: 40, h: 40 }]]);
  return { edgePts, edges, pos };
};

test('tag nudge: the tag slides right until the junction keeps the clearance from its arrowhead base', () => {
  const { edgePts, edges, pos } = scene();
  const moved = nudgeConnectorTags(edgePts, edges, pos, { isTag: (id) => id === 'tag', clearance: 8, arrowLen: 5, maxX: 300 });
  // arrowhead base was 114 - 5 = 109, on the junction: shift 8
  assert.deepEqual(moved, [{ tag: 'tag', net: 'n', shift: 8 }]);
  assert.equal(pos.get('tag').x, 122);
  assert.equal(edgePts.get('n__1').at(-1).x, 122);
  // the other branch is untouched
  assert.deepEqual(edgePts.get('n__0')[1], { x: 109, y: 50 });
});

test('tag nudge: no move when another wire or the figure edge is in the way, or the junction already has room', () => {
  const wire = scene({ blocker: [{ x: 150, y: 20 }, { x: 150, y: 80 }] });
  assert.deepEqual(nudgeConnectorTags(wire.edgePts, wire.edges, wire.pos, { isTag: (id) => id === 'tag', clearance: 8, arrowLen: 5, maxX: 300 }), []);
  assert.equal(wire.pos.get('tag').x, 114);
  const edge = scene();
  assert.deepEqual(nudgeConnectorTags(edge.edgePts, edge.edges, edge.pos, { isTag: (id) => id === 'tag', clearance: 8, arrowLen: 5, maxX: 148 }), []);
  const roomy = scene();
  roomy.edgePts.get('n__0')[1].x = 101;
  roomy.edgePts.get('n__0')[2].x = 101;
  assert.deepEqual(nudgeConnectorTags(roomy.edgePts, roomy.edges, roomy.pos, { isTag: (id) => id === 'tag', clearance: 8, arrowLen: 5, maxX: 300 }), []);
});
