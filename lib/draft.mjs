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

import { VOCABULARY } from './checks/labels.mjs';
import { coneCategories } from './checks/function-evidence.mjs';
import { aliasClasses } from './checks/coverage.mjs';
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

export function draftFigure(netlist, { preset = 'block', scope = '', depth, gateRegions = [], blackbox = [], title, repository } = {}) {
  if (!PRESETS.includes(preset)) throw new Error(`unknown view preset '${preset}' (use ${PRESETS.join(', ')})`);
  const notes = [];
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
    const id = sanitize(`p_${p.name}`);
    elements.push({ id, kind: 'port', dir: p.dir === 'out' ? 'out' : 'in', width: p.width, label: p.name.replace(/_[io]$/, '').replace(/_/g, ' '), rtl: { signal: p.name } });
    if (p.dir === 'out') outPorts.push({ id, sig });
    else claim(sig, { el: id, kind: 'port', dir: p.dir });
  }

  // Collapsed children.
  const instanceEls = new Map();
  for (const instPath of expanded) {
    for (const i of moduleOf(instPath).instances) {
      const child = `${instPath}.${i.name}`;
      if (expanded.has(child)) continue;
      const m = moduleOf(child);
      const memory = hasStub(child) || (m.registers.some((r) => r.array) && !m.instances.length);
      const id = sanitize(`u_${R(child).replace(/\//g, '_')}`);
      const cats = new Set();
      const srcLines = [];
      for (const mm of [...flat.instances.entries()].filter(([p]) => p === child || p.startsWith(`${child}.`)).map(([, x]) => x)) for (const e of mm.exprs || []) { coneCategories(e.expr).forEach((c) => cats.add(c)); if (e.source) srcLines.push(e.source); }
      const fn = memory ? { kind: 'memory' } : inferFunction(cats, humanName(m.orig_name), notes, id, srcLines);
      const el = {
        id, kind: 'instance', module: sanitize(m.orig_name), level: bbPaths.has(child) || m.blackbox ? 'blackbox' : 'block',
        ...(hasStub(child) ? { internals: 'stub' } : {}), pin_labels: false, function: fn, rtl: { instance: R(child) },
        ports: m.ports.map((q) => ({ id: q.name, dir: q.dir === 'out' ? 'out' : 'in', width: q.width, ...(allClocks.has(canon(`${child}.${q.name}`)) ? { class: [...flat.instances.keys()].some((ip) => resetsOf(ip).has(canon(`${child}.${q.name}`))) ? 'reset' : 'clock' } : {}) })),
      };
      // Registered outputs: minimum register stages from any input port.
      for (const q of el.ports.filter((x) => x.dir === 'out')) {
        const lat = minStages(back, canon(`${child}.${q.id}`), new Set(m.ports.filter((x) => x.dir !== 'out').map((x) => canon(`${child}.${x.name}`))), allClocks, memory ? 'max' : 'min');
        if (lat >= 1) { q.registered = true; if (lat > 1) q.latency = lat; }
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
  for (const instPath of expanded) {
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
    for (const s of locals) {
      const c = canon(s.path);
      if (!assigned.has(s.name)) continue; // a connection wire: owned by whatever drives it
      if (owner.has(c) && owner.get(c).kind !== 'port') continue; // aliases of collapsed child ports
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
      const id = sanitize(`p_${tag}_s${k}`);
      const el = { id, kind: 'pipeline_register', domain: 'sys', stage: k + 1, label: `S${k}|S${k + 1}`, lanes: sigs.map((s) => ({ id: sanitize(s.name), width: s.bits })) };
      elements.push(el);
      bars.push(el);
      for (const s of sigs) claim(s.path, { el: id, kind: 'lane', lane: sanitize(s.name), inst: instPath }, true);
    }
    const blockGroups = [...groups].sort((a, b) => a[0] - b[0]);
    const named = [];
    for (const [k, sigs] of blockGroups) {
      const id = sanitize(`b_${tag}_s${k}`);
      const cats = new Set();
      const lines = [];
      for (const s of sigs) for (const e of (m.exprs || []).filter((x) => x.target === s.name)) { coneCategories(e.expr).forEach((c) => cats.add(c)); if (e.source) lines.push(e.source); }
      const fn = inferFunction(cats, blockGroups.length > 1 ? `Logic stage ${k}` : 'Local logic', notes, id, lines);
      if (blockGroups.length > 1 && fn.kind !== 'custom') fn.stage = `${named.filter((n) => n.fn.kind === fn.kind).length + 1}/${blockGroups.filter(() => true).length}`;
      const el = { id, kind: 'comb', op: 'custom', width: 1, pin_labels: false, function: fn, rtl: { covers: sigs.map((s) => (R(instPath) ? `${R(instPath)}:${s.name}` : s.name)) }, ports: [] };
      named.push({ el, fn });
      elements.push(el);
      for (const s of sigs) claim(s.path, { el: id, kind: 'block', inst: instPath });
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
  const sigInfo = (c) => {
    const members = classes.get(c) || [];
    const inScope = (s) => s.instance === scopePath || s.instance.startsWith(`${scopePath}.`);
    const local = members.find((s) => owner.get(c)?.inst && s.instance === owner.get(c).inst) || members.find(inScope) || members[0];
    return { bits: local?.bits ?? 1, rtl: local ? { ...(R(local.instance) ? { instance: R(local.instance) } : {}), signal: local.name } : null, key: local ? `${R(local.instance) ? `${R(local.instance).split('/').at(-1)}_` : ''}${local.name}` : 'sig' };
  };
  const pinFor = (el, dir, key, width, cls) => {
    if (el.kind !== 'comb' || el.op !== 'custom') return null;
    const id = sanitize(`${dir === 'in' ? 'i' : 'o'}_${key}`).slice(0, 60);
    if (!el.ports.some((p) => p.id === id)) el.ports.push({ id, dir, width, ...(cls ? { class: cls } : {}) });
    return id;
  };
  const nets = [];
  const netByDriver = new Map();
  const addNet = (driver, sink, width, rtl, key) => {
    // One wire per driver pin and sink, even when the sink's signal has aliases.
    if (nets.some((n) => n.driver === driver && n.sinks.includes(sink))) return;
    const k = `${driver}|${key}`;
    if (netByDriver.has(k)) { const n = netByDriver.get(k); if (!n.sinks.includes(sink)) n.sinks.push(sink); return; }
    const n = { id: sanitize(`n_${key}`).slice(0, 60), width, driver, sinks: [sink], ...(rtl ? { rtl } : {}) };
    let suffix = 1;
    while (nets.some((x) => x.id === n.id)) n.id = sanitize(`n_${key}_${suffix++}`);
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
    const toEl = byId.get(p.to.el);
    const sigs = [...p.signals];
    if (p.to.kind === 'gate') continue; // gate inputs are wired below
    if (p.to.kind === 'lane' || p.to.kind === 'instance' || p.to.kind === 'port' || sigs.length === 1) {
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

  // Block outputs: the latency the figure draws must equal the RTL latency from
  // every mapped input. Mark a uniform latency k ≥ 1 as registered; leave a
  // wire whose latency differs by input unmapped (no claim the drawing cannot express).
  const sigPath = (rtl) => [flat.top, ...((rtl.instance ?? '') ? rtl.instance.split('/') : []), rtl.signal].join('.');
  for (const el of elements.filter((e) => e.kind === 'comb' && e.op === 'custom')) {
    const insSig = new Set(nets.filter((n) => n.rtl && n.sinks.some((s) => s.startsWith(`${el.id}.`))).map((n) => canon(sigPath(n.rtl))));
    for (const n of nets.filter((x) => x.rtl && x.driver.startsWith(`${el.id}.`))) {
      const pin = el.ports.find((p) => p.id === n.driver.split('.')[1]);
      const lats = [...insSig].map((i) => stagesBetween(back, canon(sigPath(n.rtl)), i, allClocks)).filter((x) => x !== null);
      const uniq = [...new Set(lats)];
      const feedsLane = n.sinks.some((sk) => byId.get(sk.split('.')[0])?.kind === 'pipeline_register');
      if (feedsLane && (!uniq.length || uniq.length > 1)) { notes.push(`${n.id}: feeds a pipeline register but its latency from ${el.id}'s inputs is not uniform; kept mapped, refine the grouping`); continue; }
      if (!uniq.length && insSig.size) { notes.push(`${n.id}: no mapped input of ${el.id} reaches it; drawn unmapped`); delete n.rtl; continue; }
      if (uniq.length > 1) { notes.push(`${n.id}: latency from ${el.id}'s inputs varies (${uniq.join(', ')}); drawn unmapped`); delete n.rtl; continue; }
      if (uniq[0] >= 1 && pin) { pin.registered = true; if (uniq[0] > 1) pin.latency = uniq[0]; }
    }
  }

  // Custom block widths follow their widest pin; drop pinless blocks' empty port lists.
  for (const el of elements.filter((e) => e.kind === 'comb' && e.op === 'custom')) {
    el.width = Math.max(1, ...el.ports.map((p) => (typeof p.width === 'number' ? p.width : 1)));
    if (!el.ports.length && el.rtl?.covers?.length) el.ports.push({ id: 'o_state', dir: 'out', width: 1 });
  }
  const wired = new Set(nets.flatMap((n) => [n.driver, ...n.sinks]).map((e) => String(e).split('.')[0]));
  const clean = elements.filter((e) => !(e.kind === 'comb' && e.op === 'custom' && !e.rtl?.covers?.length && !wired.has(e.id)));
  // Printed names are unique: repeated vocabulary names get a number.
  const printed = new Map();
  const memories = clean.filter((e) => e.function?.kind === 'memory');
  if (memories.length > 1) memories.forEach((el, i) => { el.label = `Memory ${i + 1}`; });
  for (const el of clean.filter((e) => e.function && e.function.kind !== 'custom' && !e.function.stage && e.function.kind !== 'memory')) {
    const key = el.function.kind + (el.function.qualifier ?? '');
    if (!printed.has(key)) printed.set(key, []);
    printed.get(key).push(el);
  }
  for (const [kind, list] of printed) {
    if (list.length < 2) continue;
    list.forEach((el, i) => { const display = VOCABULARY.kinds[el.function.kind]?.display ?? kind; el.function = { kind: 'custom', name: `${display} ${i + 1}` }; });
    notes.push(`${list.map((e) => e.id).join(', ')}: shared the name ${VOCABULARY.kinds[list[0].function.kind]?.display ?? kind}; numbered for the author to rename`);
  }
  for (const el of clean.filter((e) => e.function && e.function.kind === 'custom')) if (/^[a-z]/.test(el.function.name)) el.function.name = el.function.name[0].toUpperCase() + el.function.name.slice(1);
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
  return { doc, notes, expanded: [...expanded].map(R) };
}

const humanName = (name) => String(name).replace(/__.*$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Minimum register stages from one signal back to another, or null.
function stagesBetween(back, target, source, clocks) {
  const dist = new Map([[target, 0]]);
  const dq = [target];
  while (dq.length) {
    const v = dq.shift();
    if (v === source) continue;
    for (const e of back.get(v) || []) {
      if (clocks.has(e.s)) continue;
      const nd = dist.get(v) + (e.seq ? 1 : 0);
      if (nd > 16 || (dist.has(e.s) && dist.get(e.s) <= nd)) continue;
      dist.set(e.s, nd);
      if (e.seq) dq.push(e.s); else dq.unshift(e.s);
    }
  }
  return dist.has(source) ? dist.get(source) : null;
}

function pairsFrom(pairs, elId) {
  return [...pairs.values()].filter((p) => p.from.el === elId);
}

function minStages(back, target, inputs, clocks, pick = 'min') {
  const dist = new Map([[target, 0]]);
  const dq = [target];
  while (dq.length) {
    const v = dq.shift();
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

// A vocabulary function whose required cone operations are all present (the
// most specific entry wins, preferring general names over algorithm claims);
// else a readable generic name.
function inferFunction(cats, fallback, notes, id, sources = []) {
  const GENERAL = ['gf_poly_eval', 'gf_mul', 'gf_add', 'comparator', 'zero_detect', 'gf_div'];
  const candidates = GENERAL.map((k) => [k, VOCABULARY.kinds[k]]).filter(([, e]) => e?.evidence?.cone_all?.every((c) => cats.has(c)));
  candidates.sort((a, b) => b[1].evidence.cone_all.length - a[1].evidence.cone_all.length);
  if (candidates.length && sources.length) {
    const [kind, entry] = candidates[0];
    const file = sources[0].file;
    const same = sources.filter((s) => s.file === file).map((s) => s.line);
    notes.push(`${id}: named ${entry.display} from its RTL cone (${entry.evidence.cone_all.join(', ')}); check the name`);
    return { kind, basis: { source: { file, line: Math.min(...same), end_line: Math.max(...same) }, structure: `cone has ${[...cats].sort().join(', ')}` } };
  }
  notes.push(`${id}: no vocabulary name follows from its RTL cone; named "${fallback}" for the author to refine`);
  return { kind: 'custom', name: /^[a-z]/.test(fallback) ? fallback.replace(/_/g, ' ') : fallback };
}
