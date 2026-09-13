// Completeness against the declared RTL scope (SPEC §4.7, CONVENTIONS §4.1b):
// abstraction may collapse hardware, never drop it. Every instance, register
// (including memories) and live net inside the figure's declared scope, and
// every datapath/control transfer between them, must be represented: drawn,
// mapped by a net, or contained in a collapsed/blackbox element whose rtl
// mapping covers it. The only way to leave hardware out is to narrow the
// declared scope (meta.scope).

import { diagnostic } from '../diagnostics.mjs';
import { buildModel } from '../ir/datapath-model.mjs';
import { flattenNetlist } from '../rtl/flatten.mjs';

const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|\\[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const relToPath = (flat, rel) => [flat.top, ...(rel ? String(rel).split('/') : [])].join('.');
const pathToRel = (flat, p) => (p === flat.top ? '' : p.slice(flat.top.length + 1).split('.').join('/'));

// Union-find over signals joined by a plain instance port connection: a
// parent net and the child port it connects to are one wire.
export function aliasClasses(netlist) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    let c = x;
    while (parent.has(c) && parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };
  const byName = new Map(netlist.modules.map((m) => [m.name, m]));
  for (const h of netlist.hierarchy) {
    const m = byName.get(h.module);
    if (!m) continue;
    for (const inst of m.instances) {
      for (const c of inst.connections) if (c.expr.kind === 'net') union(`${h.path}.${c.expr.net}`, `${h.path}.${inst.name}.${c.port}`);
    }
  }
  const members = new Map();
  return {
    find,
    membersOf(x) {
      if (!members.size) for (const p of parent.keys()) { const r = find(p); if (!members.has(r)) members.set(r, new Set([r])); members.get(r).add(p); }
      return members.get(find(x)) ?? new Set([x]);
    },
  };
}

export function declaredScope(doc, flat) {
  const s = doc.meta?.scope;
  const rel = s?.instance ?? doc.meta?.rtl?.instance ?? '';
  return { instance: rel, path: relToPath(flat, rel), hierarchy: s?.hierarchy ?? 'all', cone: s?.cone ?? null, declared: Boolean(s) };
}

