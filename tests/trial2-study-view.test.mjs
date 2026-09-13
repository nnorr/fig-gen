// Trial-2 study view: width slashes keep clear of other nets' width numbers
// (geometry/text-on-line), straightening never stacks two frames flush
// (region/frame-edge-crossing), and a net entering a frame near a corner grows
// the frame so it enters mid-edge (region/entry-side).

import assert from 'node:assert/strict';
import test from 'node:test';
import { frameEntryChecks, frameChecks, growFramesForEntries, separateSiblingFrames } from '../lib/render/geometry.mjs';
import { renderDatapath } from '../lib/render/datapath.mjs';

test('separateSiblingFrames: two stacked frames sharing an edge pull apart within their padding', () => {
  // members a (y 0..20) and b (y 38..58); frames pad 5, label band 13 on top
  const frames = () => [
    { id: 'ra', x0: -5, y0: -13, x1: 45, y1: 25, inner: { x0: 0, y0: 0, x1: 40, y1: 20 } },
    { id: 'rb', x0: -5, y0: 25, x1: 45, y1: 63, inner: { x0: 0, y0: 38, x1: 40, y1: 58 } },
  ];
  const fs = frames();
  assert.equal(frameChecks(fs, []).length, 1);
  assert.equal(separateSiblingFrames(fs, { labelBand: 10 }).length, 1);
  assert.deepEqual(frameChecks(fs, []), []);
  assert.ok(fs[0].y1 >= 20 + 2 && fs[1].y0 <= 38 - 10, 'members and the label band stay enclosed');
  // nested frames are left alone
  const nested = [
    { id: 'outer', x0: 0, y0: 0, x1: 100, y1: 100, inner: { x0: 5, y0: 13, x1: 95, y1: 95 } },
    { id: 'inner', x0: 10, y0: 20, x1: 50, y1: 50, inner: { x0: 15, y0: 33, x1: 45, y1: 45 } },
  ];
  assert.deepEqual(separateSiblingFrames(nested), []);
  // no padding to give: left for the frame check
  const tight = [
    { id: 'ra', x0: 0, y0: 0, x1: 40, y1: 25, inner: { x0: 2, y0: 10, x1: 38, y1: 23 } },
    { id: 'rb', x0: 0, y0: 25, x1: 40, y1: 60, inner: { x0: 2, y0: 35, x1: 38, y1: 58 } },
  ];
  assert.deepEqual(separateSiblingFrames(tight, { labelBand: 10 }), []);
});

test('growFramesForEntries: an entry near a corner grows the perpendicular edge, then enters mid-edge', () => {
  const frame = () => ({ id: 'r', x0: 100, y0: 0, x1: 300, y1: 100, members: new Set(['sink']) });
  // enters the west side 6 pt above the bottom corner
  const entries = [{ net: 'n', region: 'r', pts: [{ x: 50, y: 94 }, { x: 200, y: 94 }] }];
  const f = frame();
  assert.equal(frameEntryChecks([f], entries).length, 1);
  const grown = growFramesForEntries([f], entries, { nodes: [{ id: 'sink', x0: 150, y0: 40, x1: 180, y1: 60 }] });
  assert.deepEqual(grown.map((g) => g.edge), ['y1']);
  assert.ok(f.y1 >= 94 + 12);
  assert.deepEqual(frameEntryChecks([f], entries), []);
  assert.deepEqual(frameChecks([f], [{ id: 'sink', x0: 150, y0: 40, x1: 180, y1: 60 }]), []);
});

test('growFramesForEntries keeps the frame when growing would cover a foreign block, leave the bounds or hug a wire', () => {
  const entries = [{ net: 'n', region: 'r', pts: [{ x: 50, y: 94 }, { x: 200, y: 94 }] }];
  const blocked = { id: 'r', x0: 100, y0: 0, x1: 300, y1: 100, members: new Set() };
  assert.deepEqual(growFramesForEntries([blocked], entries, { nodes: [{ id: 'other', x0: 120, y0: 103, x1: 160, y1: 120 }] }), []);
  assert.equal(blocked.y1, 100);
  const bounded = { id: 'r', x0: 100, y0: 0, x1: 300, y1: 100, members: new Set() };
  assert.deepEqual(growFramesForEntries([bounded], entries, { bounds: { x0: 0, y0: 0, x1: 400, y1: 104 } }), []);
  const hugged = { id: 'r', x0: 100, y0: 0, x1: 300, y1: 100, members: new Set() };
  assert.deepEqual(growFramesForEntries([hugged], entries, { segs: [{ id: 'net-w-seg0', a: { x: 110, y: 110 }, b: { x: 250, y: 110 } }] }), []);
});

test('width slashes on stacked multi-bit nets keep clear of the neighbouring width numbers', async () => {
  const outs = ['data', 'logn', 'counter', 'status'];
  const widths = { data: 8, logn: 4, counter: 32, status: 16 };
  const doc = {
    schema_version: 1, figure_type: 'datapath', meta: { title: 't', print: { format: 'study' } }, clock_domains: [],
    elements: [
      { id: 'src', kind: 'comb', op: 'custom', width: 1, function: { kind: 'custom', name: 'Source block' }, ports: outs.map((p) => ({ id: p, dir: 'out', width: widths[p] })) },
      { id: 'dst', kind: 'comb', op: 'custom', width: 1, function: { kind: 'custom', name: 'Sink block' }, ports: outs.map((p) => ({ id: p, dir: 'in', width: widths[p] })) },
    ],
    nets: outs.map((p) => ({ id: `n_${p}`, width: widths[p], driver: `src.${p}`, sinks: [`dst.${p}`] })),
  };
  const r = await renderDatapath(doc, { variant: 'study', name: 'stack' });
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'geometry/text-on-line'), []);
  const slashes = [...r.svg.matchAll(/id="net-(n_\w+)-slash" d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)"/g)].map((m) => ({ net: m[1], x0: +m[2], y0: +m[5], x1: +m[4], y1: +m[3] }));
  const numbers = [...r.svg.matchAll(/<text id="net-(n_\w+)-width" x="([\d.]+)" y="([\d.]+)"[^>]*>(\d+)</g)].map((m) => ({ net: m[1], x: +m[2], y: +m[3] }));
  assert.equal(slashes.length, outs.length);
  for (const s of slashes) {
    for (const t of numbers.filter((x) => x.net !== s.net)) {
      // text box: 7 pt secondary font, ascent about 0.72, a few pt wide
      const box = { x0: t.x - 1, x1: t.x + 12, y0: t.y - 5.1 - 1, y1: t.y + 1.3 };
      const apart = s.x1 < box.x0 || s.x0 > box.x1 || s.y1 < box.y0 || s.y0 > box.y1;
      assert.ok(apart, `slash of ${s.net} strikes the width number of ${t.net}`);
    }
  }
});
