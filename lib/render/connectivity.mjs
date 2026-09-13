// Exact connectivity of the drawn geometry (CONVENTIONS §1.5, §4.1). Runs on
// the final SVG string, after straightening, anchor extension and bubble
// placement, because post-processing can open gaps the layout model never had.
//
//   wire/detached         a wire end is more than 0.1 pt from its pin anchor, an
//                         anchor is not on the symbol's outline, an arrow's
//                         shaft does not meet its base, a junction has no dot,
//                         a dot is not on the trunk, lanes through a pipeline
//                         bar change level, or a polyline has notched joins
//   wire/touching         a vertex of one net lies on another net's wire
//                         (a crossing without a dot must not touch)
//   symbol/bubble-detached  an inversion bubble is not tangent to its body
//                         (gap or overlap > 0.25 pt), or its wire does not meet it
//
// With `anchors` (from the renderer) every wire end is matched to its pin.
// Without them (old SVGs) a wire end must touch some symbol outline or sit at
// a port label's anchor, which is enough to count detached ends.

export const WIRE_EPS = 0.1;
export const BUBBLE_EPS = 0.25;

export function parseSvg(svg) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) {
      const t = m[5].trim();
      if (t) stack.at(-1).children.push(t);
      continue;
    }
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = Object.fromEntries([...m[3].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const node = { name: m[2], attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

// Arc endpoint parameterization → sampled points (SVG 1.1 F.6.5, no rotation).
function arcPoints(x1, y1, rx, ry, large, sweep, x2, y2, samples) {
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }];
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const lambda = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * dy * dy - ry * ry * dx * dx;
  const coef = sign * Math.sqrt(Math.max(0, num / (rx * rx * dy * dy + ry * ry * dx * dx)));
  const cxp = (coef * rx * dy) / ry;
  const cyp = (-coef * ry * dx) / rx;
  const cx = cxp + (x1 + x2) / 2;
  const cy = cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (dx - cxp) / rx, (dy - cyp) / ry);
  let dt = angle((dx - cxp) / rx, (dy - cyp) / ry, (-dx - cxp) / rx, (-dy - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  return Array.from({ length: samples }, (_, k) => {
    const t = t1 + (dt * (k + 1)) / samples;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });
}

// Subpaths of a path `d` (M L Q A Z, absolute) as polylines; curves sampled.
export function pathPolylines(d, samples = 64) {
  const toks = String(d).match(/[MLQAZ]|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) || [];
  const out = [];
  let cur = null;
  let start = null;
  let cmd = null;
  let i = 0;
  const n = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/^[MLQAZ]$/i.test(toks[i])) cmd = toks[i++].toUpperCase();
    const last = cur?.at(-1);
    if (cmd === 'M') { cur = [{ x: n(), y: n() }]; start = cur[0]; out.push(cur); cmd = 'L'; }
    else if (cmd === 'L') cur.push({ x: n(), y: n() });
    else if (cmd === 'Q') {
      const [qx, qy, x, y] = [n(), n(), n(), n()];
      for (let k = 1; k <= samples; k += 1) {
        const t = k / samples;
        cur.push({ x: (1 - t) ** 2 * last.x + 2 * t * (1 - t) * qx + t * t * x, y: (1 - t) ** 2 * last.y + 2 * t * (1 - t) * qy + t * t * y });
      }
    } else if (cmd === 'A') {
      const [rx, ry, , large, sweep, x, y] = [n(), n(), n(), n(), n(), n(), n()];
      cur.push(...arcPoints(last.x, last.y, rx, ry, large, sweep, x, y, samples));
    } else if (cmd === 'Z') { if (cur && start) cur.push({ ...start }); cmd = null; }
    else i += 1;
  }
  return out;
}