// Owners of RTL signals in the figure. Priority: a net mapping (4) > an
// element's rtl.signal (3) > a covers entry naming signals (2) > a covered
// instance subtree (1).
export function figureOwners(doc, netlist, flat = flattenNetlist(netlist), aliases = aliasClasses(netlist)) {
  const base = doc.meta?.rtl?.instance;
  const bySignal = new Map();
  const allClaims = new Map();
  const subtrees = [];
  const claim = (sigPath, owner, rank) => {
    const key = aliases.find(sigPath);
    const cur = bySignal.get(key);
    if (!cur || cur.rank < rank) bySignal.set(key, { ...owner, rank });
    if (!allClaims.has(key)) allClaims.set(key, []);
    allClaims.get(key).push({ ...owner, rank });
  };
  const signalsIn = (instPath) => [...flat.signals.values()].filter((s) => s.instance === instPath);
  for (const n of doc.nets || []) {
    if (!n.rtl?.signal) continue;
    const p = `${relToPath(flat, n.rtl.instance ?? base)}.${n.rtl.signal}`;
    if (flat.signals.has(p)) claim(p, { kind: 'net', id: n.id }, 4);
  }
  for (const e of doc.elements || []) {
    const owner = { kind: 'element', id: e.id };
    if (e.rtl?.signal) {
      const p = `${relToPath(flat, e.rtl.instance ?? base)}.${e.rtl.signal}`;
      if (flat.signals.has(p)) claim(p, owner, 3);
    }
    if (e.kind === 'instance' && e.rtl?.instance) subtrees.push({ path: relToPath(flat, e.rtl.instance), owner });
    for (const entry of e.rtl?.covers || []) {
      const [instPart, sigPart] = entry.includes(':') ? entry.split(':') : [null, entry];
      if (instPart === null && flat.instances.has(relToPath(flat, entry))) { subtrees.push({ path: relToPath(flat, entry), owner }); continue; }
      const instPath = relToPath(flat, instPart ?? base);
      const re = globRe(sigPart);
      for (const s of signalsIn(instPath)) if (re.test(s.name)) claim(s.path, owner, 2);
    }
  }
  // A gate region is equivalence-checked against the RTL cone between its
  // input and output nets, so the signals inside that cone are represented by
  // its gates (owned by the gate that drives the region output).
  const model = buildModel(doc);
  for (const r of (doc.regions || []).filter((x) => x.level === 'gate')) {
    const members = new Set(r.members);
    const inst = relToPath(flat, r.rtl?.instance ?? base);
    const sigOf = (n) => (n.net.rtl?.signal ? aliases.find(`${relToPath(flat, n.net.rtl.instance ?? r.rtl?.instance ?? base)}.${n.net.rtl.signal}`) : null);
    const inputs = new Set(model.nets.filter((n) => (n.driver.error || !members.has(n.driver.element.id)) && n.sinks.some((x) => !x.error && members.has(x.element.id))).map(sigOf).filter(Boolean));
    const regionOuts = model.nets.filter((n) => !n.driver.error && members.has(n.driver.element.id) && n.net.rtl?.signal);
    const outSigs = new Set(regionOuts.map(sigOf));
    for (const o of regionOuts) {
      const owner = { kind: 'element', id: o.driver.element.id };
      const queue = [`${relToPath(flat, o.net.rtl.instance ?? r.rtl?.instance ?? base)}.${o.net.rtl.signal}`];
      const seen = new Set();
      while (queue.length) {
        const v = queue.shift();
        if (seen.has(v) || inputs.has(aliases.find(v)) || (seen.size && outSigs.has(aliases.find(v)))) continue;
        seen.add(v);
        if (flat.signals.get(v)?.instance === inst && !flat.signals.get(v)?.register) claim(v, owner, 2);
        for (const { source, kind } of flat.back.get(v) || []) if (kind === 'comb' && flat.signals.get(source)?.instance === inst) queue.push(source);
      }
    }
  }
  // Longest subtree first, so a nested instance owned separately wins.
  subtrees.sort((a, b) => b.path.length - a.path.length);
  const subtreeOwner = (p) => subtrees.find((t) => p === t.path || p.startsWith(`${t.path}.`))?.owner ?? null;
  const ownerOfSignal = (sigPath) => {
    let best = bySignal.get(aliases.find(sigPath)) ?? null;
    if (!best) {
      for (const m of aliases.membersOf(sigPath)) {
        const inst = flat.signals.get(m)?.instance;
        const o = inst ? subtreeOwner(inst) : null;
        if (o) { best = { ...o, rank: 1 }; break; }
      }
    }
    return best;
  };
  // Every owner that represents a signal: its claims (best first), then the
  // collapsed instances containing any member of its alias class. An instance
  // output read back inside that instance is represented by the instance even
  // when a port or net also covers the signal (the port is a sink; it cannot
  // drive back into the instance).
  const ownersOfSignal = (sigPath) => {
    const list = [...(allClaims.get(aliases.find(sigPath)) || [])].sort((a, b) => b.rank - a.rank);
    for (const m of aliases.membersOf(sigPath)) {
      const inst = flat.signals.get(m)?.instance;
      const o = inst ? subtreeOwner(inst) : null;
      if (o && !list.some((x) => x.kind === o.kind && x.id === o.id)) list.push({ ...o, rank: 1 });
    }
    return list;
  };
  return { ownerOfSignal, ownersOfSignal, subtreeOwner, subtrees };
}

