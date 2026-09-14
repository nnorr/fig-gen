#!/usr/bin/env node
// fig-gen CLI. validate (schema + semantic + optional RTL cross-check),
// render / deliver (datapath, microarch), crosscheck, expand-cone, lint-svg,
// check-rtl, adapters, doctor. Real runs only accept the user's own RTL as
// evidence.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGURE_TYPES, validateFigure, validateSchema } from '../lib/validate.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { discoverAdapters, loadConfig, selectAdapterId } from '../lib/rtl/adapters.mjs';
import { readUserBlackboxes } from '../lib/rtl/blackbox.mjs';
import { crosscheckDatapath, crosscheckSoc } from '../lib/rtl/crosscheck.mjs';
import { expandToGates, findModule, resolveCone } from '../lib/rtl/cone.mjs';
import { verifySourcePins } from '../lib/source-pins.mjs';
import { checkDocFacts } from '../lib/doc-facts.mjs';
import { checkFunctionEvidence } from '../lib/checks/function-evidence.mjs';
import { checkCoverage } from '../lib/checks/coverage.mjs';
import { checkDetailRefs } from '../lib/checks/detail-refs.mjs';
import { draftFigure } from '../lib/draft.mjs';
import { applyViewOverrides, checkView, withViewScope } from '../lib/view.mjs';
import { checkLatency } from '../lib/checks/latency.mjs';
import { buildFigure, deliver, figureName } from '../lib/deliver.mjs';
import { summarize } from '../lib/diagnostics.mjs';
import { findChrome } from '../lib/env/chrome.mjs';
import { DEFAULT_SCALE, chromeMissing, previewChrome, rasterizeSvg } from '../lib/preview.mjs';
import { checkNetlistEvidence, checkRtlInputs } from '../lib/evidence.mjs';
import { FORMATS, relaxDiagnostics, resolveFormat, withFormat } from '../lib/format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { ok: 0, fail: 1, usage: 2, notImplemented: 3 };

const USAGE = `usage:
  fig-gen validate <datapath|fsm|timing|microarch> <figure.json> [--netlist netlist.json] [--format paper|study] [--json]
  fig-gen render   <datapath|microarch|fsm|timing> <figure.json> <out-dir> [--netlist n.json] [--variants 2col,1col] [--profiles p.json] [--quality paper] [--format paper|study] [--no-pdf] [--why-size]
  fig-gen deliver  <datapath|microarch|fsm|timing> <figure.json> <out-dir> [--netlist n.json] [--variants 2col,1col] [--profiles p.json] [--quality paper] [--format paper|study] [--no-pdf] [--why-size] [--preview [--scale n]]
                   (default: paper, 2col required, 1col best effort; --variants makes the listed variants mandatory)
                   (--format study: one figure sized to content for RTL analysis; print-only checks relaxed, correctness kept;
                    --no-pdf skips the PDF in study; --preview also writes <name>.<variant>.png (headless Chrome);
                    after a successful delivery superseded outputs move to <out-dir>/../archive/; a failed one leaves them)
  fig-gen preview  <file.svg|figure.json> [--out file.png] [--scale n] [--format paper|study]
                   (PNG via headless Chrome; a figure JSON is rendered first and its main variant is rasterised)
                   view presets: [--view overview|block|mixed|detail] [--scope <instance path>] [--depth n]
                                 [--gate-region <region id>...] [--blackbox <element or instance>...]
  fig-gen draft --view <overview|block|mixed|detail> --scope <instance path> --netlist n.json [--depth n]
                [--gate-region name=out1,out2[:stop1,stop2]...] [--blackbox <instance path>...] [--repo-root <dir> --revision <sha>] [--out figure.json]
                [--format paper|study] [--budget-seconds s] [--layout-seconds s] [--bundle prefix|handshake] [--style rtl-datapath|lumps]
                (--format study: --view may be omitted (detail, depth 1); controllers and state drawn apart from logic;
                 a draft over its budget, default 120 s, stops with draft/budget-exceeded naming a narrower scope;
                 --bundle: ports and nets sharing a name prefix, or a valid/ready/data handshake set, become one bundle,
                 latency still checked per member; the draft is laid out once (2col, or study) and layout, fit and
                 connector errors are listed as "residual (layout):"; --layout-seconds 0 skips the layout, default 60)
  fig-gen draft --type microarch --netlist n.json [--scope <instance path>] [--out figure.json] [--format paper|study] [--layout-seconds s]
                (overview: a block per child instance, scope registers grouped by name prefix; s_/m_axil_, s_/m_axi_ and
                 s_/m_axis_ ports become AXI4-Lite and AXI4 fabrics and AXI4-Stream interfaces; host and memory off-chip)
  fig-gen draft --type fsm --netlist n.json [--scope <instance path or module>] [--state <register>] [--format paper|study] [--out figure.json]
                (a starting fsm figure from the netlist's extracted state machine, cross-checked against the same netlist)
  fig-gen crosscheck <datapath|microarch|fsm> <figure.json> --netlist netlist.json [--json]
  fig-gen expand-cone --netlist n.json --output <signal> [--index <n>] [--instance a/b] [--stop-at s1,s2]
                      [--max-gates 30] [--prefix g] [--no-bitblast] [--out fragment.json]
  fig-gen lint-svg <file.svg> [--json]
  fig-gen check-rtl --top <module> (--search-path <dir|glob>... | --files <f...> | --filelist <file.f> | --config <cfg>)
                    [--exclude <glob>...] [--prefer <file>...] [--emit-filelist <file.f>] [--summary]
                    [--out netlist.json] [--work-dir <dir>] [--source-root <dir>]
                    [--adapter <id>] [--stub <file.v>...] [--blackbox-json <file>...]
                    [--include <dir>...] [--define K=V...] [--param K=V...]
  fig-gen simulate --files <rtl...> (--tb <files...> | --bfm portmap.json --scenario scenario.json) --top <top> --work-dir <dir>
                   [--define K=V...] [--param K=V...] [--include <dir>...] [--timeout-seconds s] [--json]
                   (verilator --binary --timing --trace; the testbench must $dumpfile("wave.vcd"); a module defined nowhere
                    stops with sim/blackbox-without-model: its behavioral model must come from the user)
  fig-gen vcd2wave --vcd f.vcd --clock <path> --signals <paths or globs...> [--from n | --align-on <path>:rise|fall|change[:occurrence]]
                   [--cycles n] [--edge pos|neg] [--radix <path>=hex|dec|bin|label...] [--alias <path>=<lane name>...]
                   [--netlist n.json] [--sim-evidence simulate.json] [--out timing.json]
                   (cycle k shows the value held just before active edge k+1; the lanes carry a generator hash)
  fig-gen bfm --portmap p.json --scenario s.json --out-dir <dir> [--netlist n.json] [--dump-scope <scope>]
              (a SystemVerilog stimulus wrapper for ahb-lite / apb / axi4-lite / valid-ready; stimulus, never evidence)
  fig-gen sim-compare <timing.json> [--vcd f.vcd] [--json]
                   (cycle-by-cycle diff of drawn lanes against the simulation; x is don't-care, . holds, | skips)
  fig-gen adapters [--config <cfg>]
  fig-gen doctor`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const multi = new Set(['files', 'stub', 'blackbox-json', 'include', 'define', 'param', 'gate-region', 'blackbox', 'search-path', 'exclude', 'prefer', 'tb', 'signals', 'alias', 'radix']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (['json', 'summary', 'quiet', 'no-bitblast', 'no-pdf', 'why-size', 'preview'].includes(key)) { flags[key] = true; continue; }
    if (multi.has(key)) {
      flags[key] = flags[key] || [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key].push(argv[++i]);
      continue;
    }
    flags[key] = argv[++i];
  }
  return { positional, flags };
}