const distSeg = (p, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
const distPoly = (p, pts) => {
  let best = Infinity;
  for (let k = 1; k < pts.length; k += 1) best = Math.min(best, distSeg(p, pts[k - 1], pts[k]));
  return pts.length === 1 ? Math.hypot(p.x - pts[0].x, p.y - pts[0].y) : best;
};
const distPrim = (p, prim) => (prim.kind === 'circle' ? Math.abs(Math.hypot(p.x - prim.cx, p.y - prim.cy) - prim.r) : distPoly(p, prim.pts));
const fmt = (v) => Math.round(v * 1000) / 1000;

function primitivesOf(node, out = []) {
  if (typeof node === 'string') return out;
  const id = node.attrs.id || '';
  if (node.name === 'text' || /-hatch$/.test(id)) return out;
  const stroked = node.attrs.stroke && node.attrs.stroke !== 'none';
  const filled = node.attrs.fill && node.attrs.fill !== 'none';
  if (node.name === 'path' && (stroked || filled)) for (const pts of pathPolylines(node.attrs.d)) out.push({ kind: 'poly', id, pts });
  if (node.name === 'rect' && (stroked || filled)) {
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(node.attrs[k]));
    out.push({ kind: 'poly', id, pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }] });
  }
  if (node.name === 'circle') out.push({ kind: 'circle', id, cx: Number(node.attrs.cx), cy: Number(node.attrs.cy), r: Number(node.attrs.r) });
  for (const c of node.children) primitivesOf(c, out);
  return out;
}

// Nets and symbols of a rendered datapath SVG.
export function svgGeometry(svg) {
  const root = parseSvg(svg);
  const nets = new Map();
  const symbols = new Map();
  const texts = [];
  const visit = (node, parent) => {
    if (typeof node === 'string') return;
    const id = node.attrs.id || '';
    if (node.name === 'g' && /^net-/.test(id) && /^nets-/.test(parent?.attrs.id || '')) {
      const net = { id: id.slice(4), branches: new Map(), arrows: new Map(), dots: [], joins: new Map() };
      for (const c of node.children) {
        if (typeof c === 'string') continue;
        const cid = c.attrs.id || '';
        let m;
        if ((m = /-seg(\d+)$/.exec(cid))) { net.branches.set(Number(m[1]), pathPolylines(c.attrs.d)[0] || []); net.joins.set(Number(m[1]), c.attrs['stroke-linejoin']); }
        else if ((m = /-arrow(\d+)$/.exec(cid))) {
          const pts = pathPolylines(c.attrs.d)[0] || [];
          net.arrows.set(Number(m[1]), { tip: pts[1], base: pts[0] && pts[2] ? { x: (pts[0].x + pts[2].x) / 2, y: (pts[0].y + pts[2].y) / 2 } : null });
        } else if (/-dot\d+$/.test(cid)) net.dots.push({ x: Number(c.attrs.cx), y: Number(c.attrs.cy) });
      }
      nets.set(net.id, net);
      return;
    }
    if (node.name === 'g' && /^(stage-\d+|ports)$/.test(parent?.attrs.id || '')) {
      symbols.set(id, { id, prims: primitivesOf(node), node });
      for (const c of node.children) if (typeof c !== 'string' && c.name === 'text') texts.push({ group: id, x: Number(c.attrs.x), y: Number(c.attrs.y), size: Number(c.attrs['font-size']), value: c.children[0] });
      return;
    }
    for (const c of node.children) visit(c, node);
  };
  visit(root, null);
  return { nets, symbols, texts };
}

// Junction points of a net: a vertex of one branch where it leaves another branch.
function divergences(polylines) {
  const found = [];
  const onPoly = (p, pts) => pts.some((a, k) => k > 0 && distSeg(p, pts[k - 1], a) < 0.01);
  polylines.forEach((pts, i) => {
    for (let k = 1; k < pts.length - 1; k += 1) {
      const p = pts[k];
      const mid = { x: (p.x + pts[k + 1].x) / 2, y: (p.y + pts[k + 1].y) / 2 };
      const leaves = polylines.some((other, j) => j !== i && onPoly(p, other) && !onPoly(mid, other));
      if (leaves && !found.some((f) => Math.hypot(f.x - p.x, f.y - p.y) < 0.01)) found.push(p);
    }
  });
  return found;
}

