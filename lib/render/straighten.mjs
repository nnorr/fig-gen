// Post-layout straightening of data nets (SPEC §9.4, CONVENTIONS §1.4).
// ELK places nodes and routes edges; this pass then shifts nodes vertically
// (x stays fixed) to remove redundant level changes ("jogs") on data nets,
// re-routing only the terminal segments of the moved nodes' edges, and
// replaces detours between already-aligned pins with straight wires. A move
// is kept only if it lowers the score and keeps the hard constraints: no node
// overlap, no wire through a block, no wire sliding onto another net's wire,
// and no region box growing over a foreign block.

import { crossingCounts, dataJogs, edgeHugging } from './route-metrics.mjs';

const EPS = 0.01;

export function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (let k = out.length - 2; k >= 1; k -= 1) {
    const [a, b, c] = [out[k - 1], out[k], out[k + 1]];
    if ((Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS) || (Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS)) out.splice(k, 1);
  }
  return out;
}

// Move one end of an orthogonal polyline by d vertically, keeping it orthogonal.
export function moveEnd(pts, atStart, d) {
  const p = pts.map((q) => ({ ...q }));
  const i = atStart ? 0 : p.length - 1;
  const j = atStart ? 1 : p.length - 2;
  const horizontal = Math.abs(p[i].y - p[j].y) < EPS;
  if (!horizontal) {
    p[i].y += d;
    return simplify(p);
  }
  if (p.length >= 3) {
    p[i].y += d;
    p[j].y += d;
    return simplify(p);
  }
  const mx = (p[0].x + p[1].x) / 2;
  const moved = { x: p[i].x, y: p[i].y + d };
  return simplify(atStart ? [moved, { x: mx, y: moved.y }, { x: mx, y: p[1].y }, p[1]] : [p[0], { x: mx, y: p[0].y }, { x: mx, y: moved.y }, moved]);
}

const segs = (pts) => pts.slice(1).map((b, k) => ({ a: pts[k], b, h: Math.abs(pts[k].y - b.y) < EPS, v: Math.abs(pts[k].x - b.x) < EPS }));
const rectHit = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

function segThroughRect(a, b, r) {
  const x0 = r.x + 0.5;
  const x1 = r.x + r.w - 0.5;
  const y0 = r.y + 0.5;
  const y1 = r.y + r.h - 0.5;
  return Math.min(a.x, b.x) < x1 && Math.max(a.x, b.x) > x0 && Math.min(a.y, b.y) < y1 && Math.max(a.y, b.y) > y0;
}

function collinearOverlap(s, t) {
  const over = (a0, a1, b0, b1) => Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1)) > 1;
  if (s.h && t.h && Math.abs(s.a.y - t.a.y) < 0.3) return over(s.a.x, s.b.x, t.a.x, t.b.x);
  if (s.v && t.v && Math.abs(s.a.x - t.a.x) < 0.3) return over(s.a.y, s.b.y, t.a.y, t.b.y);
  return false;
}

export function regionBox(nodes, region) {
  const rects = [...region.leaves].map((m) => nodes.get(m)).filter(Boolean);
  for (const c of region.children) {
    const b = regionBox(nodes, c);
    if (b) rects.push(b);
  }
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map((q) => q.x)) - region.pad;
  const y0 = Math.min(...rects.map((q) => q.y)) - region.padTop;
  const x1 = Math.max(...rects.map((q) => q.x + q.w)) + region.pad;
  const y1 = Math.max(...rects.map((q) => q.y + q.h)) + region.pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function regionViolations(state) {
  let count = 0;
  const visit = (r) => {
    const box = regionBox(state.nodes, r);
    if (box) for (const [id, n] of state.nodes) if (!r.inside.has(id) && rectHit(box, n, 0)) count += 1;
    r.children.forEach(visit);
  };
  state.regions.forEach(visit);
  return count;
}

// Returns why an edge route is not acceptable, or null.
function edgeProblem(state, e) {
  for (const s of segs(e.pts)) {
    // A wire may end on its own blocks' borders, never run through them (a
    // terminal run shifted into a top pin from below would cross its block).
    for (const [oid, o] of state.nodes) if (segThroughRect(s.a, s.b, o)) return `wire ${e.id} crosses block ${oid}${oid === e.src || oid === e.dst ? ' (its own end block)' : ''}`;
    for (const f of state.edges) if (f.net !== e.net && segs(f.pts).some((t) => collinearOverlap(s, t))) return `wire ${e.id} runs on top of ${f.id}`;
  }
  return null;
}
const edgeValid = (state, e) => !edgeProblem(state, e);