export function checkCoverage(doc, netlist, { maxListed = 12 } = {}) {
  const diagnostics = [];
  const flat = flattenNetlist(netlist);
  const aliases = aliasClasses(netlist);
  const scope = declaredScope(doc, flat);
  const add = (code, message, subject, evidence, supportedFixes, severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  if (!flat.instances.has(scope.path)) {
    add('coverage/scope-unknown', `declared scope ${scope.instance || '(top)'} is not an instance of ${flat.top}`, { scope: scope.instance }, { hierarchy: [...flat.instances.keys()] }, ['fix meta.scope.instance']);
    return { diagnostics, report: null };
  }
  if (!scope.declared) add('coverage/scope-undeclared', `no meta.scope: the figure's scope defaults to ${scope.instance || flat.top} with its whole hierarchy, and everything in it must be represented`, {}, { instance: scope.instance }, ['declare meta.scope (instance, hierarchy, or a cone) explicitly'], 'warning');

  const byName = new Map(netlist.modules.map((m) => [m.name, m]));
  const inScopeInstances = [...flat.instances.keys()].filter((p) => p === scope.path || (scope.hierarchy === 'all' && p.startsWith(`${scope.path}.`)));
  const domainNets = new Set((doc.clock_domains || []).flatMap((d) => [d.clock, d.reset?.net].filter(Boolean)));

  // Per-instance signal facts: live (read somewhere), implicit (clock/reset), constant.
  const facts = new Map();
  for (const p of inScopeInstances) {
    const m = flat.instances.get(p);
    // Live signals: ports, registers, instance connections, and anything read
    // by a live signal. A net read only by dead logic is dead too (e.g. a
    // Horner chain left unused by a generate branch).
    const used = new Set([...m.ports.map((q) => q.name), ...m.registers.map((r) => r.name)]);
    for (const inst of m.instances) for (const c of inst.connections) for (const n of c.expr.net ? [c.expr.net] : (c.expr.nets || [])) used.add(n);
    for (let changed = true; changed;) {
      changed = false;
      for (const d of m.deps || []) {
        if (!used.has(d.target)) continue;
        for (const s of d.sources) if (!used.has(s)) { used.add(s); changed = true; }
      }
    }
    const clocks = new Set(m.registers.flatMap((r) => [r.clock?.net, r.reset?.net].filter(Boolean)));
    const constants = new Set((m.deps || []).filter((d) => d.kind === 'comb' && d.sources.length === 0 && !(m.deps || []).some((o) => o.target === d.target && o.sources.length)).map((d) => d.target));
    facts.set(p, { m, used, clocks, constants });
  }
  const isImplicit = (sigPath) => [...aliases.membersOf(sigPath)].some((q) => {
    const s = flat.signals.get(q);
    if (!s) return false;
    return facts.get(s.instance)?.clocks.has(s.name) || (s.instance === flat.top && domainNets.has(s.name));
  });

  // Cone scope: signals on paths from the cone inputs to its outputs.
  let coneSet = null;
  if (scope.cone) {
    coneSet = new Set();
    const stop = new Set((scope.cone.inputs || []).map((n) => aliases.find(`${scope.path}.${n}`)));
    const queue = (scope.cone.outputs || []).map((n) => `${scope.path}.${n}`);
    while (queue.length) {
      const v = queue.shift();
      if (coneSet.has(v)) continue;
      coneSet.add(v);
      for (const { source } of flat.back.get(v) || []) if (!stop.has(aliases.find(source)) && !coneSet.has(source) && flat.signals.get(source)?.instance === scope.path) queue.push(source);
    }
  }

  const { ownerOfSignal, ownersOfSignal, subtreeOwner } = figureOwners(doc, netlist, flat, aliases);
  const items = { registers: [], nets: [], instances: [], memories: [] };
  // Dead logic (read by nothing live) is excluded and listed, so a figure that
  // leaves it out says what it left out.
  const excluded = { dead_nets: 0, implicit_nets: 0, internal: 0, dead_logic: [] };
  for (const s of flat.signals.values()) {
    const f = facts.get(s.instance);
    if (!f) continue;
    if (coneSet && !coneSet.has(s.path)) continue;
    if (s.name.startsWith('_V')) { excluded.internal += 1; continue; }
    if (flat.instances.get(s.instance).blackbox) continue; // stub ports: covered with their instance
    const owner = ownerOfSignal(s.path);
    if (s.register) {
      const reg = f.m.registers.find((r) => r.name === s.name);
      const item = { path: s.path, rel: `${pathToRel(flat, s.instance) || flat.top}:${s.name}`, owner };
      items.registers.push(item);
      if (reg?.array) items.memories.push(item);
      continue;
    }
    if (isImplicit(s.path)) { excluded.implicit_nets += 1; continue; }
    if (!f.used.has(s.name) && !s.portDir) { excluded.dead_nets += 1; excluded.dead_logic.push(`${pathToRel(flat, s.instance) || flat.top}:${s.name}`); continue; }
    items.nets.push({ path: s.path, rel: `${pathToRel(flat, s.instance) || flat.top}:${s.name}`, owner });
  }
  if (!coneSet) {
    for (const p of inScopeInstances.filter((x) => x !== scope.path)) {
      const mod = flat.instances.get(p);
      let owner = subtreeOwner(p);
      if (!owner) {
        // Drawn in detail: every register and live net inside it is represented.
        const inside = [...items.registers, ...items.nets].filter((it) => it.path.startsWith(`${p}.`));
        if (inside.length && inside.every((it) => it.owner)) owner = { kind: 'expanded', id: pathToRel(flat, p) };
      }
      const item = { path: p, rel: pathToRel(flat, p), owner };
      items.instances.push(item);
      if (mod.blackbox) items.memories.push(item);
    }
  }

  // Transfers: dependency edges inside the scope between represented signals.
  const model = buildModel(doc);
  const nodeKey = (o) => `${o.kind}:${o.id}`;
  const ownerNodes = new Set([...items.registers, ...items.nets].map((it) => it.owner).filter((o) => o && o.kind !== 'expanded').map(nodeKey));
  for (const s of doc.elements || []) if (s.rtl?.covers?.length || (s.kind === 'instance' && s.rtl?.instance)) ownerNodes.add(`element:${s.id}`);
  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const n of model.nets) {
    if (!n.driver.error) link(`element:${n.driver.element.id}`, `net:${n.net.id}`);
    for (const s of n.sinks) if (!s.error) link(`net:${n.net.id}`, `element:${s.element.id}`);
  }
  const driverOfNet = new Map(model.nets.filter((n) => !n.driver.error).map((n) => [`net:${n.net.id}`, `element:${n.driver.element.id}`]));
  const reachCache = new Map();
  const represented = (from, to) => {
    const key = `${from}>${to}`;
    if (reachCache.has(key)) return reachCache.get(key);
    // A dependency between two signals an element computes (both on its
    // output nets, or its output feeding its own internals) is inside it.
    const fromEl = driverOfNet.get(from);
    let ok = from === to || fromEl === to || (fromEl !== undefined && driverOfNet.get(to) === fromEl);
    const seen = new Set([from]);
    const queue = [[from, 0]];
    while (!ok && queue.length) {
      const [v, depth] = queue.shift();
      for (const w of adj.get(v) || []) {
        if (w === to) { ok = true; break; }
        // A net that carries another RTL mapping ends the search (the transfer
        // would pass through a different signal); elements may be passed.
        if (seen.has(w) || depth > 16 || (w.startsWith('net:') && ownerNodes.has(w))) continue;
        seen.add(w);
        queue.push([w, depth + 1]);
      }
    }
    reachCache.set(key, ok);
    return ok;
  };
  const transfers = { represented: 0, total: 0 };
  const missingPairs = new Map();
  // Name the figure owners of both ends and why no drawn path joins them.
  const describe = (o) => {
    if (o.kind === 'net') return `net ${o.id}`;
    const e = (doc.elements || []).find((x) => x.id === o.id);
    return e ? `${e.kind}${e.kind === 'port' ? ` (${e.dir})` : ''} ${o.id}` : o.id;
  };
  const whyNoPath = (a, b) => {
    const e = a.kind === 'element' ? (doc.elements || []).find((x) => x.id === a.id) : null;
    if (e?.kind === 'port' && e.dir === 'out') return `the source is owned by ${describe(a)}, and an output port cannot drive back into ${describe(b)}`;
    return `no drawn wire leads from ${describe(a)} to ${describe(b)}`;
  };
  const inItems = new Set([...items.registers, ...items.nets].map((it) => it.path));
  for (const p of inScopeInstances) {
    const f = facts.get(p);
    for (const d of f.m.deps || []) {
      const T = `${p}.${d.target}`;
      if (!inItems.has(T)) continue;
      for (const src of d.sources) {
        const S = `${p}.${src}`;
        if (f.clocks.has(src) || f.constants.has(src) || src.startsWith('_V') || isImplicit(S)) continue;
        if (coneSet && !coneSet.has(S) && !(scope.cone.inputs || []).includes(src)) continue;
        const [oS, oT] = [ownerOfSignal(S), ownerOfSignal(T)];
        if (!oS || !oT) continue; // the signal itself is reported
        transfers.total += 1;
        // Represented when any owner of the source connects to any owner of the target.
        const sources = ownersOfSignal(S);
        const targets = ownersOfSignal(T);
        if (sources.some((a) => targets.some((b) => represented(nodeKey(a), nodeKey(b))))) { transfers.represented += 1; continue; }
        const pair = `${nodeKey(oS)} → ${nodeKey(oT)}`;
        if (!missingPairs.has(pair)) missingPairs.set(pair, { examples: [], why: whyNoPath(oS, oT) });
        missingPairs.get(pair).examples.push(`${pathToRel(flat, p) || flat.top}:${src} → ${d.target}`);
      }
    }
  }

  const count = (list) => ({ covered: list.filter((it) => it.owner).length, total: list.length });
  const totals = { registers: count(items.registers), instances: count(items.instances), nets: count(items.nets), memories: count(items.memories), transfers };
  const fixes = ['draw the hardware', 'collapse it into a block or blackbox whose rtl.covers (or rtl.instance) names it', 'narrow meta.scope explicitly, or split into sub-figures (a)/(b) linked with detail_ref'];
  for (const [kind, list] of [['register', items.registers], ['instance', items.instances], ['net', items.nets]]) {
    const missing = list.filter((it) => !it.owner);
    if (!missing.length) continue;
    const names = missing.map((it) => it.rel);
    add('coverage/dropped-hardware', `${missing.length} ${kind}${missing.length > 1 ? 's' : ''} inside the declared scope ${scope.instance || flat.top} ${missing.length > 1 ? 'are' : 'is'} not represented: ${names.slice(0, maxListed).join(', ')}${names.length > maxListed ? `, … (+${names.length - maxListed})` : ''}`, { kind, scope: scope.instance }, { kind, missing: names }, fixes);
  }
  for (const [pair, { examples, why }] of missingPairs) {
    add('coverage/dropped-hardware', `transfer ${pair} is not drawn (${why}): no wire connects the elements that represent ${examples.slice(0, 4).join('; ')}${examples.length > 4 ? `; … (+${examples.length - 4})` : ''}`, { kind: 'transfer', pair }, { kind: 'transfer', pair, examples, why }, ['draw a net (or a bundled net) between the two elements', ...fixes.slice(1)]);
  }

  // Per region: what its members represent; regions mapped to an instance also count what is missing inside it.
  const memberOf = (region, owner) => {
    if (!owner) return false;
    if (owner.kind === 'element') return region.members.includes(owner.id);
    if (owner.kind === 'net') {
      const n = model.nets.find((x) => x.net.id === owner.id);
      return Boolean(n && !n.driver.error && region.members.includes(n.driver.element.id));
    }
    return false;
  };
  const regions = (doc.regions || []).map((r) => {
    const within = r.rtl?.instance ? relToPath(flat, r.rtl.instance) : null;
    const pick = (list) => list.filter((it) => memberOf(r, it.owner) || (within && (it.path === within || it.path.startsWith(`${within}.`))));
    return { id: r.id, level: r.level, registers: count(pick(items.registers)), instances: count(pick(items.instances)), nets: count(pick(items.nets)) };
  });
  const report = {
    scope: { instance: scope.instance, hierarchy: scope.hierarchy, ...(scope.cone ? { cone: scope.cone } : {}), declared: scope.declared },
    totals,
    regions,
    excluded,
    uncovered: {
      registers: items.registers.filter((it) => !it.owner).map((it) => it.rel),
      instances: items.instances.filter((it) => !it.owner).map((it) => it.rel),
      nets: items.nets.filter((it) => !it.owner).map((it) => it.rel),
      transfers: [...missingPairs.keys()],
    },
  };
  return { diagnostics, report };
}
