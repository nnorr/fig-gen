// Build and deliver a figure (SPEC §12): schema → semantic → source pins →
// evidence guard → RTL cross-check → per-variant render → figma-safe lint →
// outlined PDF → print checks → atomic write of all artifacts + receipt.
// Any error means nothing is written. Verification is reported per region.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCoverage } from './checks/coverage.mjs';
import { checkDatapath } from './checks/datapath.mjs';
import { checkDetailRefs } from './checks/detail-refs.mjs';
import { checkLatency } from './checks/latency.mjs';
import { applyViewOverrides, checkView, withViewScope } from './view.mjs';
import { checkFunctionEvidence } from './checks/function-evidence.mjs';
import { checkLabels, nameIgnored, printedDuplicates } from './checks/labels.mjs';
import { DEFAULT_SCALE, rasterizeSvg, selectRasterizer } from './preview.mjs';
import { checkNetClasses } from './checks/net-class.mjs';
import { checkDocFacts } from './doc-facts.mjs';
import { checkRegionEquivalence } from './checks/equivalence.mjs';
import { checkMicroarch } from './checks/microarch.mjs';
import { checkFsm } from './checks/fsm.mjs';
import { checkMicroarchCoverage } from './checks/microarch-coverage.mjs';
import { summarize } from './diagnostics.mjs';
import { STUDY_PROFILE_FILE, formatReceipt, relaxDiagnostics, resolveFormat } from './format.mjs';
import { SKILL_ROOT, checkNetlistEvidence, gitOrigin, selfAuthoredReason } from './evidence.mjs';
import { svgToOutlinedPdf } from './pdf.mjs';
import { renderAddressMap } from './render/addrmap.mjs';
import { renderDatapath } from './render/datapath.mjs';
import { renderMicroarch } from './render/microarch.mjs';
import { renderFsm } from './render/fsm.mjs';
import { renderTiming } from './render/timing.mjs';
import { checkTiming } from './checks/timing.mjs';
import { crosscheckDatapath, crosscheckSoc } from './rtl/crosscheck.mjs';
import { flattenNetlist } from './rtl/flatten.mjs';
import { verifySourcePins } from './source-pins.mjs';
import { lintFigmaSafe } from './svg/figma-safe-lint.mjs';
import { validateSchema } from './validate.mjs';
import { fsmCone } from './checks/fsm-crosscheck.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
export const DELIVERABLE_TYPES = Object.freeze(['datapath', 'microarch', 'fsm', 'timing']);

// Verification of a timing figure (SPEC §6.6): one region, the waveform, at
// the level the timing verifier proves in this run (simulated / sim-compared
// from VCD evidence), else unverified with its reason.
async function timingVerification(doc, { figureDir, netlist }) {
  const { verifyTiming } = await import('./timing/verify.mjs');
  const v = await verifyTiming(doc, { figureDir, netlist });
  const region = { id: 'waveform', kind: 'timing', level: v.level, grounding: v.level === 'simulated' || v.level === 'sim-compared' ? 'vcd' : 'none', ...(v.level === 'unverified' ? { reason: v.reason || 'no simulation evidence' } : {}) };
  return { regions: [region], level: v.level, timing: v };
}

// RTL cross-check of one figure against the netlist, by figure type.
async function crosscheckFigure(type, doc, netlist, options = {}) {
  // A timing figure is checked against simulation evidence, not the netlist structure.
  if (type === 'timing') return { diagnostics: [], stats: {} };
  if (type === 'fsm') {
    const { crosscheckFsm } = await import('./checks/fsm-crosscheck.mjs'); const cc = crosscheckFsm(doc, netlist, options);
    return cc;
  }
  return type === 'datapath' ? crosscheckDatapath(doc, netlist) : crosscheckSoc(doc, netlist);
}
const err = (code, message, extra = {}) => ({ code, severity: 'error', message, subject: {}, evidence: {}, supportedFixes: [], ...extra });

export function figureName(figurePath) {
  return path.basename(figurePath).replace(/\.json$/, '').replace(/\.(datapath|microarch|fsm|timing)$/, '');
}