const DETOUR_CLEARANCE = 6;

// Route another net's wire around a block that now covers it: an interior
// horizontal run moves above or below the block; a run attached to a pin gets
// a detour loop. Returns the new points, or null if no clean detour exists.
function detour(state, f, r) {
  let best = null;
  // A detour steps at least one row pitch away from the wire's level, so it
  // reads as a deliberate route around the block, never as a small jog.
  const level = f.pts.find((p, i) => i < f.pts.length - 1 && Math.abs(p.y - f.pts[i + 1].y) < EPS && segThroughRect(p, f.pts[i + 1], r))?.y ?? f.pts[0].y;
  const step = state.minOffsetPt ?? 12;
  for (const y2 of [Math.min(r.y - DETOUR_CLEARANCE, level - step), Math.max(r.y + r.h + DETOUR_CLEARANCE, level + step)]) {
    let pts = f.pts.map((p) => ({ ...p }));
    for (let guard = 0; guard < 6; guard += 1) {
      const k = pts.findIndex((a, i) => i < pts.length - 1 && Math.abs(a.y - pts[i + 1].y) < EPS && segThroughRect(a, pts[i + 1], r));
      if (k < 0) break;
      const a = pts[k];
      const b = pts[k + 1];
      if (k > 0 && k + 1 < pts.length - 1) {
        a.y = y2;
        b.y = y2;
      } else {
        const dir = Math.sign(b.x - a.x) || 1;
        const clamp = (x) => (dir > 0 ? Math.min(Math.max(x, a.x), b.x) : Math.max(Math.min(x, a.x), b.x));
        const entry = clamp(dir > 0 ? r.x - DETOUR_CLEARANCE : r.x + r.w + DETOUR_CLEARANCE);
        const exit = clamp(dir > 0 ? r.x + r.w + DETOUR_CLEARANCE : r.x - DETOUR_CLEARANCE);
        pts.splice(k + 1, 0, { x: entry, y: a.y }, { x: entry, y: y2 }, { x: exit, y: y2 }, { x: exit, y: b.y });
      }
      pts = simplify(pts);
    }
    if (segs(pts).some((s) => segThroughRect(s.a, s.b, r))) continue;
    if (edgeProblem(state, { ...f, pts })) continue;
    if (!best || pts.length < best.length) best = pts;
  }
  return best;
}

// Returns why moving node `id` left an invalid state, or null. Wires of other
// nets that the moved block now covers are detoured (mutating `state`).
function nodeProblem(state, id, gap) {
  const n = state.nodes.get(id);
  for (const [oid, o] of state.nodes) if (oid !== id && rectHit(n, o, gap)) return `overlaps block ${oid}`;
  for (const f of state.edges) {
    if (f.src === id || f.dst === id || !segs(f.pts).some((s) => segThroughRect(s.a, s.b, n))) continue;
    const rerouted = detour(state, f, n);
    if (!rerouted) return `block now covers wire ${f.id}`;
    f.pts = rerouted;
  }
  for (const e of state.edges.filter((x) => x.src === id || x.dst === id)) {
    const p = edgeProblem(state, e);
    if (p) return p;
  }
  return regionViolations(state) > state.baseRegionViolations ? 'region frame would enclose a foreign block' : null;
}

// Block rects for edge-hugging (port label nodes are text, not outlines).
const hugRects = (nodes) => (nodes ? [...nodes].filter(([, n]) => !n.port).map(([id, n]) => ({ id, x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h })) : []);

