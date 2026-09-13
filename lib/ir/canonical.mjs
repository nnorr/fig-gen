// IR canonicalisation (G7): identical wiring elements are drawn once. Two
// splits of the same bus with the same slices, or two buffers of the same
// net, are one piece of hardware drawn twice; merging them is a pure
// simplification (no hardware is dropped) that often decides whether a figure
// fits. Used render-only by the renderer and on draft output.

const elementOf = (endpoint) => String(endpoint).split('.')[0];

export function mergeDuplicateSplits(doc) {
  const inNetOf = (id) => (doc.nets || []).find((n) => n.sinks.some((s) => elementOf(s) === id));
  const groups = new Map();
  for (const e of doc.elements || []) {
    if (e.kind !== 'comb' || (e.op !== 'split' && e.op !== 'buf')) continue;
    const n = inNetOf(e.id);
    if (!n) continue;
    const key = [e.op, n.driver, e.op === 'split' ? (e.slices || []).join(',') : '', e.width].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.id);
  }
  const duplicates = [...groups.values()].filter((g) => g.length > 1);
  if (!duplicates.length) return { doc, merged: [] };
  const out = structuredClone(doc);
  const merged = [];
  for (const [keepId, ...rest] of duplicates) {
    for (const dupId of rest) {
      // Each output net of the duplicate joins the kept element's same output.
      for (const n of out.nets.filter((x) => elementOf(x.driver) === dupId)) {
        const pin = String(n.driver).split('.')[1];
        const target = out.nets.find((x) => x.driver === `${keepId}.${pin}`);
        if (target) {
          for (const s of n.sinks) if (!target.sinks.includes(s)) target.sinks.push(s);
          out.nets = out.nets.filter((x) => x !== n);
        } else {
          n.driver = `${keepId}.${pin}`;
        }
      }
      for (const n of out.nets) n.sinks = n.sinks.filter((s) => elementOf(s) !== dupId);
      out.nets = out.nets.filter((n) => n.sinks.length);
      out.elements = out.elements.filter((x) => x.id !== dupId);
      for (const r of out.regions || []) r.members = r.members.filter((m) => m !== dupId);
      merged.push({ kept: keepId, removed: dupId });
    }
  }
  if (out.regions) out.regions = out.regions.filter((r) => r.members.length);
  return { doc: out, merged };
}
