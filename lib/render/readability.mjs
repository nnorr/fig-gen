// Readability of a routed figure, measured on the final SVG (receipt
// route.readability, route/readability): how often wires cross, per drawn
// net, and how far wires wander, as routed length over the direct
// (Manhattan) distance between each branch's ends. Measured on the SVG, so the
// same numbers can be taken from any rendered figure, old or new.

import { crossingCounts } from './route-metrics.mjs';

const pointsOf = (d) => [...d.matchAll(/[ML]\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
const round = (v, k = 2) => Math.round(v * 10 ** k) / 10 ** k;

export function readabilityFromSvg(svg) {
  const nets = new Map();
  for (const m of String(svg).matchAll(/<path\b[^>]*>/g)) {
    const id = /\bid="net-(.+)-seg\d+"/.exec(m[0]);
    const d = /\bd="([^"]+)"/.exec(m[0]);
    if (!id || !d) continue;
    const pts = pointsOf(d[1]);
    if (pts.length < 2) continue;
    if (!nets.has(id[1])) nets.set(id[1], []);
    nets.get(id[1]).push(pts);
  }
  let routed = 0;
  let direct = 0;
  for (const polylines of nets.values()) {
    for (const pts of polylines) {
      for (let k = 1; k < pts.length; k += 1) routed += Math.abs(pts[k].x - pts[k - 1].x) + Math.abs(pts[k].y - pts[k - 1].y);
      direct += Math.abs(pts.at(-1).x - pts[0].x) + Math.abs(pts.at(-1).y - pts[0].y);
    }
  }
  const crossings = crossingCounts([...nets].map(([id, polylines]) => ({ id, cls: 'data', polylines }))).counts.total;
  return {
    nets: nets.size,
    crossings,
    crossings_per_net: nets.size ? round(crossings / nets.size) : 0,
    wire_length_pt: round(routed, 1),
    direct_length_pt: round(direct, 1),
    wire_length_ratio: direct > 0 ? round(routed / direct) : 1,
  };
}
