// Completeness for microarch figures (trial gap G12): with a netlist, every
// instance within the view depth and every register of the scope module is
// represented by a block — its rtl.instance subtree, or an rtl.covers entry
// (register/signal glob of the scope module, instance path, or instance:glob).
// A block that claims rtl.top without covers represents the scope module's own
// registers (legacy form; soc/top-claimed flags several such blocks). Nets and
// transfers are not counted: a microarch figure draws integration, not wires.

import { diagnostic } from '../diagnostics.mjs';
import { flattenNetlist } from '../rtl/flatten.mjs';

const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|\\[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const relToPath = (flat, rel) => [flat.top, ...(rel ? String(rel).split('/') : [])].join('.');
const pathToRel = (flat, p) => (p === flat.top ? '' : p.slice(flat.top.length + 1).split('.').join('/'));

export function microarchScope(doc) {
  const instance = doc.view?.scope ?? doc.meta?.scope?.instance ?? '';
  const depth = doc.view?.preset === 'detail' ? (doc.view.depth ?? 1) : 1;
  return { instance, depth, declared: Boolean(doc.view || doc.meta?.scope) };
}

export function checkMicroarchCoverage(doc, netlist, { maxListed = 12 } = {}) {
  const diagnostics = [];
  const add = (code, message, subject = {}, evidence = {}, supportedFixes = [], severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  const flat = flattenNetlist(netlist);
  const scope = microarchScope(doc);
  const scopePath = relToPath(flat, scope.instance);
  const mod = flat.instances.get(scopePath);
  if (!mod) {
    add('coverage/scope-unknown', `declared scope ${scope.instance || '(top)'} is not an instance of ${flat.top}`, { scope: scope.instance }, {}, ['fix view.scope']);
    return { diagnostics, report: null };
  }
  const instances = [...flat.instances.keys()].filter((p) => p.startsWith(`${scopePath}.`) && p.slice(scopePath.length + 1).split('.').length <= scope.depth);
  const registers = mod.registers.map((r) => r.name).filter((n) => !n.startsWith('_V'));

  const subtrees = [];
  const regOwner = new Map();
  const unmatched = [];
  const topClaims = [];
  for (const b of doc.blocks || []) {
    const r = b.rtl;
    if (!r) continue;
    if (r.instance) subtrees.push({ path: relToPath(flat, r.instance), id: b.id });
    if (r.top && !r.covers?.length && scopePath === flat.top) topClaims.push(b.id);
    for (const entry of r.covers || []) {
      const [instPart, sigPart] = entry.includes(':') ? entry.split(':') : [null, entry];
      if (instPart === null && !/[*?]/.test(entry) && flat.instances.has(relToPath(flat, entry))) { subtrees.push({ path: relToPath(flat, entry), id: b.id }); continue; }
      const instPath = instPart === null ? scopePath : relToPath(flat, instPart);
      const target = flat.instances.get(instPath);
      const re = globRe(sigPart);
      let hit = false;
      if (target) {
        for (const reg of target.registers) if (re.test(reg.name)) { hit = true; if (instPath === scopePath && !regOwner.has(reg.name)) regOwner.set(reg.name, b.id); }
        for (const n of target.nets) if (n.kind !== 'param' && re.test(n.name)) hit = true;
        for (const i of target.instances) if (re.test(i.name)) { hit = true; subtrees.push({ path: `${instPath}.${i.name}`, id: b.id }); }
      }
      if (!hit) unmatched.push({ block: b.id, entry });
    }
  }
  if (topClaims.length) for (const name of registers) if (!regOwner.has(name)) regOwner.set(name, topClaims[0]);
  const ownerOfInstance = (p) => subtrees.filter((o) => p === o.path || p.startsWith(`${o.path}.`)).sort((a, b) => b.path.length - a.path.length)[0]?.id ?? null;

  const scopeName = pathToRel(flat, scopePath) || flat.top;
  const instItems = instances.map((p) => ({ rel: pathToRel(flat, p), owner: ownerOfInstance(p) }));
  const regItems = registers.map((name) => ({ rel: `${scopeName}:${name}`, owner: regOwner.get(name) ?? null }));
  for (const u of unmatched) add('coverage/covers-unmatched', `block ${u.block}: rtl.covers entry "${u.entry}" matches no register, signal or instance in scope ${scopeName}`, { id: u.block }, { entry: u.entry }, ['fix the glob', 'remove the entry'], 'warning');
  const fixes = ['add a block for it', 'name it in a block\'s rtl.covers (glob) or rtl.instance', 'narrow view.scope'];
  for (const [kind, list] of [['instance', instItems], ['register', regItems]]) {
    const missing = list.filter((it) => !it.owner).map((it) => it.rel);
    if (!missing.length) continue;
    add('coverage/dropped-hardware', `${missing.length} ${kind}${missing.length > 1 ? 's' : ''} inside the declared scope ${scopeName} ${missing.length > 1 ? 'are' : 'is'} not represented by any block: ${missing.slice(0, maxListed).join(', ')}${missing.length > maxListed ? `, … (+${missing.length - maxListed})` : ''}`, { kind, scope: scope.instance }, { kind, missing }, fixes);
  }
  const count = (list) => ({ covered: list.filter((it) => it.owner).length, total: list.length });
  const report = {
    scope: { instance: scope.instance, hierarchy: `depth ${scope.depth}`, depth: scope.depth, declared: scope.declared, figure_type: 'microarch' },
    totals: { registers: count(regItems), instances: count(instItems), nets: { covered: 0, total: 0 }, transfers: { represented: 0, total: 0 } },
    regions: [],
    excluded: { nets: 'not counted for microarch figures', transfers: 'not counted for microarch figures' },
    uncovered: { registers: regItems.filter((it) => !it.owner).map((it) => it.rel), instances: instItems.filter((it) => !it.owner).map((it) => it.rel), covers_unmatched: unmatched.map((u) => `${u.block}: ${u.entry}`) },
  };
  return { diagnostics, report };
}
