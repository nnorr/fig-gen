// Simulation adapter (SPEC §6.5, kind "simulate"): builds the user's RTL plus
// stimulus (a user testbench or a generated BFM wrapper) with
// `verilator --binary --timing --trace`, runs it in a marked work directory and
// collects the VCD with the evidence a receipt needs.
//
// A module that is instantiated but defined nowhere (a hard macro) makes
// simulation impossible: fig-gen reports it (sim/blackbox-without-model) and
// never writes a behavioral model; a model must come from the user.
//
// simulate({ rtlFiles, stimulusFiles, stimulusKind, top, defines, params,
//   includes, workDir, vcd: 'wave.vcd', timeoutSeconds, maxTime, allowFixtureEvidence })
//   -> { ok, vcd, diagnostics, evidence: { simulator, top, stimulus, rtl_files, defines, params, vcd_sha256 }, log }

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseMissingModules } from '../rtl/blackbox.mjs';
import { markWorkDir, selfAuthoredReason } from '../evidence.mjs';

const exe = (env = process.env) => env.FIGGEN_VERILATOR || 'verilator';
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function detectSimulator({ env = process.env } = {}) {
  const r = spawnSync(exe(env), ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { available: false, id: 'verilator', reason: r.error?.message || r.stderr };
  return { available: true, id: 'verilator', version: /Verilator\s+([\d.]+)/.exec(r.stdout)?.[1] ?? r.stdout.trim() };
}

const diag = (code, message, evidence = {}, supportedFixes = []) => ({ code, severity: 'error', message, subject: {}, evidence, supportedFixes });

export function simulate(request, { env = process.env } = {}) {
  const { rtlFiles = [], stimulusFiles = [], stimulusKind = 'sv-testbench', top, defines = {}, params = {}, includes = [], timeoutSeconds = 300, allowFixtureEvidence = false } = request;
  const diagnostics = [];
  const detected = detectSimulator({ env });
  if (!detected.available) return { ok: false, diagnostics: [diag('sim/simulator-missing', `verilator is not available: ${detected.reason}`, {}, ['install Verilator 5 (--binary --timing)'])], evidence: null };
  if (!top) return { ok: false, diagnostics: [diag('sim/usage', 'simulate needs --top (the testbench top module)')], evidence: null };
  const workDir = path.resolve(request.workDir);
  markWorkDir(workDir);
  const vcdName = request.vcd ?? 'wave.vcd';
  const rtl = rtlFiles.map((f) => path.resolve(f));
  const stim = stimulusFiles.map((f) => path.resolve(f));
  for (const f of [...rtl, ...stim]) if (!fs.existsSync(f)) diagnostics.push(diag('sim/file-missing', `${f} does not exist`));
  if (diagnostics.length) return { ok: false, diagnostics, evidence: null };
  // RTL evidence must be the user's own; tool-generated or fig-gen files never count.
  for (const f of rtl) {
    const reason = selfAuthoredReason(f, { workDirs: [workDir] });
    if (reason && !(allowFixtureEvidence && /tests[\\/]fixtures[\\/]/.test(f))) diagnostics.push(diag('evidence/self-authored', `${f} cannot be RTL evidence: ${reason}`, { file: f }, ['simulate the user\'s own RTL']));
  }
  if (diagnostics.length) return { ok: false, diagnostics, evidence: null };

  const obj = path.join(workDir, 'obj');
  const args = ['--binary', '--timing', '--trace', '-Wno-fatal', '-Wno-lint', '-Wno-style', '--top-module', top, '-Mdir', obj,
    ...Object.entries(defines).map(([k, v]) => `+define+${k}${v === '' || v === true ? '' : `=${v}`}`),
    ...Object.entries(params).map(([k, v]) => `-G${k}=${v}`),
    ...includes.map((d) => `-I${path.resolve(d)}`),
    ...stim, ...rtl];
  const t0 = Date.now();
  const build = spawnSync(exe(env), args, { cwd: workDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutSeconds * 1000 });
  const buildLog = `${build.stdout || ''}${build.stderr || ''}`;
  fs.writeFileSync(path.join(workDir, 'build.log'), `$ verilator ${args.join(' ')}\n${buildLog}`);
  const missing = parseMissingModules(buildLog);
  if (missing.length) {
    return {
      ok: false,
      diagnostics: [diag('sim/blackbox-without-model', `simulation is impossible: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} instantiated but defined nowhere (hard macros or unlisted files). A behavioral model must come from the user; fig-gen never writes one.`, { modules: missing }, ['add the user\'s own simulation model of each module to --files', 'add the missing source files', 'simulate a scope below the macros'])],
      evidence: null,
      log: buildLog,
    };
  }
  if (build.error?.code === 'ETIMEDOUT') return { ok: false, diagnostics: [diag('sim/timeout', `verilator build exceeded ${timeoutSeconds} s`)], evidence: null, log: buildLog };
  const binary = path.join(obj, `V${top}`);
  if (build.status !== 0 || !fs.existsSync(binary)) {
    const errors = buildLog.split('\n').filter((l) => /^%Error/.test(l)).slice(0, 12);
    return { ok: false, diagnostics: [diag('sim/compile-failed', `verilator build of ${top} failed: ${errors[0] ?? `exit ${build.status}`}`, { errors }, ['fix the reported compile errors', 'check --top and the file list'])], evidence: null, log: buildLog };
  }
  const buildMs = Date.now() - t0;
  const t1 = Date.now();
  const runArgs = request.maxTime ? [`+verilator+finish+${request.maxTime}`] : [];
  const runRes = spawnSync(binary, runArgs, { cwd: workDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutSeconds * 1000 });
  const runLog = `${runRes.stdout || ''}${runRes.stderr || ''}`;
  fs.writeFileSync(path.join(workDir, 'run.log'), runLog);
  if (runRes.error?.code === 'ETIMEDOUT') return { ok: false, diagnostics: [diag('sim/timeout', `simulation ran longer than ${timeoutSeconds} s without $finish`, {}, ['end the stimulus with $finish', 'raise the timeout'])], evidence: null, log: runLog };
  const vcd = path.join(workDir, vcdName);
  if (!fs.existsSync(vcd)) return { ok: false, diagnostics: [diag('sim/no-vcd', `the simulation wrote no ${vcdName}; the testbench must call $dumpfile("${vcdName}") and $dumpvars`, { exit: runRes.status }, ['add $dumpfile/$dumpvars to the testbench'])], evidence: null, log: runLog };
  const crashed = runRes.status !== 0 || /%Error|\$fatal|FATAL/.test(runLog);
  if (crashed) diagnostics.push({ code: 'sim/run-failed', severity: 'error', message: `the simulation ended with an error (exit ${runRes.status}): ${runLog.split('\n').find((l) => /%Error|fatal|FATAL/i.test(l)) ?? ''}`.trim(), subject: {}, evidence: { exit: runRes.status }, supportedFixes: ['check run.log in the work directory'] });
  // A generated BFM reports every failed expectation, poll or wait as "BFM ERROR":
  // the scenario did not happen as scripted, so its waveform is not the scenario.
  const scenarioErrors = runLog.split('\n').filter((l) => /BFM ERROR/.test(l));
  if (scenarioErrors.length) diagnostics.push({ code: 'sim/scenario-failed', severity: 'error', message: `the scenario did not run as scripted: ${scenarioErrors[0].replace(/^.*BFM ERROR:\s*/, '')}${scenarioErrors.length > 1 ? ` (+${scenarioErrors.length - 1} more)` : ''}`, subject: {}, evidence: { errors: scenarioErrors.slice(0, 12) }, supportedFixes: ['check the scenario steps against the design documentation', 'raise the wait or poll limits'] });
  const failed = crashed || scenarioErrors.length > 0;
  const hashed = (files, role) => files.map((f) => ({ path: f, sha256: sha256File(f), role }));
  return {
    ok: !failed,
    vcd,
    diagnostics,
    log: runLog,
    timing: { build_ms: buildMs, run_ms: Date.now() - t1, vcd_bytes: fs.statSync(vcd).size },
    evidence: {
      simulator: { id: 'verilator', version: detected.version },
      top,
      stimulus: { kind: stimulusKind, files: hashed(stim, 'stimulus').map(({ path: p, sha256 }) => ({ path: p, sha256 })) },
      rtl_files: hashed(rtl, 'rtl').map(({ path: p, sha256 }) => ({ path: p, sha256 })),
      ...(Object.keys(defines).length ? { defines: Object.fromEntries(Object.entries(defines).map(([k, v]) => [k, String(v)])) } : {}),
      ...(Object.keys(params).length ? { params } : {}),
      vcd_sha256: sha256File(vcd),
    },
  };
}