export function connectivityChecks(svg, { anchors = null, lanePairs = [], variant = '', measure = null, portGap = 2.5, ascent = 0.72, labelPt = 8 } = {}) {
  const geo = svgGeometry(svg);
  const diagnostics = [];
  const counts = { wire_ends_checked: 0, wire_detached: 0, wire_touching: 0, junctions_checked: 0, bubbles_checked: 0, bubble_detached: 0 };
  const pre = variant ? `${variant}: ` : '';
  const detached = (net, what, at, gap, evidence = {}) => {
    counts.wire_detached += 1;
    diagnostics.push({ code: 'wire/detached', severity: 'error', message: `${pre}net ${net}: ${what} at (${fmt(at.x)}, ${fmt(at.y)}), gap ${fmt(gap)} pt`, subject: { id: net, variant }, evidence: { at: { x: fmt(at.x), y: fmt(at.y) }, gap: fmt(gap), ...evidence }, supportedFixes: ['end the wire on the pin anchor (outline, apex or bubble tangent point)', 'report a renderer bug: drawn geometry must be exactly connected'] });
  };
  const allInk = [...geo.symbols.values()].flatMap((s) => s.prims.map((p) => ({ ...p, group: s.id })));
  const nearestInk = (p, prims) => prims.reduce((best, prim) => Math.min(best, distPrim(p, prim)), Infinity);
  // Port label anchors (heuristic mode): an input port's wire starts after
  // its label and the gap, an output port's wire ends the gap before its label.
  const portAnchors = measure ? geo.texts.filter((t) => /^port-/.test(t.group)).flatMap((t) => {
    const yc = t.y - (ascent * t.size) / 2;
    return [{ x: t.x + measure(t.value, t.size) + portGap, y: yc }, { x: t.x - portGap, y: yc }];
  }) : [];

  const anchorOf = new Map((anchors || []).map((a) => [`${a.net}|${a.branch}|${a.role}`, a]));
  for (const net of geo.nets.values()) {
    const polylines = [...net.branches.values()];
    for (const [i, pts] of net.branches) {
      if (pts.length < 2) continue;
      if (!/^(miter|round)$/.test(net.joins.get(i) || '')) detached(net.id, `branch ${i} has notched joins (stroke-linejoin ${net.joins.get(i) || 'unset'})`, pts[1], 0);
      for (let k = 1; k < pts.length; k += 1) if (Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y) < 1e-6 && k < pts.length - 1) break;
      const arrow = net.arrows.get(i);
      const start = pts[0];
      const end = arrow?.tip ?? pts.at(-1);
      if (arrow) {
        counts.wire_ends_checked += 1;
        const gap = Math.hypot(pts.at(-1).x - arrow.base.x, pts.at(-1).y - arrow.base.y);
        if (gap > WIRE_EPS) detached(net.id, `shaft of branch ${i} stops short of its arrowhead base`, pts.at(-1), gap);
      }
      for (const [role, p] of [['driver', start], ['sink', end]]) {
        counts.wire_ends_checked += 1;
        const a = anchorOf.get(`${net.id}|${i}|${role}`);
        if (anchors) {
          if (!a) continue;
          const gap = Math.hypot(p.x - a.x, p.y - a.y);
          if (gap > WIRE_EPS) { detached(net.id, `${role} end of branch ${i} misses pin ${a.element}.${a.pin}`, p, gap, { anchor: { x: fmt(a.x), y: fmt(a.y) } }); continue; }
          if (a.port) continue;
          const sym = geo.symbols.get(a.gid);
          if (a.bubble) {
            const bgap = Math.abs(Math.hypot(a.x - a.bubble.cx, a.y - a.bubble.cy) - a.bubble.r);
            if (bgap > WIRE_EPS) {
              counts.bubble_detached += 1;
              diagnostics.push({ code: 'symbol/bubble-detached', severity: 'error', message: `${pre}the wire of ${a.element}.${a.pin} does not meet its bubble (gap ${fmt(bgap)} pt)`, subject: { id: a.element, pin: a.pin, variant }, evidence: { gap: fmt(bgap) }, supportedFixes: ['anchor the pin at the bubble outer tangent point'] });
            }
          }
          const inkGap = sym ? nearestInk(a, sym.prims) : Infinity;
          if (inkGap > WIRE_EPS) detached(net.id, `pin anchor ${a.element}.${a.pin} is not on the symbol outline`, a, inkGap);
        } else {
          const gap = Math.min(nearestInk(p, allInk), ...portAnchors.map((q) => (Math.abs(q.y - p.y) <= 1 ? Math.abs(q.x - p.x) : Infinity)));
          if (gap > WIRE_EPS) detached(net.id, `${role} end of branch ${i} touches no symbol`, p, gap);
        }
      }
    }
    // Junctions: a dot at every divergence, and every dot on at least two branches.
    for (const j of divergences(polylines)) {
      counts.junctions_checked += 1;
      const dot = net.dots.find((d) => Math.hypot(d.x - j.x, d.y - j.y) <= WIRE_EPS);
      if (!dot) detached(net.id, 'branch leaves the trunk without a junction dot', j, 0);
    }
    for (const d of net.dots) {
      const on = polylines.filter((pts) => distPoly(d, pts) <= WIRE_EPS).length;
      if (on < 2) detached(net.id, 'junction dot is not on the trunk', d, Math.min(...polylines.map((pts) => distPoly(d, pts))));
    }
  }

  // Lanes through a pipeline bar keep their level on both sides.
  for (const lp of lanePairs) {
    const gap = Math.abs(lp.inY - lp.outY);
    if (gap > WIRE_EPS) detached(lp.net ?? lp.element, `lane ${lp.lane} of ${lp.element} changes level through the bar`, { x: lp.x, y: lp.inY }, gap);
  }

  // A vertex of one net must not lie on another net's wire.
  const nets = [...geo.nets.values()];
  for (const a of nets) {
    const verts = [...a.branches.values()].flatMap((pts) => pts);
    for (const b of nets) {
      if (a === b) continue;
      for (const p of verts) {
        const hit = [...b.branches.values()].find((pts) => distPoly(p, pts) < WIRE_EPS);
        if (hit) {
          counts.wire_touching += 1;
          diagnostics.push({ code: 'wire/touching', severity: 'error', message: `${pre}net ${a.id} touches net ${b.id} at (${fmt(p.x)}, ${fmt(p.y)}); wires that cross without a dot must not touch`, subject: { id: a.id, other: b.id, variant }, evidence: { at: { x: fmt(p.x), y: fmt(p.y) } }, supportedFixes: ['route one wire in its own channel'] });
          break;
        }
      }
    }
  }

  // Bubbles are tangent to their body (and XOR's back line).
  for (const sym of geo.symbols.values()) {
    const bodies = sym.prims.filter((p) => p.kind === 'poly' && /-(body|back)$/.test(p.id));
    for (const b of sym.prims.filter((p) => p.kind === 'circle' && /-bubble-/.test(p.id))) {
      counts.bubbles_checked += 1;
      const centre = { x: b.cx, y: b.cy };
      const dist = Math.min(...bodies.map((q) => distPoly(centre, q.pts)));
      const gap = dist - b.r;
      if (!bodies.length || Math.abs(gap) > BUBBLE_EPS) {
        counts.bubble_detached += 1;
        diagnostics.push({ code: 'symbol/bubble-detached', severity: 'error', message: `${pre}bubble ${b.id} is ${gap > 0 ? `${fmt(gap)} pt away from` : `${fmt(-gap)} pt inside`} its body outline`, subject: { id: b.id, variant }, evidence: { gap: fmt(gap) }, supportedFixes: ['place the bubble tangent to the outline at the pin (computed from the symbol geometry)'] });
      }
    }
  }
  return { diagnostics, counts };
}