function verificationRegions(type, doc, netlist, pins, equivalence = {}) {
  const docGrounded = (obj) => Boolean(obj?.source);
  const regions = [];
  // A figure's level considers only the regions it depends on: for a state
  // machine, stubs outside the fan-in cone of its next-state logic are listed
  // as not_in_cone instead of lowering the level.
  let coneStubs = null;
  const notInCone = [];
  if (type === 'datapath') {
    if (netlist) {
      regions.push({ id: 'figure', kind: 'figure', level: 'structural-only', grounding: 'rtl', label: doc.meta?.rtl?.instance ? `RTL instance ${doc.meta.rtl.instance}` : 'RTL top' });
      const flat = flattenNetlist(netlist);
      const moduleOf = (rel) => flat.instances.get([flat.top, ...(rel ? rel.split('/') : [])].join('.'));
      for (const r of doc.regions || []) {
        if (r.level === 'gate') {
          const eq = equivalence[r.id];
          regions.push(eq
            ? { id: `region:${r.id}`, kind: 'gate-region', ...(r.label ? { label: r.label } : {}), level: 'structural-only', grounding: 'rtl', equivalence: eq }
            : { id: `region:${r.id}`, kind: 'gate-region', level: 'unverified', grounding: 'none', reason: 'gate region was not equivalence-checked' });
        } else if (r.level === 'blackbox' || r.level === 'block') {
          // Collapsed views: only the mapped boundary nets and transfers are checked.
          regions.push({ id: `region:${r.id}`, kind: 'region', label: `${r.label ?? r.id}: ${r.level} view, boundary nets checked, internals not drawn`, level: 'structural-only', grounding: 'rtl' });
        }
      }
      for (const e of doc.elements.filter((x) => x.kind === 'instance' && x.rtl?.instance)) {
        const mod = moduleOf(e.rtl.instance);
        const blackboxDrawn = e.level === 'blackbox' || (doc.regions || []).some((r) => r.level === 'blackbox' && r.members.includes(e.id));
        if (mod?.blackbox) regions.push({ id: `element:${e.id}`, kind: 'element', level: 'unverified', grounding: 'stub', reason: `${mod.orig_name} is a ${mod.blackbox.origin} stub: only its ports are known` });
        else if (blackboxDrawn) regions.push({ id: `element:${e.id}`, kind: 'element', label: 'boundary checked; internals not drawn', level: 'structural-only', grounding: 'rtl' });
      }
    } else {
      regions.push({ id: 'figure', kind: 'figure', level: 'unverified', grounding: pins.verified ? 'doc' : 'none', reason: pins.verified ? 'doc-grounded: source pins verified, no RTL netlist supplied' : 'no RTL netlist supplied' });
    }
  } else if (type === 'fsm') {
    // One region: the machine. Structural when the RTL cross-check ran (states,
    // encodings and transitions against the netlist), else unverified.
    const machine = doc.machine?.name ?? 'state machine';
    if (netlist) regions.push({ id: 'machine', kind: 'fsm', level: 'structural-only', grounding: 'rtl', label: `${machine}: states, encodings and transitions cross-checked against the RTL` });
    if (netlist) coneStubs = fsmCone(netlist, doc.machine?.rtl || {})?.stubs ?? null;
    else regions.push({ id: 'machine', kind: 'fsm', level: 'unverified', grounding: pins.verified ? 'doc' : 'none', reason: pins.verified ? 'doc-grounded: source pins verified, no RTL netlist supplied' : 'no RTL netlist supplied' });
  } else {
    const flat = netlist ? flattenNetlist(netlist) : null;
    for (const b of doc.blocks) {
      const atts = (doc.attachments || []).filter((a) => a.block === b.id);
      if (flat && (b.rtl?.instance || b.rtl?.top)) {
        const p = b.rtl.top ? flat.top : [flat.top, ...b.rtl.instance.split('/')].join('.');
        const mod = flat.instances.get(p);
        if (mod?.blackbox) regions.push({ id: b.id, kind: 'block', level: 'unverified', grounding: 'stub', reason: `${mod.orig_name} is a ${mod.blackbox.origin} stub: only port names/widths are known` });
        else regions.push({ id: b.id, kind: 'block', level: 'structural-only', grounding: 'rtl', label: b.ports ? 'IP boundary checked' : 'instance checked' });
      } else if (docGrounded(b) || atts.some(docGrounded)) {
        regions.push({ id: b.id, kind: 'block', level: 'unverified', grounding: 'doc', reason: 'doc-grounded: no RTL for this block; address/identity pinned to documentation' });
      } else {
        regions.push({ id: b.id, kind: 'block', level: 'unverified', grounding: 'none', reason: 'no RTL and no source pin for this block' });
      }
    }
  }
  if (netlist) {
    for (const m of netlist.modules.filter((x) => x.blackbox)) {
      if (coneStubs && !coneStubs.has(m.orig_name)) {
        notInCone.push({ id: `stub:${m.orig_name}`, kind: 'stub', reason: `${m.blackbox.origin} blackbox stub outside the fan-in cone of the machine's next-state logic` });
        continue;
      }
      regions.push({ id: `stub:${m.orig_name}`, kind: 'stub', level: 'unverified', grounding: 'stub', reason: `${m.blackbox.origin} blackbox stub: internals are not evidence` });
    }
  }
  const levels = new Set(regions.map((r) => r.level));
  return { regions, level: levels.size === 1 ? [...levels][0] : 'mixed', ...(notInCone.length ? { not_in_cone: notInCone } : {}) };
}

