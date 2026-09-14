// View presets (SPEC §4.8): one design delivered at different scope and
// abstraction. A figure's `view` names the preset and the scope; the preset
// constrains what the figure may draw, the scope is the declared scope that
// the completeness rule (coverage/dropped-hardware) applies to, and the
// receipt and caption state both.
//
//   overview  whole scope; children collapsed to functional blocks; pipeline
//             registers on shown paths stay visible; no gate regions
//   block     scope = one instance path, drawn at rtl/block level; its
//             ports are the figure ports; no gate regions
//   mixed     block or overview scope plus the listed gate regions and
//             blackbox elements (and only those)
//   detail    scope expanded `depth` hierarchy levels; collapse only where
//             2col would otherwise fail (reported)

import { abstraction } from './abstraction.mjs';
import { aliasClasses } from './checks/coverage.mjs';
import { diagnostic } from './diagnostics.mjs';
import { flattenNetlist } from './rtl/flatten.mjs';

export const PRESETS = Object.freeze(['overview', 'block', 'mixed', 'detail']);
const DETAIL_KINDS = new Set(['mux', 'register']);
const WIRING_OPS = new Set(['split', 'concat', 'extend', 'replicate', 'custom']);

// Merge CLI overrides (--view, --scope, --depth, --gate-region, --blackbox)
// into a copy of the figure. Returns { doc, overrides } (overrides null when none).
export function applyViewOverrides(doc, { preset, scope, depth, gateRegions, blackbox } = {}) {
  const overrides = Object.fromEntries(Object.entries({ preset, scope, depth, gate_regions: gateRegions, blackbox }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
  if (!Object.keys(overrides).length) return { doc, overrides: null };
  const out = structuredClone(doc);
  out.view = { ...(out.view || {}), ...overrides };
  if (overrides.depth !== undefined) out.view.depth = Number(overrides.depth);
  if (overrides.scope !== undefined && out.meta?.scope) {
    // The declared scope follows the selected view scope.
    out.meta.scope = { ...out.meta.scope, ...(overrides.scope ? { instance: overrides.scope } : {}) };
    if (!overrides.scope) delete out.meta.scope.instance;
  }
  return { doc: out, overrides };
}

// The declared scope a view implies (meta.scope wins when both agree).
export function viewScope(doc) {
  const v = doc.view;
  if (!v) return null;
  return { instance: v.scope || '', hierarchy: 'all' };
}

// Copy of the figure with meta.scope filled from the view when absent.
export function withViewScope(doc) {
  if (!doc.view || doc.meta?.scope) return doc;
  const out = { ...doc, meta: { ...doc.meta, scope: { ...(doc.view.scope ? { instance: doc.view.scope } : {}), hierarchy: 'all' } } };
  return out;
}

const underScope = (inst, scope) => !scope || inst === scope || String(inst).startsWith(`${scope}/`);
const humanScope = (scope) => (scope ? scope.split('/').at(-1) : null);

export function checkView(doc, { netlist = null, quality } = {}) {
  const diagnostics = [];
  const v = doc.view;
  if (!v) return { diagnostics, report: null };
  const add = (code, message, subject = {}, evidence = {}, supportedFixes = [], severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  const scope = v.scope || '';
  const regions = doc.regions || [];
  const gateRegions = regions.filter((r) => r.level === 'gate');
  const elements = doc.elements || [];

  // The view scope and the declared scope are one thing.
  const declared = doc.meta?.scope;
  if (declared && (declared.instance || '') !== scope) add('view/scope-mismatch', `view.scope "${scope || '(top)'}" differs from meta.scope.instance "${declared.instance || '(top)'}"`, {}, {}, ['use one scope: set meta.scope.instance to the view scope or drop meta.scope']);

  const preset = (why, fixes) => add('view/preset-violation', `${v.preset} view: ${why}`, { preset: v.preset }, {}, fixes);
  if ((v.preset === 'overview' || v.preset === 'block') && gateRegions.length) preset(`gate regions (${gateRegions.map((r) => r.id).join(', ')}) belong to the mixed preset`, ['use preset mixed and list the gate regions', 'draw the logic at block level']);
  // An empty scope is the netlist top itself: a block view of the top module (its ports are the figure ports).
  if (v.preset === 'detail' && !(v.depth >= 1)) preset('the detail preset needs depth ≥ 1', ['set view.depth']);
  if (v.preset !== 'mixed' && (v.gate_regions?.length || v.blackbox?.length)) preset('gate_regions and blackbox selections belong to the mixed preset', ['use preset mixed']);
  if (v.preset === 'overview') {
    // Children are functional blocks: no gate, mux or register detail. Pipeline
    // bars (rule: pipeline registers stay visible) and wiring are allowed.
    const detail = elements.filter((e) => DETAIL_KINDS.has(e.kind) || (e.kind === 'comb' && !WIRING_OPS.has(e.op)));
    if (detail.length) preset(`draws detail elements ${detail.map((e) => e.id).join(', ')}; collapse them into functional blocks (pipeline-register bars stay)`, ['collapse into custom blocks with rtl.covers', 'use preset block, mixed or detail']);
  }
  if (v.preset === 'mixed') {
    const listed = new Set(v.gate_regions || []);
    for (const id of listed) {
      const r = regions.find((x) => x.id === id);
      if (!r || r.level !== 'gate') add('view/gate-region-unknown', `mixed view lists gate region ${id}, but the figure has no gate region with that id`, { id }, {}, ['define the region with level gate', 'fix view.gate_regions']);
    }
    for (const r of gateRegions.filter((x) => !listed.has(x.id))) add('view/gate-region-unselected', `gate region ${r.id} is not selected in view.gate_regions`, { id: r.id }, {}, ['add it to view.gate_regions', 'draw it at block level']);
    for (const b of v.blackbox || []) {
      const el = elements.find((e) => e.id === b || e.rtl?.instance === b);
      const isBlackbox = el && (el.level === 'blackbox' || regions.some((r) => r.level === 'blackbox' && r.members.includes(el.id)));
      if (!isBlackbox) add('view/blackbox-unknown', `mixed view lists blackbox ${b}, but no blackbox element or instance matches it`, { id: b }, {}, ['model it as an instance with level blackbox', 'fix view.blackbox']);
    }
  }
  // Context outside the scope may only appear as blackboxes.
  for (const e of elements.filter((x) => x.rtl?.instance && !underScope(x.rtl.instance, scope))) {
    const isBlackbox = e.level === 'blackbox' || regions.some((r) => r.level === 'blackbox' && r.members.includes(e.id));
    if (!isBlackbox) add('view/context-not-blackbox', `element ${e.id} maps ${e.rtl.instance}, outside the view scope ${scope || '(top)'}; context outside the scope is drawn only as a blackbox`, { id: e.id }, {}, ['set level blackbox', 'widen the scope']);
  }

  const report = { preset: v.preset, scope: scope || null, ...(v.depth !== undefined ? { depth: v.depth } : {}), ...(v.gate_regions?.length ? { gate_regions: v.gate_regions } : {}), ...(v.blackbox?.length ? { blackbox: v.blackbox } : {}) };
  if (netlist) {
    const flat = flattenNetlist(netlist);
    const rel = (p) => (p === flat.top ? '' : p.slice(flat.top.length + 1).replace(/\./g, '/'));
    const scopePath = [flat.top, ...(scope ? scope.split('/') : [])].join('.');
    const mod = flat.instances.get(scopePath);
    if (mod && v.preset === 'block') {
      // Clock and reset stay implicit: a scope port is one when any register
      // under the scope (the scope module or a child, e.g. at the netlist top)
      // is clocked or reset by it through port connections.
      const aliases = aliasClasses(netlist);
      const implicit = new Set();
      for (const [p, m] of flat.instances) {
        if (p !== scopePath && !p.startsWith(`${scopePath}.`)) continue;
        for (const r of m.registers || []) for (const n of [r.clock?.net, r.reset?.net].filter(Boolean)) implicit.add(aliases.find(`${p}.${n}`));
      }
      const clocks = new Set(mod.ports.filter((p) => implicit.has(aliases.find(`${scopePath}.${p.name}`))).map((p) => p.name));
      for (const clk of doc.clock_domains || []) { clocks.add(clk.clock); if (clk.reset?.net) clocks.add(clk.reset.net); }
      const shown = new Set(elements.filter((e) => e.kind === 'port').flatMap((e) => [e.rtl?.signal, ...(e.rtl?.covers || [])].filter(Boolean)));
      const missing = mod.ports.filter((p) => !clocks.has(p.name) && !shown.has(p.name)).map((p) => p.name);
      if (missing.length) add('view/boundary-port', `block view of ${scope || '(top)'}: scope ports ${missing.join(', ')} are not figure ports`, { scope }, { missing }, ['add a port element with rtl.signal for each scope port (bundle with rtl.covers)']);
    }
    if (v.preset === 'detail' && v.depth >= 1) {
      // Instances within the depth that the figure collapses (allowed only where 2col would fail).
      const collapsed = elements.filter((e) => e.kind === 'instance' && e.rtl?.instance && underScope(e.rtl.instance, scope)).map((e) => e.rtl.instance)
        .filter((inst) => {
          const d = inst.split('/').length - (scope ? scope.split('/').length : 0);
          return d >= 1 && d <= v.depth && !flat.instances.get([flat.top, ...inst.split('/')].join('.'))?.blackbox;
        });
      report.collapsed_within_depth = collapsed;
      if (collapsed.length) add('view/detail-collapsed', `detail view (depth ${v.depth}) collapses ${collapsed.join(', ')}; collapse inside the depth only where 2col would otherwise fail, and say so in the caption`, {}, { collapsed }, ['expand the instances', 'state in the caption why they are collapsed'], 'warning');
    }
    report.scope_module = mod?.orig_name ?? null;
    void rel;
  }

  // Declared abstraction: only handshake nets between drawn blocks, and the caption says so.
  const abs = abstraction(doc);
  diagnostics.push(...abs.diagnostics);
  if (abs.abstracted.length) report.abstracted_handshakes = abs.abstracted.map((a) => ({ net: a.net, signal: a.signal, reason: a.reason }));

  // The caption states the preset and the scope.
  const caption = String(doc.meta?.caption || '').toLowerCase();
  const scopeWord = humanScope(scope);
  const namesScope = scope ? caption.includes(scope.toLowerCase()) || caption.includes(String(scopeWord).toLowerCase()) : /\b(whole|entire|top|complete)\b/.test(caption);
  if (!caption.includes(v.preset) || !namesScope) add('view/caption', `the caption must state the ${v.preset} view and its scope (${scope || 'the whole design'})`, {}, {}, [`mention "${v.preset} view" and ${scope ? `"${scope}"` : '"whole"'} in meta.caption`], quality === 'paper' ? 'error' : 'warning');
  return { diagnostics, report };
}
