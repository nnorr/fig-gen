// Routing quality metrics shared by the renderer checks and the before/after
// report script (SPEC §9.4): wire crossings per net class, redundant jogs on
// data nets, and text boxes touching any drawn line (wires, frames, outlines).

const EPS = 0.05;

export function segmentsOfPolyline(pts) {
  const out = [];
  for (let k = 1; k < pts.length; k += 1) {
    const a = pts[k - 1];
    const b = pts[k];
    if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) continue;
    out.push({ a, b, horizontal: Math.abs(a.y - b.y) < EPS, vertical: Math.abs(a.x - b.x) < EPS });
  }
  return out;
}

// nets: [{ id, cls: 'data'|'control'|'clock'|'reset', polylines: [[{x,y}]] }]
export function crossingCounts(nets) {
  const segs = nets.flatMap((n) => n.polylines.flatMap((pl) => segmentsOfPolyline(pl).map((s) => ({ ...s, net: n.id, cls: n.cls === 'data' ? 'data' : 'control' }))));
  const seen = new Set();
  const counts = { data: 0, control: 0, mixed: 0, total: 0 };
  const pairs = [];
  for (const h of segs.filter((s) => s.horizontal)) {
    const hx0 = Math.min(h.a.x, h.b.x);
    const hx1 = Math.max(h.a.x, h.b.x);
    for (const v of segs.filter((s) => s.vertical && s.net !== h.net)) {
      const vy0 = Math.min(v.a.y, v.b.y);
      const vy1 = Math.max(v.a.y, v.b.y);
      const x = v.a.x;
      const y = h.a.y;
      // strictly interior on both segments: a T-junction or shared endpoint is not a crossing
      if (!(x > hx0 + 0.5 && x < hx1 - 0.5 && y > vy0 + 0.5 && y < vy1 - 0.5)) continue;
      const key = `${[h.net, v.net].sort().join('|')}@${x.toFixed(1)},${y.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cls = h.cls === 'data' && v.cls === 'data' ? 'data' : h.cls === 'control' && v.cls === 'control' ? 'control' : 'mixed';
      counts[cls] += 1;
      counts.total += 1;
      pairs.push({ nets: [h.net, v.net], x, y, cls });
    }
  }
  return { counts, pairs };
}

// Data-net jogs (SPEC §9.4, CONVENTIONS "straight data trunks"): a vertical
// step shorter than `minOffsetPt` between two same-direction horizontal runs
// is a redundant level change. Longer steps are unavoidable routing, reported
// with a reason.
export function dataJogs(nets, { minOffsetPt = 12 } = {}) {
  const jogs = [];
  let straight = 0;
  const data = nets.filter((n) => n.cls === 'data');
  for (const n of data) {
    let netStraight = true;
    const branches = n.polylines.length;
    for (const pl of n.polylines) {
      const segs = segmentsOfPolyline(pl);
      const first = pl[0];
      const last = pl[pl.length - 1];
      const feedback = last.x < first.x - EPS;
      segs.forEach((s, k) => {
        if (!s.vertical) return;
        netStraight = false;
        const len = Math.abs(s.b.y - s.a.y);
        const prev = segs[k - 1];
        const next = segs[k + 1];
        const sameDir = prev?.horizontal && next?.horizontal && Math.sign(prev.b.x - prev.a.x) === Math.sign(next.b.x - next.a.x);
        const at = { x: s.a.x, y: Math.min(s.a.y, s.b.y) };
        // Nets touching gate-level symbols (pin pitch below the grid) cannot
        // keep every step a full pitch; their small steps are not redundant.
        if (len < minOffsetPt && sameDir && !feedback && !n.finePitch) jogs.push({ net: n.id, kind: 'redundant', offset: len, at });
        else jogs.push({ net: n.id, kind: 'unavoidable', offset: len, at, reason: feedback ? 'feedback' : n.finePitch && len < minOffsetPt ? 'gate pin pitch' : branches > 1 ? 'fan-out branch' : len >= minOffsetPt ? 'cross-row' : 'turn' });
      });
    }
    if (netStraight) straight += 1;
  }
  return { straight, total: data.length, redundant: jogs.filter((j) => j.kind === 'redundant').length, unavoidable: jogs.filter((j) => j.kind === 'unavoidable').length, jogs };
}

// Edge hugging (SPEC §9.4): a wire running parallel to a block outline, or to
// another net's wire, closer than minGap over more than minOverlap reads as
// part of the outline or as one wire. rects: [{id, x0, y0, x1, y1}].
export function edgeHugging(nets, rects, { minGap = 4, minOverlap = 3 } = {}) {
  const segList = nets.flatMap((n) => n.polylines.flatMap((pl) => segmentsOfPolyline(pl).map((s) => ({ ...s, net: n.id }))));
  const overlapLen = (a0, a1, b0, b1) => Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hits = new Map();
  const add = (h) => {
    const key = `${h.net}|${h.kind}|${h.other}|${h.gap.toFixed(1)}`;
    if (!hits.has(key)) hits.set(key, h);
  };
  for (const s of segList) {
    for (const r of rects) {
      if (s.vertical && overlapLen(s.a.y, s.b.y, r.y0, r.y1) > minOverlap) {
        for (const ex of [r.x0, r.x1]) {
          const gap = Math.abs(s.a.x - ex);
          if (gap < minGap) add({ net: s.net, kind: 'block', other: r.id, gap, at: { x: s.a.x, y: Math.max(Math.min(s.a.y, s.b.y), r.y0) } });
        }
      } else if (s.horizontal && overlapLen(s.a.x, s.b.x, r.x0, r.x1) > minOverlap) {
        for (const ey of [r.y0, r.y1]) {
          const gap = Math.abs(s.a.y - ey);
          if (gap < minGap) add({ net: s.net, kind: 'block', other: r.id, gap, at: { x: Math.max(Math.min(s.a.x, s.b.x), r.x0), y: s.a.y } });
        }
      }
    }
  }
  for (let i = 0; i < segList.length; i += 1) {
    for (let j = i + 1; j < segList.length; j += 1) {
      const [s, u] = [segList[i], segList[j]];
      if (s.net === u.net) continue;
      if (s.vertical && u.vertical) {
        const gap = Math.abs(s.a.x - u.a.x);
        if (gap > 0.3 && gap < minGap && overlapLen(s.a.y, s.b.y, u.a.y, u.b.y) > minOverlap) add({ net: s.net, kind: 'wire', other: u.net, gap, at: { x: s.a.x, y: Math.min(s.a.y, s.b.y) } });
      } else if (s.horizontal && u.horizontal) {
        const gap = Math.abs(s.a.y - u.a.y);
        if (gap > 0.3 && gap < minGap && overlapLen(s.a.x, s.b.x, u.a.x, u.b.x) > minOverlap) add({ net: s.net, kind: 'wire', other: u.net, gap, at: { x: Math.min(s.a.x, s.b.x), y: s.a.y } });
      }
    }
  }
  return [...hits.values()];
}

const boxHitsSegment = (box, s, hw) => {
  const r = { x0: Math.min(s.a.x, s.b.x) - hw, x1: Math.max(s.a.x, s.b.x) + hw, y0: Math.min(s.a.y, s.b.y) - hw, y1: Math.max(s.a.y, s.b.y) + hw };
  return box.x0 < r.x1 - EPS && r.x0 < box.x1 - EPS && box.y0 < r.y1 - EPS && r.y0 < box.y1 - EPS;
};

// texts: [{id, text, x0, x1, y0, y1}], lines: [{id, a, b, hw}]
export function textLineCollisions(texts, lines) {
  const hits = [];
  for (const box of texts) {
    const hit = lines.find((s) => boxHitsSegment(box, s, s.hw));
    if (hit) hits.push({ text: box.text, label: box.id, line: hit.id });
  }
  return hits;
}
