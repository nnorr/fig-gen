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
import { checkNetlistEvidence, checkRtlInputs } from '../lib/evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { ok: 0, fail: 1, usage: 2, notImplemented: 3 };

const USAGE = `usage:
  fig-gen validate <datapath|fsm|timing|microarch> <figure.json> [--netlist netlist.json] [--json]
  fig-gen render   <datapath|microarch> <figure.json> <out-dir> [--netlist n.json] [--variants 2col,1col] [--profiles p.json] [--quality paper]
  fig-gen deliver  <datapath|microarch> <figure.json> <out-dir> [--netlist n.json] [--variants 2col,1col] [--profiles p.json] [--quality paper]
                   (default: 2col required, 1col best effort; --variants makes the listed variants mandatory)
                   view presets: [--view overview|block|mixed|detail] [--scope <instance path>] [--depth n]
                                 [--gate-region <region id>...] [--blackbox <element or instance>...]
  fig-gen draft --view <overview|block|mixed|detail> --scope <instance path> --netlist n.json [--depth n]
                [--gate-region name=out1,out2[:stop1,stop2]...] [--blackbox <instance path>...] [--repo-root <dir> --revision <sha>] [--out figure.json]
  fig-gen crosscheck <datapath|microarch> <figure.json> --netlist netlist.json [--json]
  fig-gen expand-cone --netlist n.json --output <signal> [--index <n>] [--instance a/b] [--stop-at s1,s2]
                      [--max-gates 30] [--prefix g] [--no-bitblast] [--out fragment.json]
  fig-gen lint-svg <file.svg> [--json]
  fig-gen check-rtl --top <module> (--files <f...> | --filelist <file.f> | --config <cfg>)
                    [--out netlist.json] [--work-dir <dir>] [--source-root <dir>]
                    [--adapter <id>] [--stub <file.v>...] [--blackbox-json <file>...]
                    [--include <dir>...] [--define K=V...] [--param K=V...]
  fig-gen adapters [--config <cfg>]
  fig-gen doctor`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const multi = new Set(['files', 'stub', 'blackbox-json', 'include', 'define', 'param', 'gate-region', 'blackbox']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (['json', 'summary', 'quiet', 'no-bitblast'].includes(key)) { flags[key] = true; continue; }
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
        const cc = type === 'datapath' ? crosscheckDatapath(doc, netlist) : type === 'microarch' ? crosscheckSoc(doc, netlist) : null;
        if (cc) { result.diagnostics.push(...cc.diagnostics); result.checks.rtl = cc.stats; }
        if (type === 'datapath') {
          const cov = checkCoverage(doc, netlist);
          const lat = checkLatency(doc, netlist);
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
  const build = await buildFigure({ type, figurePath: file, netlistPath: flags.netlist, profilesPath: flags.profiles, variants: flags.variants?.split(','), quality: flags.quality, view: viewOpts(flags) });
  fs.mkdirSync(outDir, { recursive: true });
  const name = figureName(file);
  const written = [];
  for (const a of build.artifacts) {
    for (const [ext, data] of [['svg', a.svg], ['pdf', a.pdf]]) {
      const target = path.join(outDir, `${name}.${a.id}.${ext}`);
      fs.writeFileSync(target, data);
      written.push(target);
    }
  }
  print({ ok: build.ok, written, verification: build.evidence?.verification, variant_status: build.evidence?.variantStatus, layout: build.artifacts.map((a) => ({ id: a.id, size_pt: [a.width_pt, a.height_pt], ...a.layout })), counts: summarize(build.diagnostics), diagnostics: build.diagnostics.map(line) });
  return build.ok ? EXIT.ok : EXIT.fail;
}

async function cmdDeliver({ positional, flags }) {
  const [type, file, outDir] = positional;
  if (!type || !file || !outDir) return usage();
  const result = await deliver({ type, figurePath: file, outDir, netlistPath: flags.netlist, profilesPath: flags.profiles, variants: flags.variants?.split(','), quality: flags.quality, view: viewOpts(flags) });
  print({
    ok: result.ok,
    written: result.written,
    verification: result.receipt?.verification ? { level: result.receipt.verification.level, regions: result.receipt.verification.regions } : result.evidence?.verification,
    variant_status: result.receipt?.variant_status ?? result.evidence?.variantStatus,
    layout: result.artifacts.map((a) => ({ id: a.id, size_pt: [a.width_pt, a.height_pt], min_font_pt: a.min_font_pt, min_stroke_pt: a.min_stroke_pt, ...a.layout })),
    counts: summarize(result.diagnostics),
    diagnostics: result.diagnostics.map(line),
  });
  return result.ok ? EXIT.ok : EXIT.fail;
}

async function cmdCrosscheck({ positional, flags }) {
  const [type, file] = positional;
  if (!type || !file || !flags.netlist) return usage();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { netlist, guard } = loadNetlistWithGuard(flags.netlist);
  const guarded = guard.diagnostics.some((d) => d.severity === 'error');
  const cc = guarded ? { diagnostics: [], stats: {} } : (type === 'datapath' ? crosscheckDatapath(doc, netlist) : crosscheckSoc(doc, netlist));
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
  if (!flags.netlist || !flags.view) return usage();
  const { netlist, guard } = loadNetlistWithGuard(flags.netlist);
  if (guard.diagnostics.some((d) => d.severity === 'error')) {
    for (const d of guard.diagnostics) console.error(line(d));
    return EXIT.fail;
  }
  const draft = draftFigure(netlist, { preset: flags.view, scope: flags.scope ?? '', depth: flags.depth !== undefined ? Number(flags.depth) : undefined, gateRegions: flags['gate-region'] || [], blackbox: flags.blackbox || [], ...(flags['repo-root'] && flags.revision ? { repository: { root: flags['repo-root'], revision: flags.revision } } : {}) });
  const text = `${JSON.stringify(draft.doc, null, 2)}\n`;
  if (flags.out) fs.writeFileSync(flags.out, text);
  else process.stdout.write(text);
  for (const n of draft.notes) console.error(`note: ${n}`);
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
  const { config, dir: configDir } = loadConfig({ configPath: flags.config });
  const rtl = config.rtl || {};
  let files = flags.files || [];
  if (flags.filelist) {
    const base = path.dirname(path.resolve(flags.filelist));
    files = files.concat(fs.readFileSync(flags.filelist, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).map((l) => path.resolve(base, l)));
  }
  if (!files.length && rtl.files) files = rtl.files.map((f) => path.resolve(configDir, f));
  const top = flags.top || rtl.top;
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
    include_dirs: flags.include || [],
    defines: kv(flags.define),
    params: kv(flags.param),
    blackbox_stubs: flags.stub || (rtl.blackbox_stubs || []).map((f) => path.resolve(configDir, f)),
    blackboxes: readUserBlackboxes(flags['blackbox-json'] || []),
  };
  const netlist = await adapter.extract(request, { log: flags.quiet ? () => {} : (m) => console.error(`[${adapter.id}] ${m}`) });
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

function usage() {
  console.error(USAGE);
  return EXIT.usage;
}

const commands = {
  validate: cmdValidate,
  render: cmdRender,
  deliver: cmdDeliver,
  crosscheck: cmdCrosscheck,
  'expand-cone': cmdExpandCone,
  draft: cmdDraft,
  'lint-svg': cmdLintSvg,
  'check-rtl': cmdCheckRtl,
  adapters: cmdAdapters,
  doctor: cmdDoctor,
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
