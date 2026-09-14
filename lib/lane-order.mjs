// Mux fan-in ordering (SPEC §4.10): register-bank lanes that feed stacked
// multiplexers are ordered, and the banks and muxes placed in the column, to
// minimise the wire crossings between the bank outputs and the mux inputs.
// A mux's input order is its select order and never changes: only the lanes,
// the bank order, the mux stacking order and the figure inputs loading the
// lanes are permuted. Crossings are counted on the two-column model (every
// lane output on one side, every mux input on the other, in drawing order).

import { parseEndpoint } from './ir/endpoints.mjs';

const permutations = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
const factorial = (n) => (n <= 1 ? 1 : n * factorial(n - 1));

// Crossings between edges [sourceIndex, targetIndex]: pairs from different
// sources whose order reverses between the two columns.
export function twoColumnCrossings(edges) {
  let c = 0;
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = 0; j < edges.length; j += 1) if (edges[i][0] < edges[j][0] && edges[i][1] > edges[j][1]) c += 1;
  }
  return c;
}

// The fan-in groups of a figure: banks (registers with lanes) whose lanes feed
// muxes, and those muxes. Returns null when no bank lane feeds a mux.
export function fanIn(doc) {
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const banks = doc.elements.filter((e) => e.kind === 'register' && Array.isArray(e.lanes));
  const muxInputs = new Map();
  for (const n of doc.nets) {
    const d = parseEndpoint(n.driver);
    const bank = byId.get(d?.element);
    if (!bank || !banks.includes(bank) || !d.port?.startsWith('q_')) continue;
    for (const s of n.sinks) {
      const ep = parseEndpoint(s);
      const m = byId.get(ep?.element);
      const k = /^in(\d+)$/.exec(ep?.port ?? '');
      if (m?.kind !== 'mux' || !k) continue;
      if (!muxInputs.has(m.id)) muxInputs.set(m.id, []);
      muxInputs.get(m.id).push({ bank: bank.id, lane: d.port.slice(2), input: Number(k[1]) });
    }
  }
  if (!muxInputs.size) return null;
  const feeding = banks.filter((b) => [...muxInputs.values()].some((l) => l.some((x) => x.bank === b.id)));
  const muxes = doc.elements.filter((e) => muxInputs.has(e.id));
  return { banks: feeding, muxes, inputs: muxInputs };
}

// Crossings of one arrangement: bank ids in order with their lane ids, mux ids in order.
export function fanInCrossings(group, arrangement) {
  const offset = new Map();
  let at = 0;
  for (const id of arrangement.muxes) { offset.set(id, at); at += byMux(group, id).inputs ?? 0; }
  const src = new Map();
  let k = 0;
  for (const b of arrangement.banks) for (const lane of b.lanes) src.set(`${b.id}.${lane}`, k++);
  const edges = [];
  for (const [mux, list] of group.inputs) for (const x of list) edges.push([src.get(`${x.bank}.${x.lane}`), offset.get(mux) + x.input]);
  return twoColumnCrossings(edges);
}
const byMux = (group, id) => group.muxes.find((m) => m.id === id);

// Best arrangement: every bank order and mux stacking order; lanes exactly when
// the product of lane permutations is small, otherwise barycentre order refined
// by adjacent swaps. The current arrangement is kept unless another is strictly better.
export function bestFanIn(group, { exactLimit = 50000 } = {}) {
  const current = { banks: group.banks.map((b) => ({ id: b.id, lanes: b.lanes.map((l) => l.id) })), muxes: group.muxes.map((m) => m.id) };
  const before = fanInCrossings(group, current);
  let best = { ...current, crossings: before };
  const consider = (a) => { const c = fanInCrossings(group, a); if (c < best.crossings) best = { ...a, crossings: c }; };
  for (const muxes of permutations(current.muxes)) {
    for (const bankOrder of permutations(current.banks)) {
      const product = bankOrder.reduce((p, b) => p * factorial(b.lanes.length), 1);
      if (product <= exactLimit) {
        const rec = (i, chosen) => {
          if (i === bankOrder.length) { consider({ banks: chosen, muxes }); return; }
          for (const lanes of permutations(bankOrder[i].lanes)) rec(i + 1, [...chosen, { id: bankOrder[i].id, lanes }]);
        };
        rec(0, []);
        continue;
      }
      // Barycentre of each lane's mux input positions, then adjacent swaps while they help.
      const offset = new Map();
      let at = 0;
      for (const id of muxes) { offset.set(id, at); at += byMux(group, id).inputs ?? 0; }
      const centre = (bank, lane) => {
        const ps = [...group.inputs].flatMap(([m, l]) => l.filter((x) => x.bank === bank && x.lane === lane).map((x) => offset.get(m) + x.input));
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
      };
      const a = { banks: bankOrder.map((b) => ({ id: b.id, lanes: [...b.lanes].sort((x, y) => centre(b.id, x) - centre(b.id, y)) })), muxes };
      let c = fanInCrossings(group, a);
      for (let improved = true; improved;) {
        improved = false;
        for (const b of a.banks) {
          for (let i = 0; i + 1 < b.lanes.length; i += 1) {
            [b.lanes[i], b.lanes[i + 1]] = [b.lanes[i + 1], b.lanes[i]];
            const d = fanInCrossings(group, a);
            if (d < c) { c = d; improved = true; } else [b.lanes[i], b.lanes[i + 1]] = [b.lanes[i + 1], b.lanes[i]];
          }
        }
      }
      consider(a);
    }
  }
  return { before, after: best.crossings, arrangement: best, changed: best.crossings < before };
}

// Apply the best arrangement to a figure (a new document): lanes reordered,
// banks and muxes in their chosen order within the positions they already
// hold in the element list, and the figure inputs that load a bank's lanes in
// lane order. Mux inputs and every net are unchanged.
export function orderFanIn(doc, opts = {}) {
  const group = fanIn(doc);
  if (!group) return { doc, report: null };
  const result = bestFanIn(group, opts);
  if (!result.changed) return { doc, report: { before: result.before, after: result.after, changed: false } };
  const out = structuredClone(doc);
  const byId = new Map(out.elements.map((e) => [e.id, e]));
  for (const b of result.arrangement.banks) {
    const el = byId.get(b.id);
    el.lanes = b.lanes.map((id) => el.lanes.find((l) => l.id === id));
  }
  const reorder = (ids) => {
    const slots = out.elements.map((e, i) => (ids.includes(e.id) ? i : -1)).filter((i) => i >= 0);
    slots.forEach((slot, k) => { out.elements[slot] = byId.get(ids[k]); });
  };
  reorder(result.arrangement.banks.map((b) => b.id));
  reorder(result.arrangement.muxes);
  // Figure inputs loading bank lanes follow the lane order.
  const laneRank = new Map();
  let r = 0;
  for (const b of result.arrangement.banks) for (const lane of b.lanes) laneRank.set(`${b.id}.d_${lane}`, r++);
  const inputs = out.elements.filter((e) => e.kind === 'port' && e.dir === 'in').map((e) => {
    const n = out.nets.find((x) => parseEndpoint(x.driver)?.element === e.id);
    const ranks = (n?.sinks || []).map((s) => laneRank.get(s)).filter((x) => x !== undefined);
    return ranks.length ? { id: e.id, rank: Math.min(...ranks) } : null;
  }).filter(Boolean);
  reorder([...inputs].sort((a, b) => a.rank - b.rank).map((x) => x.id));
  return { doc: out, report: { before: result.before, after: result.after, changed: true, banks: result.arrangement.banks, muxes: result.arrangement.muxes } };
}
