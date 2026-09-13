// Verification level of a timing figure (SPEC §6.6), computed from evidence in
// this run, never authored:
// - simulated: the lanes are exactly what vcd2wave generated (lanes hash
//   matches provenance.generator.lanes_sha256) and the VCD on disk still has
//   the recorded hash;
// - sim-compared: provenance.compare_vcd diffed cycle by cycle with 0 mismatches;
// - otherwise unverified, with the reason. A failing compare is unverified
//   (with the mismatches), never structural-only.
// A caption or meta field that claims more than the computed level is
// receipt/level-overclaim.
//
// verifyTiming(doc, { figureDir }) -> { level, reason?, evidence: { simulation?, compare? }, diagnostics }

import fs from 'node:fs';
import path from 'node:path';
import { compareTiming } from './compare.mjs';
import { lanesSha256, sha256File } from './vcd2wave.mjs';

const RANK = { unverified: 0, 'structural-only': 1, 'sim-compared': 2, simulated: 2 };

// Levels a caption or meta field claims ("simulated", "sim-compared", "verified against simulation").
export function claimedLevel(doc) {
  const text = [doc.meta?.caption, doc.meta?.title, doc.meta?.verification, doc.meta?.claim].filter(Boolean).join(' ').toLowerCase();
  if (/\bsim(ulation)?[- ]compared\b|compared (cycle by cycle )?(against|with) (a |the )?simulation/.test(text)) return 'sim-compared';
  if (/\bsimulated\b|\bfrom (a |the )?simulation\b|\bsimulation[- ]grounded\b/.test(text)) return 'simulated';
  if (/\bstructural(ly)?[- ]?(checked|verified|only)\b/.test(text)) return 'structural-only';
  return null;
}

const resolve = (figureDir, p) => (p ? (path.isAbsolute(p) ? p : path.resolve(figureDir ?? '.', p)) : null);

function simulationEvidence(doc, generatedHash) {
  const prov = doc.provenance || {};
  const sim = prov.simulation || {};
  const lanes = Object.entries(prov.rtl_map || {}).map(([lane, rtl_path]) => ({ lane, rtl_path }));
  const missing = [];
  if (!sim.simulator) missing.push('simulator');
  if (!sim.top) missing.push('top');
  if (!sim.stimulus?.files?.length) missing.push('stimulus files');
  if (!sim.rtl_files?.length) missing.push('RTL files');
  if (!prov.vcd_sha256) missing.push('VCD hash');
  if (!prov.clock) missing.push('clock path');
  if (!Number.isInteger(prov.first_cycle) || !Number.isInteger(prov.cycles)) missing.push('cycle window');
  if (!lanes.length) missing.push('lane map');
  if (missing.length) return { missing };
  return {
    evidence: {
      simulator: sim.simulator,
      top: sim.top,
      stimulus: { kind: sim.stimulus.kind, files: sim.stimulus.files.map(({ path: p, sha256 }) => ({ path: p, sha256 })) },
      rtl_files: sim.rtl_files.map(({ path: p, sha256 }) => ({ path: p, sha256 })),
      ...(sim.defines && Object.keys(sim.defines).length ? { defines: sim.defines } : {}),
      ...(sim.params && Object.keys(sim.params).length ? { params: sim.params } : {}),
      vcd_sha256: prov.vcd_sha256,
      clock: { path: prov.clock, edge: doc.clock?.edge ?? 'pos' },
      window: { first_cycle: prov.first_cycle, cycles: prov.cycles },
      signals: lanes,
      ...(generatedHash ? { generated_wavejson_sha256: generatedHash } : {}),
    },
  };
}

// Files recorded with a hash must still match on disk when they exist.
function staleFiles(doc, figureDir) {
  const sim = doc.provenance?.simulation || {};
  const out = [];
  for (const f of [...(sim.rtl_files || []), ...(sim.stimulus?.files || [])]) {
    const p = resolve(figureDir, f.path);
    if (p && fs.existsSync(p) && sha256File(p) !== f.sha256) out.push(f.path);
  }
  return out;
}