export function routeScore(edges, minOffsetPt, crossingWeight = 200, nodes = null) {
  const nets = new Map();
  for (const e of edges) {
    if (!nets.has(e.net)) nets.set(e.net, { id: e.net, cls: e.cls, finePitch: false, polylines: [] });
    nets.get(e.net).polylines.push(e.pts);
    if (e.finePitch) nets.get(e.net).finePitch = true;
  }
  const list = [...nets.values()];
  const jogs = dataJogs(list, { minOffsetPt });
  const crossings = crossingCounts(list).counts;
  const bends = list.reduce((a, n) => a + n.polylines.reduce((b, p) => b + Math.max(0, p.length - 2), 0), 0);
  // Vertical travel of data wires: a long detour must not look cheaper than
  // a clean alignment elsewhere.
  const dataRise = list.filter((n) => n.cls === 'data').reduce((a, n) => a + n.polylines.reduce((b, p) => b + p.slice(1).reduce((c, q, k) => c + Math.abs(q.y - p[k].y), 0), 0), 0);
  // A redundant jog is an error (1000); a crossing costs a reader more than a
  // bend, so it outweighs several bends but never an error.
  // A wire hugging an outline or another wire is an error-level defect too.
  const hug = nodes ? edgeHugging(list, hugRects(nodes)).length : 0;
  return { value: jogs.redundant * 1000 + hug * 400 + crossings.total * crossingWeight + bends + dataRise * 5, redundant: jogs.redundant, straight: jogs.straight, total: jogs.total, crossings, bends, dataRise, hug };
}

// Port nodes wired only to `id` on its input ('up') or output ('down') side.
function portNeighbours(state, id, dir) {
  const ids = state.edges.filter((f) => (dir === 'up' ? f.dst === id : f.src === id)).map((f) => (dir === 'up' ? f.src : f.dst));
  return [...new Set(ids)].filter((p) => state.nodes.get(p)?.port && state.edges.every((f) => (f.src !== p && f.dst !== p) || f.src === id || f.dst === id));
}

function candidates(state, minOffsetPt) {
  const out = [];
  // Channel moves: an interior segment (bends at both ends) that hugs a block
  // outline or another wire may slide sideways within its neighbours' reach.
  const rects = hugRects(state.nodes);
  const near = (v, list) => list.some((x) => Math.abs(v - x) < 4);
  const xs = [...rects.flatMap((r) => [r.x0, r.x1])];
  const ys = [...rects.flatMap((r) => [r.y0, r.y1])];
  for (const e of state.edges) {
    const p = e.pts;
    for (let k = 1; k + 2 < p.length; k += 1) {
      const vertical = Math.abs(p[k].x - p[k + 1].x) < EPS;
      const pos = vertical ? p[k].x : p[k].y;
      const others = state.edges.filter((f) => f.net !== e.net).flatMap((f) => segs(f.pts).filter((s) => (vertical ? s.v : s.h)).map((s) => (vertical ? s.a.x : s.a.y)));
      if (!near(pos, vertical ? xs : ys) && !near(pos, others)) continue;
      const lo = Math.min(vertical ? p[k - 1].x : p[k - 1].y, vertical ? p[k + 2].x : p[k + 2].y) + 1;
      const hi = Math.max(vertical ? p[k - 1].x : p[k - 1].y, vertical ? p[k + 2].x : p[k + 2].y) - 1;
      for (let v = lo; v <= hi; v += 1) if (Math.abs(v - pos) >= 1) out.push({ edge: e.id, seg: k, [vertical ? 'x' : 'y']: v });
    }
  }
  const fanout = new Map();
  for (const e of state.edges) fanout.set(e.net, (fanout.get(e.net) || 0) + 1);
  for (const e of state.edges) {
    if (e.cls !== 'data' || e.pts.length < 2) continue;
    const a = e.pts[0];
    const b = e.pts[e.pts.length - 1];
    const d = a.y - b.y;
    if (b.x <= a.x) continue;
    // Full-row level changes on a single-sink data trunk are not accepted as
    // given: try moving either end block into line (up to four rows).
    if (fanout.get(e.net) === 1 && Math.abs(d) >= minOffsetPt && Math.abs(d) <= 4 * minOffsetPt) out.push({ node: e.dst, d }, { node: e.src, d: -d });
    // A block moves together with the figure ports on its far side, which
    // float freely (e.g. a concatenation and the two input ports feeding it).
    if (Math.abs(d) > EPS) {
      const ups = portNeighbours(state, e.src, 'up');
      const downs = portNeighbours(state, e.dst, 'down');
      if (ups.length) out.push({ group: [e.src, ...ups], d: -d });
      if (downs.length) out.push({ group: [e.dst, ...downs], d });
    }
    if (Math.abs(d) < EPS) {
      if (e.pts.length > 2) out.push({ edge: e.id });
      continue;
    }
    // A level change split into several small steps (ELK may route a
    // full-row branch as 2 pt + 10 pt) collapses into one bend at one of the
    // existing bend positions.
    const verticals = segs(e.pts).filter((s) => s.v);
    if (verticals.length >= 2) {
      // existing bend positions first, then a 2 pt sweep across the gap for a
      // channel that no other net's vertical wire occupies
      const xs = new Set(verticals.map((s) => s.a.x));
      for (let x = Math.min(a.x, b.x) + 2; x < Math.max(a.x, b.x) - 2; x += 2) xs.add(Math.round(x * 2) / 2);
      for (const x of xs) out.push({ edge: e.id, bendX: x });
    }
    if (Math.abs(d) >= minOffsetPt) continue;
    out.push({ node: e.dst, d }, { node: e.src, d: -d });
    // ...or move the sink a whole row off, turning the jog into a legitimate
    // cross-row bend (e.g. a block sitting on another net's trunk).
    const row = Math.sign(-d || 1) * minOffsetPt;
    out.push({ node: e.dst, d: d + row }, { node: e.dst, d: d - row });
    // ...or move the sink together with the blocks that drive its other data
    // inputs (a mux and the XOR feeding its second input), so both inputs
    // stay aligned.
    const partners = [...new Set(state.edges.filter((f) => f.cls === 'data' && f.dst === e.dst && f.src !== e.src && f.id !== e.id).map((f) => f.src))];
    if (partners.length) out.push({ group: [e.dst, ...partners], d });
  }
  for (const [id, phase] of state.pinPhase || []) {
    const n = state.nodes.get(id);
    if (!n) continue;
    const off = (((n.y + phase - minOffsetPt / 2) % minOffsetPt) + minOffsetPt) % minOffsetPt;
    const d = off <= minOffsetPt / 2 ? -off : minOffsetPt - off;
    if (Math.abs(d) > EPS && Math.abs(d) <= 3) out.push({ node: id, d, snap: true });
  }
  return out;
}

