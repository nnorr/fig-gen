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
// Controllers: an output may declare its latency per input pin
// ({pin: stages}) or as "state" (varies with the state; no single number is
// claimed, hidden pipeline registers are still reported).
// Other blocks holding registers with feedback may do the same with
// holds_state: true, verified here (latency/holds-state). "state" on an output
// the netlist reaches from an input with a fixed latency warns
// (latency/state-escape): the per-input map could be compared instead.
// Bundles: a heterogeneous bundle net is expanded to its member signals; the
// RTL latency of a drawn net pair is the minimum over its member pairs.
// A figure whose scope holds registers but compares no latency pair is
// unverified (latency/unverified: error at paper quality, warning otherwise),
// unless it opts out with latency_unverified.reason.

import { diagnostic } from '../diagnostics.mjs';
import { buildModel, pinLatencyFrom } from '../ir/datapath-model.mjs';
import { flattenNetlist } from '../rtl/flatten.mjs';
import { netSignalPaths } from './bundle-members.mjs';
import { declaresState, STATEFUL_KINDS } from './datapath.mjs';
import { aliasClasses, declaredScope } from './coverage.mjs';

const relToPath = (flat, rel) => [flat.top, ...(rel ? String(rel).split('/') : [])].join('.');
const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|\\[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const EXPLICIT = new Set(['port', 'const', 'register', 'pipeline_register', 'synchronizer', 'memory']);

export function checkLatency(doc, netlist, { quality } = {}) {
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

  const report = { pairs_checked: 0, pairs_with_registers: 0, mismatches: 0, hidden_registers: 0, member_pairs_checked: 0, bundled_pairs_checked: 0, pairs_skipped_bundled: 0, state_pairs: 0, excluded_unmapped: [], paths: [] };
  // Signals each net stands for: one mapped signal, or the members of a bundle.
  const netSigs = new Map();
  const bundledNets = new Set();
  // A net drawn unmapped for latency may keep its RTL signal for structural
  // checks (rtl_unmapped.rtl): it bounds the traced paths like any drawn net
  // and verifies comb_from, but no latency is compared on it.
  const structural = new Set();
  for (const n of model.nets) {
    if (n.net.rtl_unmapped) report.excluded_unmapped.push({ net: n.net.id, reason: n.net.rtl_unmapped.reason });
    if (!n.net.rtl && n.net.rtl_unmapped?.rtl) {
      const { paths } = netSignalPaths({ ...n, net: { ...n.net, rtl: n.net.rtl_unmapped.rtl } }, flat, base);
      const known = paths.filter((p) => flat.signals.has(p));
      if (known.length) { netSigs.set(n.net.id, [...new Set(known.map(canon))]); structural.add(n.net.id); }
      continue;
    }
    const { paths, bundled } = netSignalPaths(n, flat, base);
    const known = paths.filter((p) => flat.signals.has(p));
    if (bundled) {
      bundledNets.add(n.net.id);
      report.pairs_skipped_bundled += paths.length - known.length;
    }
    if (known.length) netSigs.set(n.net.id, [...new Set(known.map(canon))]);
  }
  // Registers the figure draws: q outputs of register/pipeline elements, register elements' own mapping.
  const drawn = new Set();
  for (const n of model.nets) if (!n.driver.error && netSigs.has(n.net.id) && ['register', 'pipeline_register', 'synchronizer'].includes(n.driver.element.kind)) netSigs.get(n.net.id).forEach((s) => drawn.add(s));
  for (const e of doc.elements || []) if (e.kind === 'register' && e.rtl?.signal) drawn.add(canon(`${relToPath(flat, e.rtl.instance ?? base)}.${e.rtl.signal}`));
  // A register bank draws each of its lanes' registers.
  for (const e of doc.elements || []) for (const l of (e.kind === 'register' && Array.isArray(e.lanes) ? e.lanes : [])) if (l.rtl?.signal) drawn.add(canon(`${relToPath(flat, l.rtl.instance ?? e.rtl?.instance ?? base)}.${l.rtl.signal}`));
  const mapped = new Set([...netSigs.values()].flat());

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

  // Every mapped signal other than the traced output (backward) or input
  // (forward) ends the search: the path may not pass through another drawn
  // net. That makes each search independent of the other endpoint, so one
  // backward search per output and one forward search per input serve every
  // member pair of a bundle.
  const backCache = new Map();
  const backDist = (to) => {
    if (!backCache.has(to)) {
      // 0-1 BFS backwards from the output: minimum register stages to each node.
      const dist = new Map([[to, 0]]);
      const dq = [to];
      while (dq.length) {
        const v = dq.shift();
        if (v !== to && mapped.has(v)) continue;
        for (const { s, seq } of back.get(v) || []) {
          const nd = dist.get(v) + (seq ? 1 : 0);
          if (nd > 64 || (dist.has(s) && dist.get(s) <= nd)) continue;
          dist.set(s, nd);
          if (seq) dq.push(s); else dq.unshift(s);
        }
      }
      backCache.set(to, dist);
    }
    return backCache.get(to);
  };
  const fwdCache = new Map();
  const forwardReach = (from) => {
    if (!fwdCache.has(from)) {
      const reach = new Set([from]);
      const queue = [from];
      while (queue.length) {
        const v = queue.shift();
        if (v !== from && mapped.has(v)) continue;
        for (const { t } of fwd.get(v) || []) if (!reach.has(t)) { reach.add(t); queue.push(t); }
      }
      fwdCache.set(from, reach);
    }
    return fwdCache.get(from);
  };

  // One member pair: minimum register stages, registers on the path, and which of them are pipeline registers.
  const tracePair = (from, to) => {
    const dist = backDist(to);
    if (!dist.has(from)) return null;
    const reach = forwardReach(from);
    const onPath = [...dist.keys()].filter((v) => reach.has(v) && registerAt.has(v) && v !== from);
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
    return { dist: dist.get(from), onPath, pipeline };
  };

  const hiddenSet = new Set();
  // Outputs declared "state" and the fixed latency the netlist gives from each input pin.
  const stateEscape = new Map();
  const nameOf = (c) => { const s = registerAt.get(c); return s ? `${s.instance === flat.top ? '' : `${s.instance.slice(flat.top.length + 1).replace(/\./g, '/')}:`}${s.name}` : c; };
  for (const { el, pins } of model.elements.values()) {
    if (EXPLICIT.has(el.kind)) continue;
    const ins = model.nets.filter((n) => netSigs.has(n.net.id) && n.net.class !== 'clock' && n.net.class !== 'reset' && n.sinks.some((s) => !s.error && s.element.id === el.id));
    const outs = model.nets.filter((n) => netSigs.has(n.net.id) && !n.driver.error && n.driver.element.id === el.id);
    const memoryLike = el.function?.kind === 'memory';
    for (const o of outs) {
      const outPin = pins.find((p) => p.id === o.driver.pin.id);
      for (const i of ins) {
        if (i === o) continue;
        const sinkPin = i.sinks.find((s) => !s.error && s.element.id === el.id)?.pin;
        const declared = pinLatencyFrom(el, outPin, sinkPin?.id);
        let rtlLatency = null;
        let memberPairs = 0;
        const onPath = new Set();
        const hidden = new Set();
        const state = new Set();
        for (const to of netSigs.get(o.net.id)) {
          for (const from of netSigs.get(i.net.id)) {
            if (from === to) continue;
            const res = tracePair(from, to);
            if (!res) continue;
            memberPairs += 1;
            rtlLatency = rtlLatency === null ? res.dist : Math.min(rtlLatency, res.dist);
            for (const r of res.onPath) {
              onPath.add(r);
              if (drawn.has(r)) continue;
              if (!memoryLike && res.pipeline(r)) hidden.add(r); else if (!res.pipeline(r)) state.add(r);
            }
          }
        }
        if (rtlLatency === null) continue;
        if (outPin?.combFrom && sinkPin && rtlLatency === 0 && !outPin.combFrom.includes(sinkPin.id)) diagnostics.push(diagnostic({ code: 'latency/comb-from', message: `${el.kind} ${el.id}: output ${outPin.id} does not list ${sinkPin.id} in comb_from, but the RTL reaches ${o.net.id} from ${i.net.id} with no register on the way`, subject: { id: el.id, from: i.net.id, to: o.net.id }, evidence: { comb_from: outPin.combFrom, input: sinkPin.id, rtl: 0 }, supportedFixes: [`add "${sinkPin.id}" to comb_from`, 'remove comb_from (every input then counts as combinational)'] }));
        // Structural nets verify comb_from only; their latency is not drawn.
        if (structural.has(o.net.id) || structural.has(i.net.id)) continue;
        report.pairs_checked += 1;
        report.member_pairs_checked += memberPairs;
        if (bundledNets.has(i.net.id) || bundledNets.has(o.net.id)) report.bundled_pairs_checked += 1;
        const drawnText = declared.kind === 'state' ? 'state' : declared.value ?? 'undeclared';
        const entry = { element: el.id, from: i.net.id, to: o.net.id, drawn: drawnText, rtl: rtlLatency, registers: [...onPath].map(nameOf), ...(memberPairs > 1 ? { member_pairs: memberPairs } : {}) };
        if (onPath.size) report.pairs_with_registers += 1;
        if (hidden.size) {
          for (const h of hidden) hiddenSet.add(h);
          const names = [...hidden].map(nameOf);
          report.paths.push({ ...entry, status: 'hidden-register', hidden: names });
          diagnostics.push(diagnostic({ code: 'latency/hidden-register', message: `${el.kind} ${el.id} hides pipeline register${names.length > 1 ? 's' : ''} ${names.join(', ')} on the shown path ${i.net.id} → ${o.net.id} (RTL latency ${rtlLatency}, drawn ${drawnText}); pipeline registers on a shown path are drawn outside collapsed blocks`, subject: { id: el.id, from: i.net.id, to: o.net.id }, evidence: { hidden: names, rtl: rtlLatency, drawn: drawnText }, supportedFixes: ['split the block at the register boundary and draw the register as a pipeline-register bar (or register)', 'narrow the path: map the nets at the register boundary'] }));
        } else if (declared.kind === 'state') {
          report.state_pairs += 1;
          if (sinkPin && outPin) {
            const key = `${el.id}.${outPin.id}`;
            if (!stateEscape.has(key)) stateEscape.set(key, { el, pin: outPin.id, map: {} });
            const map = stateEscape.get(key).map;
            map[sinkPin.id] = Math.min(map[sinkPin.id] ?? Infinity, rtlLatency);
          }
          report.paths.push({ ...entry, status: 'state', ...(state.size ? { state: [...state].map(nameOf) } : {}) });
        } else if (declared.value === undefined) {
          report.mismatches += 1;
          report.paths.push({ ...entry, status: 'latency-undeclared' });
          diagnostics.push(diagnostic({ code: 'latency/hidden-register', message: `${el.kind} ${el.id}: output ${o.driver.pin.id} declares latency per input but not for input pin ${sinkPin?.id} (RTL latency ${rtlLatency} on ${i.net.id} → ${o.net.id})`, subject: { id: el.id, from: i.net.id, to: o.net.id }, evidence: { rtl: rtlLatency }, supportedFixes: [`add "${sinkPin?.id}": ${rtlLatency} (or "default") to the output's latency map`, 'declare latency "state" if it varies with the state'] }));
        } else if (rtlLatency !== declared.value && !memoryLike) {
          report.mismatches += 1;
          report.paths.push({ ...entry, status: 'latency-mismatch', ...(state.size ? { state: [...state].map(nameOf) } : {}) });
          const controller = declaresState(el);
          diagnostics.push(diagnostic({ code: 'latency/hidden-register', message: `${el.kind} ${el.id}: the path ${i.net.id} → ${o.net.id} has RTL latency ${rtlLatency} but the figure draws ${declared.value}`, subject: { id: el.id, from: i.net.id, to: o.net.id }, evidence: { rtl: rtlLatency, drawn: declared.value, state: [...state].map(nameOf) }, supportedFixes: [rtlLatency > declared.value ? 'draw the register stages (split the block) or mark the output port registered with its latency (internal state only)' : 'remove the registered marking from the output port', controller ? 'a stateful block output whose latency differs by input: declare latency as a map {input pin: stages}' : (state.size ? 'the block holds registers with feedback: set holds_state: true and declare latency as a map {input pin: stages}' : null), 'fix the net mappings'].filter(Boolean) }));
        } else if (onPath.size) {
          report.paths.push({ ...entry, status: 'ok', ...(state.size ? { state: [...state].map(nameOf) } : {}) });
        }
      }
    }
  }
  report.hidden_registers = hiddenSet.size;
  report.hidden = [...hiddenSet].map(nameOf);

  // "state" claims no number; where every drawn input reaches the output with a
  // measured minimum latency, the per-input map says more and is compared.
  for (const { el, pin, map } of stateEscape.values()) {
    const text = Object.entries(map).map(([k, v]) => `${k}: ${v}`).join(', ');
    diagnostics.push(diagnostic({ code: 'latency/state-escape', severity: 'warning', message: `${el.kind} ${el.id}: output ${pin} declares latency "state", but the netlist gives a fixed latency from its drawn inputs (${text}); a per-input map would be verified`, subject: { id: el.id, pin }, evidence: { measured: map }, supportedFixes: [`declare latency ${JSON.stringify(map)}`, 'keep "state" only on outputs that no drawn input reaches'] }));
  }

  // holds_state is a claim about the RTL: the block represents a register with feedback.
  const registersOf = (el) => {
    const out = new Set();
    const subtree = (p) => { for (const s of flat.signals.values()) if (s.register && (s.instance === p || s.instance.startsWith(`${p}.`))) out.add(canon(s.path)); };
    if (el.kind === 'instance' && el.rtl?.instance) subtree(relToPath(flat, el.rtl.instance));
    for (const entry of el.rtl?.covers || []) {
      const [instPart, sigPart] = entry.includes(':') ? entry.split(':') : [null, entry];
      if (instPart === null && flat.instances.has(relToPath(flat, entry))) { subtree(relToPath(flat, entry)); continue; }
      const instPath = relToPath(flat, instPart ?? el.rtl?.instance ?? base);
      const re = globRe(sigPart);
      for (const s of flat.signals.values()) if (s.register && s.instance === instPath && re.test(s.name)) out.add(canon(s.path));
    }
    return [...out];
  };
  for (const el of (doc.elements || []).filter((e) => e.holds_state === true && !STATEFUL_KINDS.includes(e.function?.kind))) {
    const regs = registersOf(el);
    if (regs.slice(0, 400).some(feedback)) continue;
    diagnostics.push(diagnostic({ code: 'latency/holds-state', message: `${el.kind} ${el.id} declares holds_state, but ${regs.length ? `none of its ${regs.length} register${regs.length > 1 ? 's' : ''} has feedback` : 'its rtl.covers and rtl.instance name no register'} in the netlist`, subject: { id: el.id }, evidence: { registers: regs.length }, supportedFixes: ['remove holds_state and give each output one latency', 'fix rtl.covers or rtl.instance to name the state registers'] }));
  }

  // A figure that draws registers of its scope but compares no latency pair
  // leaves the drawn timing unverified.
  const scope = declaredScope(doc, flat);
  const inScope = (inst) => inst === scope.path || (scope.hierarchy === 'all' && inst.startsWith(`${scope.path}.`));
  let registers = 0;
  for (const s of flat.signals.values()) if (s.register && !s.name.startsWith('_V') && inScope(s.instance)) registers += 1;
  const compared = report.pairs_checked - report.state_pairs;
  if (registers && compared === 0) {
    const scopeName = scope.instance || flat.top;
    const why = `${report.pairs_checked} pair${report.pairs_checked === 1 ? '' : 's'} traced, ${report.state_pairs} declared "state", ${report.excluded_unmapped.length} net${report.excluded_unmapped.length === 1 ? '' : 's'} drawn unmapped`;
    const reason = doc.latency_unverified?.reason;
    if (reason) diagnostics.push(diagnostic({ code: 'latency/unverified', severity: 'info', message: `scope ${scopeName} holds ${registers} registers and no latency pair is compared (${why}); opted out: ${reason}`, subject: { scope: scope.instance }, evidence: { registers, pairs_checked: report.pairs_checked, state_pairs: report.state_pairs, reason }, supportedFixes: [] }));
    else diagnostics.push(diagnostic({ code: 'latency/unverified', severity: quality === 'paper' ? 'error' : 'warning', message: `scope ${scopeName} holds ${registers} registers, but no drawn latency pair is compared (${why}): the figure's timing is unverified`, subject: { scope: scope.instance }, evidence: { registers, pairs_checked: report.pairs_checked, state_pairs: report.state_pairs, excluded_unmapped: report.excluded_unmapped.length }, supportedFixes: ['map the nets on both sides of the blocks that hold the registers', 'declare latency per input pin ({input pin: stages}) on blocks that hold state (function.kind controller, or holds_state: true) instead of drawing their nets unmapped', 'draw the registers', 'opt out explicitly: latency_unverified: { reason: "…" }'] }));
  }
  return { diagnostics, report };
}
