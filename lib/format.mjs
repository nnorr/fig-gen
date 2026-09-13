// Output formats (SPEC §9.6). `paper` (the default) delivers the column
// variants of a print profile. `study` delivers one figure sized to its
// content, for analysing RTL: no column width, no maximum height, no 1col/2col,
// nothing collapsed or split for size.
//
// Study keeps every correctness check (schema, coverage within scope, latency,
// RTL cross-check, connectivity, bubbles, dot clearance, stroke uniformity,
// glyph distinguishability, evidence rules). It relaxes only the checks that
// exist because a figure must fit a printed column. PAPER_ONLY_CHECKS is the
// one list of those checks and their study treatment; nothing else relaxes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FORMATS = Object.freeze(['paper', 'study']);
export const DEFAULT_FORMAT = 'paper';
export const STUDY_PROFILE_FILE = path.join(root, 'profiles', 'study-profile.json');

// study: 'skip' (not reported) or 'warning' (reported, never blocks delivery)
export const PAPER_ONLY_CHECKS = Object.freeze([
  { code: 'print/width-overflow', study: 'skip', reason: 'no column width: the canvas is sized to the content' },
  { code: 'print/max-height', study: 'skip', reason: 'no maximum height' },
  { code: 'deliver/does-not-fit', study: 'skip', reason: 'nothing has to fit, so nothing is collapsed or split for size' },
  { code: 'print/label-fallback', study: 'skip', reason: 'full labels are always used' },
  { code: 'print/variant-not-requested', study: 'skip', reason: 'one study variant, no 1col/2col' },
  { code: 'variant/1col-skipped', study: 'skip', reason: 'no 1col variant' },
  { code: 'print/small-font', study: 'skip', reason: 'the 7 pt recommendation is for printed columns' },
  { code: 'view/detail-collapsed', study: 'skip', reason: 'full hierarchy and detail are allowed; nothing is collapsed for size' },
  { code: 'route/crossings', study: 'skip', reason: 'crossing thresholds are print legibility targets' },
  { code: 'print/min-font', study: 'warning', reason: 'the printed font floor is measured against a column' },
  { code: 'print/min-stroke', study: 'warning', reason: 'the printed stroke floor is a print constraint' },
  { code: 'label/unreadable', study: 'warning', reason: 'RTL names are acceptable while analysing the RTL' },
  { code: 'view/caption', study: 'warning', reason: 'a study figure has no paper caption' },
]);
const BY_CODE = new Map(PAPER_ONLY_CHECKS.map((c) => [c.code, c]));

export const paperOnly = (code) => BY_CODE.get(code) ?? null;

// The CLI flag wins over meta.print.format; the default is paper.
export function resolveFormat(doc, cli) {
  const requested = cli ?? doc?.meta?.print?.format ?? DEFAULT_FORMAT;
  if (FORMATS.includes(requested)) return { format: requested, diagnostics: [] };
  return {
    format: DEFAULT_FORMAT,
    diagnostics: [{ code: 'format/unknown', severity: 'error', message: `unknown format '${requested}'; use ${FORMATS.join(' or ')}`, subject: {}, evidence: { requested }, supportedFixes: ['--format paper', '--format study'] }],
  };
}

// Apply the study treatment to a diagnostics array in place and count what was
// relaxed per code. Paper leaves the array untouched.
export function relaxDiagnostics(list, format, tally = new Map()) {
  if (format !== 'study') return tally;
  const bump = (code, treatment) => {
    const t = tally.get(code) ?? { code, treatment, count: 0 };
    t.count += 1;
    tally.set(code, t);
  };
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const d = list[i];
    const rule = BY_CODE.get(d.code);
    if (!rule || d.format_relaxed) continue;
    if (rule.study === 'skip') {
      list.splice(i, 1);
      bump(d.code, 'skip');
    } else if (d.severity === 'error') {
      list[i] = { ...d, severity: 'warning', format_relaxed: 'study' };
      bump(d.code, 'warning');
    }
  }
  return tally;
}

// Receipt block: the format, its profile and the paper checks not applied.
export function formatReceipt(format, tally, profile) {
  if (format !== 'study') return { name: format, profile, skipped_checks: [], downgraded_checks: [], relaxed: [] };
  return {
    name: 'study',
    profile,
    skipped_checks: PAPER_ONLY_CHECKS.filter((c) => c.study === 'skip').map((c) => c.code),
    downgraded_checks: PAPER_ONLY_CHECKS.filter((c) => c.study === 'warning').map((c) => c.code),
    relaxed: [...tally.values()].sort((a, b) => a.code.localeCompare(b.code)),
  };
}

export const loadStudyProfile = () => JSON.parse(fs.readFileSync(STUDY_PROFILE_FILE, 'utf8'));

// A copy of the figure with meta.print.format set (used by `draft --format`).
export function withFormat(doc, format) {
  const out = structuredClone(doc);
  out.meta = out.meta || {};
  out.meta.print = { ...(out.meta.print || {}), format };
  return out;
}
