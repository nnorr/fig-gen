// Serpentine FSM layout: a long, mostly linear machine snakes in rows across
// the column with its own orthogonal routing (skip, back, cross-row, any-state
// and recovery arcs on their own tracks), verified on the final SVG; a split
// into linked sub-figures is suggested when nothing fits; collapsed super-states
// are covered by the RTL cross-check.

import assert from 'node:assert/strict';
import test from 'node:test';
import { expandCollapsed } from '../lib/checks/fsm.mjs';
import { crosscheckFsm } from '../lib/checks/fsm-crosscheck.mjs';
import { parseGuard as rtlGuard } from '../lib/checks/fsm-crosscheck.mjs';
import { dominantChain, renderFsm, serpentineRows } from '../lib/render/fsm.mjs';
import { validateSchema } from '../lib/validate.mjs';

const ids = Array.from({ length: 11 }, (_, i) => `S_${String.fromCharCode(65 + i)}`);

// An 11-state chain with a skip arc, a back arc, an any-state override and a
// default-recovery arc.
function chain() {
  return {
    schema_version: 1, figure_type: 'fsm',
    meta: { title: 'Long chain', print: { profile: 'ieee' } },
    machine: { name: 'chain.state_q', state_width: 4, encoding: 'binary', kind: 'moore', default: 'hold', show_default_recovery: true },
    inputs: [{ name: 'step', width: 1 }, { name: 'skip', width: 1 }, { name: 'abort', width: 1 }, { name: 'soft_reset', width: 1 }],
    outputs: [],
    reset: { state: ids[0], condition: '!rst_n', async: true },
    states: ids.map((id, i) => ({ id, encoding: `4'd${i}` })),
    transitions: [
      ...ids.slice(0, -1).map((id, i) => ({ id: `c${i}`, from: id, to: ids[i + 1], guard: 'step' })),
      { id: 'skip1', from: ids[1], to: ids[8], guard: 'skip && !step' },
      { id: 'back', from: ids[10], to: ids[0], guard: 'abort' },
      { id: 'soft', from: '*', to: ids[0], guard: 'soft_reset', style: 'any_state' },
      { id: 'rec', from: '*', to: ids[9], recovery: true },
    ],
  };
}

