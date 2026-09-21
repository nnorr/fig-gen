// sim-compare (SPEC §6.6, sim-compared semantics): a hand-authored or edited
// WaveJSON diffed cycle by cycle against a VCD of the same scenario.
//
// - provenance.rtl_map maps each lane name to a hierarchical path; an unmapped
//   lane is timing/compare-unmapped unless listed in provenance.compare.ignore.
// - The named clock (clock.name -> rtl_map, else provenance.clock) defines the
//   cycles; cycle k is sampled pre-edge. provenance.first_cycle aligns drawn
//   cycle 0 to a VCD cycle, or compare.align_on aligns a drawn event with the
//   same event in the VCD.
// - Drawn x is don't-care; '.' holds the previous drawn value; '|' is skipped.
// - Bit lanes compare levels (0/l/L, 1/h/H, z). Bus lanes compare numeric data
//   labels (0x1F, 31, 8'h1f) numerically; a symbolic label is skipped unless
//   compare.values maps it, but a drawn value change where the VCD has none (or
//   the reverse) is still a mismatch.
//
// compareTiming(doc, vcdFile) -> { report, diagnostics }
//   report: { compared_cells, dont_care_cells, skipped_cells, skipped_symbolic_values,
//             value_map_used, mismatches: [{ lane, cycle, drawn, simulated }], unmapped, offset }

import { edgesOf, matchingSignals, readVcd, valueBefore } from './vcd.mjs';
import { eventCycle } from './vcd2wave.mjs';

const LEVEL = { 0: '0', l: '0', L: '0', 1: '1', h: '1', H: '1', z: 'z', x: 'x', u: 'x', d: 'x' };

// Flatten WaveJSON signal groups into lanes with names.
export function flattenLanes(signal) {
  const out = [];
  const walk = (items) => {
    for (const it of items || []) {
      if (Array.isArray(it)) walk(it.slice(1));
      else if (it && typeof it === 'object' && typeof it.wave === 'string') out.push(it);
    }
  };
  walk(signal);
  return out;
}

const isClockWave = (wave) => /[pnPN]/.test(wave);

// Drawn value per cycle: { kind: 'level'|'value'|'x'|'z'|'skip', v, label, change }.
export function drawnCycles(lane) {
  const period = Number.isFinite(lane.period) && lane.period > 1 ? Math.round(lane.period) : 1;
  const data = Array.isArray(lane.data) ? lane.data : typeof lane.data === 'string' ? lane.data.trim().split(/\s+/) : [];
  let di = 0;
  const cells = [];
  let prev = { kind: 'x', v: null, change: false };
  for (const c of lane.wave) {
    let cell;
    if (c === '.') cell = { ...prev, change: false };
    else if (c === '|') cell = { kind: 'skip', change: false };
    else if (c === '=' || /[2-9]/.test(c)) cell = { kind: 'value', label: data[di++] ?? '', change: true };
    else if (LEVEL[c] === 'x') cell = { kind: 'x', change: true };
    else if (LEVEL[c] === 'z') cell = { kind: 'z', change: true };
    else if (LEVEL[c] !== undefined) cell = { kind: 'level', v: LEVEL[c], change: prev.kind !== 'level' || prev.v !== LEVEL[c] };
    else cell = { kind: 'x', change: true };
    for (let r = 0; r < period; r += 1) cells.push(r ? { ...cell, change: false } : cell);
    if (cell.kind !== 'skip') prev = cell;
  }
  return cells;
}