const cloneState = (s) => ({ ...s, nodes: new Map([...s.nodes].map(([k, v]) => [k, { ...v }])), edges: s.edges.map((e) => ({ ...e, pts: e.pts.map((p) => ({ ...p })) })) });

// nodes: Map(id -> {x, y, w, h}); edges: [{id, net, cls, src, dst, pts}];
// regions: tree [{id, leaves:Set, children:[...], inside:Set, pad, padTop}]
// maxEvaluations bounds the search deterministically: once that many candidate
// layouts have been scored, the best route found so far is kept and the result
// says the budget was exhausted (large study figures would otherwise take minutes).
export function straighten({ nodes, edges, regions = [], movable = () => true, pinPhase = new Map() }, { minOffsetPt = 12, gap = 2, maxPasses = 40, crossingWeight = 200, onReject, maxEvaluations = Infinity } = {}) {
  let state = { nodes: new Map([...nodes].map(([k, v]) => [k, { ...v }])), edges: edges.map((e) => ({ ...e, pts: simplify(e.pts) })), regions, minOffsetPt };
  state.baseRegionViolations = regionViolations(state);
  const before = routeScore(state.edges, minOffsetPt, crossingWeight, state.nodes);
  // ELK can leave nodes a point or two off the shared pin grid (pitch/2 +
  // k·pitch). Snapping back is offered as an ordinary candidate, kept only
  // when it lowers the score (a forced snap misaligns single-pin neighbours).
  state.pinPhase = pinPhase;
  let current = before;
  const moves = [];
  // Apply one candidate to a copy of `from`; returns the new state or null.
  const apply = (from, c, report) => {
    const next = cloneState(from);
    if (c.seg !== undefined) {
      // Branches of one net share trunk segments: move every interior segment
      // of the net at the same position together, so the trunk stays one wire.
      const e0 = next.edges.find((x) => x.id === c.edge);
      const vertical = c.x !== undefined;
      const from0 = vertical ? e0.pts[c.seg].x : e0.pts[c.seg].y;
      const moved = [];
      for (const e of next.edges.filter((x) => x.net === e0.net)) {
        for (let k = 1; k + 2 < e.pts.length; k += 1) {
          const [p, q] = [e.pts[k], e.pts[k + 1]];
          if (vertical ? Math.abs(p.x - q.x) < EPS && Math.abs(p.x - from0) < EPS : Math.abs(p.y - q.y) < EPS && Math.abs(p.y - from0) < EPS) {
            if (vertical) { p.x = c.x; q.x = c.x; } else { p.y = c.y; q.y = c.y; }
            moved.push(e);
          }
        }
      }
      for (const e of moved) {
        e.pts = simplify(e.pts);
        const blocker = [...next.nodes].find(([oid, o]) => oid !== e.src && oid !== e.dst && segs(e.pts).some((s) => segThroughRect(s.a, s.b, o)));
        if (blocker) { report?.(c, `channel move of ${e.id} crosses ${blocker[0]}`); return null; }
        const problem = edgeProblem(next, e);
        if (problem) { report?.(c, problem); return null; }
      }
      return next;
    }
    if (c.edge) {
      const e = next.edges.find((x) => x.id === c.edge);
      const [a, b] = [e.pts[0], e.pts[e.pts.length - 1]];
      e.pts = c.bendX === undefined ? [a, b] : simplify([a, { x: c.bendX, y: a.y }, { x: c.bendX, y: b.y }, b]);
      const blocker = [...next.nodes].find(([oid, o]) => oid !== e.src && oid !== e.dst && segs(e.pts).some((s) => segThroughRect(s.a, s.b, o)));
      if (blocker && c.bendX !== undefined) { report?.(c, `single-bend route of ${e.id} blocked by ${blocker[0]}`); return null; }
      if (blocker) {
        // A straight wire blocked by a block becomes a full-pitch detour around it.
        const rerouted = detour(next, e, blocker[1]);
        if (!rerouted) { report?.(c, `straight wire ${e.id} blocked by ${blocker[0]}, no detour`); return null; }
        e.pts = rerouted;
      }
      const problem = edgeProblem(next, e);
      if (problem) { report?.(c, problem); return null; }
    } else {
      const group = c.group ?? [c.node];
      if (!group.every((id) => movable(id) && next.nodes.has(id))) return null;
      for (const id of group) shiftNode(next, id, c.d);
      for (const id of group) {
        const problem = nodeProblem(next, id, gap);
        if (problem) { report?.(c, problem); return null; }
      }
    }
    return next;
  };
  let evaluations = 0;
  let exhausted = false;
  const scoreOf = (s) => { evaluations += 1; return routeScore(s.edges, minOffsetPt, crossingWeight, s.nodes); };
  for (let pass = 0; pass < maxPasses && !exhausted; pass += 1) {
    let best = null;
    for (const c of candidates(state, minOffsetPt)) {
      if (evaluations >= maxEvaluations) { exhausted = true; break; }
      const next = apply(state, c, onReject);
      if (!next) continue;
      const score = scoreOf(next);
      if (score.value >= current.value - 1e-6) onReject?.(c, 'no-improvement', { redundant: score.redundant, crossings: score.crossings.total, bends: score.bends });
      if (score.value < current.value - 1e-6 && (!best || score.value < best.score.value)) best = { next, score, c };
    }
    if (!exhausted) {
      // Bounded two-step lookahead on every pass: some fixes need two moves
      // (e.g. lift a mux and its XOR together), and a greedy single move can
      // otherwise win now and block the better pair later.
      const firsts = candidates(state, minOffsetPt).slice(0, 24);
      for (const c1 of firsts) {
        const s1 = apply(state, c1);
        if (!s1) continue;
        for (const c2 of candidates(s1, minOffsetPt).slice(0, 24)) {
          if (evaluations >= maxEvaluations) { exhausted = true; break; }
          const s2 = apply(s1, c2);
          if (!s2) continue;
          const score = scoreOf(s2);
          if (score.value < current.value - 1e-6 && (!best || score.value < best.score.value)) best = { next: s2, score, c: [c1, c2] };
        }
      }
    }
    if (!best) break;
    state = best.next;
    current = best.score;
    moves.push(...[best.c].flat());
  }
  return { nodes: state.nodes, edges: state.edges, before, after: current, moves, evaluations, exhausted };
}

