// Hidden pipeline registers and drawn latency (SPEC §8, CONVENTIONS §5.4).
// For every drawn element with RTL-mapped nets on both sides, the RTL path
// from each input net to each output net is traced through the netlist
// (not through other mapped nets). Then:
//   - a register on that path without feedback is a pipeline register; if the
//     figure does not draw it (register, pipeline-register lane), it is hidden
//     inside the collapsed element: latency/hidden-register (error), fixed by
//     splitting the block at the register boundary (option a);
//   - the latency the figure draws through the element (registered output
//     ports) must equal the RTL minimum register count: otherwise
//     latency/hidden-register (error). Internal state (registers with
//     feedback) and memories may stay inside a block marked registered with
//     its latency (option b).

import { diagnostic } from '../diagnostics.mjs';
import { buildModel, pinLatency } from '../ir/datapath-model.mjs';
import { flattenNetlist } from '../rtl/flatten.mjs';
import { aliasClasses } from './coverage.mjs';

const relToPath = (flat, rel) => [flat.top, ...(rel ? String(rel).split('/') : [])].join('.');
const EXPLICIT = new Set(['port', 'const', 'register', 'pipeline_register', 'synchronizer', 'memory']);

export function checkLatency(doc, netlist) {
  const diagnostics = [];
  const flat = flattenNetlist(netlist);
  const aliases = aliasClasses(netlist);
  const model = buildModel(doc);
  const base = doc.meta?.rtl?.instance;
  const canon = (p) => aliases.find(p);
  // Canonical back/forward adjacency (port connections collapse into one node).
  const back = new Map();
  const fwd = new Map();
  for (const [target, list] of flat.back) {
    const t = canon(target);
    for (const { source, kind } of list) {
      const s = canon(source);
      if (s === t) continue;
      if (!back.has(t)) back.set(t, []);
      back.get(t).push({ s, seq: kind === 'seq' });
      if (!fwd.has(s)) fwd.set(s, []);
      fwd.get(s).push({ t, seq: kind === 'seq' });
    }
  }
  const registerAt = new Map();
  for (const sig of flat.signals.values()) if (sig.register) registerAt.set(canon(sig.path), sig);
  const netSig = new Map();
  for (const n of model.nets) {
    if (!n.net.rtl?.signal) continue;
    const p = `${relToPath(flat, n.net.rtl.instance ?? base)}.${n.net.rtl.signal}`;
    if (flat.signals.has(p)) netSig.set(n.net.id, canon(p));
  }
  // Registers the figure draws: q outputs of register/pipeline elements, register elements' own mapping.
  const drawn = new Set();
  for (const n of model.nets) if (!n.driver.error && netSig.has(n.net.id) && ['register', 'pipeline_register', 'synchronizer'].includes(n.driver.element.kind)) drawn.add(netSig.get(n.net.id));
  for (const e of doc.elements || []) if (e.kind === 'register' && e.rtl?.signal) drawn.add(canon(`${relToPath(flat, e.rtl.instance ?? base)}.${e.rtl.signal}`));
  const mapped = new Set(netSig.values());

  const selfDep = new Set();
  for (const [t, list] of flat.back) if (list.some((e) => e.source === t)) selfDep.add(canon(t));
  const hasFeedback = (r) => {
    if (selfDep.has(r)) return true;
    const seen = new Set();
    const queue = (back.get(r) || []).map((e) => e.s);
    while (queue.length) {
      const v = queue.shift();
      if (v === r) return true;
      if (seen.has(v) || seen.size > 20000) continue;
      seen.add(v);
      for (const e of back.get(v) || []) queue.push(e.s);
    }
    return false;
  };
  const feedbackCache = new Map();
  const feedback = (r) => { if (!feedbackCache.has(r)) feedbackCache.set(r, hasFeedback(r)); return feedbackCache.get(r); };

  const report = { pairs_checked: 0, pairs_with_registers: 0, mismatches: 0, hidden_registers: 0, paths: [] };
  const hiddenSet = new Set();
  const nameOf = (c) => { const s = registerAt.get(c); return s ? `${s.instance === flat.top ? '' : `${s.instance.slice(flat.top.length + 1).replace(/\./g, '/')}:`}${s.name}` : c; };
  for (const { el, pins } of model.elements.values()) {
    if (EXPLICIT.has(el.kind)) continue;
    const ins = model.nets.filter((n) => netSig.has(n.net.id) && n.net.class !== 'clock' && n.net.class !== 'reset' && n.sinks.some((s) => !s.error && s.element.id === el.id));
    const outs = model.nets.filter((n) => netSig.has(n.net.id) && !n.driver.error && n.driver.element.id === el.id);
    const memoryLike = el.function?.kind === 'memory';
    for (const o of outs) {
      const to = netSig.get(o.net.id);
      const outPin = pins.find((p) => p.id === o.driver.pin.id);
      const drawnLatency = pinLatency(el, outPin);
      for (const i of ins) {
        const from = netSig.get(i.net.id);
        if (from === to) continue;
        const blocked = (v) => mapped.has(v) && v !== from && v !== to;
        // 0-1 BFS backwards from the output: minimum register stages to each node.
        const dist = new Map([[to, 0]]);
        const dq = [to];
        while (dq.length) {
          const v = dq.shift();
          if (v !== to && blocked(v)) continue;
          if (v === from) continue;
          for (const { s, seq } of back.get(v) || []) {
            const nd = dist.get(v) + (seq ? 1 : 0);
            if (nd > 64 || (dist.has(s) && dist.get(s) <= nd)) continue;
            dist.set(s, nd);
            if (seq) dq.push(s); else dq.unshift(s);
          }
        }
        if (!dist.has(from)) continue;
        const reach = new Set([from]);
        const queue = [from];
        while (queue.length) {
          const v = queue.shift();
          if (v !== from && (blocked(v) || v === to)) continue;
          for (const { t } of fwd.get(v) || []) if (!reach.has(t)) { reach.add(t); queue.push(t); }
        }
        const onPath = [...dist.keys()].filter((v) => reach.has(v) && registerAt.has(v) && v !== from);
        const rtlLatency = dist.get(from);
        report.pairs_checked += 1;
        // A pipeline register of this path is loaded from the path alone:
        // exactly one source other than its clock and reset, reachable from
        // the input, and it does not feed itself. Registers also loaded from elsewhere
        // (CSRs, stickies, shared buffers) or with feedback are internal state.
        // A registered output marking never excuses a pipeline register:
        // option (b) is for internal state and memories only.
        const pipeline = (r) => {
          if (feedback(r)) return false;
          const sig = registerAt.get(r);
          const clocks = new Set([sig.register.clock?.net, sig.register.reset?.net].filter(Boolean).map((n) => canon(`${sig.instance}.${n}`)));
          const data = (back.get(r) || []).filter(({ s }) => !clocks.has(s));
          // One data source: a register with several (an enable, a clear, a set) holds state.
          return data.length === 1 && reach.has(data[0].s);
        };
        const hidden = onPath.filter((r) => !drawn.has(r) && !memoryLike && pipeline(r));
        const state = onPath.filter((r) => !drawn.has(r) && !pipeline(r));
        const entry = { element: el.id, from: i.net.id, to: o.net.id, drawn: drawnLatency, rtl: rtlLatency, registers: onPath.map(nameOf) };
        if (onPath.length) report.pairs_with_registers += 1;
        if (hidden.length) {
          for (const h of hidden) hiddenSet.add(h);
          report.paths.push({ ...entry, status: 'hidden-register', hidden: hidden.map(nameOf) });
          diagnostics.push(diagnostic({ code: 'latency/hidden-register', message: `${el.kind} ${el.id} hides pipeline register${hidden.length > 1 ? 's' : ''} ${hidden.map(nameOf).join(', ')} on the shown path ${i.net.id} → ${o.net.id} (RTL latency ${rtlLatency}, drawn ${drawnLatency}); pipeline registers on a shown path are drawn outside collapsed blocks`, subject: { id: el.id, from: i.net.id, to: o.net.id }, evidence: { hidden: hidden.map(nameOf), rtl: rtlLatency, drawn: drawnLatency }, supportedFixes: ['split the block at the register boundary and draw the register as a pipeline-register bar (or register)', 'narrow the path: map the nets at the register boundary'] }));
        } else if (rtlLatency !== drawnLatency && !memoryLike) {
          report.mismatches += 1;
          report.paths.push({ ...entry, status: 'latency-mismatch', ...(state.length ? { state: state.map(nameOf) } : {}) });
          diagnostics.push(diagnostic({ code: 'latency/hidden-register', message: `${el.kind} ${el.id}: the path ${i.net.id} → ${o.net.id} has RTL latency ${rtlLatency} but the figure draws ${drawnLatency}`, subject: { id: el.id, from: i.net.id, to: o.net.id }, evidence: { rtl: rtlLatency, drawn: drawnLatency, state: state.map(nameOf) }, supportedFixes: [rtlLatency > drawnLatency ? 'draw the register stages (split the block) or mark the output port registered with its latency (internal state only)' : 'remove the registered marking from the output port', 'fix the net mappings'] }));
        } else if (onPath.length) {
          report.paths.push({ ...entry, status: 'ok', ...(state.length ? { state: state.map(nameOf) } : {}) });
        }
      }
    }
  }
  report.hidden_registers = hiddenSet.size;
  report.hidden = [...hiddenSet].map(nameOf);
  return { diagnostics, report };
}
