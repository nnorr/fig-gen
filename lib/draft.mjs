// Draft a starting datapath figure from a normalized netlist for a view
// preset (SPEC §4.8). The draft is a starting point the author refines; every
// check still applies to it.
//
// What is drawn:
//   - the scope's ports become figure ports (clock and reset stay implicit);
//   - instances inside the drawn depth are expanded, others are collapsed into
//     instance blocks with their RTL ports (overview/block/mixed: depth 0,
//     detail: depth n). A collapsed child that holds pipeline registers is
//     expanded anyway, so pipeline registers on shown paths stay visible;
//     children holding a blackbox stub are memories and stay collapsed;
//   - the local logic of each expanded instance is split at its pipeline
//     registers: one functional block per stage, one pipeline-register bar per
//     stage boundary. Registers with feedback, several sources or array
//     storage are internal state and stay inside their stage block;
//   - selected gate regions (mixed) are expanded to gates from the RTL cone.
// Signals crossing between drawn elements become nets: single signals are
// mapped (rtl.signal); several signals between the same two elements, and
// narrow control ports into the same element, are bundled.
// Names follow the naming rules: a vocabulary function inferred from the
// operations in the block's RTL cone (with function.basis citing it), else a
// readable generic name for the author to refine.

import { VOCABULARY, distinctInstanceNames, primaryName, readableIdentifier, readableInstanceSegment } from './checks/labels.mjs';
import { coneCategories } from './checks/function-evidence.mjs';
import { aliasClasses } from './checks/coverage.mjs';
import { STATEFUL_KINDS } from './checks/datapath.mjs';
import { checkLatency } from './checks/latency.mjs';
import { pinLatencyFrom } from './ir/datapath-model.mjs';
import { mergeDuplicateSplits } from './ir/canonical.mjs';
import { expandToGates, resolveCone } from './rtl/cone.mjs';
import { flattenNetlist } from './rtl/flatten.mjs';
import { PRESETS } from './view.mjs';

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1').slice(0, 60);
const EXPANDABLE = new Set(['ref', 'const', 'and', 'or', 'xor', 'not', 'land', 'lor', 'lnot', 'redand', 'redor', 'redxor', 'cond', 'sel', 'index', 'concat', 'extend']);

function expandableTree(n) {
  if (!n || typeof n !== 'object') return true;
  if (n.op === 'eq' || n.op === 'neq') return (n.args || []).some((a) => a.op === 'const') && n.args.every(expandableTree);
  if (!EXPANDABLE.has(n.op)) return false;
  return (n.args || []).every(expandableTree);
}

// Parse "name=[instance:]out1,out2[;stop1,stop2]" into a gate-region spec.
export function parseGateRegion(text) {
  const [head, stops] = String(text).split(';');
  const [name, outs] = head.includes('=') ? head.split('=') : [head, head];
  return { name: sanitize(name), outputs: outs.split(',').filter(Boolean), stop: (stops || '').split(',').filter(Boolean) };
}

// A draft that runs too long or covers too much stops with this error instead
// of hanging; its diagnostic names where it stopped and how to narrow the scope.
export class DraftBudgetError extends Error {
  constructor(diagnostic) {
    super(diagnostic.message);
    this.name = 'DraftBudgetError';
    this.diagnostic = diagnostic;
  }
}
export const DRAFT_BUDGET = { seconds: 120, signals: 50000 };
let budgetTick = null;
let budgetState = null;

function budgetDiagnostic(s, reason) {
  const largest = s.children.slice(0, 3).map((c) => `${c.path} (${c.signals} signals)`).join(', ');
  return {
    code: 'draft/budget-exceeded', severity: 'error',
    message: `draft of ${s.scope || '(top)'} at depth ${s.depth ?? '?'} stopped: ${reason} (while ${s.phase}; ${s.expanded} expanded instances, ${s.signals} signals in scope)`,
    subject: { scope: s.scope },
    evidence: { phase: s.phase, seconds: s.seconds, max_signals: s.maxSignals, expanded: s.expanded, signals: s.signals, largest_children: s.children.slice(0, 5) },
    supportedFixes: [...(largest ? [`narrow --scope to one child: ${largest}`] : []), 'lower --depth', 'draft the largest child on its own and --blackbox it here', 'raise the limit with --budget-seconds if the scope really needs it'],
  };
}

// Study figures are for reading the RTL: the draft shows structure by default
// (a detail view one level deep, also for the whole design). A time and size
// budget bounds every draft.
export function draftFigure(netlist, options = {}) {
  const opts = { ...options };
  const studyNotes = [];
  if (opts.format === 'study') {
    if (!opts.preset) { opts.preset = 'detail'; studyNotes.push('study format: detail view by default, so the children of the scope are drawn'); }
    else if (opts.preset !== 'detail' && !opts.scope) { studyNotes.push(`study format: the whole design is drafted as a detail view (not ${opts.preset}) so its structure shows`); opts.preset = 'detail'; }
  }
  const seconds = opts.budget?.seconds ?? DRAFT_BUDGET.seconds;
  const started = Date.now();
  const state = { phase: 'reading the netlist', scope: opts.scope ?? '', depth: opts.depth, expanded: 0, signals: 0, children: [], seconds, maxSignals: opts.budget?.signals ?? DRAFT_BUDGET.signals };
  budgetState = state;
  budgetTick = (phase) => {
    if (phase) state.phase = phase;
    if (Date.now() - started > seconds * 1000) throw new DraftBudgetError(budgetDiagnostic(state, `it did not finish within ${seconds} s`));
  };
  try {
    return draftFigureInner(netlist, { ...opts, studyNotes });
  } finally {
    budgetTick = null;
    budgetState = null;
  }
}

