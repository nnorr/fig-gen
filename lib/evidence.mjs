// Evidence guard (SPEC §12.2, hard rule): a figure may only be verified
// against the user's own RTL / docs / VCDs. Evidence inside the fig-gen
// installation (skill files, tests/fixtures) or inside a fig-gen work
// directory (tool- or agent-generated files) is rejected with
// evidence/self-authored. Every accepted evidence file is recorded with its
// path, content hash and git origin.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostic } from './diagnostics.mjs';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORK_MARKER = '.figgen-work';

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const inside = (child, parent) => {
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function markWorkDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, WORK_MARKER), 'fig-gen work directory: tool/agent-generated files. Never evidence.\n');
}

// Reason string when a path may not serve as evidence, else null.
export function selfAuthoredReason(file, { workDirs = [] } = {}) {
  const abs = real(file);
  if (inside(abs, SKILL_ROOT)) return 'it is inside the fig-gen installation (skill files or tests/fixtures)';
  for (const w of workDirs.filter(Boolean)) if (inside(abs, w)) return 'it is inside a fig-gen work directory (tool/agent-generated)';
  for (let dir = path.dirname(abs), guard = 0; guard < 64; guard += 1) {
    if (fs.existsSync(path.join(dir, WORK_MARKER))) return 'it is inside a fig-gen work directory (tool/agent-generated)';
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function gitOrigin(file) {
  const dir = path.dirname(real(file));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) return null;
  const root = top.stdout.trim();
  const rev = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain', '--', real(file)]);
  return { root, revision: rev.status === 0 ? rev.stdout.trim() : null, dirty: status.status === 0 ? status.stdout.trim().length > 0 : null };
}

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function checkRtlInputs(files, { workDirs = [] } = {}) {
  const diagnostics = [];
  for (const f of files) {
    const reason = selfAuthoredReason(f, { workDirs });
    if (reason) diagnostics.push(diagnostic({ code: 'evidence/self-authored', message: `${f} cannot be RTL evidence: ${reason}`, subject: { file: f }, supportedFixes: ['point check-rtl at the user\'s own RTL repository', 'leave the region unverified'] }));
  }
  return diagnostics;
}

// Validate the origin of every input of a normalized netlist.
export function checkNetlistEvidence(netlist) {
  const diagnostics = [];
  const evidence = [];
  const add = (code, message, subject, severity = 'error', supportedFixes = []) => diagnostics.push(diagnostic({ code, severity, message, subject, supportedFixes }));
  const files = netlist.inputs?.files || [];
  const sourceRoot = netlist.inputs?.source_root;
  const workDirs = [netlist.inputs?.work_dir];
  if (!files.some((f) => f.role === 'rtl')) add('evidence/origin-unknown', 'the netlist does not record its RTL input files', {}, 'error', ['re-run check-rtl with this version of fig-gen']);
  for (const f of files) {
    if (f.role !== 'rtl') {
      evidence.push({ role: f.role, path: f.path, sha256: f.sha256, repository: null });
      continue;
    }
    const abs = path.isAbsolute(f.path) ? f.path : (sourceRoot ? path.resolve(sourceRoot, f.path) : null);
    if (!abs) { add('evidence/origin-unknown', `${f.path}: relative path without inputs.source_root`, { file: f.path }, 'error', ['re-run check-rtl with --source-root']); continue; }
    const reason = selfAuthoredReason(abs, { workDirs });
    if (reason) { add('evidence/self-authored', `${abs} cannot be RTL evidence: ${reason}`, { file: abs }, 'error', ['extract the netlist from the user\'s own RTL', 'leave the region unverified']); continue; }
    if (!fs.existsSync(abs)) { add('evidence/missing', `${abs} no longer exists`, { file: abs }, 'error', ['re-run check-rtl']); continue; }
    if (sha256File(abs) !== f.sha256) { add('evidence/stale', `${abs} changed after the netlist was extracted`, { file: abs }, 'error', ['re-run check-rtl']); continue; }
    const origin = gitOrigin(abs);
    if (!origin) add('evidence/untracked', `${abs} is not in a git repository; no revision can be recorded`, { file: abs }, 'warning');
    else if (origin.dirty) add('evidence/uncommitted', `${abs} has uncommitted changes relative to ${origin.revision?.slice(0, 12)}`, { file: abs }, 'warning');
    evidence.push({ role: 'rtl', path: abs, sha256: f.sha256, repository: origin });
  }
  return { diagnostics, evidence };
}
