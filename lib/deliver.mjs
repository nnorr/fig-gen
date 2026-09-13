// Build and deliver a figure (SPEC §12): schema → semantic → source pins →
// evidence guard → RTL cross-check → per-variant render → figma-safe lint →
// outlined PDF → print checks → atomic write of all artifacts + receipt.
// Any error means nothing is written. Verification is reported per region.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCoverage } from './checks/coverage.mjs';
import { checkDatapath } from './checks/datapath.mjs';
import { checkDetailRefs } from './checks/detail-refs.mjs';
import { checkLatency } from './checks/latency.mjs';
import { applyViewOverrides, checkView, withViewScope } from './view.mjs';
import { checkFunctionEvidence } from './checks/function-evidence.mjs';
import { checkLabels } from './checks/labels.mjs';
import { checkNetClasses } from './checks/net-class.mjs';
import { checkDocFacts } from './doc-facts.mjs';
import { checkRegionEquivalence } from './checks/equivalence.mjs';
import { checkMicroarch } from './checks/microarch.mjs';
import { summarize } from './diagnostics.mjs';
import { SKILL_ROOT, checkNetlistEvidence, gitOrigin, selfAuthoredReason } from './evidence.mjs';
import { svgToOutlinedPdf } from './pdf.mjs';
import { renderAddressMap } from './render/addrmap.mjs';
import { renderDatapath } from './render/datapath.mjs';
import { renderMicroarch } from './render/microarch.mjs';
import { crosscheckDatapath, crosscheckSoc } from './rtl/crosscheck.mjs';
import { flattenNetlist } from './rtl/flatten.mjs';
import { verifySourcePins } from './source-pins.mjs';
import { lintFigmaSafe } from './svg/figma-safe-lint.mjs';
import { validateSchema } from './validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
export const DELIVERABLE_TYPES = Object.freeze(['datapath', 'microarch']);
const err = (code, message, extra = {}) => ({ code, severity: 'error', message, subject: {}, evidence: {}, supportedFixes: [], ...extra });

export function figureName(figurePath) {
  return path.basename(figurePath).replace(/\.json$/, '').replace(/\.(datapath|microarch|fsm|timing)$/, '');
}

function verificationRegions(type, doc, netlist, pins, equivalence = {}) {
  const docGrounded = (obj) => Boolean(obj?.source);
  const regions = [];
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
      regions.push({ id: `stub:${m.orig_name}`, kind: 'stub', level: 'unverified', grounding: 'stub', reason: `${m.blackbox.origin} blackbox stub: internals are not evidence` });
    }
  }
  const levels = new Set(regions.map((r) => r.level));
  return { regions, level: levels.size === 1 ? [...levels][0] : 'mixed' };
}