// A data label as a number, or null when symbolic.
export function literalNumber(label) {
  const s = String(label).trim().replace(/_/g, '');
  let m;
  if ((m = /^0x([0-9a-f]+)$/i.exec(s))) return BigInt(`0x${m[1]}`);
  if ((m = /^0b([01]+)$/i.exec(s))) return BigInt(`0b${m[1]}`);
  if (/^\d+$/.test(s)) return BigInt(s);
  if ((m = /^\d*'[sS]?([bdhoBDHO])([0-9a-fA-F]+)$/.exec(s))) {
    const base = { b: 2, d: 10, h: 16, o: 8 }[m[1].toLowerCase()];
    return base === 10 ? BigInt(m[2]) : base === 16 ? BigInt(`0x${m[2]}`) : base === 2 ? BigInt(`0b${m[2]}`) : BigInt(`0o${m[2]}`);
  }
  return null;
}

const simText = (bits) => (bits === null ? 'no sample' : /[xz]/.test(bits) ? bits.replace(/^0+(?=.)/, '') : `0x${BigInt(`0b${bits}`).toString(16).toUpperCase()}`);

export function compareTiming(doc, vcdFile) {
  const diagnostics = [];
  const prov = doc.provenance || {};
  const cmp = prov.compare || {};
  const ignore = new Set(cmp.ignore || []);
  const rtlMap = prov.rtl_map || {};
  const lanes = flattenLanes(doc.wavejson?.signal);
  const clockName = doc.clock?.name;
  const clockPath = (clockName && rtlMap[clockName]) || prov.clock;
  const edge = doc.clock?.edge ?? 'pos';
  const report = { compared_cells: 0, dont_care_cells: 0, skipped_cells: 0, skipped_symbolic_values: 0, value_map_used: false, mismatches: [], unmapped: [], offset: null };
  if (!clockPath) {
    diagnostics.push({ code: 'timing/compare-unmapped', severity: 'error', message: `the clock ${clockName ?? '(none)'} has no RTL path: set provenance.rtl_map["${clockName ?? 'clk'}"] or provenance.clock`, subject: { lane: clockName ?? null }, evidence: {}, supportedFixes: ['map the clock lane in provenance.rtl_map'] });
    return { report, diagnostics };
  }
  const compared = lanes.filter((l) => l.name && !isClockWave(l.wave) && l.name !== clockName && !ignore.has(l.name));
  for (const l of compared) if (!rtlMap[l.name]) report.unmapped.push(l.name);
  for (const name of report.unmapped) diagnostics.push({ code: 'timing/compare-unmapped', severity: 'error', message: `lane ${name} has no RTL path in provenance.rtl_map`, subject: { lane: name }, evidence: {}, supportedFixes: [`map it: provenance.rtl_map["${name}"] = "<tb.dut.signal>"`, `list it in provenance.compare.ignore`] });
  const mapped = compared.filter((l) => rtlMap[l.name]);
  const paths = new Set([clockPath, ...mapped.map((l) => rtlMap[l.name])]);
  if (cmp.align_on && rtlMap[cmp.align_on.lane]) paths.add(rtlMap[cmp.align_on.lane]);
  const header = readVcd(vcdFile, { select: () => false });
  const resolved = new Map([...paths].map((p) => {
    const hits = matchingSignals(header.signals, p);
    return [p, hits.length === 1 ? hits[0].path : p];
  }));
  const keep = new Set(resolved.values());
  const dump = readVcd(vcdFile, { select: (p) => keep.has(p) });
  const declared = new Set(dump.signals.map((s) => s.path));
  for (const p of paths) {
    if (!declared.has(resolved.get(p))) diagnostics.push({ code: 'timing/compare-unmapped', severity: 'error', message: `RTL path ${p} is not in the VCD`, subject: { path: p }, evidence: {}, supportedFixes: ['correct provenance.rtl_map', 'dump that scope in the testbench'] });
  }
  if (diagnostics.some((d) => d.severity === 'error')) return { report, diagnostics };
  const edges = edgesOf(dump.changes.get(resolved.get(clockPath)) || [], edge);
  const sampleAt = (path, cycle) => {
    const at = edges[cycle + 1];
    return at === undefined ? null : valueBefore(dump.changes.get(resolved.get(path)) || [], at);
  };
  // Alignment: drawn cycle 0 = VCD cycle `offset`.
  let offset = prov.first_cycle ?? 0;
  if (cmp.align_on) {
    const lane = lanes.find((l) => l.name === cmp.align_on.lane);
    const path = rtlMap[cmp.align_on.lane];
    const drawn = lane ? drawnCycles(lane).map((c) => (c.kind === 'level' ? c.v : c.kind === 'value' ? c.label : c.kind)) : [];
    const d = eventCycle(drawn.map((v) => (v === '0' || v === '1' ? v : v === 'x' || v === 'skip' ? null : v)), cmp.align_on.event, cmp.align_on.occurrence ?? 1);
    const simSamples = Array.from({ length: Math.max(0, edges.length - 1) }, (_, k) => sampleAt(path, k));
    const v = eventCycle(simSamples, cmp.align_on.event, cmp.align_on.occurrence ?? 1);
    if (d === null || v === null) {
      diagnostics.push({ code: 'timing/diverges-from-simulation', severity: 'error', message: `align_on ${cmp.align_on.lane} ${cmp.align_on.event}: event ${d === null ? 'not drawn' : 'not in the VCD'}`, subject: { lane: cmp.align_on.lane }, evidence: { drawn_cycle: d, vcd_cycle: v }, supportedFixes: ['check the lane and event', 'use provenance.first_cycle'] });
      return { report, diagnostics };
    }
    offset = v - d;
  }
  report.offset = offset;
  for (const lane of mapped) {
    const path = rtlMap[lane.name];
    const cells = drawnCycles(lane);
    let prevSim = null;
    for (let k = 0; k < cells.length; k += 1) {
      const cell = cells[k];
      const sim = sampleAt(path, offset + k);
      const simChanged = k > 0 && prevSim !== null && sim !== prevSim;
      prevSim = sim;
      if (cell.kind === 'skip') { report.skipped_cells += 1; continue; }
      if (cell.kind === 'x') { report.dont_care_cells += 1; continue; }
      if (sim === null) {
        report.mismatches.push({ lane: lane.name, cycle: k, drawn: cell.kind === 'value' ? cell.label : cell.v ?? cell.kind, simulated: 'no sample (VCD ends)' });
        continue;
      }
      if (cell.kind === 'z') {
        report.compared_cells += 1;
        if (!/^z+$/.test(sim)) report.mismatches.push({ lane: lane.name, cycle: k, drawn: 'z', simulated: simText(sim) });
        continue;
      }
      if (cell.kind === 'level') {
        report.compared_cells += 1;
        const want = cell.v === '1' ? 1n : 0n;
        const got = /^[01]+$/.test(sim) ? BigInt(`0b${sim}`) : null;
        if (got === null || got !== want) report.mismatches.push({ lane: lane.name, cycle: k, drawn: cell.v, simulated: got === null ? sim : got.toString() });
        continue;
      }
      // bus value
      let label = cell.label;
      if (cmp.values?.[lane.name]?.[label] !== undefined) { label = cmp.values[lane.name][label]; report.value_map_used = true; }
      const n = literalNumber(label);
      const drawnChange = cell.change && k > 0;
      if (n === null) {
        report.skipped_symbolic_values += 1;
        if (k > 0 && drawnChange !== simChanged) {
          report.compared_cells += 1;
          report.mismatches.push({ lane: lane.name, cycle: k, drawn: drawnChange ? `new value ${cell.label}` : `${cell.label} held`, simulated: simChanged ? `changes to ${simText(sim)}` : `holds ${simText(sim)}` });
        }
        continue;
      }
      report.compared_cells += 1;
      const got = /^[01]+$/.test(sim) ? BigInt(`0b${sim}`) : null;
      if (got === null || got !== n) report.mismatches.push({ lane: lane.name, cycle: k, drawn: cell.label, simulated: simText(sim) });
    }
  }
  for (const m of report.mismatches) {
    diagnostics.push({ code: 'timing/sim-mismatch', severity: 'error', message: `${m.lane} @ cycle ${m.cycle}: drawn ${m.drawn}, simulated ${m.simulated}`, subject: { lane: m.lane, cycle: m.cycle }, evidence: { drawn: m.drawn, simulated: m.simulated, vcd_cycle: offset + m.cycle }, supportedFixes: ['correct the drawn wave', 'regenerate the lanes with fig-gen vcd2wave'] });
  }
  if (report.mismatches.length) {
    diagnostics.push({ code: 'timing/diverges-from-simulation', severity: 'error', message: `${report.mismatches.length} of ${report.compared_cells} compared cells differ from the simulation`, subject: {}, evidence: { mismatches: report.mismatches.length, compared: report.compared_cells }, supportedFixes: ['correct the drawn waves', 'regenerate the lanes with fig-gen vcd2wave'] });
  }
  return { report, diagnostics };
}