// State rectangles, arc polylines and arrowheads parsed from the SVG.
function geometry(svg) {
  const n = Number;
  const states = [...svg.matchAll(/<rect id="fsm-state-([A-Za-z0-9_]+)-body" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .map((m) => ({ id: m[1], x0: n(m[2]), y0: n(m[3]), x1: n(m[2]) + n(m[4]), y1: n(m[3]) + n(m[5]) }));
  const pts = (d) => [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({ x: n(m[1]), y: n(m[2]) }));
  const arcs = [...svg.matchAll(/<path id="(fsm-(?:edge-[A-Za-z0-9_]+|reset))-seg0" d="([^"]+)"/g)].map((m) => ({ id: m[1], pts: pts(m[2]) }));
  const heads = [...svg.matchAll(/<path id="(fsm-(?:edge-[A-Za-z0-9_]+|reset))-arrow" d="([^"]+)"/g)].map((m) => ({ id: m[1], pts: pts(m[2]) }));
  return { states, arcs, heads };
}
const onRect = (p, r, tol = 0.35) => p.x >= r.x0 - tol && p.x <= r.x1 + tol && p.y >= r.y0 - tol && p.y <= r.y1 + tol
  && Math.min(Math.abs(p.x - r.x0), Math.abs(p.x - r.x1), Math.abs(p.y - r.y0), Math.abs(p.y - r.y1)) <= tol;

test('dominantChain: the longest path from reset over main-flow arcs; states off the chain follow a neighbour', () => {
  const doc = chain();
  assert.deepEqual(dominantChain(doc).chain, ids);
  doc.states.push({ id: 'S_X', encoding: "4'd11" });
  doc.transitions.push({ id: 'x0', from: ids[3], to: 'S_X', guard: 'abort' });
  const { chain: path, sequence } = dominantChain(doc);
  assert.deepEqual(path, ids, 'any-state, recovery and side arcs do not lengthen the chain');
  assert.equal(sequence.indexOf('S_X'), sequence.indexOf(ids[3]) + 1);
});

test('serpentineRows: rows fill the usable width, then snake with the next box under the previous one', () => {
  // boxes 40 wide with 20 pt gaps: three fit in 200 pt (0, 60, 120), the fourth starts row 1
  const rows = serpentineRows([40, 40, 40, 40, 40], [20, 20, 20, 20], [12, 12, 12, 12], 200);
  assert.deepEqual(rows.map((r) => r.items.map((it) => it.index)), [[0, 1, 2], [3, 4]]);
  assert.deepEqual(rows.map((r) => r.dir), [1, -1]);
  for (const r of rows) for (const it of r.items) assert.ok(it.x >= -0.01 && it.x + 40 <= 200.01);
  // the row break box sits under the previous row's last box, shifted inward by the jog
  assert.equal(rows[1].items[0].x, rows[0].items.at(-1).x - 12);
  assert.equal(serpentineRows([250], [], [], 200), null, 'a box wider than the column');
});

test('a long chain delivers 2col in serpentine rows: every arc on its target, no arc through a state, no shared runs', async () => {
  const doc = chain();
  assert.deepEqual(await validateSchema('fsm', doc), []);
  const r = await renderFsm(doc, { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, name: 'chain' });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`), []);
  assert.equal(r.layout.direction, 'serpentine rows');
  assert.ok(r.layout.rows.length >= 2);
  assert.ok(r.width_pt <= 515.5 + 0.01 && r.height_pt <= 230.4 + 0.01);
  const g = geometry(r.svg);
  const edgeIds = g.arcs.filter((a) => a.id.startsWith('fsm-edge-')).map((a) => a.id.slice(9));
  assert.deepEqual(edgeIds.sort(), doc.transitions.map((t) => t.id).sort(), 'every transition drawn once');
  const targetOf = (id) => (id === 'fsm-reset' ? doc.reset.state : doc.transitions.find((t) => `fsm-edge-${t.id}` === id).to);
  for (const h of g.heads) assert.ok(onRect(h.pts[1], g.states.find((s) => s.id === targetOf(h.id))), `${h.id} ends on its target`);
  // no two arcs share a collinear run
  const segs = g.arcs.flatMap((a) => a.pts.slice(1).map((b, i) => ({ id: a.id, a: a.pts[i], b })));
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const [u, v] = [segs[i], segs[j]];
      if (u.id === v.id) continue;
      const horiz = (s) => Math.abs(s.a.y - s.b.y) < 0.01;
      const vert = (s) => Math.abs(s.a.x - s.b.x) < 0.01;
      let overlap = 0;
      if (horiz(u) && horiz(v) && Math.abs(u.a.y - v.a.y) < 0.3) overlap = Math.min(Math.max(u.a.x, u.b.x), Math.max(v.a.x, v.b.x)) - Math.max(Math.min(u.a.x, u.b.x), Math.min(v.a.x, v.b.x));
      if (vert(u) && vert(v) && Math.abs(u.a.x - v.a.x) < 0.3) overlap = Math.min(Math.max(u.a.y, u.b.y), Math.max(v.a.y, v.b.y)) - Math.max(Math.min(u.a.y, u.b.y), Math.min(v.a.y, v.b.y));
      assert.ok(overlap <= 0.5, `${u.id} and ${v.id} share a run`);
    }
  }
  // no arc crosses a state it does not start or end at
  for (const a of g.arcs) {
    const t = doc.transitions.find((x) => `fsm-edge-${x.id}` === a.id);
    for (const s of g.states) {
      if (t && (s.id === t.from || s.id === t.to)) continue;
      if (a.id === 'fsm-reset' && s.id === doc.reset.state) continue;
      for (let k = 1; k < a.pts.length; k += 1) {
        const [p, q] = [a.pts[k - 1], a.pts[k]];
        const inside = (x, lo, hi) => x > lo + 0.75 && x < hi - 0.75;
        const hit = Math.abs(p.y - q.y) < 0.01
          ? inside(p.y, s.y0, s.y1) && Math.min(p.x, q.x) < s.x1 - 0.75 && Math.max(p.x, q.x) > s.x0 + 0.75
          : inside(p.x, s.x0, s.x1) && Math.min(p.y, q.y) < s.y1 - 0.75 && Math.max(p.y, q.y) > s.y0 + 0.75;
        assert.ok(!hit, `${a.id} crosses ${s.id}`);
      }
    }
  }
  assert.match(r.svg, /<path id="fsm-edge-rec-seg0"[^>]*stroke-dasharray/);
});

test('a split into linked sub-figures is suggested when no plan fits', async () => {
  const doc = chain();
  const r = await renderFsm(doc, { variant: '2col', widthPt: 515.5, maxHeightPt: 90, name: 'tight' });
  assert.ok(r.diagnostics.some((d) => d.severity === 'error' && /print\/(max-height|width-overflow)/.test(d.code)));
  const split = r.diagnostics.find((d) => d.code === 'fsm/split-suggested');
  assert.ok(split, 'split suggested');
  assert.ok(split.evidence.groups.length >= 2);
  assert.deepEqual(split.evidence.groups.flatMap((g) => g.states), dominantChain(doc).sequence, 'groups are consecutive runs of the sequence');
});

test('a collapsed super-state stands for its members in the RTL cross-check', async () => {
  // RTL: A -> B -> C -> D -> A; the figure collapses B and C into one state with a detail figure.
  const netlist = {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'm', diagnostics: [], hierarchy: [{ path: 'm', module: 'm' }],
    modules: [{
      name: 'm', orig_name: 'm', ports: [], instances: [], registers: [],
      nets: [{ name: 'go', width: 1, kind: 'wire' }, { name: 'state_q', width: 2, kind: 'var' }],
      fsms: [{
        register: 'state_q', next: null, width: 2, encoding_source: 'localparam',
        states: [{ name: 'A', value: "2'h0" }, { name: 'B', value: "2'h1" }, { name: 'C', value: "2'h2" }, { name: 'D', value: "2'h3" }],
        reset: { state: 'A', net: 'rst_n', active: 'low', async: true },
        transitions: [
          { id: 'r0', from: 'A', to: 'B', guard: rtlGuard('go').ast, priority: 0 },
          { id: 'r1', from: 'B', to: 'C', guard: null, priority: 0 },
          { id: 'r2', from: 'C', to: 'D', guard: null, priority: 0 },
          { id: 'r3', from: 'D', to: 'A', guard: null, priority: 0 },
        ],
        default: { kind: 'hold' },
      }],
    }],
  };
  const doc = {
    schema_version: 1, figure_type: 'fsm', meta: { title: 'Collapsed', print: { profile: 'ieee' } },
    machine: { name: 'm.state_q', state_width: 2, encoding: 'binary', rtl: { module: 'm', state_register: 'state_q' } },
    inputs: [{ name: 'go', width: 1 }], outputs: [],
    reset: { state: 'A', condition: '!rst_n', async: true },
    states: [
      { id: 'A', encoding: "2'h0" },
      { id: 'BC', label: 'Body', collapsed: { members: ['B', 'C'] }, detail_ref: { figure: 'body.fsm.json' } },
      { id: 'D', encoding: "2'h3" },
    ],
    transitions: [
      { id: 't0', from: 'A', to: 'BC', guard: 'go' },
      { id: 't1', from: 'BC', to: 'D' },
      { id: 't2', from: 'D', to: 'A' },
    ],
  };
  assert.deepEqual(await validateSchema('fsm', doc), []);
  const expanded = expandCollapsed(doc);
  assert.deepEqual(expanded.states.map((s) => s.id), ['A', 'B', 'C', 'D']);
  assert.deepEqual(expanded.transitions.map((t) => `${t.from}>${t.to}`), ['A>B', 'C>D', 'D>A']);
  const cc = crosscheckFsm(doc, netlist);
  assert.deepEqual(cc.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`), []);
  // without the collapse, the undrawn states and the internal transition are errors
  const plain = structuredClone(doc);
  plain.states[1] = { id: 'BC', label: 'Body' };
  assert.ok(crosscheckFsm(plain, netlist).diagnostics.some((d) => d.code === 'fsm/undrawn-state' || d.code === 'fsm/rtl-state-missing'));
});