export async function buildFigure({ type, figurePath, netlistPath, profilesPath, variants: onlyVariants, quality, view }) {
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

  if (!DELIVERABLE_TYPES.includes(type)) {
    diagnostics.push(err('deliver/type-unsupported', `deliver supports ${DELIVERABLE_TYPES.join(', ')} in phase 2; '${type}' is planned`));
    return fail();
  }
  stages.push('schema');
  diagnostics.push(...await validateSchema(type, doc));
  if (doc.figure_type !== type) diagnostics.push(err('input/figure-type', `figure_type '${doc.figure_type}' does not match '${type}'`));
  if (diagnostics.some((d) => d.severity === 'error')) return fail();

  stages.push(`semantic:${type}`);
  let addressTable = [];
  diagnostics.push(...checkLabels(doc, type, { quality }));
  if (type === 'datapath') diagnostics.push(...checkDatapath(doc).diagnostics, ...checkNetClasses(doc).diagnostics, ...checkDetailRefs(doc, { figureDir }).diagnostics);
  else {
    const mc = checkMicroarch(doc, { figureDir });
    diagnostics.push(...mc.diagnostics);
    addressTable = mc.addressTable;
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
    const cc = type === 'datapath' ? crosscheckDatapath(doc, netlist) : crosscheckSoc(doc, netlist);
    diagnostics.push(...cc.diagnostics);
    evidence.rtl = { netlist, sha256: sha256(netBytes), stats: cc.stats };
    if (type === 'datapath') {
      // Completeness against the declared scope, and drawn vs RTL latency.
      stages.push('coverage', 'latency');
      const cov = checkCoverage(doc, netlist);
      diagnostics.push(...cov.diagnostics);
      evidence.coverage = cov.report;
      const lat = checkLatency(doc, netlist);
      diagnostics.push(...lat.diagnostics);
      evidence.latency = lat.report;
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
  } else {
    stages.push('function-evidence');
    const fe = checkFunctionEvidence(doc, { figureDir, netlist, quality });
    diagnostics.push(...fe.diagnostics);
    evidence.functionEvidence = fe.report;
  }
  if (diagnostics.some((d) => d.severity === 'error')) return fail();
  evidence.verification = verificationRegions(type, doc, netlist, pins, evidence.equivalence);

  const profilesFile = profilesPath ?? path.join(root, 'profiles', 'print-profiles.json');
  const profilesBytes = fs.readFileSync(profilesFile);
  const profiles = JSON.parse(profilesBytes.toString('utf8'));
  const profile = profiles.profiles[doc.meta.print.profile];
  evidence.profileSha256 = sha256(profilesBytes);
  if (!profile) {
    diagnostics.push(err('print/profile-unknown', `print profile '${doc.meta.print.profile}' not found`, { evidence: { available: Object.keys(profiles.profiles) }, supportedFixes: ['use a defined profile', 'pass --profiles'] }));
    return fail();
  }
  // 2col is required; 1col is best effort unless the caller names variants
  // explicitly (then every named variant must pass). SPEC §9.5.
  const strictVariants = Boolean(onlyVariants);
  const variantIds = onlyVariants ?? doc.meta.print.variants ?? Object.keys(profile.variants);
  for (const v of variantIds) if (!profile.variants[v]) diagnostics.push(err('print/profile-unknown', `variant '${v}' not in profile ${doc.meta.print.profile}`));
  for (const v of Object.keys(profile.variants).filter((x) => !variantIds.includes(x))) diagnostics.push({ code: 'print/variant-not-requested', severity: 'info', message: `variant ${v} of ${doc.meta.print.profile} is not requested for this figure`, subject: {}, evidence: {}, supportedFixes: [] });
  if (diagnostics.some((d) => d.severity === 'error')) return fail();

  stages.push('layout', 'geometry', 'print', 'svg-lint', 'pdf');
  const artifacts = [];
  evidence.variantStatus = {};
  const bestEffort = (id) => !strictVariants && /(^|\.)1col$/.test(id);
  const produce = async (id, rendered, variant, maxHeightPt) => {
    const local = [...rendered.diagnostics];
    local.push(...lintFigmaSafe(rendered.svg));
    const pdf = await svgToOutlinedPdf(rendered.svg, { widthPt: rendered.width_pt, heightPt: rendered.height_pt, title: `${name} ${id}` });
    if (pdf.fontsPresent) local.push(err('pdf/fonts-present', `${id}: PDF contains font resources`));
    if (pdf.missingGlyphs.length) local.push(err('text/glyph-missing', `${id}: glyphs missing for ${pdf.missingGlyphs.join(' ')}`, { supportedFixes: ['use Latin characters'] }));
    if (rendered.width_pt > variant.width_pt + 0.01) local.push(err('print/width-overflow', `${id}: ${rendered.width_pt} pt wider than ${variant.width_pt} pt`));
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
    if (fit.length) diagnostics.push(err('deliver/does-not-fit', `${id}: the figure does not fit (${fit.map((d) => d.message).join('; ')}); hardware inside the declared scope may not be dropped`, { subject: { variant: id }, evidence: { measured }, supportedFixes: ['collapse more hardware into blocks whose rtl.covers name it', `allow a taller figure up to the profile maximum (${Math.round(variant.max_height_pt / 72 * 100) / 100} in) with meta.print.max_height_in`, 'narrow meta.scope explicitly, or split into sub-figures (a)/(b) linked with detail_ref'] }));
    evidence.variantStatus[id] = { status: errors.length ? 'failed' : 'delivered', measured };
    artifacts.push({ id, svg: rendered.svg, pdf: pdf.pdf, width_pt: rendered.width_pt, height_pt: rendered.height_pt, min_font_pt: rendered.min_font_pt, min_stroke_pt: rendered.min_stroke_pt, font: rendered.font, layout: rendered.layout, short_labels_used: rendered.short_labels_used ?? [], route: rendered.route, warnFontPt: variant.warn_font_pt });
  };
  for (const v of variantIds) {
    const pv = profile.variants[v];
    const maxHeightPt = doc.meta.print.max_height_in?.[v] ? doc.meta.print.max_height_in[v] * 72 : pv.max_height_pt;
    const opts = { variant: v, widthPt: pv.width_pt, maxHeightPt, minFontPt: pv.min_font_pt, minStrokePt: pv.min_stroke_pt, name };
    const rendered = type === 'datapath' ? await renderDatapath(doc, opts) : await renderMicroarch(doc, opts);
    await produce(v, rendered, pv, maxHeightPt);
    if (type === 'microarch' && doc.address_map?.table && addressTable.length) await produce(`addrmap.${v}`, renderAddressMap(doc, addressTable, opts), pv, maxHeightPt);
  }
  for (const a of artifacts) {
    if (a.warnFontPt && a.min_font_pt < a.warnFontPt) diagnostics.push({ code: 'print/small-font', severity: 'warning', message: `${a.id}: smallest text ${a.min_font_pt} pt is below the ${a.warnFontPt} pt recommendation`, subject: { variant: a.id }, evidence: {}, supportedFixes: [] });
  }
  return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics, stages, evidence, artifacts, doc, type };
}

