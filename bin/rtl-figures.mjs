#!/usr/bin/env node
// rtl-figures CLI (Phase 1 stub). Implemented: validate (schema), lint-svg,
// check-rtl (netlist extraction), adapters, doctor. render/deliver: planned.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGURE_TYPES, validateFigure, validateSchema } from '../lib/validate.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { discoverAdapters, loadConfig, selectAdapterId } from '../lib/rtl/adapters.mjs';
import { readUserBlackboxes } from '../lib/rtl/blackbox.mjs';
import { summarize } from '../lib/diagnostics.mjs';
import { findChrome } from '../lib/env/chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { ok: 0, fail: 1, usage: 2, notImplemented: 3 };

const USAGE = `usage:
  rtl-figures validate <datapath|fsm|timing|microarch> <figure.json> [--json]
  rtl-figures render   <type> <figure.json> <out-dir> [--variants 1col,2col]    (not implemented in phase 1)
  rtl-figures deliver  <type> <figure.json> <out-dir> [--variants 1col,2col]    (not implemented in phase 1)
  rtl-figures lint-svg <file.svg> [--json]
  rtl-figures check-rtl --top <module> (--files <f...> | --filelist <file.f> | --config <cfg>)
                        [--out netlist.json] [--work-dir <dir>] [--source-root <dir>]
                        [--adapter <id>] [--stub <file.v>...] [--blackbox-json <file>...]
                        [--include <dir>...] [--define K=V...] [--param K=V...] [--figure <fig.json>]
  rtl-figures adapters [--config <cfg>]
  rtl-figures doctor`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const multi = new Set(['files', 'stub', 'blackbox-json', 'include', 'define', 'param']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (key === 'json' || key === 'summary' || key === 'quiet') { flags[key] = true; continue; }
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

async function cmdValidate({ positional, flags }) {
  const [type, file] = positional;
  if (!type || !file) return usage();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = await validateFigure(type, doc);
  if (flags.json) print({ ok: result.ok, file, type, ...result, counts: summarize(result.diagnostics) });
  else {
    for (const d of result.diagnostics) console.error(`${d.severity} ${d.code}: ${d.message}`);
    console.log(`${result.ok ? 'schema ok' : 'invalid'} — semantic/layout/print checks not implemented in phase 1`);
  }
  return result.ok ? EXIT.ok : EXIT.fail;
}

async function cmdLintSvg({ positional, flags }) {
  const [file] = positional;
  if (!file) return usage();
  const diagnostics = lintFigmaSafe(fs.readFileSync(file, 'utf8'));
  if (flags.json) print({ ok: !diagnostics.length, file, profile: 'figma-safe', diagnostics });
  else for (const d of diagnostics) console.error(`${d.severity} ${d.code}: ${d.message}`);
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
      ports: m.ports.length, registers: m.registers.length, instances: m.instances.length, deps: m.deps.length,
    })),
    hierarchy: netlist.hierarchy.map((h) => h.path),
    diagnostics: netlist.diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message}`),
    figure_crosscheck: flags.figure ? 'not-implemented' : undefined,
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
  let ajv = false;
  let elk = false;
  try { await import('ajv/dist/2020.js'); ajv = true; } catch { /* reported below */ }
  try { await import('elkjs'); elk = true; } catch { /* reported below */ }
  const checks = {
    node: { ok: nodeMajor >= 20, version: process.version, required: '>=20' },
    dependencies: { ok: ajv, ajv, elkjs: elk, fix: ajv && elk ? undefined : 'run npm ci in the skill directory' },
    verilator: { required_for: 'check-rtl, vcd grounding', ...(await verilator.detect()) },
    chrome: { required_for: 'visual-check, PDF fallback', ...findChrome() },
  };
  print({ root, figure_types: FIGURE_TYPES, checks });
  return checks.node.ok && ajv ? EXIT.ok : EXIT.fail;
}

function usage() {
  console.error(USAGE);
  return EXIT.usage;
}

const commands = {
  validate: cmdValidate,
  'lint-svg': cmdLintSvg,
  'check-rtl': cmdCheckRtl,
  adapters: cmdAdapters,
  doctor: cmdDoctor,
  render: async () => { console.error('render: not implemented in phase 1 (see SPEC §9–10)'); return EXIT.notImplemented; },
  deliver: async () => { console.error('deliver: not implemented in phase 1 (see SPEC §12)'); return EXIT.notImplemented; },
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
    console.error(`error: ${error.message}`);
    process.exitCode = EXIT.fail;
  }
}