// Superseded outputs never sit beside current ones (SPEC §12.3). Once a
// delivery has passed every check and its new files are staged, every existing
// output of this figure name in outDir (SVG, PDF, PNG preview of any variant,
// receipt) moves to <outDir>/../archive/<date>-<name>-<hash>/ with a README.
// A failed delivery archives nothing: the last good outputs stay current.
export function archiveSuperseded(outDir, name, { now = new Date() } = {}) {
  const dir = path.resolve(outDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`^${esc}\\.(?:receipt\\.json|(?:addrmap\\.)?[A-Za-z0-9_-]+\\.(?:svg|pdf|png|preview\\.png|svg\\.png))$`);
  const old = fs.readdirSync(dir).filter((f) => own.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort();
  if (!old.length) return null;
  const hash = createHash('sha256');
  for (const f of old) hash.update(f).update(fs.readFileSync(path.join(dir, f)));
  const date = now.toISOString().slice(0, 10);
  const base = path.join(path.dirname(dir), 'archive', `${date}-${name}-${hash.digest('hex').slice(0, 8)}`);
  let target = base;
  for (let k = 2; fs.existsSync(target); k += 1) target = `${base}-${k}`;
  fs.mkdirSync(target, { recursive: true });
  for (const f of old) fs.renameSync(path.join(dir, f), path.join(target, f));
  fs.writeFileSync(path.join(target, 'README.md'), `# ${name}\n\nArchived ${date} from \`${dir}\`: superseded by a new delivery.\n\nFiles: ${old.map((f) => `\`${f}\``).join(', ')}\n`);
  return target;
}

export async function buildFigure({ type, figurePath, netlistPath, profilesPath, variants: onlyVariants, quality, view, format: formatOption, pdf: wantPdf = true }) {
  const diagnostics = [];
  const stages = [];
  const specBytes = fs.readFileSync(figurePath);
  // View presets (SPEC §4.8): CLI overrides apply to a copy of the spec, and
  // the view scope is the declared scope when meta.scope is absent.
  const viewApplied = applyViewOverrides(JSON.parse(specBytes.toString('utf8')), view);
  const doc = type === 'datapath' ? withViewScope(viewApplied.doc) : viewApplied.doc;
  const figureDir = path.dirname(path.resolve(figurePath));
  const name = figureName(figurePath);
  const evidence = { spec: { sha256: sha256(specBytes), bytes: specBytes.length }, name, files: [] };
  const fail = () => ({ ok: false, diagnostics, stages, evidence, artifacts: [], doc, type });
  // Output format (lib/format.mjs): study relaxes only the paper-only checks,
  // at every gate, so a relaxed check never blocks a study delivery.
  const fmt = resolveFormat(doc, formatOption);
  const format = fmt.format;
  const study = format === 'study';
  const relaxed = new Map();
  const blocked = () => { relaxDiagnostics(diagnostics, format, relaxed); return diagnostics.some((d) => d.severity === 'error'); };
  evidence.format = { name: format, relaxed };
  diagnostics.push(...fmt.diagnostics);

  if (!DELIVERABLE_TYPES.includes(type)) {
    diagnostics.push(err('deliver/type-unsupported', `deliver supports ${DELIVERABLE_TYPES.join(', ')} in phase 2; '${type}' is planned`));
    return fail();
  }
  stages.push('schema');
  diagnostics.push(...await validateSchema(type, doc));
  if (type === 'datapath') diagnostics.push(...nameIgnored(doc));
  if (doc.figure_type !== type) diagnostics.push(err('input/figure-type', `figure_type '${doc.figure_type}' does not match '${type}'`));
  if (blocked()) return fail();

  stages.push(`semantic:${type}`);
  let addressTable = [];
  diagnostics.push(...checkLabels(doc, type, { quality }));
  if (type === 'datapath') diagnostics.push(...checkDatapath(doc).diagnostics, ...checkNetClasses(doc).diagnostics, ...checkDetailRefs(doc, { figureDir }).diagnostics);
  else if (type === 'fsm') diagnostics.push(...checkFsm(doc, { quality }).diagnostics);
  else if (type === 'timing') {
    const tc = checkTiming(doc, { figureDir, quality });
    diagnostics.push(...tc.diagnostics);
    evidence.timingChecks = tc.report;
  }
  else {
    const mc = checkMicroarch(doc, { figureDir, quality });
    diagnostics.push(...mc.diagnostics);
    addressTable = mc.addressTable;
    if (mc.view) evidence.view = { ...mc.view, ...(viewApplied.overrides ? { overrides: viewApplied.overrides } : {}) };
    stages.push('memory-map');
  }

  stages.push('source-pins');
  const pins = verifySourcePins(doc, { figureDir });
  diagnostics.push(...pins.diagnostics);
  evidence.sourcePins = pins;
  if (pins.pins && doc.meta?.repository) {
    const repoRoot = path.resolve(figureDir, doc.meta.repository.root);
    const reason = selfAuthoredReason(path.join(repoRoot, '.'));
    if (reason) diagnostics.push(err('evidence/self-authored', `source pins resolve into ${repoRoot}, which cannot be evidence: ${reason}`, { supportedFixes: ['pin the user\'s own repository'] }));
    for (const f of pins.files || []) evidence.files.push({ role: 'doc', path: path.join(repoRoot, f.file), sha256: f.sha256, repository: { root: repoRoot, revision: doc.meta.repository.revision, dirty: null }, counts_as_evidence: true });
  }

  let netlist = null;
  if (netlistPath) {
    stages.push('evidence-guard', 'rtl-crosscheck');
    const netBytes = fs.readFileSync(netlistPath);
    netlist = JSON.parse(netBytes.toString('utf8'));
    const netDiag = await validateSchema('rtl-netlist', netlist);
    if (netDiag.length) {
      diagnostics.push(err('rtl/adapter-output-invalid', `netlist ${netlistPath} does not match rtl-netlist schema`, { evidence: { first: netDiag.slice(0, 3).map((d) => d.message) }, supportedFixes: ['re-run check-rtl'] }));
      return fail();
    }
    const guard = checkNetlistEvidence(netlist);
    diagnostics.push(...guard.diagnostics);
    evidence.files.push({ role: 'netlist', path: path.resolve(netlistPath), sha256: sha256(netBytes), repository: gitOrigin(netlistPath), counts_as_evidence: false });
    for (const e of guard.evidence) evidence.files.push({ ...e, counts_as_evidence: e.role === 'rtl' });
    if (guard.diagnostics.some((d) => d.severity === 'error')) return fail();
    const cc = await crosscheckFigure(type, doc, netlist, { quality });
    diagnostics.push(...cc.diagnostics);
    evidence.rtl = { netlist, sha256: sha256(netBytes), stats: cc.stats };
    if (type === 'datapath') {
      // Completeness against the declared scope, and drawn vs RTL latency.
      stages.push('coverage', 'latency');
      const cov = checkCoverage(doc, netlist);
      diagnostics.push(...cov.diagnostics);
      evidence.coverage = cov.report;
      const lat = checkLatency(doc, netlist, { quality });
      diagnostics.push(...lat.diagnostics);
      evidence.latency = lat.report;
    } else if (type === 'microarch') {
      // Microarch completeness (G12): the scope's instances and registers are represented by blocks.
      stages.push('coverage');
      const cov = checkMicroarchCoverage(doc, netlist);
      diagnostics.push(...cov.diagnostics);
      if (cov.report) evidence.coverage = cov.report;
    }
    const gateRegions = type === 'datapath' ? (doc.regions || []).filter((r) => r.level === 'gate') : [];
    if (gateRegions.length) {
      stages.push('gate-equivalence');
      evidence.equivalence = {};
      for (const r of gateRegions) {
        const eq = checkRegionEquivalence(doc, r, netlist);
        diagnostics.push(...eq.diagnostics);
        if (eq.result) evidence.equivalence[r.id] = eq.result;
      }
    }
  }
  if (type === 'datapath' && doc.view) {
    stages.push('view');
    const vc = checkView(doc, { netlist, quality });
    diagnostics.push(...vc.diagnostics);
    evidence.view = { ...vc.report, ...(viewApplied.overrides ? { overrides: viewApplied.overrides } : {}) };
  }
  // Document facts against ALL documents (doc/conflict, doc/rtl-mismatch) and
  // vocabulary names against cited RTL structure (label/function-justification).
  if (type === 'microarch') {
    stages.push('doc-facts');
    const df = checkDocFacts(doc, { figureDir, netlist });
    diagnostics.push(...df.diagnostics);
    evidence.docFacts = df.report;
  } else if (type === 'datapath') {
    stages.push('function-evidence');
    const fe = checkFunctionEvidence(doc, { figureDir, netlist, quality });
    diagnostics.push(...fe.diagnostics);
    evidence.functionEvidence = fe.report;
  }
  if (blocked()) return fail();
  if (type === 'timing') {
    const tv = await timingVerification(doc, { figureDir, netlist });
    diagnostics.push(...(tv.timing.diagnostics || []));
    evidence.verification = tv;
    if (blocked()) return fail();
  } else evidence.verification = verificationRegions(type, doc, netlist, pins, evidence.equivalence);

  // Study uses its own one-variant profile (no column, no maximum height).
  const profilesFile = study ? STUDY_PROFILE_FILE : (profilesPath ?? path.join(root, 'profiles', 'print-profiles.json'));
  const profilesBytes = fs.readFileSync(profilesFile);
  const profiles = JSON.parse(profilesBytes.toString('utf8'));
  const profileName = study ? profiles.profile : doc.meta.print.profile;
  const profile = study ? profiles : profiles.profiles[profileName];
  evidence.profileSha256 = sha256(profilesBytes);
  evidence.format.profile = profileName;
  if (!profile) {
    diagnostics.push(err('print/profile-unknown', `print profile '${profileName}' not found`, { evidence: { available: Object.keys(profiles.profiles) }, supportedFixes: ['use a defined profile', 'pass --profiles', 'use --format study for a figure sized to its content'] }));
    return fail();
  }
  // 2col is required; 1col is best effort unless the caller names variants
  // explicitly (then every named variant must pass). SPEC §9.5. Study has
  // exactly one variant.
  const strictVariants = study || Boolean(onlyVariants);
  const variantIds = study ? Object.keys(profile.variants) : (onlyVariants ?? doc.meta.print.variants ?? Object.keys(profile.variants));
  if (study && onlyVariants) diagnostics.push({ code: 'format/variants-ignored', severity: 'info', message: `the study format delivers one figure sized to its content; --variants ${onlyVariants.join(',')} is ignored`, subject: {}, evidence: {}, supportedFixes: [] });
  if (study && !wantPdf) stages.push('no-pdf');
  if (!study && !wantPdf) diagnostics.push({ code: 'format/pdf-required', severity: 'info', message: 'paper delivery always writes the outlined PDF; --no-pdf applies to the study format only', subject: {}, evidence: {}, supportedFixes: [] });
  for (const v of variantIds) if (!profile.variants[v]) diagnostics.push(err('print/profile-unknown', `variant '${v}' not in profile ${profileName}`));
  for (const v of Object.keys(profile.variants).filter((x) => !variantIds.includes(x))) diagnostics.push({ code: 'print/variant-not-requested', severity: 'info', message: `variant ${v} of ${profileName} is not requested for this figure`, subject: {}, evidence: {}, supportedFixes: [] });
  if (blocked()) return fail();

  stages.push('layout', 'geometry', 'print', 'svg-lint', 'pdf');
  const artifacts = [];
  evidence.variantStatus = {};
  const bestEffort = (id) => !strictVariants && /(^|\.)1col$/.test(id);
  // label/duplicate on the text each variant prints: the renderer's label mode
  // (full or short) decides the names, so two blocks distinct in full labels
  // can collide in a short-label variant. Groups the spec-level check already
  // reported (full names) are not repeated.
  const fullDuplicates = type === 'datapath' ? new Set(printedDuplicates(doc, 'full').map((g) => g.ids.join(','))) : new Set();
  const variantDuplicates = (id, rendered) => {
    if (type !== 'datapath' || id.startsWith('addrmap.')) return [];
    const mode = rendered.layout?.labels === 'short' ? 'short' : 'full';
    return printedDuplicates(doc, mode, { variant: id }).filter((g) => !fullDuplicates.has(g.ids.join(','))).map((g) => err('label/duplicate', `${id}: ${g.ids.length} blocks print the same name "${g.name}" in ${mode} labels (${g.ids.join(', ')})`, {
      subject: { variant: id, ids: g.ids }, evidence: { name: g.name, variant: id, labels: mode },
      supportedFixes: ['give each block a distinct short_label', 'put the distinguishing words in function.qualifier (the short name keeps them)', 'if they are stages of one function, set function.stage'],
    }));
  };
  const produce = async (id, rendered, variant, maxHeightPt) => {
    const local = [...rendered.diagnostics];
    local.push(...variantDuplicates(id, rendered));
    local.push(...lintFigmaSafe(rendered.svg));
    // The PDF page is the rendered canvas; a study delivery may leave it out.
    const pdf = wantPdf || !study ? await svgToOutlinedPdf(rendered.svg, { widthPt: rendered.width_pt, heightPt: rendered.height_pt, title: `${name} ${id}` }) : null;
    if (pdf?.fontsPresent) local.push(err('pdf/fonts-present', `${id}: PDF contains font resources`));
    if (pdf?.missingGlyphs.length) local.push(err('text/glyph-missing', `${id}: glyphs missing for ${pdf.missingGlyphs.join(' ')}`, { supportedFixes: ['use Latin characters'] }));
    if (variant.width_pt != null && rendered.width_pt > variant.width_pt + 0.01) local.push(err('print/width-overflow', `${id}: ${rendered.width_pt} pt wider than ${variant.width_pt} pt`));
    relaxDiagnostics(local, format, relaxed);
    const errors = local.filter((d) => d.severity === 'error');
    const measured = {
      column_width_pt: variant.width_pt, content_width_pt: Math.round((rendered.content_width_pt ?? rendered.width_pt) * 100) / 100,
      height_pt: rendered.height_pt, max_height_pt: maxHeightPt, min_font_pt: rendered.min_font_pt, min_stroke_pt: rendered.min_stroke_pt,
    };
    if (errors.length && bestEffort(id)) {
      diagnostics.push(...local.filter((d) => d.severity !== 'error'));
      const reason = [...new Set(errors.map((d) => d.code))].join(', ');
      diagnostics.push({ code: 'variant/1col-skipped', severity: 'info', message: `${id} skipped (best effort; 2col is the required deliverable): ${reason}`, subject: { variant: id }, evidence: { measured, failures: errors.map((d) => d.message) }, supportedFixes: ['accept the 2col figure', 'add short_label to wide elements', 'force with --variants 1col to see the errors'] });
      evidence.variantStatus[id] = { status: 'skipped', reason: errors.map((d) => d.message).join('; '), measured };
      return;
    }
    diagnostics.push(...local);
    // A figure that does not fit is never fixed by dropping hardware: collapse,
    // grow to the profile height, or narrow the scope / split into sub-figures.
    const fit = errors.filter((d) => ['print/width-overflow', 'print/max-height'].includes(d.code));
    if (fit.length) diagnostics.push(err('deliver/does-not-fit', `${id}: the figure does not fit (${fit.map((d) => d.message).join('; ')}); hardware inside the declared scope may not be dropped${rendered?.size_report ? ` (run with --why-size for the elements that set the size)` : ''}`, { subject: { variant: id }, evidence: { measured }, supportedFixes: ['collapse more hardware into blocks whose rtl.covers name it', `allow a taller figure up to the profile maximum (${Math.round(variant.max_height_pt / 72 * 100) / 100} in) with meta.print.max_height_in`, 'narrow meta.scope explicitly, or split into sub-figures (a)/(b) linked with detail_ref'] }));
    evidence.variantStatus[id] = { status: errors.length ? 'failed' : 'delivered', measured };
    artifacts.push({ id, size_report: rendered.size_report, svg: rendered.svg, pdf: pdf?.pdf ?? null, width_pt: rendered.width_pt, height_pt: rendered.height_pt, min_font_pt: rendered.min_font_pt, min_stroke_pt: rendered.min_stroke_pt, font: rendered.font, layout: rendered.layout, short_labels_used: rendered.short_labels_used ?? [], route: rendered.route, warnFontPt: variant.warn_font_pt });
  };
  for (const v of variantIds) {
    const pv = profile.variants[v];
    // Study: no column width and no height limit, so the renderers size the
    // canvas to the content and never retry with short labels.
    const maxHeightPt = study ? undefined : (doc.meta.print.max_height_in?.[v] ? doc.meta.print.max_height_in[v] * 72 : pv.max_height_pt);
    const opts = { variant: v, widthPt: pv.width_pt ?? undefined, maxHeightPt, minFontPt: pv.min_font_pt, minStrokePt: pv.min_stroke_pt, name };
    const rendered = type === 'datapath' ? await renderDatapath(doc, opts) : type === 'fsm' ? await renderFsm(doc, opts) : type === 'timing' ? await renderTiming(doc, opts) : await renderMicroarch(doc, opts);
    await produce(v, rendered, pv, maxHeightPt);
    if (type === 'microarch' && doc.address_map?.table && addressTable.length) await produce(`addrmap.${v}`, renderAddressMap(doc, addressTable, opts), pv, maxHeightPt);
  }
  for (const a of artifacts) {
    if (a.warnFontPt && a.min_font_pt < a.warnFontPt) diagnostics.push({ code: 'print/small-font', severity: 'warning', message: `${a.id}: smallest text ${a.min_font_pt} pt is below the ${a.warnFontPt} pt recommendation`, subject: { variant: a.id }, evidence: {}, supportedFixes: [] });
  }
  return { ok: !blocked(), diagnostics, stages, evidence, artifacts, doc, type };
}

// preview: { scale, rasterizer } also writes <name>.<variant>.png per variant
// (resvg by default, lib/preview.mjs); without a usable rasterizer the
// delivery still succeeds with a warning.
export async function deliver({ type, figurePath, outDir, netlistPath, profilesPath, variants, quality, view, format, pdf, preview }) {
  const build = await buildFigure({ type, figurePath, netlistPath, profilesPath, variants, quality, view, format, pdf });
  // A failed delivery writes nothing and moves nothing: the last good outputs
  // (and their receipt) stay in place, still matching each other.
  if (!build.ok) return { ...build, written: [] };
  const { evidence, artifacts } = build;
  const name = evidence.name;
  if (selfAuthoredReason(path.join(path.resolve(outDir), 'x')) && !path.resolve(outDir).startsWith(path.join(SKILL_ROOT, 'references', 'local')) && !path.resolve(outDir).startsWith(path.join(SKILL_ROOT, 'examples')) && !path.resolve(outDir).startsWith(path.join(SKILL_ROOT, 'docs'))) {
    // delivering into the skill tree is allowed only for its own examples, docs and local references
    build.diagnostics.push({ code: 'deliver/output-location', severity: 'warning', message: `output directory ${outDir} is inside the fig-gen installation or a work directory`, subject: {}, evidence: {}, supportedFixes: ['deliver into the user project'] });
  }

  const files = [];
  const variantsReceipt = artifacts.map((a) => {
    const svgPath = path.join(outDir, `${name}.${a.id}.svg`);
    const pdfPath = path.join(outDir, `${name}.${a.id}.pdf`);
    const svgBuf = Buffer.from(a.svg, 'utf8');
    files.push([svgPath, svgBuf], ...(a.pdf ? [[pdfPath, a.pdf]] : []));
    return {
      id: a.id,
      svg: { path: path.basename(svgPath), sha256: sha256(svgBuf), bytes: svgBuf.length, width_pt: a.width_pt, height_pt: a.height_pt },
      ...(a.pdf ? { pdf: { path: path.basename(pdfPath), sha256: sha256(a.pdf), bytes: a.pdf.length, width_pt: a.width_pt, height_pt: a.height_pt, fonts_present: false } } : {}),
      min_font_pt: a.min_font_pt,
      min_stroke_pt: a.min_stroke_pt,
      short_labels_used: a.short_labels_used,
      ...(a.route ? { route: a.route } : {}),
      svg_lint: 'pass',
    };
  });
  if (preview) {
    // The figure itself is valid; a missing preview does not block it.
    const warning = (d, prefix = '') => ({ ...d, severity: 'warning', message: `${prefix}${d.message}` });
    const rasterizer = selectRasterizer({ requested: preview.rasterizer });
    build.diagnostics.push(...(rasterizer.ok ? rasterizer.diagnostics : rasterizer.diagnostics.map((d) => warning(d))));
    const scale = preview.scale ?? DEFAULT_SCALE;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-deliver-preview-'));
    try {
      for (const [i, a] of (rasterizer.ok ? artifacts : []).entries()) {
        const shot = await rasterizeSvg(a.svg, path.join(scratch, `${a.id}.png`), { scale, rasterizer });
        if (!shot.ok) {
          build.diagnostics.push(...shot.diagnostics.map((d) => warning(d, `${a.id}: `)));
          continue;
        }
        const png = fs.readFileSync(path.join(scratch, `${a.id}.png`));
        const pngPath = path.join(outDir, `${name}.${a.id}.png`);
        files.push([pngPath, png]);
        variantsReceipt[i].preview = { path: path.basename(pngPath), sha256: sha256(png), bytes: png.length, scale, rasterizer: shot.rasterizer };
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  const counts = summarize(build.diagnostics);
  const deps = {};
  for (const dep of ['elkjs', 'opentype.js', 'pdfkit', 'svg-to-pdfkit', 'ajv', '@fontsource/arimo', '@fontsource/tinos', '@fontsource/libertinus-serif']) {
    const v = pkg.dependencies?.[dep] ?? pkg.optionalDependencies?.[dep];
    if (v) deps[dep] = v;
  }
  const fonts = [...new Map(artifacts.map((a) => [a.font.sha256, a.font])).values()];
  const rtl = evidence.rtl;
  const { regions, level, not_in_cone: notInCone } = evidence.verification;
  const verification = { level, regions, ...(notInCone ? { not_in_cone: notInCone } : {}) };
  if (rtl && regions.some((r) => r.level === 'structural-only')) {
    verification.structural = build.type === 'fsm'
      ? { fsm_figure_sha256: evidence.spec.sha256, netlist_sha256: rtl.sha256, crosscheck: 'pass', states_checked: rtl.stats.states_checked ?? 0, transitions_checked: rtl.stats.transitions_checked ?? 0 }
      : { ...(build.type === 'datapath' ? { datapath_figure_sha256: evidence.spec.sha256 } : {}), netlist_sha256: rtl.sha256, crosscheck: 'pass', latencies_checked: rtl.stats.latenciesChecked ?? 0 };
  }
  // Timing: the simulation (and compare) evidence the timing verifier produced in this run.
  if (build.type === 'timing') {
    const ev = evidence.verification.timing?.evidence || {};
    if (level === 'simulated' || level === 'sim-compared') {
      verification.scope_note = 'Simulation evidence covers only the recorded stimulus and cycle window.';
      if (ev.simulation) verification.simulation = ev.simulation;
      if (level === 'sim-compared' && ev.compare) verification.compare = ev.compare;
    }
  }
  if (level === 'unverified') verification.reason = regions.map((r) => r.reason).filter(Boolean).join('; ') || 'no verification evidence';
  const receipt = {
    schema_version: 1,
    kind: 'fig-gen-receipt',
    figure: { type: build.type, spec_sha256: evidence.spec.sha256, spec_bytes: evidence.spec.bytes },
    tool: { version: pkg.version, node: process.version, dependencies: deps, fonts, profile_sha256: evidence.profileSha256 },
    variants: variantsReceipt,
    variant_status: Object.fromEntries(Object.entries(evidence.variantStatus || {}).map(([id, s]) => [id, s.status === 'skipped' ? s : { status: s.status, measured: s.measured }])),
    format: formatReceipt(evidence.format.name, evidence.format.relaxed, evidence.format.profile),
    checks: { codes_run: build.stages, errors: 0, warnings: counts.warning, quality: evidence.format.name === 'study' ? 'study' : 'paper' },
    ...(evidence.sourcePins.pins ? { source_pins: { revision: evidence.sourcePins.revision, verified: evidence.sourcePins.verified } } : {}),
    evidence: evidence.files,
    ...(evidence.docFacts?.facts?.length ? { doc_facts: evidence.docFacts } : {}),
    ...(evidence.functionEvidence?.length ? { function_evidence: evidence.functionEvidence } : {}),
    ...(evidence.view ? { view: evidence.view } : {}),
    ...(evidence.coverage ? { coverage: evidence.coverage } : {}),
    ...(evidence.latency ? { latency: evidence.latency } : {}),
    ...(rtl ? {
      rtl: {
        adapter: rtl.netlist.adapter,
        top: rtl.netlist.top,
        netlist_sha256: rtl.sha256,
        rtl_files: (rtl.netlist.inputs?.files || []).filter((f) => f.role === 'rtl').map((f) => ({ path: f.path, sha256: f.sha256 })),
        blackboxes: rtl.netlist.modules.filter((m) => m.blackbox).map((m) => ({ module: m.orig_name, origin: m.blackbox.origin })),
        crosscheck: 'pass',
      },
    } : {}),
    verification,
  };
  // The archive path is a relative string; validating with a stand-in keeps a
  // schema failure from moving anything.
  const receiptDiag = await validateSchema('receipt', { ...receipt, archived: '../archive/pending' });
  if (receiptDiag.length) {
    return { ...build, ok: false, diagnostics: [...build.diagnostics, err('receipt/invalid', `receipt failed its schema: ${receiptDiag.map((d) => `${d.subject.path} ${d.message}`).join('; ')}`)], written: [] };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const receiptPath = path.join(outDir, `${name}.receipt.json`);

  // Stage every new file, then archive the superseded outputs, then move the
  // staged files into place. Temp names never match the archive pattern.
  const staged = [...files, [receiptPath, null]];
  const temps = staged.map(([file]) => `${file}.tmp-${process.pid}`);
  let archived = null;
  try {
    files.forEach(([, buf], i) => fs.writeFileSync(temps[i], buf));
    archived = archiveSuperseded(outDir, name);
    if (archived) receipt.archived = path.relative(path.resolve(outDir), archived);
    fs.writeFileSync(temps.at(-1), `${JSON.stringify(receipt, null, 2)}\n`);
    staged.forEach(([file], i) => fs.renameSync(temps[i], file));
  } catch (error) {
    for (const tmp of temps) fs.rmSync(tmp, { force: true });
    throw error;
  }
  return { ...build, receipt, written: staged.map(([file]) => file), ...(archived ? { archived } : {}) };
}