const kv = (list = []) => Object.fromEntries(list.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const line = (d) => `${d.severity} ${d.code}: ${d.message}`;

function loadNetlistWithGuard(file) {
  const netlist = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { netlist, guard: checkNetlistEvidence(netlist) };
}

async function cmdValidate({ positional, flags }) {
  const [type, file] = positional;
  if (!type || !file) return usage();
  const applied = applyViewOverrides(JSON.parse(fs.readFileSync(file, 'utf8')), viewOpts(flags));
  const doc = type === 'datapath' ? withViewScope(applied.doc) : applied.doc;
  const figureDir = path.dirname(path.resolve(file));
  const result = await validateFigure(type, doc, { figureDir, quality: flags.quality });
  if (result.checks?.schema === 'pass') {
    const pins = verifySourcePins(doc, { figureDir });
    result.diagnostics.push(...pins.diagnostics);
    result.checks.source_pins = { pins: pins.pins, verified: pins.verified };
    if (flags.netlist) {
      const { netlist, guard } = loadNetlistWithGuard(flags.netlist);
      result.diagnostics.push(...guard.diagnostics);
      if (!guard.diagnostics.some((d) => d.severity === 'error')) {
        const cc = type === 'datapath' ? crosscheckDatapath(doc, netlist) : type === 'microarch' ? crosscheckSoc(doc, netlist) : type === 'fsm' ? (await import('../lib/checks/fsm-crosscheck.mjs')).crosscheckFsm(doc, netlist, { quality: flags.quality }) : null;
        if (cc) { result.diagnostics.push(...cc.diagnostics); result.checks.rtl = cc.stats; }
        if (type === 'datapath') {
          const cov = checkCoverage(doc, netlist);
          const lat = checkLatency(doc, netlist, { quality: flags.quality });
          result.diagnostics.push(...cov.diagnostics, ...lat.diagnostics);
          result.checks.coverage = cov.report;
          result.checks.latency = lat.report;
        }
        if (type === 'datapath' && doc.view) {
          const vc = checkView(doc, { netlist, quality: flags.quality });
          result.diagnostics.push(...vc.diagnostics);
          result.checks.view = vc.report;
        }
      }
    }
    const docNetlist = flags.netlist ? JSON.parse(fs.readFileSync(flags.netlist, 'utf8')) : null;
    if (type === 'microarch') {
      const df = checkDocFacts(doc, { figureDir, netlist: docNetlist });
      result.diagnostics.push(...df.diagnostics);
      result.checks.doc_facts = df.report;
    }
    if (type === 'datapath') {
      result.diagnostics.push(...checkDetailRefs(doc, { figureDir }).diagnostics);
      const fe = checkFunctionEvidence(doc, { figureDir, netlist: docNetlist, quality: flags.quality });
      result.diagnostics.push(...fe.diagnostics);
      result.checks.function_evidence = fe.report;
    }
    result.ok = !result.diagnostics.some((d) => d.severity === 'error');
  }
  // Study format (lib/format.mjs): print-only checks are skipped or warnings.
  const fmt = resolveFormat(doc, flags.format);
  result.diagnostics.push(...fmt.diagnostics);
  const relaxed = relaxDiagnostics(result.diagnostics, fmt.format);
  result.checks = { ...(result.checks || {}), format: { name: fmt.format, relaxed: [...relaxed.values()] } };
  result.ok = !result.diagnostics.some((d) => d.severity === 'error');
  if (flags.json) print({ ok: result.ok, file, type, ...result, counts: summarize(result.diagnostics) });
  else {
    for (const d of result.diagnostics) console.error(line(d));
    console.log(`${result.ok ? 'ok' : 'invalid'}: ${JSON.stringify(result.checks)}`);
  }
  return result.ok ? EXIT.ok : EXIT.fail;
}

async function cmdRender({ positional, flags }) {
  const [type, file, outDir] = positional;
  if (!type || !file || !outDir) return usage();
  const build = await buildFigure({ type, figurePath: file, netlistPath: flags.netlist, profilesPath: flags.profiles, variants: flags.variants?.split(','), quality: flags.quality, view: viewOpts(flags), format: flags.format, pdf: !flags['no-pdf'] });
  fs.mkdirSync(outDir, { recursive: true });
  const name = figureName(file);
  const written = [];
  for (const a of build.artifacts) {
    for (const [ext, data] of [['svg', a.svg], ['pdf', a.pdf]].filter(([, d]) => d)) {
      const target = path.join(outDir, `${name}.${a.id}.${ext}`);
      fs.writeFileSync(target, data);
      written.push(target);
    }
  }
  print({ ok: build.ok, written, verification: build.evidence?.verification, variant_status: build.evidence?.variantStatus, layout: build.artifacts.map((a) => ({ id: a.id, size_pt: [a.width_pt, a.height_pt], ...a.layout, ...(flags['why-size'] ? { size_report: a.size_report } : {}) })), counts: summarize(build.diagnostics), diagnostics: build.diagnostics.map(line) });
  return build.ok ? EXIT.ok : EXIT.fail;
}

async function cmdDeliver({ positional, flags }) {
  const [type, file, outDir] = positional;
  if (!type || !file || !outDir) return usage();
  const result = await deliver({ type, figurePath: file, outDir, netlistPath: flags.netlist, profilesPath: flags.profiles, variants: flags.variants?.split(','), quality: flags.quality, view: viewOpts(flags), format: flags.format, pdf: !flags['no-pdf'], ...(flags.preview ? { preview: { scale: flags.scale !== undefined ? Number(flags.scale) : DEFAULT_SCALE } } : {}) });
  print({
    ok: result.ok,
    format: result.receipt?.format ?? { name: result.evidence?.format?.name },
    written: result.written,
    ...(result.archived ? { archived: result.archived } : {}),
    verification: result.receipt?.verification ? { level: result.receipt.verification.level, regions: result.receipt.verification.regions } : result.evidence?.verification,
    variant_status: result.receipt?.variant_status ?? result.evidence?.variantStatus,
    layout: result.artifacts.map((a) => ({ id: a.id, size_pt: [a.width_pt, a.height_pt], min_font_pt: a.min_font_pt, min_stroke_pt: a.min_stroke_pt, ...a.layout, ...(flags['why-size'] ? { size_report: a.size_report } : {}) })),
    counts: summarize(result.diagnostics),
    diagnostics: result.diagnostics.map(line),
  });
  return result.ok ? EXIT.ok : EXIT.fail;
}

// preview <file.svg|figure.json>: a PNG to look at. A figure JSON is rendered
// (paper or study) and its main variant rasterised; nothing else is written.
async function cmdPreview({ positional, flags }) {
  const [file] = positional;
  if (!file) return usage();
  const scale = flags.scale !== undefined ? Number(flags.scale) : DEFAULT_SCALE;
  const chrome = previewChrome();
  if (!chrome.available) {
    const d = chromeMissing(chrome);
    print({ ok: false, written: [], diagnostics: [line(d)], fix: d.supportedFixes });
    return EXIT.fail;
  }
  let svg;
  let target = flags.out;
  const diagnostics = [];
  if (/\.svg$/i.test(file)) {
    svg = fs.readFileSync(file, 'utf8');
    target ??= file.replace(/\.svg$/i, '.png');
  } else {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const build = await buildFigure({ type: doc.figure_type, figurePath: file, format: flags.format, pdf: false });
    diagnostics.push(...build.diagnostics);
    const main = build.artifacts.find((a) => !a.id.startsWith('addrmap.'));
    if (!build.ok || !main) {
      print({ ok: false, written: [], counts: summarize(diagnostics), diagnostics: diagnostics.map(line) });
      return EXIT.fail;
    }
    svg = main.svg;
    target ??= path.join(path.dirname(file), `${figureName(file)}.${main.id}.png`);
  }
  const shot = await rasterizeSvg(svg, target, { scale, chrome });
  diagnostics.push(...shot.diagnostics);
  print({ ok: shot.ok, written: shot.ok ? [target] : [], ...(shot.ok ? { size_px: shot.size, bytes: shot.bytes } : {}), chrome: chrome.executable, counts: summarize(diagnostics), diagnostics: diagnostics.map(line) });
  return shot.ok ? EXIT.ok : EXIT.fail;
}

async function cmdCrosscheck({ positional, flags }) {
  const [type, file] = positional;
  if (!type || !file || !flags.netlist) return usage();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { netlist, guard } = loadNetlistWithGuard(flags.netlist);
  const guarded = guard.diagnostics.some((d) => d.severity === 'error');
  const cc = guarded ? { diagnostics: [], stats: {} } : (type === 'datapath' ? crosscheckDatapath(doc, netlist) : type === 'fsm' ? (await import('../lib/checks/fsm-crosscheck.mjs')).crosscheckFsm(doc, netlist, { quality: flags.quality }) : crosscheckSoc(doc, netlist));
  const extra = !guarded && type === 'datapath' ? { coverage: checkCoverage(doc, netlist), latency: checkLatency(doc, netlist) } : {};
  if (extra.coverage) cc.stats = { ...cc.stats, coverage: extra.coverage.report?.totals, latency: { ...extra.latency.report, paths: undefined } };
  const diagnostics = [...guard.diagnostics, ...cc.diagnostics, ...(extra.coverage?.diagnostics || []), ...(extra.latency?.diagnostics || [])];
  const ok = !diagnostics.some((d) => d.severity === 'error');
  if (flags.json) print({ ok, stats: cc.stats, diagnostics });
  else { for (const d of diagnostics) console.error(line(d)); console.log(`${ok ? 'pass' : 'fail'} ${JSON.stringify(cc.stats)}`); }
  return ok ? EXIT.ok : EXIT.fail;
}

// Expand the RTL cone of one output into a gate-level figure fragment whose
// nets already carry rtl mappings, ready to paste into a datapath figure and
// to be equivalence-checked by deliver.
async function cmdExpandCone({ flags }) {
  if (!flags.netlist || !flags.output) return usage();
  const { netlist, guard } = loadNetlistWithGuard(flags.netlist);
  if (guard.diagnostics.some((d) => d.severity === 'error')) {
    for (const d of guard.diagnostics) console.error(line(d));
    return EXIT.fail;
  }
  const mod = findModule(netlist, flags.instance);
  if (!mod) { console.error(`instance ${flags.instance ?? '(top)'} not found`); return EXIT.fail; }
  const index = flags.index !== undefined ? Number(flags.index) : undefined;
  const stopAt = flags['stop-at'] ? flags['stop-at'].split(',') : [];
  const cone = resolveCone(mod, { output: flags.output, index, stopAt });
  if (cone.error) { console.error(cone.error); return EXIT.fail; }
  const prefix = flags.prefix || 'g';
  const exp = expandToGates(cone, { maxGates: flags['max-gates'] ? Number(flags['max-gates']) : 30, bitblast: !flags['no-bitblast'], prefix, outputLabel: `${flags.output}${index !== undefined ? `[${index}]` : ''}` });
  const rtlOf = (input) => (input.slice ? { signal: input.name, slice: `${input.slice[0]}:${input.slice[1]}` } : input.index !== undefined ? { signal: input.name, index: input.index } : { signal: input.name });
  const nets = exp.nets.map((n) => {
    const inPort = exp.inputs.find((i) => i.id === n.driver);
    if (inPort) return { ...n, rtl: rtlOf(cone.inputs.find((c) => c.key === inPort.key)) };
    if (n.sinks.includes(exp.output)) return { ...n, rtl: { signal: flags.output, ...(index !== undefined ? { index } : {}) } };
    return n;
  });
  const fragment = {
    elements: exp.elements,
    nets,
    region: {
      id: `${prefix}_region`, level: 'gate', label: `${flags.output}${index !== undefined ? `[${index}]` : ''} (gates)`,
      members: exp.elements.filter((e) => e.kind !== 'port').map((e) => e.id),
      rtl: { ...(flags.instance ? { instance: flags.instance } : {}), ...(stopAt.length ? { stop_at: stopAt } : {}) },
    },
    inputs: cone.inputs.map((i) => ({ key: i.key, width: i.width, port: exp.inputs.find((p) => p.key === i.key)?.id })),
    output: exp.output,
    gate_count: exp.gateCount,
    source: cone.source,
    diagnostics: exp.diagnostics,
  };
  if (flags.out) fs.writeFileSync(flags.out, `${JSON.stringify(fragment, null, 2)}\n`);
  else print(fragment);
  for (const d of exp.diagnostics) console.error(line(d));
  return exp.diagnostics.some((d) => d.severity === 'error') ? EXIT.fail : EXIT.ok;
}

const viewOpts = (flags) => ({
  preset: flags.view, scope: flags.scope, depth: flags.depth !== undefined ? Number(flags.depth) : undefined,
  gateRegions: flags['gate-region'], blackbox: flags.blackbox,
});

// Draft a starting figure for a view preset from the user's netlist. The
// author refines it; validate/deliver apply every check to the result.
async function cmdDraft({ flags }) {
  if (flags.type === 'fsm') return cmdDraftFsm({ flags });
  const microarch = flags.type === 'microarch';
  if (flags.type !== undefined && !['datapath', 'microarch'].includes(flags.type)) return usage();
  if (flags.bundle !== undefined && (microarch || !['prefix', 'handshake'].includes(flags.bundle))) return usage();
  if (flags.style !== undefined && (microarch || !['rtl-datapath', 'lumps'].includes(flags.style))) return usage();
  if (microarch && flags.view !== undefined && flags.view !== 'overview') return usage();
  if (!flags.netlist || (!microarch && !flags.view && flags.format !== 'study')) return usage();
  const { netlist, guard } = loadNetlistWithGuard(flags.netlist);
  if (guard.diagnostics.some((d) => d.severity === 'error')) {
    for (const d of guard.diagnostics) console.error(line(d));
    return EXIT.fail;
  }
  // A short or symbolic revision (c6591b3, HEAD) is resolved in the repository: source pins need the full hash.
  let revision = flags.revision;
  if (flags['repo-root'] && revision && !/^[0-9a-f]{40}$/.test(revision)) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('git', ['-C', flags['repo-root'], 'rev-parse', '--verify', `${revision}^{commit}`], { encoding: 'utf8' });
    if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(r.stdout.trim())) {
      console.error(`error draft/revision: --revision ${revision} is not a commit in ${flags['repo-root']}; give the full 40-hex hash or a resolvable ref`);
      return EXIT.fail;
    }
    revision = r.stdout.trim();
    console.error(`note: --revision ${flags.revision} resolved to ${revision}`);
  }
  let draft;
  try {
    if (microarch) draft = (await import('../lib/draft-microarch.mjs')).draftMicroarch(netlist, { scope: flags.scope ?? '' });
    // Paper block drafts of one module default to the register-transfer style (registers, muxes, operators, controller);
    // --style lumps keeps functional blocks. Study, mixed, detail and bundled drafts keep the lump draft.
    else if ((flags.style ?? (flags.format !== 'study' && flags.view === 'block' && !flags['gate-region'] && !flags.blackbox && !flags.bundle ? 'rtl-datapath' : 'lumps')) === 'rtl-datapath') {
      if (flags.view && flags.view !== 'block') return usage();
      // Function names need a cited basis at a pinned revision: without --repo-root/--revision the draft finds
      // the repository of the RTL itself (the netlist's source root) and says so.
      let repository = flags['repo-root'] && revision ? { root: flags['repo-root'], revision } : null;
      if (!repository && netlist.inputs?.source_root) {
        const { spawnSync } = await import('node:child_process');
        const top = spawnSync('git', ['-C', netlist.inputs.source_root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
        const head = spawnSync('git', ['-C', netlist.inputs.source_root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
        if (top.status === 0 && head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim())) {
          repository = { root: top.stdout.trim(), revision: head.stdout.trim() };
          const dirty = spawnSync('git', ['-C', repository.root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
          console.error(`note: repository ${repository.root} at ${repository.revision} (from the netlist's source root; pass --repo-root/--revision to choose)${dirty.stdout.trim() ? '; the working tree has uncommitted changes, so cited lines are read at that revision' : ''}`);
        }
      }
      draft = (await import('../lib/draft-rtl.mjs')).draftRtlDatapath(netlist, { scope: flags.scope ?? '', format: flags.format, ...(repository ? { repository } : {}), ...(flags['budget-seconds'] !== undefined ? { budget: { seconds: Number(flags['budget-seconds']) } } : {}) });
    } else draft = draftFigure(netlist, { format: flags.format, preset: flags.view, scope: flags.scope ?? '', depth: flags.depth !== undefined ? Number(flags.depth) : undefined, gateRegions: flags['gate-region'] || [], blackbox: flags.blackbox || [], ...(flags.bundle ? { bundle: flags.bundle } : {}), ...(flags['budget-seconds'] !== undefined ? { budget: { seconds: Number(flags['budget-seconds']) } } : {}), ...(flags['repo-root'] && revision ? { repository: { root: flags['repo-root'], revision } } : {}) });
  } catch (error) {
    // A draft over its time or size budget reports where it stopped and how to narrow the scope.
    if (!error.diagnostic) throw error;
    console.error(line(error.diagnostic));
    return EXIT.fail;
  }
  if (flags.format && !FORMATS.includes(flags.format)) return usage();
  const text = `${JSON.stringify(flags.format ? withFormat(draft.doc, flags.format) : draft.doc, null, 2)}\n`;
  if (flags.out) fs.writeFileSync(flags.out, text);
  else process.stdout.write(text);
  for (const n of draft.notes) console.error(`note: ${n}`);
  // The draft is checked like any figure; residual errors are notes to fix, not a failed draft.
  const { draftLayout, draftMicroarchResiduals, draftResiduals } = await import('../lib/draft-check.mjs');
  // Residuals are judged as the figure will be delivered: paper quality unless the draft is a study figure.
  const checkOpts = { quality: flags.quality ?? (flags.format === 'study' ? undefined : 'paper'), figureDir: flags.out ? path.dirname(path.resolve(flags.out)) : process.cwd() };
  const drafted = JSON.parse(text);
  const residual = microarch ? await draftMicroarchResiduals(drafted, netlist, checkOpts) : await draftResiduals(drafted, netlist, checkOpts);
  for (const r of residual) console.error(`residual: ${r.code}: ${r.message}`);
  const checkList = microarch ? 'schema, semantics, labels, view, RTL cross-check, coverage' : 'schema, semantics, labels, view, RTL cross-check, coverage, latency';
  console.error(residual.length ? `note: the draft still fails ${residual.length} of its own checks (listed as residual:); refine it before delivery` : `note: the draft passes its own checks (${checkList})`);
  // Layout, fit and connectors (N2): one bounded render in the delivery format, reported apart.
  const layout = await draftLayout(drafted, { type: microarch ? 'microarch' : 'datapath', format: flags.format, ...(flags['layout-seconds'] !== undefined ? { seconds: Number(flags['layout-seconds']) } : {}) });
  for (const r of layout.residual) console.error(`residual (layout): ${r.code}: ${r.message}`);
  const pt = (v) => Math.round(v * 10) / 10;
  if (layout.skipped) console.error(`note: layout not run (${layout.skipped}); the checks above are semantic only, delivery can still fail layout, fit and connector checks`);
  else console.error(`note: layout ${layout.variant}: ${pt(layout.width_pt)} × ${pt(layout.height_pt)} pt${layout.max_height_pt ? ` (max height ${pt(layout.max_height_pt)} pt)` : ''}; ${layout.residual.length ? `${layout.residual.length} layout residual${layout.residual.length > 1 ? 's' : ''} (listed as residual (layout):)` : 'no layout residuals'}`);
  return EXIT.ok;
}

// draft --type fsm: a starting fsm figure from the netlist's extracted state
// machine, checked against the same netlist (schema and RTL cross-check).
async function cmdDraftFsm({ flags }) {
  if (!flags.netlist || (flags.format && !FORMATS.includes(flags.format))) return usage();
  const { netlist, guard } = loadNetlistWithGuard(flags.netlist);
  if (guard.diagnostics.some((d) => d.severity === 'error')) {
    for (const d of guard.diagnostics) console.error(line(d));
    return EXIT.fail;
  }
  const { draftFsm } = await import('../lib/draft-fsm.mjs');
  let draft;
  try {
    draft = draftFsm(netlist, { scope: flags.scope ?? '', state: flags.state, format: flags.format });
  } catch (error) {
    if (!error.diagnostic) throw error;
    console.error(line(error.diagnostic));
    return EXIT.fail;
  }
  const text = `${JSON.stringify(draft.doc, null, 2)}\n`;
  if (flags.out) fs.writeFileSync(flags.out, text);
  else process.stdout.write(text);
  for (const n of draft.notes) console.error(`note: ${n}`);
  const { crosscheckFsm } = await import('../lib/checks/fsm-crosscheck.mjs');
  const residual = [...await validateSchema('fsm', draft.doc)];
  const cc = residual.length ? { diagnostics: [], stats: null } : crosscheckFsm(draft.doc, netlist);
  residual.push(...cc.diagnostics.filter((d) => d.severity === 'error'));
  for (const r of residual) console.error(`residual: ${r.code}: ${r.message}`);
  if (cc.stats) console.error(`note: RTL cross-check: ${cc.stats.states_checked} states, ${cc.stats.transitions_checked} transitions, ${cc.stats.guards_compared} guards compared`);
  console.error(residual.length ? `note: the draft still fails ${residual.length} of its own checks (listed as residual:); refine it before delivery` : 'note: the draft passes its own checks (schema, RTL cross-check)');
  return EXIT.ok;
}

async function cmdLintSvg({ positional, flags }) {
  const [file] = positional;
  if (!file) return usage();
  const diagnostics = lintFigmaSafe(fs.readFileSync(file, 'utf8'));
  if (flags.json) print({ ok: !diagnostics.length, file, profile: 'figma-safe', diagnostics });
  else for (const d of diagnostics) console.error(line(d));
  return diagnostics.some((d) => d.severity === 'error') ? EXIT.fail : EXIT.ok;
}

async function cmdCheckRtl({ flags }) {
  const { expandSearchPath, formatFilelist, insideAny, parseFilelist, resolveDependencies } = await import('../lib/rtl/deps.mjs');
  const { summaryLines } = await import('../lib/rtl/summary.mjs');
  const { config, dir: configDir } = loadConfig({ configPath: flags.config });
  const rtl = config.rtl || {};
  let files = (flags.files || []).map((f) => path.resolve(f));
  let includeDirs = (flags.include || []).map((d) => path.resolve(d));
  if (flags.filelist) {
    const parsed = parseFilelist(fs.readFileSync(flags.filelist, 'utf8'), path.dirname(path.resolve(flags.filelist)));
    files = files.concat(parsed.files);
    includeDirs = includeDirs.concat(parsed.includeDirs);
  }
  const top = flags.top || rtl.top;
  // Dependency resolution from search paths: module, package and include
  // closure of the top, duplicates reported, the choice recorded.
  const searchPaths = flags['search-path'] || (rtl.search_paths || []).map((p) => path.resolve(configDir, p));
  let resolved = null;
  if (searchPaths.length && top) {
    resolved = resolveDependencies({ top, searchPaths, excludes: flags.exclude || [], prefer: flags.prefer || [], includeDirs });
    if (!resolved.files.length) {
      for (const d of resolved.diagnostics) console.error(line(d));
      return EXIT.fail;
    }
    files = [...files, ...resolved.files.filter((f) => !files.includes(f))];
    includeDirs = resolved.includeDirs;
    // Tool output never goes into the RTL tree being read.
    const roots = searchPaths.map((p) => expandSearchPath(p).base);
    for (const [flag, target] of [['out', flags.out], ['work-dir', flags['work-dir']], ['emit-filelist', flags['emit-filelist']]]) {
      const inside = target && insideAny(target, roots);
      if (inside) {
        console.error(`error evidence/output-in-rtl-tree: --${flag} ${target} lies inside the search path ${inside}; write tool output outside the RTL tree`);
        return EXIT.fail;
      }
    }
    if (flags['emit-filelist']) {
      fs.mkdirSync(path.dirname(path.resolve(flags['emit-filelist'])), { recursive: true });
      fs.writeFileSync(flags['emit-filelist'], formatFilelist({ files, includeDirs }));
    }
  }
  if (!files.length && rtl.files) files = rtl.files.map((f) => path.resolve(configDir, f));
  if (!top || !files.length) return usage();

  // Hard rule: never extract "evidence" from fig-gen's own files or tool output.
  const guard = checkRtlInputs(files.map((f) => path.resolve(f)), { workDirs: [flags['work-dir']] });
  if (guard.length) {
    for (const d of guard) console.error(line(d));
    return EXIT.fail;
  }

  const adapters = await discoverAdapters({ config, configDir });
  const id = selectAdapterId({ cliId: flags.adapter, config });
  const adapter = adapters.get(id);
  if (!adapter) {
    console.error(`unknown adapter '${id}'; available: ${[...adapters.keys()].join(', ')}`);
    return EXIT.usage;
  }
  const request = {
    files,
    top,
    work_dir: flags['work-dir'],
    source_root: flags['source-root'] ? path.resolve(flags['source-root']) : undefined,
    include_dirs: includeDirs,
    defines: kv(flags.define),
    params: kv(flags.param),
    blackbox_stubs: flags.stub || (rtl.blackbox_stubs || []).map((f) => path.resolve(configDir, f)),
    blackboxes: readUserBlackboxes(flags['blackbox-json'] || []),
  };
  const netlist = await adapter.extract(request, { log: flags.quiet ? () => {} : (m) => console.error(`[${adapter.id}] ${m}`) });
  if (resolved) {
    const relTo = (f) => (request.source_root ? path.relative(request.source_root, f).split(path.sep).join('/') : f);
    netlist.inputs = {
      ...(netlist.inputs || {}),
      include_dirs: includeDirs.map(relTo),
      resolution: {
        ...resolved.resolution,
        files: resolved.resolution.files.map((f) => ({ ...f, path: relTo(f.path) })),
        duplicates: resolved.resolution.duplicates.map((d) => ({ ...d, candidates: d.candidates.map(relTo), chosen: relTo(d.chosen) })),
        unresolved: resolved.resolution.unresolved.map((u) => ({ ...u, ...(u.referenced_by ? { referenced_by: relTo(u.referenced_by) } : {}) })),
      },
    };
    netlist.diagnostics = [...resolved.diagnostics, ...netlist.diagnostics];
  }
  const schemaDiagnostics = await validateSchema('rtl-netlist', netlist);
  if (schemaDiagnostics.length) {
    console.error(`rtl/adapter-output-invalid: ${schemaDiagnostics.slice(0, 5).map((d) => d.message).join('; ')}`);
    return EXIT.fail;
  }
  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(flags.out, `${JSON.stringify(netlist, null, 2)}\n`);
  }
  const summary = {
    adapter: netlist.adapter,
    top: netlist.top,
    modules: netlist.modules.map((m) => ({
      name: m.name, orig_name: m.orig_name, params: m.params, blackbox: m.blackbox,
      ports: m.ports.length, registers: m.registers.length, instances: m.instances.length, deps: m.deps.length, muxes: (m.muxes || []).length, exprs: (m.exprs || []).length,
    })),
    hierarchy: netlist.hierarchy.map((h) => h.path),
    diagnostics: netlist.diagnostics.map(line),
  };
  // --summary: one line per module, the file resolution, then the diagnostics.
  if (flags.summary && !flags.json) {
    process.stdout.write(`${summaryLines(netlist).join('\n')}\n`);
    return EXIT.ok;
  }
  if (flags.json || flags.summary || !flags.out) print(flags.json && !flags.summary ? netlist : summary);
  return EXIT.ok;
}

async function cmdAdapters({ flags }) {
  const { config, dir } = loadConfig({ configPath: flags.config });
  const adapters = await discoverAdapters({ config, configDir: dir });
  const rows = [];
  for (const a of adapters.values()) rows.push({ id: a.id, kind: a.kind, ...(await a.detect()) });
  print({ selected: selectAdapterId({ config }), adapters: rows });
  return EXIT.ok;
}

async function cmdDoctor() {
  const verilator = (await discoverAdapters()).get('verilator');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const deps = {};
  for (const [name, spec] of [['ajv', 'ajv/dist/2020.js'], ['elkjs', 'elkjs'], ['opentype.js', 'opentype.js'], ['pdfkit', 'pdfkit'], ['svg-to-pdfkit', 'svg-to-pdfkit'], ['wavedrom', 'wavedrom']]) {
    try { await import(spec); deps[name] = true; } catch { deps[name] = false; }
  }
  const fonts = {};
  for (const f of ['arimo', 'tinos', 'libertinus-serif']) fonts[f] = fs.existsSync(path.join(root, 'node_modules', '@fontsource', f));
  const depsOk = Object.values(deps).every(Boolean) && Object.values(fonts).every(Boolean);
  const checks = {
    node: { ok: nodeMajor >= 20, version: process.version, required: '>=20' },
    dependencies: { ok: depsOk, ...deps, fonts, fix: depsOk ? undefined : 'run npm ci in the skill directory' },
    verilator: { required_for: 'check-rtl, cross-checks, vcd grounding', ...(await verilator.detect()) },
    chrome: { required_for: 'visual-check, previews', ...findChrome() },
  };
  print({ root, figure_types: FIGURE_TYPES, checks });
  return checks.node.ok && depsOk ? EXIT.ok : EXIT.fail;
}

async function cmdSimulate({ flags }) {
  if (!flags.top || !flags['work-dir'] || !(flags.tb || flags.bfm)) return usage();
  const { simulate } = await import('../lib/sim/verilator-sim.mjs');
  const workDir = path.resolve(flags['work-dir']);
  let stimulusFiles = flags.tb || [];
  let stimulusKind = 'sv-testbench';
  let top = flags.top;
  if (flags.bfm) {
    if (!flags.scenario) return usage();
    const { writeBfm } = await import('../lib/bfm/generate.mjs');
    const netlist = flags.netlist ? JSON.parse(fs.readFileSync(flags.netlist, 'utf8')) : undefined;
    const portmap = JSON.parse(fs.readFileSync(flags.bfm, 'utf8'));
    const scenario = JSON.parse(fs.readFileSync(flags.scenario, 'utf8'));
    // --top names the DUT for a BFM run; the generated wrapper is the simulation top.
    if (portmap.top !== top) portmap.top = top;
    const gen = writeBfm(portmap, scenario, path.join(workDir, 'bfm'), { netlist, dumpScope: flags['dump-scope'] });
    stimulusFiles = [gen.file, flags.bfm, flags.scenario];
    stimulusKind = 'bfm-script';
    top = gen.top;
  }
  const r = simulate({
    rtlFiles: flags.files || [], stimulusFiles: stimulusFiles.filter((f) => /\.(s?v|svh|vh)$/i.test(f)), stimulusKind, top, workDir,
    defines: kv(flags.define), params: kv(flags.param), includes: flags.include || [], timeoutSeconds: flags['timeout-seconds'] ? Number(flags['timeout-seconds']) : undefined,
  });
  // Scenario and port map files are stimulus too: hash them with the generated wrapper.
  if (r.evidence && flags.bfm) {
    const { createHash } = await import('node:crypto');
    for (const f of [flags.bfm, flags.scenario]) r.evidence.stimulus.files.push({ path: path.resolve(f), sha256: createHash('sha256').update(fs.readFileSync(f)).digest('hex') });
  }
  const out = { ok: r.ok, vcd: r.vcd ?? null, top, evidence: r.evidence, timing: r.timing ?? null, diagnostics: r.diagnostics.map(line) };
  if (r.evidence) fs.writeFileSync(path.join(workDir, 'simulate.json'), `${JSON.stringify(out, null, 2)}\n`);
  if (flags.json) print({ ...out, diagnostics: r.diagnostics });
  else print(out);
  return r.ok ? EXIT.ok : EXIT.fail;
}

async function cmdVcd2wave({ flags }) {
  if (!flags.vcd || !flags.clock || !flags.signals?.length) return usage();
  const { vcdToTiming } = await import('../lib/timing/vcd2wave.mjs');
  const pairs = (list = []) => Object.fromEntries(list.map((s) => { const i = s.lastIndexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  let alignOn;
  if (flags['align-on']) {
    const [p, event = 'rise', occurrence = '1'] = String(flags['align-on']).split(':');
    alignOn = { path: p, event, occurrence: Number(occurrence) };
  }
  const simEvidence = flags['sim-evidence'] ? JSON.parse(fs.readFileSync(flags['sim-evidence'], 'utf8')).evidence : null;
  const { doc, diagnostics } = vcdToTiming(path.resolve(flags.vcd), {
    clock: flags.clock, edge: flags.edge ?? 'pos', signals: flags.signals, from: flags.from ? Number(flags.from) : 0, alignOn,
    cycles: flags.cycles ? Number(flags.cycles) : undefined, radix: pairs(flags.radix), aliases: pairs(flags.alias),
    netlist: flags.netlist ? JSON.parse(fs.readFileSync(flags.netlist, 'utf8')) : undefined, title: flags.title,
    ...(simEvidence ? { simulation: { simulator: simEvidence.simulator, top: simEvidence.top, stimulus: simEvidence.stimulus, rtl_files: simEvidence.rtl_files, ...(simEvidence.defines ? { defines: simEvidence.defines } : {}), ...(simEvidence.params ? { params: simEvidence.params } : {}) } } : {}),
  });
  if (doc && flags.out) fs.writeFileSync(flags.out, `${JSON.stringify(doc, null, 2)}\n`);
  print({ ok: Boolean(doc) && !diagnostics.some((d) => d.severity === 'error'), written: doc && flags.out ? [flags.out] : [], ...(flags.out ? {} : { timing: doc }), diagnostics: diagnostics.map(line) });
  return doc ? EXIT.ok : EXIT.fail;
}

async function cmdBfm({ flags }) {
  if (!flags.portmap || !flags.scenario || !flags['out-dir']) return usage();
  const { writeBfm } = await import('../lib/bfm/generate.mjs');
  const netlist = flags.netlist ? JSON.parse(fs.readFileSync(flags.netlist, 'utf8')) : undefined;
  const r = writeBfm(JSON.parse(fs.readFileSync(flags.portmap, 'utf8')), JSON.parse(fs.readFileSync(flags.scenario, 'utf8')), path.resolve(flags['out-dir']), { netlist, dumpScope: flags['dump-scope'] });
  print({ ok: true, top: r.top, written: [r.file], note: 'generated stimulus: never evidence of DUT behaviour beyond this scenario' });
  return EXIT.ok;
}

async function cmdSimCompare({ positional, flags }) {
  const [file] = positional;
  if (!file) return usage();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const vcd = flags.vcd ?? doc.provenance?.compare_vcd ?? doc.provenance?.vcd;
  if (!vcd) return usage();
  const { compareTiming } = await import('../lib/timing/compare.mjs');
  const resolved = path.isAbsolute(vcd) || flags.vcd ? path.resolve(vcd) : path.resolve(path.dirname(path.resolve(file)), vcd);
  const { report, diagnostics } = compareTiming(doc, resolved);
  const ok = !diagnostics.some((d) => d.severity === 'error');
  print({ ok, report, diagnostics: flags.json ? diagnostics : diagnostics.map(line) });
  return ok ? EXIT.ok : EXIT.fail;
}

function usage() {
  console.error(USAGE);
  return EXIT.usage;
}

const commands = {
  validate: cmdValidate,
  render: cmdRender,
  deliver: cmdDeliver,
  preview: cmdPreview,
  crosscheck: cmdCrosscheck,
  'expand-cone': cmdExpandCone,
  draft: cmdDraft,
  'lint-svg': cmdLintSvg,
  'check-rtl': cmdCheckRtl,
  adapters: cmdAdapters,
  doctor: cmdDoctor,
  simulate: cmdSimulate,
  vcd2wave: cmdVcd2wave,
  bfm: cmdBfm,
  'sim-compare': cmdSimCompare,
};

// exitCode (not process.exit) so large piped stdout is flushed before exit.
const [command, ...rest] = process.argv.slice(2);
const handler = commands[command];
if (!handler) {
  process.exitCode = usage();
} else {
  try {
    process.exitCode = await handler(parseArgs(rest));
  } catch (error) {
    console.error(`error: ${error.stack || error.message}`);
    process.exitCode = EXIT.fail;
  }
}