export async function deliver({ type, figurePath, outDir, netlistPath, profilesPath, variants, quality, view }) {
  const build = await buildFigure({ type, figurePath, netlistPath, profilesPath, variants, quality, view });
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
    files.push([svgPath, svgBuf], [pdfPath, a.pdf]);
    return {
      id: a.id,
      svg: { path: path.basename(svgPath), sha256: sha256(svgBuf), bytes: svgBuf.length, width_pt: a.width_pt, height_pt: a.height_pt },
      pdf: { path: path.basename(pdfPath), sha256: sha256(a.pdf), bytes: a.pdf.length, width_pt: a.width_pt, height_pt: a.height_pt, fonts_present: false },
      min_font_pt: a.min_font_pt,
      min_stroke_pt: a.min_stroke_pt,
      short_labels_used: a.short_labels_used,
      ...(a.route ? { route: a.route } : {}),
      svg_lint: 'pass',
    };
  });
  const counts = summarize(build.diagnostics);
  const deps = {};
  for (const dep of ['elkjs', 'opentype.js', 'pdfkit', 'svg-to-pdfkit', 'ajv', '@fontsource/arimo', '@fontsource/tinos', '@fontsource/libertinus-serif']) {
    const v = pkg.dependencies?.[dep] ?? pkg.optionalDependencies?.[dep];
    if (v) deps[dep] = v;
  }
  const fonts = [...new Map(artifacts.map((a) => [a.font.sha256, a.font])).values()];
  const rtl = evidence.rtl;
  const { regions, level } = evidence.verification;
  const verification = { level, regions };
  if (rtl && regions.some((r) => r.level === 'structural-only')) verification.structural = { ...(build.type === 'datapath' ? { datapath_figure_sha256: evidence.spec.sha256 } : {}), netlist_sha256: rtl.sha256, crosscheck: 'pass', latencies_checked: rtl.stats.latenciesChecked ?? 0 };
  if (level === 'unverified') verification.reason = regions.map((r) => r.reason).filter(Boolean).join('; ') || 'no verification evidence';
  const receipt = {
    schema_version: 1,
    kind: 'fig-gen-receipt',
    figure: { type: build.type, spec_sha256: evidence.spec.sha256, spec_bytes: evidence.spec.bytes },
    tool: { version: pkg.version, node: process.version, dependencies: deps, fonts, profile_sha256: evidence.profileSha256 },
    variants: variantsReceipt,
    variant_status: Object.fromEntries(Object.entries(evidence.variantStatus || {}).map(([id, s]) => [id, s.status === 'skipped' ? s : { status: s.status, measured: s.measured }])),
    checks: { codes_run: build.stages, errors: 0, warnings: counts.warning, quality: 'paper' },
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
  const receiptDiag = await validateSchema('receipt', receipt);
  if (receiptDiag.length) {
    return { ...build, ok: false, diagnostics: [...build.diagnostics, err('receipt/invalid', `receipt failed its schema: ${receiptDiag.map((d) => `${d.subject.path} ${d.message}`).join('; ')}`)], written: [] };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const receiptPath = path.join(outDir, `${name}.receipt.json`);
  files.push([receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)]);

  const temps = files.map(([file]) => `${file}.tmp-${process.pid}`);
  try {
    files.forEach(([, buf], i) => fs.writeFileSync(temps[i], buf));
    files.forEach(([file], i) => fs.renameSync(temps[i], file));
  } catch (error) {
    for (const tmp of temps) fs.rmSync(tmp, { force: true });
    throw error;
  }
  return { ...build, receipt, written: files.map(([file]) => file) };
}
