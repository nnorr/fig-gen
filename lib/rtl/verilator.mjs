// Built-in Verilator extraction adapter. Runs `verilator --json-only` in a
// work directory outside the RTL tree, auto-stubs missing modules in two
// passes (placeholder → refined), and normalizes the JSON AST.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseMissingModules, placeholderStubs, refineStubs, scanInstantiations, stubSource,
} from './blackbox.mjs';
import { normalizeVerilatorJson } from './verilator-json.mjs';
import { markWorkDir } from '../evidence.mjs';

function executable(env = process.env) {
  return env.FIGGEN_VERILATOR || 'verilator';
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(exe, args, cwd) {
  const result = spawnSync(exe, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`could not run ${exe}: ${result.error.message}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function errorLines(output) {
  return output.split('\n').filter((l) => /^%Error/.test(l));
}

const adapter = {
  id: 'verilator',
  kind: 'extract',

  async detect({ env = process.env } = {}) {
    const exe = executable(env);
    const result = spawnSync(exe, ['--version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) return { available: false, executable: exe, reason: result.error?.message || result.stderr };
    const version = /Verilator\s+([\d.]+)/.exec(result.stdout)?.[1] || result.stdout.trim();
    return { available: true, executable: exe, version };
  },

  async extract(request, { env = process.env, log = () => {} } = {}) {
    const exe = executable(env);
    const detected = await adapter.detect({ env });
    if (!detected.available) throw new Error(`verilator unavailable: ${detected.reason}`);
    const files = request.files.map((f) => path.resolve(f));
    const workDir = path.resolve(request.work_dir || fs.mkdtempSync(path.join(os.tmpdir(), 'fig-gen-')));
    // Everything the tool writes lives under a marked work directory, so the
    // evidence guard can reject any of it being used as RTL evidence.
    markWorkDir(workDir);
    const userStubFiles = (request.blackbox_stubs || []).map((f) => path.resolve(f));
    const userStubJson = request.blackboxes || [];
    const stubModules = new Map();
    const diagnostics = [];

    const commonArgs = [
      '--Mdir', path.join(workDir, 'obj'),
      '-Wno-fatal', '-Wno-lint', '-Wno-style', '-Wno-TIMESCALEMOD',
      '--top-module', request.top,
      ...(request.include_dirs || []).map((d) => `-I${path.resolve(d)}`),
      ...Object.entries(request.defines || {}).map(([k, v]) => `+define+${k}=${v}`),
      ...Object.entries(request.params || {}).map(([k, v]) => `-G${k}=${v}`),
    ];
    const treeFile = (tag) => path.join(workDir, `tree.${tag}.json`);
    const metaFile = (tag) => path.join(workDir, `tree.${tag}.meta.json`);

    const writeStubs = (name, stubs, origin) => {
      const file = path.join(workDir, `${name}.stubs.v`);
      fs.writeFileSync(file, stubSource(stubs, { origin }));
      return file;
    };

    const extraFiles = [...userStubFiles];
    if (userStubJson.length) {
      extraFiles.push(writeStubs('user', userStubJson, 'user'));
      for (const s of userStubJson) stubModules.set(s.module, { origin: 'user', confidence: 'declared' });
    }
    for (const f of userStubFiles) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/^\s*module\s+([A-Za-z_]\w*)/gm)) stubModules.set(m[1], { origin: 'user', confidence: 'declared' });
    }

    const elaborate = (tag, extra) => {
      log(`${tag}: elaborate`);
      return run(exe, [
        '--json-only', '--json-only-output', treeFile(tag), '--json-only-meta-output', metaFile(tag),
        ...commonArgs, ...extra, ...files,
      ], workDir);
    };
    const normalize = (tag) => normalizeVerilatorJson(
      JSON.parse(fs.readFileSync(treeFile(tag), 'utf8')),
      JSON.parse(fs.readFileSync(metaFile(tag), 'utf8')),
      { adapterVersion: detected.version, sourceRoot: request.source_root, top: request.top, stubModules },
    );
    const failIf = (pass, what) => {
      if (pass.status !== 0) throw new Error(`verilator elaboration ${what} failed:\n${errorLines(pass.output).slice(0, 20).join('\n')}`);
    };

    let tag = 'pass1';
    let pass = elaborate(tag, extraFiles);
    let autoStubFile;
    if (pass.status !== 0) {
      const missing = parseMissingModules(pass.output);
      // Verilator <= 5.022 does not tag these %Error-MODMISSING; it emits a plain
      // %Error plus a second "no search path" line. Filtering on the tag alone
      // leaves both in otherErrors, so auto-blackboxing never runs and any design
      // instantiating a vendor macro it does not vendor fails outright. Match the
      // message too.
      const otherErrors = errorLines(pass.output).filter((l) => !/MODMISSING|Exiting due to/.test(l)
        && !/Cannot find file containing module:/.test(l)
        && !/This may be because there's no search path specified with -I/.test(l));
      if (!missing.length || otherErrors.length) failIf(pass, 'of the design');
      log(`missing modules → auto blackbox: ${missing.join(', ')}`);
      const sites = scanInstantiations(files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') })), missing);
      for (const site of sites.filter((s) => s.positional)) {
        diagnostics.push({ code: 'rtl/blackbox-port-unknown', severity: 'warning', message: `${site.module} instance ${site.instance} uses positional or wildcard connections; ports cannot be inferred`, subject: { module: site.module, instance: site.instance }, evidence: { file: site.file, line: site.line }, supportedFixes: ['provide a user blackbox stub for this module'] });
      }
      const unseen = missing.filter((m) => !sites.some((s) => s.module === m));
      if (unseen.length) throw new Error(`missing modules without a parsable instantiation site: ${unseen.join(', ')}; provide user stubs`);
      for (const m of missing) stubModules.set(m, { origin: 'auto', confidence: 'inferred' });

      tag = 'pass2';
      pass = elaborate(tag, [...extraFiles, writeStubs('auto-pass1', placeholderStubs(sites), 'auto, placeholder')]);
      failIf(pass, 'with placeholder stubs');
      const { stubs, unresolved } = refineStubs(normalize(tag), missing, sites);
      for (const u of unresolved) {
        diagnostics.push({ code: 'rtl/blackbox-port-unknown', severity: 'warning', message: `${u.module}.${u.port} on ${u.instance}: ${u.reason}; port omitted from stub`, subject: u, supportedFixes: ['provide a user blackbox stub for this module'] });
      }
      for (const stub of stubs) for (const p of stub.ports.filter((q) => q.conflict)) {
        diagnostics.push({ code: 'rtl/blackbox-port-conflict', severity: 'warning', message: `${stub.module}.${p.name}: instances disagree on width/direction; using width ${p.width}`, subject: { module: stub.module, port: p.name } });
      }
      autoStubFile = writeStubs('auto', stubs.map((s) => ({ ...s, ports: s.ports.map(({ conflict, ...p }) => p) })), 'auto, refined');
      tag = 'final';
      pass = elaborate(tag, [...extraFiles, autoStubFile]);
      failIf(pass, 'with refined stubs');
    }

    const netlist = normalize(tag);
    for (const mod of netlist.modules) {
      if (mod.blackbox?.origin === 'auto') for (const p of mod.ports) p.direction_inferred = true;
    }
    const toolWarnings = pass.output.split('\n').filter((l) => /^%Warning/.test(l));
    const rel = (f) => (request.source_root ? path.relative(request.source_root, f).split(path.sep).join('/') : f);
    netlist.inputs = {
      files: [
        ...files.map((f) => ({ path: rel(f), sha256: sha256File(f), role: 'rtl' })),
        ...userStubFiles.map((f) => ({ path: rel(f), sha256: sha256File(f), role: 'stub-user' })),
        ...(autoStubFile ? [{ path: path.basename(autoStubFile), sha256: sha256File(autoStubFile), role: 'stub-auto' }] : []),
      ],
      defines: request.defines || {},
      params: request.params || {},
      ...(request.source_root ? { source_root: path.resolve(request.source_root) } : {}),
      work_dir: workDir,
    };
    netlist.diagnostics = [
      ...diagnostics,
      ...netlist.diagnostics,
      ...(toolWarnings.length ? [{ code: 'rtl/tool-warnings', severity: 'info', message: `${toolWarnings.length} tool warnings (lint categories suppressed)`, evidence: { sample: toolWarnings.slice(0, 10) } }] : []),
    ];
    return netlist;
  },
};

export default adapter;