function shiftNode(state, id, d) {
  state.nodes.get(id).y += d;
  for (const e of state.edges) {
    if (e.src === id) e.pts = moveEnd(e.pts, true, d);
    if (e.dst === id) e.pts = moveEnd(e.pts, false, d);
  }
}

// Justification of every remaining bend on a data wire (SPEC §9.4). A bend is
// unavoidable only for a fan-out branch to another row, feedback, gate pin
// pitch, or a straight path that no vertical move of either end block can
// clear; each attempt and why it failed is reported. Otherwise it is avoidable.
export function justifyBends({ nodes, edges, regions = [] }, { minOffsetPt = 12, gap = 2, crossingWeight = 200 } = {}) {
  const state = { nodes: new Map([...nodes].map(([k, v]) => [k, { ...v }])), edges: edges.map((e) => ({ ...e, pts: e.pts.map((p) => ({ ...p })) })), regions, minOffsetPt };
  state.baseRegionViolations = regionViolations(state);
  const base = routeScore(state.edges, minOffsetPt, crossingWeight, state.nodes);
  const fanout = new Map();
  for (const e of state.edges) fanout.set(e.net, (fanout.get(e.net) || 0) + 1);
  const delta = (s) => [s.redundant - base.redundant && `${s.redundant - base.redundant > 0 ? "+" : ""}${s.redundant - base.redundant} jogs`, s.hug - base.hug && `${s.hug - base.hug > 0 ? "+" : ""}${s.hug - base.hug} hugging wires`, s.crossings.total - base.crossings.total && `${s.crossings.total - base.crossings.total > 0 ? "+" : ""}${s.crossings.total - base.crossings.total} crossings`, s.bends - base.bends && `${s.bends - base.bends > 0 ? "+" : ""}${s.bends - base.bends} bends`].filter(Boolean).join(", ") || "no gain";
  const out = [];
  for (const e of state.edges) {
    if (e.cls !== "data") continue;
    const rises = segs(e.pts).filter((q) => q.v && Math.abs(q.b.y - q.a.y) > EPS);
    if (!rises.length) continue;
    const a = e.pts[0];
    const b = e.pts[e.pts.length - 1];
    const dy = a.y - b.y;
    const item = { edge: e.id, net: e.net, bends: rises.length };
    if (e.finePitch) { out.push({ ...item, reason: "gate pin pitch" }); continue; }
    if (b.x < a.x - EPS) { out.push({ ...item, reason: "feedback" }); continue; }
    // One bend that turns into a pin on a top or bottom edge (a side input).
    const first = segs(e.pts)[0];
    const last = segs(e.pts).at(-1);
    if (rises.length === 1 && last.v && !first.v) { out.push({ ...item, reason: "turn into a pin on a top or bottom edge" }); continue; }
    // A fan-out branch is justified only when its sink sits on another row
    // (at least one pitch away); a smaller offset is a misaligned lane.
    if ((fanout.get(e.net) || 0) > 1 && Math.abs(dy) >= minOffsetPt - EPS) { out.push({ ...item, reason: `fan-out branch to another row (${Math.abs(dy).toFixed(0)} pt)` }); continue; }
    const tries = Math.abs(dy) < EPS ? [{ straight: true }] : [{ node: e.dst, d: dy }, { node: e.src, d: -dy }];
    const ups = portNeighbours(state, e.src, "up");
    if (Math.abs(dy) > EPS && ups.length) tries.push({ node: e.src, group: ups, d: -dy });
    const notes = [];
    let avoidable = false;
    for (const c of tries) {
      const next = cloneState(state);
      const x = next.edges.find((q) => q.id === e.id);
      let problem = null;
      if (c.straight) {
        x.pts = [{ ...a }, { ...b }];
        const blocker = [...next.nodes].find(([oid, o]) => oid !== x.src && oid !== x.dst && segs(x.pts).some((s) => segThroughRect(s.a, s.b, o)));
        problem = blocker ? `straight path blocked by ${blocker[0]}` : edgeProblem(next, x);
      } else {
        for (const id of [c.node, ...(c.group || [])]) shiftNode(next, id, c.d);
        for (const id of [c.node, ...(c.group || [])]) problem = problem || nodeProblem(next, id, gap);
      }
      const what = c.straight ? "straight route" : `moving ${[c.node, ...(c.group || [])].join(" + ")} ${c.d > 0 ? "down" : "up"} ${Math.abs(c.d).toFixed(0)} pt`;
      if (problem) { notes.push(`${what}: ${problem}`); continue; }
      const s = routeScore(next.edges, minOffsetPt, crossingWeight, next.nodes);
      if (s.value < base.value - 1e-6) { avoidable = true; notes.push(`${what} would clear it (${delta(s)})`); break; }
      notes.push(`${what} would cost ${delta(s)}`);
    }
    out.push({ ...item, avoidable, reason: avoidable ? null : `blocked: ${notes.join("; ")}`, attempts: notes });
  }
  return out;
}
