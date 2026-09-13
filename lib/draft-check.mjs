// Residual checks on a draft (G5). A draft is a starting point, but the author
// must see which of the figure's own checks it still fails, instead of
// discovering them one delivery attempt at a time. Every check that delivery
// runs with a netlist is run here; errors come back with their source.

import { checkCoverage } from './checks/coverage.mjs';
import { checkDatapath } from './checks/datapath.mjs';
import { checkFunctionEvidence } from './checks/function-evidence.mjs';
import { checkLabels } from './checks/labels.mjs';
import { checkLatency } from './checks/latency.mjs';
import { crosscheckDatapath } from './rtl/crosscheck.mjs';
import { validateSchema } from './validate.mjs';
import { checkView } from './view.mjs';

export async function draftResiduals(doc, netlist, { quality, figureDir = process.cwd() } = {}) {
  const residual = [];
  const push = (source, list) => {
    for (const d of list || []) if ((d.severity ?? 'error') === 'error') residual.push({ source, code: d.code, message: d.message });
  };
  const schema = await validateSchema('datapath', doc);
  push('schema', schema);
  if (schema.length) return residual; // semantic checks assume a schema-valid figure
  const run = (source, fn) => {
    try { push(source, fn()); } catch (error) { residual.push({ source, code: 'draft/check-failed', message: `${source} check could not run on the draft: ${error.message}` }); }
  };
  run('datapath', () => checkDatapath(doc).diagnostics);
  run('labels', () => checkLabels(doc, 'datapath', { quality }));
  run('function-evidence', () => checkFunctionEvidence(doc, { figureDir, netlist, quality }).diagnostics);
  if (netlist) {
    run('view', () => checkView(doc, { netlist, quality }).diagnostics);
    run('rtl', () => crosscheckDatapath(doc, netlist).diagnostics);
    run('coverage', () => checkCoverage(doc, netlist).diagnostics);
    run('latency', () => checkLatency(doc, netlist).diagnostics);
  }
  return residual;
}
