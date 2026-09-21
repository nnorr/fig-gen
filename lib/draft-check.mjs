// Residual checks on a draft (G5). A draft is a starting point, but the author
// must see which of the figure's own checks it still fails, instead of
// discovering them one delivery attempt at a time. Every check that delivery
// runs with a netlist is run here; errors come back with their source. A fast
// layout pass (N2) renders the draft once in its delivery format and reports
// layout, fit and connector errors apart from the semantic ones.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { checkCoverage } from './checks/coverage.mjs';
import { checkDatapath } from './checks/datapath.mjs';
import { checkFunctionEvidence } from './checks/function-evidence.mjs';
import { checkLabels } from './checks/labels.mjs';
import { checkLatency } from './checks/latency.mjs';
import { checkMicroarch } from './checks/microarch.mjs';
import { checkMicroarchCoverage } from './checks/microarch-coverage.mjs';
import { relaxDiagnostics, resolveFormat, STUDY_PROFILE_FILE } from './format.mjs';
import { crosscheckDatapath, crosscheckSoc } from './rtl/crosscheck.mjs';
import { validateSchema } from './validate.mjs';
import { checkView, withViewScope } from './view.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    run('latency', () => checkLatency(doc, netlist, { quality }).diagnostics);
  }
  return residual;
}

// The checks delivery runs on a microarch figure with a netlist (N7).
export async function draftMicroarchResiduals(doc, netlist, { quality, figureDir = process.cwd() } = {}) {
  const residual = [];
  const push = (source, list) => {
    for (const d of list || []) if ((d.severity ?? 'error') === 'error') residual.push({ source, code: d.code, message: d.message });
  };
  const schema = await validateSchema('microarch', doc);
  push('schema', schema);
  if (schema.length) return residual;
  const run = (source, fn) => {
    try { push(source, fn()); } catch (error) { residual.push({ source, code: 'draft/check-failed', message: `${source} check could not run on the draft: ${error.message}` }); }
  };
  run('microarch', () => checkMicroarch(doc, { figureDir, quality }).diagnostics);
  run('labels', () => checkLabels(doc, 'microarch', { quality }));
  if (netlist) {
    run('rtl', () => crosscheckSoc(doc, netlist).diagnostics);
    run('coverage', () => checkMicroarchCoverage(doc, netlist).diagnostics);
  }
  return residual;
}

// A figure larger than this is not laid out by the draft (the full layout of a
// very large draft can take minutes); the note says so.
export const DRAFT_LAYOUT_LIMITS = Object.freeze({ elements: 160, nets: 400, seconds: 60 });

// One render of the draft in its delivery format: the 2col variant of its print
// profile (paper) or the study variant. Returns the error diagnostics as
// layout residuals, the measured size, or why the layout was skipped. The pass
// is bounded by size (limits) and by time (seconds, checked when the render
// yields; a render past its time is abandoned and reported as skipped).
export async function draftLayout(doc, { type = 'datapath', format, seconds = DRAFT_LAYOUT_LIMITS.seconds, limits = DRAFT_LAYOUT_LIMITS } = {}) {
  if (!(seconds > 0)) return { skipped: 'layout pass disabled (--layout-seconds 0)', residual: [] };
  const fmt = resolveFormat(doc, format).format;
  const study = fmt === 'study';
  const elements = type === 'datapath' ? (doc.elements?.length ?? 0) : (doc.blocks?.length ?? 0);
  const nets = type === 'datapath' ? (doc.nets?.length ?? 0) : (doc.links?.length ?? 0) + (doc.attachments?.length ?? 0) + (doc.interfaces?.length ?? 0);
  if (elements > limits.elements || nets > limits.nets) return { skipped: `${elements} elements and ${nets} connections exceed the draft layout limit (${limits.elements} elements, ${limits.nets} connections)`, residual: [] };
  let pv;
  let variant;
  if (study) {
    variant = 'study';
    pv = JSON.parse(fs.readFileSync(STUDY_PROFILE_FILE, 'utf8')).variants.study;
  } else {
    variant = '2col';
    const profiles = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'print-profiles.json'), 'utf8'));
    pv = profiles.profiles[doc.meta?.print?.profile ?? 'ieee']?.variants?.['2col'];
  }
  if (!pv) return { skipped: `print profile ${doc.meta?.print?.profile} has no 2col variant`, residual: [] };
  const maxHeightPt = study ? undefined : (doc.meta?.print?.max_height_in?.[variant] ? doc.meta.print.max_height_in[variant] * 72 : pv.max_height_pt);
  const opts = { variant, widthPt: pv.width_pt ?? undefined, maxHeightPt, minFontPt: pv.min_font_pt, minStrokePt: pv.min_stroke_pt, name: 'draft' };
  const input = type === 'datapath' ? withViewScope(doc) : doc;
  // Isolate layout: a Promise.race alone leaves ELK/render work alive after
  // the timeout and can keep the CLI consuming CPU indefinitely.
  const worker = new Worker(new URL('./draft-layout-worker.mjs', import.meta.url), {
    workerData: { type, input, opts }, execArgv: [],
  });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), seconds * 1000); });
  let rendered;
  try {
    const result = new Promise((resolve, reject) => {
      worker.once('message', (message) => message.error ? reject(new Error(message.error)) : resolve(message.result));
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`layout worker exited before returning a result (${code})`)));
    });
    rendered = await Promise.race([result, timeout]);
  } catch (error) {
    return { variant, residual: [{ source: 'layout', code: 'draft/layout-failed', message: `the layout could not run on the draft: ${error.message}` }] };
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
  if (!rendered) return { skipped: `the layout did not finish within ${seconds} s (--layout-seconds)`, residual: [] };
  const local = [...rendered.diagnostics];
  if (pv.width_pt != null && rendered.width_pt > pv.width_pt + 0.01) local.push({ code: 'print/width-overflow', severity: 'error', message: `${variant}: ${rendered.width_pt} pt wider than ${pv.width_pt} pt` });
  relaxDiagnostics(local, fmt);
  const residual = local.filter((d) => d.severity === 'error').map((d) => ({ source: 'layout', code: d.code, message: d.message }));
  return { variant, width_pt: rendered.width_pt, height_pt: rendered.height_pt, max_height_pt: maxHeightPt ?? null, residual };
}
