// View presets for microarch figures (SPEC §4.8, trial gap G12): `overview`
// draws the scope's children as blocks, `detail` expands `depth` hierarchy
// levels. The shared rules come from lib/view.mjs (the view scope equals the
// declared scope, detail needs a depth, the caption states preset and scope);
// datapath-only rules (gate regions, element kinds, boundary ports) do not apply.

import { diagnostic } from './diagnostics.mjs';
import { flattenNetlist } from './rtl/flatten.mjs';
import { checkView } from './view.mjs';

export const MICROARCH_PRESETS = Object.freeze(['overview', 'detail']);
const underScope = (inst, scope) => !scope || inst === scope || String(inst).startsWith(`${scope}/`);

export function checkMicroarchView(doc, { netlist = null, quality } = {}) {
  if (!doc.view) return { diagnostics: [], report: null };
  const { diagnostics, report } = checkView({ meta: doc.meta, view: doc.view, elements: [], regions: [] }, { quality });
  const add = (code, message, subject = {}, evidence = {}, supportedFixes = [], severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  const scope = doc.view.scope || '';
  if (!MICROARCH_PRESETS.includes(doc.view.preset)) add('view/preset-violation', `microarch figures take the overview or detail preset, not ${doc.view.preset}`, { preset: doc.view.preset }, {}, ['use preset overview or detail']);
  // Blocks drawn from RTL outside the scope would be hardware the scope does not contain.
  for (const b of doc.blocks || []) {
    if (b.rtl?.instance && !underScope(b.rtl.instance, scope)) add('view/context-outside-scope', `block ${b.id} maps ${b.rtl.instance}, outside the view scope ${scope || '(top)'}`, { id: b.id }, {}, ['widen view.scope', 'draw it as context (kind offchip or custom) without rtl.instance']);
  }
  if (netlist) {
    const flat = flattenNetlist(netlist);
    const mod = flat.instances.get([flat.top, ...scope.split('/').filter(Boolean)].join('.'));
    if (!mod) add('view/scope-unknown', `view scope ${scope} is not an instance of ${flat.top}`, { scope }, {}, ['fix view.scope']);
    report.scope_module = mod?.orig_name ?? null;
  }
  return { diagnostics, report };
}