function draftFigureInner(netlist, { format, preset = 'block', scope = '', depth, gateRegions = [], blackbox = [], title, repository, studyNotes = [] } = {}) {
  if (!PRESETS.includes(preset)) throw new Error(`unknown view preset '${preset}' (use ${PRESETS.join(', ')})`);
  const notes = [...studyNotes];
  // Element ids are unique even when long hierarchical names truncate alike.
  const usedIds = new Set();
  const uid = (base) => {
    let id = sanitize(base);
    if (usedIds.has(id)) {
      let k = 2;
      while (usedIds.has(`${id.slice(0, 56)}_${k}`)) k += 1;
      id = `${id.slice(0, 56)}_${k}`;
    }
    usedIds.add(id);
    return id;
  };
  const flat = flattenNetlist(netlist);
  const aliases = aliasClasses(netlist);
  const canon = (p) => aliases.find(p);
  const P = (rel) => [flat.top, ...(rel ? rel.split('/') : [])].join('.');
  const R = (p) => (p === flat.top ? '' : p.slice(flat.top.length + 1).replace(/\./g, '/'));
  const scopePath = P(scope);
  const scopeMod = flat.instances.get(scopePath);
  if (!scopeMod) throw new Error(`scope ${scope || '(top)'} is not an instance of ${flat.top}`);
  const maxDepth = preset === 'detail' ? (depth ?? 1) : 0;
  const inScopePath = (p) => p === P(scope) || p.startsWith(`${P(scope)}.`);
  const outside = blackbox.filter((b) => !inScopePath(P(b)));
  for (const b of outside) notes.push(`blackbox ${b} is outside the scope ${scope || '(top)'}: add it as context (level blackbox) by hand if the figure should show it`);
  blackbox = blackbox.filter((b) => inScopePath(P(b)));
  const bbPaths = new Set(blackbox.map((b) => P(b)));
  const specs = gateRegions.map((g) => (typeof g === 'string' ? parseGateRegion(g) : g));

  // Canonical dependency graph.
  const back = new Map();
  for (const [t, list] of flat.back) {
    const ct = canon(t);
    for (const { source, kind } of list) {
      const cs = canon(source);
      if (cs === ct) continue;
      if (!back.has(ct)) back.set(ct, []);
      back.get(ct).push({ s: cs, seq: kind === 'seq', raw: source, rawTarget: t, port: kind === 'port' });
    }
  }
  const moduleOf = (instPath) => flat.instances.get(instPath);
  const resetsOf = (instPath) => new Set((moduleOf(instPath)?.registers || []).map((r) => r.reset?.net).filter(Boolean).map((n) => canon(`${instPath}.${n}`)));
  const clocksOf = (instPath) => new Set((moduleOf(instPath)?.registers || []).flatMap((r) => [r.clock?.net, r.reset?.net].filter(Boolean)).map((n) => canon(`${instPath}.${n}`)));
  const allClocks = new Set([...flat.instances.keys()].flatMap((p) => [...clocksOf(p)]));
  const selfDep = new Set();
  for (const [t, list] of flat.back) if (list.some((e) => e.source === t)) selfDep.add(canon(t));
  const feedback = (r) => {
    if (selfDep.has(r)) return true;
    const seen = new Set();
    const q = (back.get(r) || []).map((e) => e.s);
    while (q.length) {
      const v = q.shift();
      budgetTick?.();
      if (v === r) return true;
      if (seen.has(v) || seen.size > 20000) continue;
      seen.add(v);
      for (const e of back.get(v) || []) q.push(e.s);
    }
    return false;
  };
  const hasStub = (instPath) => [...flat.instances.entries()].some(([p, m]) => (p === instPath || p.startsWith(`${instPath}.`)) && m.blackbox);
  // A pipeline register: one data source, no feedback, not an array.
  const isPipeline = (instPath, reg) => {
    const r = canon(`${instPath}.${reg.name}`);
    const srcs = (back.get(r) || []).filter((e) => !allClocks.has(e.s));
    return srcs.length === 1 && !feedback(r);
  };
  const holdsPipeline = (instPath) => {
    if (hasStub(instPath)) return false;
    const m = moduleOf(instPath);
    if (m.registers.some((reg) => isPipeline(instPath, reg))) return true;
    return m.instances.some((i) => holdsPipeline(`${instPath}.${i.name}`));
  };

  // Expanded instances.
  const expanded = new Set([scopePath]);
  const gateInstances = new Set(specs.map((g) => P(g.outputs[0].includes(':') ? g.outputs[0].split(':')[0] : scope)));
  const visit = (instPath, d) => {
    for (const i of moduleOf(instPath).instances) {
      const child = `${instPath}.${i.name}`;
      if (moduleOf(child)?.blackbox || bbPaths.has(child)) continue;
      const force = [...gateInstances].some((g) => g === child || g.startsWith(`${child}.`));
      if (d < maxDepth || force || holdsPipeline(child)) {
        if (!(d < maxDepth || force) && holdsPipeline(child)) notes.push(`${R(child)} expanded: it holds pipeline registers on its paths`);
        expanded.add(child);
        visit(child, d + 1);
      }
    }
  };
  visit(scopePath, 0);
  if (budgetState) {
    const inScope = [...flat.signals.values()].filter((s) => inScopePath(s.instance));
    Object.assign(budgetState, {
      scope, depth: maxDepth, expanded: expanded.size, signals: inScope.length,
      children: scopeMod.instances.map((i) => { const p = `${scopePath}.${i.name}`; return { path: R(p), signals: inScope.filter((s) => s.instance === p || s.instance.startsWith(`${p}.`)).length }; }).sort((a, b) => b.signals - a.signals),
    });
    if (budgetState.signals > budgetState.maxSignals) { budgetState.phase = 'sizing the scope'; throw new DraftBudgetError(budgetDiagnostic(budgetState, `the scope holds more than ${budgetState.maxSignals} signals`)); }
  }
  budgetTick?.('drafting collapsed children');

  const elements = [];
  const owner = new Map(); // canonical signal -> { el, kind, lane? }
  const claim = (sigPath, o, force = false) => { const c = canon(sigPath); if (force || !owner.has(c)) owner.set(c, o); };
  const localSignals = (instPath) => [...flat.signals.values()].filter((s) => s.instance === instPath && !s.name.startsWith('_V'));

  // Figure ports of the scope boundary.
  const scopeClocks = clocksOf(scopePath);
  const outPorts = [];
  for (const p of scopeMod.ports) {
    const sig = `${scopePath}.${p.name}`;
    if (scopeClocks.has(canon(sig)) || allClocks.has(canon(sig))) continue;
    const id = uid(`p_${p.name}`);
    elements.push({ id, kind: 'port', dir: p.dir === 'out' ? 'out' : 'in', width: p.width, label: p.name.replace(/_[io]$/, '').replace(/_/g, ' '), rtl: { signal: p.name } });
    if (p.dir === 'out') outPorts.push({ id, sig });
    else claim(sig, { el: id, kind: 'port', dir: p.dir });
  }

  // Collapsed children.
  const instanceEls = new Map();
  const varyingPins = new Map(); // "element.pin" -> reason its nets are drawn unmapped
  for (const instPath of expanded) {
    for (const i of moduleOf(instPath).instances) {
      const child = `${instPath}.${i.name}`;
      if (expanded.has(child)) continue;
      budgetTick?.(`drafting collapsed child ${R(child)}`);
      const m = moduleOf(child);
      const traits = moduleTraits(m);
      // A collapsed instance is a controller when its state machine sits in a child (e.g. a client around a stream FSM).
      if (!traits.controller) {
        const nested = [...flat.instances.entries()].filter(([p]) => p.startsWith(`${child}.`)).flatMap(([, mm]) => mm.registers || []).find((r) => r.enum);
        if (nested) traits.controller = nested.name;
      }
      const memory = hasStub(child) || (!traits.fifo && m.registers.some((r) => r.array) && !m.instances.length);
      // Instance names usually start with u_ already: no doubled prefix (u_u_ctrl).
      const relName = R(child).replace(/\//g, '_');
      const id = uid(/^u_/.test(relName) ? relName : `u_${relName}`);
      const cats = new Set();
      const srcLines = [];
      for (const mm of [...flat.instances.entries()].filter(([p]) => p === child || p.startsWith(`${child}.`)).map(([, x]) => x)) for (const e of mm.exprs || []) { coneCategories(e.expr).forEach((c) => cats.add(c)); if (e.source) srcLines.push(e.source); }
      const perOutput = outputConeCats(m, m.ports.filter((q) => q.dir === 'out').map((q) => q.name));
      const fn = memory ? { kind: 'memory' } : inferFunction(cats, humanName(m.orig_name), notes, id, srcLines, { ...traits, perOutput: perOutput.length ? perOutput : undefined });
      const el = {
        id, kind: 'instance', module: sanitize(m.orig_name), level: bbPaths.has(child) || m.blackbox ? 'blackbox' : 'block',
        ...(hasStub(child) ? { internals: 'stub' } : {}), pin_labels: false, function: fn, rtl: { instance: R(child) },
        ports: m.ports.map((q) => ({ id: q.name, dir: q.dir === 'out' ? 'out' : 'in', width: q.width, ...(allClocks.has(canon(`${child}.${q.name}`)) ? { class: [...flat.instances.keys()].some((ip) => resetsOf(ip).has(canon(`${child}.${q.name}`))) ? 'reset' : 'clock' } : {}) })),
      };
      // Registered outputs: minimum register stages from any input port. An
      // output whose latency differs by input is a controller output (declared
      // per input) or, for any other block, drawn unmapped with the reason.
      const dataInPorts = m.ports.filter((x) => x.dir !== 'out' && !allClocks.has(canon(`${child}.${x.name}`)));
      for (const q of el.ports.filter((x) => x.dir === 'out')) {
        const lat = minStages(back, canon(`${child}.${q.id}`), new Set(m.ports.filter((x) => x.dir !== 'out').map((x) => canon(`${child}.${x.name}`))), allClocks, memory ? 'max' : 'min');
        if (lat >= 1) { q.registered = true; if (lat > 1) q.latency = lat; }
        if (memory) continue;
        const per = Object.fromEntries(dataInPorts.map((x) => [x.name, stagesBetween(back, canon(`${child}.${q.id}`), canon(`${child}.${x.name}`), allClocks)]).filter(([, v]) => v !== null));
        // A combinational output lists the inputs with a register-free path to it.
        if (!q.registered) {
          const comb = Object.keys(per).filter((k) => per[k] === 0).sort();
          if (comb.length < dataInPorts.length) q.comb_from = comb;
        }
        const values = [...new Set(Object.values(per))];
        // A controller output that no input reaches (a reset or status driven
        // from its state alone) is a state output, not a path from an input.
        if (fn.kind === 'controller' && !values.length && dataInPorts.length) {
          delete q.registered;
          delete q.comb_from;
          q.latency = 'state';
          notes.push(`${id}.${q.id}: no input reaches this controller output; declared a state output`);
          continue;
        }
        if (values.length < 2) continue;
        if (fn.kind === 'controller') {
          delete q.registered;
          delete q.comb_from;
          q.latency = per;
          notes.push(`${id}.${q.id}: controller output whose latency differs by input (${values.join(', ')}); declared per input`);
        } else {
          varyingPins.set(`${id}.${q.id}`, `latency of ${id}.${q.id} differs by input (${values.join(', ')}) and ${id} is not a controller`);
        }
      }
      elements.push(el);
      instanceEls.set(child, el);
      const inputClasses = new Set(m.ports.filter((q) => q.dir !== 'out').map((q) => canon(`${child}.${q.name}`)));
      for (const s of [...flat.signals.values()].filter((x) => x.instance === child || x.instance.startsWith(`${child}.`))) {
        if (inputClasses.has(canon(s.path))) continue;
        claim(s.path, { el: id, kind: 'instance', inst: child });
      }
    }
  }

  // Gate regions: RTL cones expanded to gates; signals read outside the cone stop it.
  const gateOwned = new Set();
  const regions = [];
  const gateFragments = [];
  for (const g of specs) {
    const instRel = g.outputs[0].includes(':') ? g.outputs[0].split(':')[0] : scope;
    const instPath = P(instRel);
    const mod = moduleOf(instPath);
    const outs = g.outputs.map((o) => (o.includes(':') ? o.split(':')[1] : o));
    const table = new Map((mod.exprs || []).map((e) => [e.index !== undefined ? `${e.target}[${e.index}]` : e.target, e]));
    const readers = (name) => (mod.deps || []).filter((d) => d.sources.includes(name)).map((d) => d.target);
    let stops = new Set([...g.stop, ...outs]);
    let interior;
    for (let it = 0; it < 8; it += 1) {
      interior = new Set();
      const walk = (name) => {
        const e = table.get(name);
        if (!e || !expandableTree(e.expr) || mod.registers.some((r) => r.name === name)) { stops.add(name); return; }
        interior.add(name);
        const refs = [];
        (function collect(n) { if (!n || typeof n !== 'object') return; if (n.op === 'ref') refs.push(n.name); (n.args || []).forEach(collect); })(e.expr);
        for (const r of refs) if (!stops.has(r) && !interior.has(r)) walk(r);
      };
      for (const o of outs) {
        const e = table.get(o);
        if (!e) throw new Error(`gate region ${g.name}: no continuous assignment to ${o} in ${mod.orig_name}`);
        const refs = [];
        (function collect(n) { if (!n || typeof n !== 'object') return; if (n.op === 'ref') refs.push(n.name); (n.args || []).forEach(collect); })(e.expr);
        for (const r of refs) if (!stops.has(r) || outs.includes(r)) { if (!outs.includes(r)) walk(r); }
      }
      const leak = [...interior].filter((s) => readers(s).some((t) => !interior.has(t) && !outs.includes(t)));
      if (!leak.length) break;
      leak.forEach((s) => stops.add(s));
    }
    const members = [];
    for (const o of outs) {
      const cone = resolveCone(mod, { output: o, stopAt: [...stops].filter((s) => s !== o) });
      if (cone.error) throw new Error(`gate region ${g.name}: ${cone.error}`);
      const x = expandToGates(cone, { prefix: sanitize(`${g.name}_${o}`), outputLabel: o, maxGates: 60 });
      for (const d of x.diagnostics) notes.push(`${g.name}: ${d.message}`);
      gateFragments.push({ region: g.name, instPath, output: o, x, cone });
      members.push(...x.elements.filter((e) => e.kind !== 'port').map((e) => e.id));
    }
    for (const s of interior) { gateOwned.add(canon(`${instPath}.${s}`)); }
    regions.push({ id: g.name, label: `${g.name.replace(/_/g, ' ')} (gates)`, level: 'gate', rtl: { instance: R(instPath) }, members });
    notes.push(`gate region ${g.name}: outputs ${outs.join(', ')}; cone inputs ${[...new Set(gateFragments.filter((f) => f.region === g.name).flatMap((f) => f.cone.inputs.map((i) => i.key)))].join(', ')}`);
  }

  // Local logic of expanded instances: stage blocks and pipeline bars.
  const bars = [];
  const barInst = new Map(); // pipeline bar id -> instance path
  const blocksOf = new Map();
  for (const instPath of expanded) {
    budgetTick?.(`grouping the local logic of ${R(instPath) || '(top)'}`);
    const m = moduleOf(instPath);
    const clocks = clocksOf(instPath);
    const locals = localSignals(instPath).filter((s) => !(instPath === scopePath && s.portDir && s.portDir !== 'out') && !allClocks.has(canon(s.path)) && !gateOwned.has(canon(s.path)));
    const inputs = instPath === scopePath ? scopeMod.ports.filter((p) => p.dir !== 'out').map((p) => canon(`${instPath}.${p.name}`)) : m.ports.filter((p) => p.dir !== 'out').map((p) => canon(`${instPath}.${p.name}`));
    const pipelineRegs = new Set(m.registers.filter((r) => isPipeline(instPath, r)).map((r) => canon(`${instPath}.${r.name}`)));
    // stage = minimum pipeline registers from the instance inputs (forward 0-1 BFS).
    const fwd = new Map();
    for (const [t, list] of back) for (const e of list) { if (!fwd.has(e.s)) fwd.set(e.s, []); fwd.get(e.s).push(t); }
    const stage = new Map(inputs.map((i) => [i, 0]));
    const localSet = new Set(localSignals(instPath).map((s) => canon(s.path)));
    for (let changed = true, guard = 0; changed && guard < 200; guard += 1) {
      budgetTick?.();
      changed = false;
      for (const [t, list] of back) {
        if (!localSet.has(t) && !inputs.includes(t)) continue;
        for (const e of list) {
          if (!stage.has(e.s) || allClocks.has(e.s)) continue;
          const nd = Math.min(64, stage.get(e.s) + (pipelineRegs.has(t) ? 1 : 0));
          if (!stage.has(t) || stage.get(t) < nd) { stage.set(t, nd); changed = true; }
        }
      }
    }
    // Signals no input reaches (constants, free-running state) sit with their earliest reader.
    for (const s of localSignals(instPath)) {
      const c = canon(s.path);
      if (stage.has(c)) continue;
      const rs = (fwd.get(c) || []).filter((t) => stage.has(t)).map((t) => stage.get(t) - (pipelineRegs.has(t) ? 1 : 0));
      stage.set(c, rs.length ? Math.max(0, Math.min(...rs)) : 0);
    }
    const groups = new Map();
    const boundaries = new Map();
    const assigned = new Set([...(m.deps || []).map((d) => d.target), ...m.registers.map((r) => r.name)]);
    // The controller is its own block, not a lump with the datapath: an
    // enumerated state register, the logic read only by the controller (its
    // next state) and the signals computed from its state alone (decoded
    // outputs). Other registers and everything else stay in stage blocks.
    const drawnLocal = new Map(locals.filter((s) => assigned.has(s.name) && !(owner.has(canon(s.path)) && owner.get(canon(s.path)).kind !== 'port')).map((s) => [canon(s.path), s]));
    const registerNames = new Set(m.registers.map((r) => r.name));
    const ctrl = new Set(m.registers.filter((r) => r.enum).map((r) => canon(`${instPath}.${r.name}`)).filter((c) => drawnLocal.has(c) && !pipelineRegs.has(c)));
    for (let grew = ctrl.size > 0; grew;) {
      grew = false;
      for (const [c, s] of drawnLocal) {
        if (ctrl.has(c) || registerNames.has(s.name)) continue;
        const readers = (fwd.get(c) || []).filter((t) => drawnLocal.has(t));
        const deps = (back.get(c) || []).map((e) => e.s).filter((x) => drawnLocal.has(x));
        const nextState = readers.length > 0 && readers.every((t) => ctrl.has(t));
        const decoded = deps.length > 0 && deps.every((x) => ctrl.has(x));
        if (nextState || decoded) { ctrl.add(c); grew = true; }
      }
    }
    // A study draft also draws each stage's state apart from its combinational
    // logic: the other registers (not pipeline registers) with the logic read
    // only by them (their next state). Block outputs then have one timing
    // each, registered or combinational, so a loop check on pins sees the RTL's
    // paths instead of a lump where every input seems to reach every output.
    const stateSet = new Set();
    if (format === 'study') {
      for (const [c, s] of drawnLocal) if (registerNames.has(s.name) && !ctrl.has(c) && !pipelineRegs.has(c)) stateSet.add(c);
      for (let grew = stateSet.size > 0; grew;) {
        grew = false;
        for (const [c, s] of drawnLocal) {
          if (stateSet.has(c) || ctrl.has(c) || registerNames.has(s.name)) continue;
          const readers = (fwd.get(c) || []).filter((t) => drawnLocal.has(t));
          if (readers.length > 0 && readers.every((t) => stateSet.has(t))) { stateSet.add(c); grew = true; }
        }
      }
    }
    const stateGroups = new Map();
    const ctrlSigs = [];
    for (const s of locals) {
      const c = canon(s.path);
      if (!assigned.has(s.name)) continue; // a connection wire: owned by whatever drives it
      if (owner.has(c) && owner.get(c).kind !== 'port') continue; // aliases of collapsed child ports
      if (ctrl.has(c)) { ctrlSigs.push(s); continue; }
      if (stateSet.has(c)) {
        const k = stage.get(c) ?? 0;
        if (!stateGroups.has(k)) stateGroups.set(k, []);
        stateGroups.get(k).push(s);
        continue;
      }
      if (pipelineRegs.has(c)) {
        const k = (stage.get(c) ?? 1) - 1;
        if (!boundaries.has(k)) boundaries.set(k, []);
        boundaries.get(k).push(s);
      } else {
        const k = stage.get(c) ?? 0;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
      }
    }
    const tag = R(instPath).replace(/\//g, '_') || 'top';
    const stageCount = Math.max(0, ...groups.keys(), ...[...boundaries.keys()].map((k) => k + 1)) + 1;
    for (const [k, sigs] of [...boundaries].sort((a, b) => a[0] - b[0])) {
      const id = uid(`p_${tag}_s${k}`);
      const el = { id, kind: 'pipeline_register', domain: 'sys', stage: k + 1, label: `S${k}|S${k + 1}`, lanes: sigs.map((s) => ({ id: sanitize(s.name), width: s.bits })) };
      elements.push(el);
      bars.push(el);
      barInst.set(el.id, instPath);
      for (const s of sigs) claim(s.path, { el: id, kind: 'lane', lane: sanitize(s.name), inst: instPath }, true);
    }
    const blockGroups = [...groups].sort((a, b) => a[0] - b[0]);
    const named = [];
    const placeName = R(instPath) ? capitalize(readableInstanceSegment(R(instPath).split('/').at(-1))) : humanName(m.orig_name);
    // Outputs of a group of signals: signals read outside it, or ports of the instance.
    const outputsOf = (sigs) => {
      const inGroup = new Set(sigs.map((s) => canon(s.path)));
      return sigs.filter((s) => s.portDir === 'out' || (fwd.get(canon(s.path)) || []).some((t) => !inGroup.has(t))).map((s) => s.name);
    };
    // A study figure splits a stage lump with many outputs into its
    // independent output cones (signals linked by dependencies inside the
    // group): a shared bus or a set of unrelated selects becomes small blocks
    // named after what they drive, not one hub that every wire passes through.
    const conesOf = (sigs) => {
      const names = new Set(sigs.map((s) => s.name));
      const parent = new Map(sigs.map((s) => [s.name, s.name]));
      const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); return r; };
      for (const d of m.deps || []) if (names.has(d.target)) for (const src of d.sources) if (names.has(src)) parent.set(find(d.target), find(src));
      const parts = new Map();
      for (const s of sigs) { const r = find(s.name); if (!parts.has(r)) parts.set(r, []); parts.get(r).push(s); }
      return [...parts.values()];
    };
    // Only a hub is split: at least three cones, none driving more than one of
    // the lump's outputs (a shared bus fanned in from several instances).
    // Logic with a cone that drives several outputs stays one block: splitting
    // it adds wires between the parts and makes the figure harder to follow.
    const blockParts = blockGroups.flatMap(([k, sigs]) => {
      const groupOuts = new Set(outputsOf(sigs));
      const cones = format === 'study' && groupOuts.size > 4 ? conesOf(sigs) : [sigs];
      const hub = cones.length > 2 && cones.every((p) => p.filter((s) => groupOuts.has(s.name)).length <= 1);
      return (hub ? cones : [sigs]).map((p) => [k, p, hub, groupOuts]);
    });
    for (const [k, sigs, split, groupOuts] of blockParts) {
      const id = uid(`b_${tag}_s${k}`);
      const cats = new Set();
      const lines = [];
      for (const s of sigs) for (const e of (m.exprs || []).filter((x) => x.target === s.name)) { coneCategories(e.expr).forEach((c) => cats.add(c)); if (e.source) lines.push(e.source); }
      const stateReg = sigs.map((s) => m.registers.find((r) => r.name === s.name)).find((r) => r?.enum);
      const outNames = split ? sigs.filter((s) => groupOuts.has(s.name)).map((s) => s.name) : outputsOf(sigs);
      const perOutput = outputConeCats(m, outNames, new Set(sigs.map((s) => s.name)));
      // A lump without a name that fits all of it is named after its instance;
      // a cone split off a hub is named after the output(s) it drives.
      // A cone that drives none of the hub's outputs is logic nothing reads.
      const drives = outNames.map(readableIdentifier);
      const named2 = `${drives[0]} and ${drives[1]} logic`;
      const fallback = split && !drives.length ? `${placeName} unused logic`
        : split && drives.length === 1 ? `${capitalize(drives[0])} logic`
          : split && drives.length === 2 && named2.length <= 40 ? capitalize(named2)
            : split && `${drives[0]} and related logic`.length <= 40 ? `${capitalize(drives[0])} and related logic`
              : `${placeName} ${blockGroups.length > 1 ? `stage ${k}` : 'logic'}`;
      const fn = inferFunction(cats, fallback, notes, id, lines, { controller: stateReg ? stateReg.name : null, perOutput });
      if (blockGroups.length > 1 && fn.kind !== 'custom' && !split) fn.stage = `${named.filter((n) => n.fn.kind === fn.kind).length + 1}/${blockGroups.filter(() => true).length}`;
      const el = { id, kind: 'comb', op: 'custom', width: 1, pin_labels: false, function: fn, rtl: { covers: sigs.map((s) => (R(instPath) ? `${R(instPath)}:${s.name}` : s.name)) }, ports: [] };
      if (!split) named.push({ el, fn });
      if (!blocksOf.has(instPath)) blocksOf.set(instPath, []);
      blocksOf.get(instPath).push(el);
      elements.push(el);
      for (const s of sigs) claim(s.path, { el: id, kind: 'block', inst: instPath });
    }
    for (const [k, sigs] of [...stateGroups].sort((a, b) => a[0] - b[0])) {
      const id = uid(`b_${tag}_s${k}_state`);
      const cats = new Set();
      const lines = [];
      for (const s of sigs) for (const e of (m.exprs || []).filter((x) => x.target === s.name)) { coneCategories(e.expr).forEach((c) => cats.add(c)); if (e.source) lines.push(e.source); }
      // State is named by structure only (FIFO, counter) or as the module's
      // state: the next-state cone of a register group names no function.
      const traits = moduleTraits({ ...m, registers: m.registers.filter((r) => sigs.some((s) => s.name === r.name)) });
      const fn = inferFunction(new Set(), `${placeName} state`, notes, id, lines, { fifo: traits.fifo, counter: traits.counter });
      void cats;
      const el = { id, kind: 'comb', op: 'custom', width: 1, pin_labels: false, function: fn, rtl: { covers: sigs.map((s) => (R(instPath) ? `${R(instPath)}:${s.name}` : s.name)) }, ports: [] };
      if (!blocksOf.has(instPath)) blocksOf.set(instPath, []);
      blocksOf.get(instPath).push(el);
      elements.push(el);
      for (const s of sigs) claim(s.path, { el: id, kind: 'block', inst: instPath });
    }
    if (ctrlSigs.length) {
      const id = uid(`b_${tag}_ctrl`);
      const stateReg = ctrlSigs.map((s) => m.registers.find((r) => r.name === s.name)).find((r) => r?.enum);
      const lines = ctrlSigs.flatMap((s) => (m.exprs || []).filter((x) => x.target === s.name && x.source).map((x) => x.source));
      const fn = inferFunction(new Set(), humanName(m.orig_name), notes, id, lines, { controller: stateReg.name });
      const el = { id, kind: 'comb', op: 'custom', width: 1, pin_labels: false, function: fn, rtl: { covers: ctrlSigs.map((s) => (R(instPath) ? `${R(instPath)}:${s.name}` : s.name)) }, ports: [] };
      if (!blocksOf.has(instPath)) blocksOf.set(instPath, []);
      blocksOf.get(instPath).push(el);
      elements.push(el);
      for (const s of ctrlSigs) claim(s.path, { el: id, kind: 'block', inst: instPath });
      notes.push(`${id}: controller of ${R(instPath) || '(top)'} drawn apart from its datapath: state register ${stateReg.name} with ${ctrlSigs.length - 1} signal(s) of next-state and decoded-output logic`);
    }
    // Stage numbering on functions that share a kind.
    const byKind = new Map();
    for (const n of named.filter((x) => x.fn.kind !== 'custom')) { if (!byKind.has(n.fn.kind)) byKind.set(n.fn.kind, []); byKind.get(n.fn.kind).push(n); }
    for (const list of byKind.values()) list.forEach((n, i) => { if (list.length > 1) n.fn.stage = `${i + 1}/${list.length}`; else delete n.fn.stage; });
    void stageCount;
    void clocks;
  }

  // Gate fragments: members and their output owners.
  for (const f of gateFragments) {
    for (const e of f.x.elements.filter((x) => x.kind !== 'port')) elements.push(e);
    const outNet = f.x.nets.find((n) => n.sinks.includes(f.x.output));
    claim(`${f.instPath}.${f.output}`, { el: outNet.driver.split('.')[0], kind: 'gate', pin: outNet.driver.split('.')[1] }, true);
    const coverName = R(f.instPath) ? `${R(f.instPath)}:${f.output}` : f.output;
    for (const el of elements.filter((x) => x.rtl?.covers)) el.rtl.covers = el.rtl.covers.filter((cv) => cv !== coverName);
  }

  // A plain copy of a gate-region output (e.g. an output port assigned from it)
  // belongs to the gate that drives it, so no block sits on both sides of the gates.
  for (const instPath of expanded) {
    const mod = moduleOf(instPath);
    for (const e of mod.exprs || []) {
      if (e.index !== undefined || e.expr?.op !== 'ref') continue;
      const src = owner.get(canon(`${instPath}.${e.expr.name}`));
      if (src?.kind !== 'gate') continue;
      const c = canon(`${instPath}.${e.target}`);
      owner.set(c, src);
      for (const el of elements.filter((x) => x.rtl?.covers)) el.rtl.covers = el.rtl.covers.filter((cv) => cv !== (R(instPath) ? `${R(instPath)}:${e.target}` : e.target));
    }
  }

  // An input port of an expanded child that no drawn element drives (tied to
  // a constant, connected through a slice or expression) is represented by
  // the child's first stage block, which reads it; otherwise the draft would
  // fail its own coverage check.
  for (const instPath of [...expanded].filter((p) => p !== scopePath)) {
    const first = blocksOf.get(instPath)?.[0];
    if (!first) continue;
    for (const p of moduleOf(instPath).ports.filter((q) => q.dir !== 'out')) {
      const c = canon(`${instPath}.${p.name}`);
      if (allClocks.has(c) || owner.has(c)) continue;
      first.rtl.covers.push(R(instPath) ? `${R(instPath)}:${p.name}` : p.name);
      claim(`${instPath}.${p.name}`, { el: first.id, kind: 'block', inst: instPath });
      notes.push(`${R(instPath)}:${p.name}: input with no drawn driver (tie-off or expression); covered by ${first.id}`);
    }
  }

  // --- connections -----------------------------------------------------------
  const byId = new Map(elements.map((e) => [e.id, e]));
  const classes = new Map();
  for (const s of flat.signals.values()) {
    if (s.name.startsWith('_V')) continue;
    const c = canon(s.path);
    if (!classes.has(c)) classes.set(c, []);
    classes.get(c).push(s);
  }
  // Driver owner of a class: a local target, a collapsed child's output port, or a scope input port.
  const driverOf = (c) => owner.get(c) || null;
  const reads = []; // { signal canon, reader owner, sinkPin? }
  budgetTick?.('connecting the drawn elements');
  for (const [t, list] of back) {
    const to = owner.get(t);
    if (!to) continue;
    for (const e of list) {
      if (allClocks.has(e.s)) continue;
      const from = driverOf(e.s);
      if (!from || from.el === to.el) continue;
      if (to.kind === 'instance') continue; // inside a collapsed child (its input pins are read below)
      reads.push({ c: e.s, from, to, rawTarget: e.rawTarget });
    }
  }
  // Collapsed instances read each input port's wire from its driver.
  for (const [child, el] of instanceEls) {
    for (const q of el.ports.filter((x) => x.dir !== 'out' && !x.class)) {
      const c = canon(`${child}.${q.id}`);
      const from = driverOf(c);
      if (from && from.el !== el.id) reads.push({ c, from, to: { el: el.id, kind: 'instance', inst: child } });
    }
  }
  // Output ports read their own signal from the element that computes it.
  for (const { id, sig } of outPorts) {
    const c = canon(sig);
    const from = driverOf(c);
    if (from && from.el !== id) reads.push({ c, from, to: { el: id, kind: 'port' } });
  }
  // Net and pin names come from the signal's instance and name. Two instances
  // may share a local name (u_stream_client under two clients): a key already
  // taken by another signal falls back to the full instance path, so two
  // signals never share one block pin.
  const keyOf = new Map();
  const keyUser = new Map();
  const sigInfo = (c) => {
    const members = classes.get(c) || [];
    const inScope = (s) => s.instance === scopePath || s.instance.startsWith(`${scopePath}.`);
    const local = members.find((s) => owner.get(c)?.inst && s.instance === owner.get(c).inst) || members.find(inScope) || members[0];
    if (local && !keyOf.has(c)) {
      const rel = R(local.instance);
      let key = `${rel ? `${rel.split('/').at(-1)}_` : ''}${local.name}`;
      if (keyUser.has(key) && keyUser.get(key) !== c) key = `${rel ? `${rel.replace(/\//g, '_')}_` : ''}${local.name}`;
      keyUser.set(key, c);
      keyOf.set(c, key);
    }
    return { bits: local?.bits ?? 1, rtl: local ? { ...(R(local.instance) ? { instance: R(local.instance) } : {}), signal: local.name } : null, key: local ? keyOf.get(c) : 'sig' };
  };
  // One pin per (element, direction, key). Ids are cut at 60 characters, so a
  // long key that truncates onto another key's pin gets a numbered id instead
  // of sharing that pin (two bundles on one pin would mismatch in width).
  const pinIds = new Map();
  const pinFor = (el, dir, key, width, cls) => {
    if (el.kind !== 'comb' || el.op !== 'custom') return null;
    const k = `${el.id}|${dir}|${key}`;
    if (pinIds.has(k)) return pinIds.get(k);
    const base = sanitize(`${dir === 'in' ? 'i' : 'o'}_${key}`).slice(0, 60);
    let id = base;
    for (let n = 2; el.ports.some((p) => p.id === id); n += 1) id = `${base.slice(0, 59 - String(n).length)}_${n}`;
    el.ports.push({ id, dir, width, ...(cls ? { class: cls } : {}) });
    pinIds.set(k, id);
    return id;
  };
  const nets = [];
  const netByDriver = new Map();
  const addNet = (driver, sink, width, rtl, key) => {
    // A figure input port only drives; a net never sinks into it (a mis-mapped alias).
    const sinkEl = byId.get(String(sink).split('.')[0]);
    if (sinkEl?.kind === 'port' && sinkEl.dir !== 'out') { notes.push(`${key}: would sink into input port ${sinkEl.id}; not drawn`); return; }
    // One wire per driver pin and sink, even when the sink's signal has aliases.
    if (nets.some((n) => n.driver === driver && n.sinks.includes(sink))) return;
    const k = `${driver}|${key}`;
    if (netByDriver.has(k)) { const n = netByDriver.get(k); if (!n.sinks.includes(sink)) n.sinks.push(sink); return; }
    const n = { id: sanitize(`n_${key}`).slice(0, 60), width, driver, sinks: [sink], ...(rtl ? { rtl } : {}) };
    // The suffix goes after the trimmed base: ids are cut at 60 characters, and
    // a suffix cut off with them would never make a deep name unique.
    for (let suffix = 1; nets.some((x) => x.id === n.id); suffix += 1) n.id = `${sanitize(`n_${key}`).slice(0, 59 - String(suffix).length)}_${suffix}`;
    netByDriver.set(k, n);
    nets.push(n);
  };
  const driverEndpoint = (o, c, bundleKey, width) => {
    const el = byId.get(o.el);
    const m = classes.get(c) || [];
    if (o.kind === 'port') return o.el;
    if (o.kind === 'lane') return `${o.el}.q_${o.lane}`;
    if (o.kind === 'gate') return `${o.el}.${o.pin}`;
    if (o.kind === 'instance') {
      const p = m.find((s) => s.instance === o.inst && el.ports.some((q) => q.id === s.name && q.dir === 'out'));
      return p ? `${o.el}.${p.name}` : null;
    }
    return `${o.el}.${pinFor(el, 'out', bundleKey, width)}`;
  };
  // Group reads by (from, to): lanes, gates, instance pins and ports are per signal; block→block bundles.
  const pairs = new Map();
  for (const r of reads) {
    const toEl = byId.get(r.to.el);
    let sinkPin;
    if (r.to.kind === 'lane') sinkPin = `d_${r.to.lane}`;
    else if (r.to.kind === 'instance') sinkPin = (classes.get(r.c) || []).find((s) => s.instance === r.to.inst && toEl.ports.some((q) => q.id === s.name && q.dir !== 'out'))?.name;
    else if (r.to.kind === 'gate') sinkPin = null;
    const key = `${r.from.el}>${r.to.el}>${sinkPin ?? ''}`;
    if (!pairs.has(key)) pairs.set(key, { from: r.from, to: r.to, sinkPin, signals: new Set() });
    pairs.get(key).signals.add(r.c);
  }
  for (const p of pairs.values()) {
    budgetTick?.();
    const toEl = byId.get(p.to.el);
    const sigs = [...p.signals];
    if (p.to.kind === 'gate') continue; // gate inputs are wired below
    // A controller's inputs and outputs stay one net per signal: each gets its
    // own latency from each input, which a bundle cannot carry (and a bundle
    // would close a false combinational loop through the controller). A study
    // figure never bundles: it is for reading the RTL signal by signal.
    const stateful = (id) => STATEFUL_KINDS.includes(byId.get(id)?.function?.kind);
    if (p.to.kind === 'lane' || p.to.kind === 'instance' || p.to.kind === 'port' || sigs.length === 1 || stateful(p.from.el) || stateful(p.to.el) || format === 'study') {
      for (const c of sigs) {
        const info = sigInfo(c);
        const key = info.key;
        const drv = driverEndpoint(owner.get(c) && owner.get(c).el === p.from.el ? owner.get(c) : p.from, c, key, info.bits);
        if (!drv) continue;
        const sink = p.to.kind === 'port' ? p.to.el : p.to.kind === 'lane' || p.to.kind === 'instance' ? `${p.to.el}.${p.sinkPin}` : `${p.to.el}.${pinFor(toEl, 'in', key, info.bits)}`;
        if (sink.endsWith('.undefined')) continue;
        addNet(drv, sink, info.bits, info.rtl, `${key}`);
      }
    } else {
      const width = sigs.reduce((a, c) => a + sigInfo(c).bits, 0);
      const key = `${p.from.el}_to_${p.to.el}`;
      const drv = driverEndpoint({ ...p.from, kind: p.from.kind === 'block' ? 'block' : p.from.kind }, sigs[0], key, width);
      if (p.from.kind !== 'block') {
        for (const c of sigs) { const info = sigInfo(c); const own = owner.get(c) && owner.get(c).el === p.from.el ? owner.get(c) : p.from; const drv = driverEndpoint(own, c, info.key, info.bits); if (drv) addNet(drv, `${p.to.el}.${pinFor(toEl, 'in', info.key, info.bits)}`, info.bits, info.rtl, info.key); }
      } else {
        addNet(drv, `${p.to.el}.${pinFor(toEl, 'in', key, width)}`, width, null, key);
      }
    }
  }
  // Gate fragment inputs from their owners; outputs to their readers.
  for (const f of gateFragments) {
    const mod = moduleOf(f.instPath);
    for (const n of f.x.nets) {
      const inPort = f.x.inputs.find((i) => i.id === n.driver);
      if (inPort) {
        const coneIn = f.cone.inputs.find((i) => i.key === inPort.key);
        const c = canon(`${f.instPath}.${coneIn.name}`);
        const o = owner.get(c);
        const info = sigInfo(c);
        const drv = o ? driverEndpoint(o, c, info.key, info.bits) : null;
        if (!drv) { notes.push(`gate region ${f.region}: input ${coneIn.key} has no drawn driver`); continue; }
        if (coneIn.index !== undefined || coneIn.slice) {
          const sid = sanitize(`${f.region}_${coneIn.name}_bit`);
          if (!byId.has(sid)) { const sp = { id: sid, kind: 'comb', op: 'split', width: info.bits, slices: [] }; elements.push(sp); byId.set(sid, sp); regions.find((r) => r.id === f.region).members.push(sid); addNet(drv, `${sid}.in0`, info.bits, info.rtl, info.key); }
          const sp = byId.get(sid);
          const slice = coneIn.slice ? `${coneIn.slice[0]}:${coneIn.slice[1]}` : String(coneIn.index);
          if (!sp.slices.includes(slice)) sp.slices.push(slice);
          const oi = sp.slices.indexOf(slice);
          for (const s of n.sinks) addNet(`${sid}.out${oi}`, s, coneIn.width ?? 1, null, `${f.region}_${coneIn.key}`);
        } else {
          for (const s of n.sinks) addNet(drv, s, info.bits, info.rtl, info.key);
        }
        continue;
      }
      if (n.sinks.includes(f.x.output)) continue;
      nets.push({ ...n });
    }
    // readers of the region output
    const outNet = f.x.nets.find((n) => n.sinks.includes(f.x.output));
    const c = canon(`${f.instPath}.${f.output}`);
    const readersOut = pairsFrom(pairs, owner.get(c)?.el);
    for (const p of readersOut.filter((x) => x.to.kind !== 'gate')) {
      const toEl = byId.get(p.to.el);
      const sink = p.to.kind === 'port' ? p.to.el : p.to.kind === 'lane' || p.to.kind === 'instance' ? `${p.to.el}.${p.sinkPin}` : `${p.to.el}.${pinFor(toEl, 'in', f.output, 1)}`;
      addNet(outNet.driver, sink, outNet.width, { ...(R(f.instPath) ? { instance: R(f.instPath) } : {}), signal: f.output }, f.output);
    }
    void mod;
  }

  // Local blocks that feed each other combinationally form a loop no drawing
  // can show (comb/loop): merge each such group into one block, before any
  // output latency is marked. An edge is combinational when its signal is 0
  // register stages from some mapped input of the driving block (or unmapped).
  {
    const custom = new Map(elements.filter((e) => e.kind === 'comb' && e.op === 'custom').map((e) => [e.id, e]));
    const pathOf = (rtl) => [flat.top, ...((rtl.instance ?? '') ? rtl.instance.split('/') : []), rtl.signal].join('.');
    const combOut = (n, fromId) => {
      if (!n.rtl) return true;
      const ins = nets.filter((x) => x.rtl && x.sinks.some((s) => String(s).startsWith(`${fromId}.`)));
      const lats = ins.map((i) => stagesBetween(back, canon(pathOf(n.rtl)), canon(pathOf(i.rtl)), allClocks)).filter((v) => v !== null);
      return !lats.length || Math.min(...lats) === 0;
    };
    const adj = new Map([...custom.keys()].map((id) => [id, new Set()]));
    budgetTick?.('finding combinational loops between blocks');
    for (const n of nets) {
      budgetTick?.();
      const from = String(n.driver).split('.')[0];
      if (!custom.has(from) || !combOut(n, from)) continue;
      for (const s of n.sinks) { const to = String(s).split('.')[0]; if (custom.has(to) && to !== from) adj.get(from).add(to); }
    }
    let index = 0;
    const idx = new Map();
    const low = new Map();
    const stack = [];
    const onStack = new Set();
    const loops = [];
    const strong = (v) => {
      idx.set(v, index); low.set(v, index); index += 1; stack.push(v); onStack.add(v);
      for (const w of adj.get(v)) {
        if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = [];
        let w;
        do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1) loops.push(comp);
      }
    };
    for (const v of adj.keys()) if (!idx.has(v)) strong(v);
    // Merging keeps structure: only blocks of one instance merge, and a
    // controller is never absorbed. A loop that crosses instances or runs
    // through a controller stays drawn and is left to comb/loop, which follows
    // pins and per-input latencies.
    const instOf = new Map([...blocksOf].flatMap(([p, els]) => els.map((e) => [e.id, p])));
    const merges = [];
    for (const loop of loops) {
      const byInst = new Map();
      for (const id of loop) {
        if (STATEFUL_KINDS.includes(custom.get(id).function?.kind)) continue;
        const key = instOf.get(id) ?? '';
        if (!byInst.has(key)) byInst.set(key, []);
        byInst.get(key).push(id);
      }
      const merged = [...byInst.values()].filter((g) => g.length > 1);
      if (merged.flat().length < loop.length) notes.push(`${loop.join(', ')}: a block-level loop across instances or through a controller; blocks kept apart so the structure stays visible`);
      merges.push(...merged);
    }
    for (const comp of merges) {
      const [keep, ...rest] = comp.map((id) => custom.get(id));
      const members = new Set(comp);
      const renamed = new Map();
      for (const el of rest) {
        for (const p of el.ports) {
          let pid = p.id;
          for (let k = 2; keep.ports.some((q) => q.id === pid); k += 1) pid = `${sanitize(p.id).slice(0, 59 - String(k).length)}_${k}`;
          keep.ports.push({ ...p, id: pid });
          renamed.set(`${el.id}.${p.id}`, `${keep.id}.${pid}`);
        }
      }
      keep.rtl.covers = [...new Set([...(keep.rtl.covers || []), ...rest.flatMap((el) => el.rtl?.covers || [])])];
      const inside = (ep) => members.has(String(ep).split('.')[0]);
      for (let i = nets.length - 1; i >= 0; i -= 1) {
        const n = nets[i];
        if (inside(n.driver)) n.sinks = n.sinks.filter((s) => !inside(s));
        n.driver = renamed.get(n.driver) ?? n.driver;
        n.sinks = n.sinks.map((s) => renamed.get(s) ?? s);
        if (!n.sinks.length) nets.splice(i, 1);
      }
      const used = new Set(nets.flatMap((n) => [n.driver, ...n.sinks]));
      keep.ports = keep.ports.filter((p) => used.has(`${keep.id}.${p.id}`));
      for (const el of rest) elements.splice(elements.indexOf(el), 1);
      notes.push(`${comp.join(', ')}: local blocks feed each other combinationally (a loop no drawing can show); merged into ${keep.id}, rename it`);
    }
  }

  // Block outputs: the latency the figure draws must equal the RTL latency from
  // every mapped input. Mark a uniform latency k ≥ 1 as registered; leave a
  // wire whose latency differs by input unmapped (no claim the drawing cannot express).
  const sigPath = (rtl) => [flat.top, ...((rtl.instance ?? '') ? rtl.instance.split('/') : []), rtl.signal].join('.');
  // Decisions use the mappings as drafted: a net unmapped while an earlier
  // block is processed is still a real input of the blocks it feeds (a
  // controller's state output would otherwise look input-free and combinational).
  const rtlOf = new Map(nets.map((n) => [n, n.rtl]));
  for (const el of elements.filter((e) => e.kind === 'comb' && e.op === 'custom')) {
    const insSig = new Set(nets.filter((n) => rtlOf.get(n) && n.sinks.some((s) => s.startsWith(`${el.id}.`))).map((n) => canon(sigPath(rtlOf.get(n)))));
    budgetTick?.(`measuring output latency of ${el.id}`);
    for (const n of nets.filter((x) => x.rtl && x.driver.startsWith(`${el.id}.`))) {
      const pin = el.ports.find((p) => p.id === n.driver.split('.')[1]);
      // The inputs that reach this output with no register on the way
      // (comb_from); the loop check follows exactly these. An input without an
      // RTL mapping (a bundle) counts as combinational.
      if (pin) {
        const combIn = new Set();
        for (const m2 of nets.filter((x) => x.sinks.some((s) => s.startsWith(`${el.id}.`)))) {
          const src = rtlOf.get(m2);
          const v = src ? stagesBetween(back, canon(sigPath(n.rtl)), canon(sigPath(src)), allClocks) : 0;
          if (v === 0) for (const s of m2.sinks.filter((x) => x.startsWith(`${el.id}.`))) combIn.add(s.split('.')[1]);
        }
        if (combIn.size < el.ports.filter((p) => p.dir !== 'out').length) pin.comb_from = [...combIn].sort();
        else delete pin.comb_from;
      }
      const lats = [...insSig].map((i) => stagesBetween(back, canon(sigPath(n.rtl)), i, allClocks)).filter((x) => x !== null);
      const uniq = [...new Set(lats)];
      const feedsLane = n.sinks.some((sk) => byId.get(sk.split('.')[0])?.kind === 'pipeline_register');
      if (feedsLane && (!uniq.length || uniq.length > 1)) { notes.push(`${n.id}: feeds a pipeline register but its latency from ${el.id}'s inputs is not uniform; kept mapped, refine the grouping`); continue; }
      if (!uniq.length && insSig.size) { notes.push(`${n.id}: no mapped input of ${el.id} reaches it; drawn unmapped`); n.rtl_unmapped = { reason: `no mapped input of ${el.id} reaches it`, rtl: n.rtl }; delete n.rtl; continue; }
      if (uniq.length > 1) {
        if (el.function?.kind === 'controller' && pin) {
          // A controller output: one latency per input pin (0 = combinational).
          const per = {};
          for (const m2 of nets.filter((x) => rtlOf.get(x) && x.sinks.some((s) => s.startsWith(`${el.id}.`)))) {
            const v = stagesBetween(back, canon(sigPath(n.rtl)), canon(sigPath(rtlOf.get(m2))), allClocks);
            if (v === null) continue;
            for (const s of m2.sinks.filter((x) => x.startsWith(`${el.id}.`))) per[s.split('.')[1]] = v;
          }
          delete pin.registered;
          delete pin.comb_from;
          pin.latency = per;
          notes.push(`${n.id}: controller output whose latency differs by input (${uniq.join(', ')}); declared per input`);
          continue;
        }
        // Registered from every input (at least one stage on each path): the
        // output is sequential even though one number cannot state its latency.
        // The net stays unmapped (no claim the latency check could not verify).
        const least = Math.min(...uniq);
        if (pin && least >= 1) { pin.registered = true; if (least > 1) pin.latency = least; delete pin.comb_from; }
        notes.push(`${n.id}: latency from ${el.id}'s inputs varies (${uniq.join(', ')}); drawn unmapped${pin && least >= 1 ? `, its output marked registered (at least ${least} stage${least > 1 ? 's' : ''})` : ''}`);
        n.rtl_unmapped = { reason: `latency from ${el.id}'s inputs varies (${uniq.join(', ')})`, rtl: n.rtl };
        delete n.rtl;
        continue;
      }
      if (uniq[0] >= 1 && pin) { pin.registered = true; if (uniq[0] > 1) pin.latency = uniq[0]; delete pin.comb_from; }
    }
  }
  // Instance outputs whose latency varies by input (non-controllers): their nets are drawn unmapped, counted with the reason.
  for (const n of nets.filter((x) => x.rtl && varyingPins.has(x.driver))) {
    n.rtl_unmapped = { reason: varyingPins.get(n.driver).slice(0, 200), rtl: n.rtl };
    notes.push(`${n.id}: ${varyingPins.get(n.driver)}; drawn unmapped`);
    delete n.rtl;
  }

  // Custom block widths follow their widest pin; drop pinless blocks' empty port lists.
  for (const el of elements.filter((e) => e.kind === 'comb' && e.op === 'custom')) {
    el.width = Math.max(1, ...el.ports.map((p) => (typeof p.width === 'number' ? p.width : 1)));
    if (!el.ports.length && el.rtl?.covers?.length) el.ports.push({ id: 'o_state', dir: 'out', width: 1 });
  }
  const wired = new Set(nets.flatMap((n) => [n.driver, ...n.sinks]).map((e) => String(e).split('.')[0]));
  const clean = elements.filter((e) => !(e.kind === 'comb' && e.op === 'custom' && !e.rtl?.covers?.length && !wired.has(e.id)));
  for (const el of clean.filter((e) => e.function && e.function.kind === 'custom')) if (/^[a-z]/.test(el.function.name)) el.function.name = el.function.name[0].toUpperCase() + el.function.name.slice(1);
  // Printed names are unique and say whose they are: blocks that would print
  // the same name are qualified with the readable context of their instance
  // paths ("Nonce client controller", "Owner controller"), set through the
  // label so the function kind stays (checks depend on it). A number is added
  // only where the contexts cannot tell the blocks apart.
  const instanceOfEl = (e) => e.rtl?.instance ?? (barInst.has(e.id) ? R(barInst.get(e.id)) : (e.rtl?.covers || []).find((c) => c.includes(':'))?.split(':')[0] ?? '');
  const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
  // "<instance> <name>", without repeating an instance name the name starts with.
  const qualified = (context, name) => (!context ? name : lowerFirst(name).toLowerCase().startsWith(context.toLowerCase()) ? capitalize(lowerFirst(name)) : capitalize(`${context} ${lowerFirst(name)}`));
  // In a figure with blocks of several instances, a vocabulary name alone
  // ("Comparator", "Controller") does not say whose block it is: blocks of
  // instances below the scope are qualified with their instance name.
  const contextsInFigure = new Set(clean.filter((e) => e.kind !== 'port').map(instanceOfEl).filter((p) => p !== scope));
  const vocabulary = clean.filter((e) => e.function && e.function.kind !== 'custom' && !e.label && primaryName(e) && instanceOfEl(e) !== scope);
  if (contextsInFigure.size > 1) {
    const names = distinctInstanceNames(vocabulary.map(instanceOfEl));
    vocabulary.forEach((e, i) => { e.label = qualified(names[i], primaryName(e)); });
  }
  const sameName = new Map();
  for (const el of clean) {
    const name = primaryName(el);
    if (!name) continue;
    if (!sameName.has(name)) sameName.set(name, []);
    sameName.get(name).push(el);
  }
  for (const [name, list] of sameName) {
    if (list.length < 2) continue;
    const contexts = distinctInstanceNames(list.map(instanceOfEl));
    const labels = list.map((_, i) => qualified(contexts[i], name));
    list.forEach((el, i) => {
      const twins = labels.filter((l) => l === labels[i]).length;
      el.label = twins > 1 ? `${labels[i]} ${labels.slice(0, i + 1).filter((l) => l === labels[i]).length}` : labels[i];
    });
    notes.push(`${list.map((e) => e.id).join(', ')}: shared the name "${name}"; qualified by instance as ${list.map((e) => `"${e.label}"`).join(', ')}`);
  }
  // A study figure frames each expanded instance as a region holding its
  // blocks, pipeline bars and collapsed children, nested like the hierarchy:
  // the reader sees whose logic each block is, and the layout keeps an
  // instance's wires inside its frame.
  if (format === 'study') {
    const regionOf = new Map();
    const study = [];
    const inRegion = new Set(regions.flatMap((g) => g.members));
    const parentRel = (rel) => rel.split('/').slice(0, -1).join('/');
    for (const instPath of [...expanded].filter((p) => p !== scopePath).sort((a, b) => a.split('.').length - b.split('.').length)) {
      const rel = R(instPath);
      const members = clean.filter((e) => e.kind !== 'port' && !inRegion.has(e.id) && ((blocksOf.get(instPath) || []).includes(e) || barInst.get(e.id) === instPath || (e.kind === 'instance' && e.rtl?.instance && parentRel(e.rtl.instance) === rel))).map((e) => e.id);
      let parent = instPath.slice(0, instPath.lastIndexOf('.'));
      while (parent.includes('.') && !regionOf.has(parent)) parent = parent.slice(0, parent.lastIndexOf('.'));
      if (!members.length) continue;
      const region = { id: uid(`r_${rel.replace(/\//g, '_')}`), label: '', level: 'block', members, ...(regionOf.has(parent) ? { parent: regionOf.get(parent) } : {}), rtl: { instance: rel } };
      regions.push(region);
      study.push(region);
      regionOf.set(instPath, region.id);
    }
    const names = distinctInstanceNames(study.map((r) => r.rtl.instance));
    study.forEach((r, i) => { r.label = capitalize(names[i]).slice(0, 60); });
    if (study.length) notes.push(`study format: ${study.length} instance frame(s): ${study.map((r) => r.label).join(', ')}`);
  }
  if (!repository) {
    for (const el of clean) if (el.function?.basis) delete el.function.basis;
    notes.push('no repository given (--repo-root, --revision): function.basis source pins omitted; add them to justify vocabulary names');
  }
  const scopeName = scope || 'the whole design';
  const doc = {
    schema_version: 1, figure_type: 'datapath',
    meta: {
      title: title ?? `${preset} view of ${scope || scopeMod.orig_name}`,
      caption: `${preset[0].toUpperCase()}${preset.slice(1)} view of ${scope ? `instance ${scope}` : `the whole design (top ${scopeMod.orig_name})`}${preset === 'detail' ? `, expanded ${maxDepth} level${maxDepth > 1 ? 's' : ''}` : ''}. Draft generated from the netlist: refine names and grouping.`,
      print: { profile: 'ieee', variants: ['1col', '2col'] },
      ...(repository ? { repository } : {}),
      ...(scope ? { rtl: { instance: scope } } : {}),
      scope: { ...(scope ? { instance: scope } : {}), hierarchy: 'all' },
    },
    view: { preset, scope, ...(preset === 'detail' ? { depth: maxDepth } : {}), ...(specs.length ? { gate_regions: specs.map((g) => g.name) } : {}), ...(blackbox.length ? { blackbox: [...blackbox] } : {}) },
    clock_domains: [{ id: 'sys', clock: [...scopeClocks].map((c) => c.split('.').pop())[0] ?? 'clk' }],
    elements: clean,
    nets: nets.filter((n) => n.sinks.length),
    ...(regions.length ? { regions } : {}),
  };
  void scopeName;
  // Identical splits of one bus (two gate-region cones reading the same bits) are drawn once.
  const canonical = mergeDuplicateSplits(doc);
  for (const m of canonical.merged) notes.push(`${m.removed}: identical to ${m.kept} (same input and slices); merged`);
  reconcileControllerLatency(canonical.doc, netlist, notes);
  return { doc: canonical.doc, notes, expanded: [...expanded].map(R) };
}

// The generator estimates latency on the unrestricted RTL graph; the latency
// check measures each drawn pair with every other drawn net as a boundary, so
// the two can differ where a path runs through another drawn signal. For
// stateful blocks the check's own value is the one the figure must draw: write
// it into the output's per-input map. Hidden pipeline registers are never
// reconciled (they must be drawn), and other kinds stay residuals.
function reconcileControllerLatency(doc, netlist, notes) {
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const netById = new Map(doc.nets.map((n) => [n.id, n]));
  for (let round = 0; round < 3; round += 1) {
    budgetTick?.('reconciling controller latency with the latency check');
    let diagnostics;
    try { ({ diagnostics } = checkLatency(doc, netlist)); } catch { return; }
    let changed = 0;
    for (const d of diagnostics) {
      if (d.code !== 'latency/hidden-register' || d.evidence?.hidden || typeof d.evidence?.rtl !== 'number') continue;
      const el = byId.get(d.subject?.id);
      if (!el || !STATEFUL_KINDS.includes(el.function?.kind)) continue;
      const out = netById.get(d.subject.to);
      const inNet = netById.get(d.subject.from);
      const pin = out && el.ports?.find((p) => `${el.id}.${p.id}` === out.driver);
      const sink = inNet?.sinks.find((s) => s.startsWith(`${el.id}.`))?.split('.')[1];
      if (!pin || !sink) continue;
      if (typeof pin.latency !== 'object') {
        const fixed = pinLatencyFrom(el, pin, null);
        pin.latency = fixed.kind === 'fixed' && typeof fixed.value === 'number' ? { default: fixed.value } : {};
        delete pin.registered;
        delete pin.comb_from;
      }
      if (pin.latency[sink] === d.evidence.rtl) continue;
      pin.latency[sink] = d.evidence.rtl;
      changed += 1;
      notes.push(`${el.id}.${pin.id}: latency from ${sink} set to ${d.evidence.rtl}, as measured between the drawn nets ${inNet.id} → ${out.id}`);
    }
    if (!changed) return;
  }
}

const humanName = (name) => String(name).replace(/__.*$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Minimum register stages from one signal back to another, or null. One
// backward 0-1 BFS per target is computed once and reused for every source
// (drafts of large designs ask for many pairs with the same target).
const stageCache = new WeakMap();
function stagesBetween(back, target, source, clocks) {
  if (!stageCache.has(back)) stageCache.set(back, new Map());
  const perTarget = stageCache.get(back);
  if (!perTarget.has(target)) {
    const dist = new Map([[target, 0]]);
    const dq = [target];
    while (dq.length) {
      const v = dq.shift();
      budgetTick?.();
      for (const e of back.get(v) || []) {
        if (clocks.has(e.s)) continue;
        const nd = dist.get(v) + (e.seq ? 1 : 0);
        if (nd > 16 || (dist.has(e.s) && dist.get(e.s) <= nd)) continue;
        dist.set(e.s, nd);
        if (e.seq) dq.push(e.s); else dq.unshift(e.s);
      }
    }
    perTarget.set(target, dist);
  }
  const d = perTarget.get(target).get(source);
  return d === undefined ? null : d;
}

function pairsFrom(pairs, elId) {
  return [...pairs.values()].filter((p) => p.from.el === elId);
}

function minStages(back, target, inputs, clocks, pick = 'min') {
  const dist = new Map([[target, 0]]);
  const dq = [target];
  while (dq.length) {
    const v = dq.shift();
    budgetTick?.();
    if (inputs.has(v)) continue;
    for (const e of back.get(v) || []) {
      if (clocks.has(e.s)) continue;
      const nd = dist.get(v) + (e.seq ? 1 : 0);
      if (nd > 16 || (dist.has(e.s) && dist.get(e.s) <= nd)) continue;
      dist.set(e.s, nd);
      if (e.seq) dq.push(e.s); else dq.unshift(e.s);
    }
  }
  const hits = [...inputs].filter((i) => dist.has(i)).map((i) => dist.get(i));
  return hits.length ? (pick === 'max' ? Math.max(...hits) : Math.min(...hits)) : 0;
}

// Structural traits of a module that name it without guessing from names:
// an enumerated state register (controller), an array with two
// self-incrementing pointers (FIFO), one self-incrementing register (counter).
function moduleTraits(m) {
  const regs = m.registers || [];
  const refsSelf = (tree, name) => {
    let self = false;
    let konst = false;
    (function visit(n) { if (!n || typeof n !== 'object') return; if (n.op === 'ref' && n.name === name) self = true; if (n.op === 'const') konst = true; (n.args || []).forEach(visit); })(tree);
    return self && konst;
  };
  const increments = regs.filter((r) => !r.array && (m.exprs || []).some((e) => e.target === r.name && ['add', 'sub'].includes(e.expr?.op) && refsSelf(e.expr, r.name)));
  const controller = regs.find((r) => r.enum)?.name ?? null;
  const fifo = regs.some((r) => r.array) && increments.length >= 2;
  const counter = !fifo && !controller && !(m.instances || []).length && regs.length <= 2 && increments.length === 1;
  return { controller, fifo, counter };
}

// A name from what the RTL computes: structural traits first (controller,
// FIFO, counter); then a vocabulary entry whose required cone operations are
// all present — Galois-field names only with field evidence (a gf/field
// helper), compare names only for cones that only compare, multiply or
// divide without field evidence is an arithmetic unit; else the module name
// (weak evidence never produces a wrong vocabulary name).
function inferFunction(cats, fallback, notes, id, sources = [], traits = {}) {
  if (traits.controller) { notes.push(`${id}: named Controller: it holds the enumerated state register ${traits.controller}`); return { kind: 'controller' }; }
  if (traits.fifo) { notes.push(`${id}: named FIFO: an array register with read and write pointers`); return { kind: 'fifo' }; }
  if (traits.counter) { notes.push(`${id}: named Counter: one self-incrementing register`); return { kind: 'counter' }; }
  const GENERAL = ['gf_poly_eval', 'gf_mul', 'gf_add', 'comparator', 'zero_detect', 'gf_div'];
  const COMPARE = new Set(['compare-eq', 'compare-zero']);
  const onlyCompares = [...cats].every((c) => COMPARE.has(c));
  const allowed = (k) => (k.startsWith('gf_') ? cats.has('gf-hint') : ['comparator', 'zero_detect'].includes(k) ? onlyCompares : true);
  // A narrow name must describe the whole block: every output's cone carries
  // the structure (a 40-input hub with one zero test is not a zero detector).
  // perOutput undefined: nothing known about the outputs (an instance driven by
  // its children), the union decides; an empty list: the block drives nothing,
  // so no function name can describe it.
  const perOutput = traits.perOutput;
  const wholeBlock = (cone) => !perOutput || (perOutput.length > 0 && perOutput.every((set) => cone.every((c) => set.has(c))));
  const found = GENERAL.filter(allowed).map((k) => [k, VOCABULARY.kinds[k]]).filter(([, e]) => e?.evidence?.cone_all?.every((c) => cats.has(c)));
  const partial = found.filter(([, e]) => !wholeBlock(e.evidence.cone_all));
  if (partial.length) notes.push(`${id}: ${partial.map(([, e]) => e.display).join(', ')} would describe only part of the block (${perOutput.length ? `${perOutput.filter((set) => !partial[0][1].evidence.cone_all.every((c) => set.has(c))).length} of ${perOutput.length} outputs lack ${partial[0][1].evidence.cone_all.join(', ')}` : 'it drives no output'}); not used`);
  const candidates = found.filter(([, e]) => wholeBlock(e.evidence.cone_all));
  candidates.sort((a, b) => b[1].evidence.cone_all.length - a[1].evidence.cone_all.length);
  if (candidates.length && sources.length) {
    const [kind, entry] = candidates[0];
    const file = sources[0].file;
    const same = sources.filter((s) => s.file === file).map((s) => s.line);
    notes.push(`${id}: named ${entry.display} from its RTL cone (${entry.evidence.cone_all.join(', ')}); check the name`);
    return { kind, basis: { source: { file, line: Math.min(...same), end_line: Math.max(...same) }, structure: `cone has ${[...cats].sort().join(', ')}` } };
  }
  if ((cats.has('multiply') || cats.has('division')) && !cats.has('gf-hint') && (!perOutput || (perOutput.length > 0 && perOutput.every((set) => set.has('multiply') || set.has('division'))))) {
    notes.push(`${id}: multiply/divide in its RTL cone without field evidence; named Arithmetic unit — qualify it (integer, fixed or floating point)`);
    return { kind: 'arithmetic_unit' };
  }
  const name = (/^[a-z]/.test(fallback) ? fallback.replace(/_/g, ' ') : fallback).slice(0, 40);
  notes.push(`${id}: no vocabulary name follows from its RTL structure; named "${name}" for the author to refine`);
  return { kind: 'custom', name };
}

// Operation categories in the combinational cone of each output inside one
// module: its own assignments reached backwards from the output (only through
// signals in `within`, when given), stopping at registers and not entering
// child instances. Outputs without a local assignment are skipped: nothing is
// known about their structure.
function outputConeCats(mod, outputs, within = null) {
  const depsOf = new Map();
  for (const d of mod.deps || []) { if (!depsOf.has(d.target)) depsOf.set(d.target, []); depsOf.get(d.target).push(...d.sources); }
  const exprsOf = new Map();
  for (const e of mod.exprs || []) { if (!exprsOf.has(e.target)) exprsOf.set(e.target, []); exprsOf.get(e.target).push(e); }
  const registers = new Set((mod.registers || []).map((r) => r.name));
  const result = [];
  for (const out of outputs) {
    if (!depsOf.has(out)) continue;
    const cats = new Set();
    const seen = new Set([out]);
    const queue = [out];
    while (queue.length) {
      const v = queue.shift();
      for (const e of exprsOf.get(v) || []) coneCategories(e.expr).forEach((c) => cats.add(c));
      if (v !== out && registers.has(v)) continue;
      for (const s of depsOf.get(v) || []) if (!seen.has(s) && (!within || within.has(s))) { seen.add(s); queue.push(s); }
    }
    result.push(cats);
  }
  return result;
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