export async function verifyTiming(doc, { figureDir } = {}) {
  const diagnostics = [];
  const prov = doc.provenance || {};
  const finish = (result) => {
    const claim = claimedLevel(doc);
    if (claim && RANK[claim] > RANK[result.level]) {
      diagnostics.push({ code: 'receipt/level-overclaim', severity: 'error', message: `the figure text claims "${claim}" but the evidence in this run supports only ${result.level}${result.reason ? ` (${result.reason})` : ''}`, subject: {}, evidence: { claimed: claim, computed: result.level }, supportedFixes: ['remove the claim from the caption', 'regenerate the lanes from the simulation (fig-gen vcd2wave)', 'add provenance.compare_vcd and fix the mismatches'] });
    }
    return { ...result, diagnostics };
  };
  if (!prov.kind || prov.kind === 'hand') {
    if (prov.compare_vcd) return finish(await compared(doc, figureDir, diagnostics));
    return finish({ level: 'unverified', reason: 'hand-drawn waveform with no simulation to compare against', evidence: {} });
  }
  if (prov.kind === 'vcd') {
    const generated = prov.generator?.lanes_sha256;
    const actual = lanesSha256(doc.wavejson);
    const vcdPath = resolve(figureDir, prov.vcd);
    const vcdOk = vcdPath && fs.existsSync(vcdPath) ? sha256File(vcdPath) === prov.vcd_sha256 : null;
    const stale = staleFiles(doc, figureDir);
    if (generated && generated === actual && vcdOk !== false && !stale.length) {
      const ev = simulationEvidence(doc, generated);
      if (ev.missing) return finish({ level: 'unverified', reason: `simulation evidence incomplete: ${ev.missing.join(', ')}`, evidence: {} });
      return finish({ level: 'simulated', evidence: { simulation: ev.evidence } });
    }
    const why = !generated ? 'lanes carry no generator hash' : generated !== actual ? 'lanes were edited after vcd2wave generated them' : vcdOk === false ? 'the VCD on disk no longer matches the recorded hash' : `recorded files changed: ${stale.join(', ')}`;
    if (prov.compare_vcd) {
      const r = await compared(doc, figureDir, diagnostics);
      if (r.level === 'sim-compared') return finish(r);
      return finish({ ...r, reason: `${why}; ${r.reason}` });
    }
    if (generated && generated !== actual) diagnostics.push({ code: 'timing/lanes-edited', severity: 'warning', message: `${why}; the figure is not simulated. Regenerate it, or set provenance.compare_vcd to sim-compare the edited lanes`, subject: {}, evidence: { generated, actual }, supportedFixes: ['regenerate with fig-gen vcd2wave', 'set provenance.compare_vcd'] });
    return finish({ level: 'unverified', reason: why, evidence: {} });
  }
  return finish({ level: 'unverified', reason: `unknown provenance kind ${prov.kind}`, evidence: {} });
}

async function compared(doc, figureDir, diagnostics) {
  const prov = doc.provenance;
  const vcd = resolve(figureDir, prov.compare_vcd);
  if (!vcd || !fs.existsSync(vcd)) {
    diagnostics.push({ code: 'timing/compare-unmapped', severity: 'error', message: `provenance.compare_vcd ${prov.compare_vcd} does not exist`, subject: {}, evidence: {}, supportedFixes: ['point compare_vcd at the simulation VCD'] });
    return { level: 'unverified', reason: 'compare VCD missing', evidence: {} };
  }
  const { report, diagnostics: found } = compareTiming(doc, vcd);
  diagnostics.push(...found);
  const compareEvidence = { compared_cells: report.compared_cells, dont_care_cells: report.dont_care_cells, skipped_symbolic_values: report.skipped_symbolic_values, value_map_used: report.value_map_used, mismatches: report.mismatches };
  if (found.some((d) => d.severity === 'error')) {
    return { level: 'unverified', reason: report.mismatches.length ? `sim-compare found ${report.mismatches.length} mismatch(es)` : 'sim-compare could not run', evidence: { failed: { compare: compareEvidence, unmapped: report.unmapped } } };
  }
  if (!report.compared_cells) return { level: 'unverified', reason: 'sim-compare compared no cells', evidence: {} };
  const vcdHash = sha256File(vcd);
  const ev = simulationEvidence({ ...doc, provenance: { ...prov, vcd_sha256: prov.vcd_sha256 ?? vcdHash, first_cycle: prov.first_cycle ?? report.offset ?? 0, cycles: prov.cycles ?? Math.max(...flattenCount(doc)) } }, null);
  if (ev.missing) return { level: 'unverified', reason: `sim-compare passed but simulation evidence is incomplete: ${ev.missing.join(', ')}`, evidence: {} };
  if (ev.evidence.vcd_sha256 !== vcdHash) ev.evidence.vcd_sha256 = vcdHash;
  return { level: 'sim-compared', evidence: { simulation: ev.evidence, compare: compareEvidence } };
}

function flattenCount(doc) {
  const lens = [];
  const walk = (items) => { for (const it of items || []) { if (Array.isArray(it)) walk(it.slice(1)); else if (it?.wave) lens.push(it.wave.length); } };
  walk(doc.wavejson?.signal);
  return lens.length ? lens : [1];
}
