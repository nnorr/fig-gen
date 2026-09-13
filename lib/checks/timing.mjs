// Timing figure checks on the WaveJSON (SPEC §6.2): periodic clocks, equal
// lane lengths, bus data counts and widths, drawn latencies against declared
// cycles (and against the register stages of a referenced datapath figure),
// valid/ready handshake rules, the supported WaveJSON subset, and readable
// printed lane names.

import fs from 'node:fs';
import path from 'node:path';
import { diagnostic } from '../diagnostics.mjs';
import { readableIdentifier, unreadableReason } from './labels.mjs';

const CLOCK_CHARS = new Set(['p', 'n', 'P', 'N']);
const VALUE_CHARS = new Set(['=', '2', '3', '4', '5', '6', '7', '8', '9']);
const HIGH = new Set(['1', 'h', 'H']);
const LOW = new Set(['0', 'l', 'L']);

// Every lane object with its group path, in drawing order (spacers skipped).
export function lanesOf(wavejson) {
  const out = [];
  const visit = (items, group) => {
    for (const item of items || []) {
      if (Array.isArray(item)) visit(item.slice(1), [...group, String(item[0] ?? '')]);
      else if (item && typeof item === 'object' && typeof item.wave === 'string') out.push({ lane: item, group });
    }
  };
  visit(wavejson?.signal, []);
  return out;
}

// One entry per cycle position: the wave character that starts or continues it.
// `period` repeats each character (period 2: "p." spans 4 cycles).
export function expandWave(lane) {
  const period = Number.isFinite(lane.period) && lane.period > 0 ? lane.period : 1;
  const cells = [];
  for (const c of String(lane.wave)) for (let k = 0; k < period; k += 1) cells.push(k === 0 ? c : '.');
  return cells;
}

// Cycle index of each node letter (aligned with the wave characters, times period).
export function nodeCycles(lane) {
  const period = Number.isFinite(lane.period) && lane.period > 0 ? lane.period : 1;
  const map = new Map();
  [...String(lane.node || '')].forEach((c, i) => { if (c !== '.') map.set(c, i * period); });
  return map;
}

// Data entries of a bus lane (array, or space-separated string).
export const dataEntries = (lane) => (Array.isArray(lane.data) ? lane.data.map(String) : typeof lane.data === 'string' ? lane.data.trim().split(/\s+/).filter(Boolean) : []);

// The name a lane prints: an explicit signals.<name>.label, the short name in
// short mode, else the RTL-ish name made readable (never a raw id).
export function laneName(doc, name, { mode = 'full' } = {}) {
  if (name === undefined || name === null || name === '') return '';
  const meta = doc.signals?.[name] || {};
  if (mode === 'short' && meta.short_name) return meta.short_name;
  if (meta.label) return meta.label;
  return readableIdentifier(name);
}

// Numeric value of a data label (0x1F, 31, 8'h1f, 'd12), or null for a symbolic label.
export function literalNumber(text) {
  const s = String(text).trim().replace(/_/g, '');
  let m = /^0[xX]([0-9a-fA-F]+)$/.exec(s);
  if (m) return BigInt(`0x${m[1]}`);
  m = /^\d+$/.exec(s);
  if (m) return BigInt(s);
  m = /^(\d+)?'[sS]?([bBoOdDhH])([0-9a-fA-F]+)$/.exec(s);
  if (m) {
    const base = { b: 2, o: 8, d: 10, h: 16 }[m[2].toLowerCase()];
    return [...m[3].toLowerCase()].reduce((acc, ch) => acc * BigInt(base) + BigInt(parseInt(ch, 16)), 0n);
  }
  return null;
}

// Level per cycle for a bit lane: 1, 0, or null (x, z, value, unknown).
export function levels(lane) {
  const out = [];
  let prev = null;
  for (const c of expandWave(lane)) {
    if (c === '.' || c === '|') out.push(prev);
    else if (HIGH.has(c) || c === 'P' || c === 'p') { prev = 1; out.push(1); }
    else if (LOW.has(c) || c === 'N' || c === 'n') { prev = 0; out.push(0); }
    else { prev = null; out.push(null); }
  }
  return out;
}

// Index of the data segment each cycle shows (changes at =, 2-9 and x/z).
function segments(lane) {
  const out = [];
  let seg = -1;
  for (const c of expandWave(lane)) {
    if (VALUE_CHARS.has(c) || c === 'x' || c === 'z' || c === 'u' || c === 'd') seg += 1;
    out.push(seg);
  }
  return out;
}

// Register stages on the shortest drawn path between two datapath endpoints
// (pipeline and plain registers, and registered port latencies), or null.
export function datapathStages(dp, from, to) {
  const elementOf = (ep) => String(ep).split('.')[0];
  const byId = new Map((dp.elements || []).map((e) => [e.id, e]));
  const stageOf = (e) => {
    if (!e) return 0;
    if (e.kind === 'pipeline_register' || e.kind === 'register') return 1;
    return 0;
  };
  const adj = new Map();
  for (const n of dp.nets || []) {
    const a = elementOf(n.driver);
    for (const s of n.sinks || []) {
      const b = elementOf(s);
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    }
  }
  const src = elementOf(from);
  const dst = elementOf(to);
  const dist = new Map([[src, 0]]);
  const deque = [src];
  while (deque.length) {
    const u = deque.shift();
    for (const v of adj.get(u) || []) {
      const w = dist.get(u) + stageOf(byId.get(v));
      if (!dist.has(v) || w < dist.get(v)) {
        dist.set(v, w);
        if (stageOf(byId.get(v))) deque.push(v); else deque.unshift(v);
      }
    }
  }
  if (!dist.has(dst)) return null;
  // the destination register itself is the last stage only if the path ends at its output
  return dist.get(dst) - (String(to).includes('.') && /^(q|q_.*|out)$/.test(String(to).split('.')[1]) ? 0 : 0);
}

// figureDir: the figure's directory; datapath_ref figures are resolved against
// it, and are not checked without it (validate on a document with no path).
export function checkTiming(doc, { figureDir, quality } = {}) {
  const diagnostics = [];
  const add = (code, message, subject = {}, evidence = {}, supportedFixes = [], severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  const wj = doc.wavejson || {};
  const lanes = lanesOf(wj);
  const byName = new Map();
  for (const { lane } of lanes) if (lane.name) byName.set(lane.name, lane);

  // Supported subset (SPEC §6.1): sub-cycle groups are not supported.
  for (const { lane } of lanes) {
    if (/[<>]/.test(lane.wave)) add('timing/wavejson-unsupported', `lane ${lane.name ?? '(unnamed)'}: sub-cycle groups (< >) are not in the supported WaveJSON subset`, { lane: lane.name }, { wave: lane.wave }, ['write one character per cycle']);
  }

  // Equal lane lengths after period expansion.
  const lengths = lanes.map(({ lane }) => ({ name: lane.name ?? '(unnamed)', cycles: expandWave(lane).length }));
  const clockLane = doc.clock?.name ? byName.get(doc.clock.name) : null;
  const target = clockLane ? expandWave(clockLane).length : Math.max(0, ...lengths.map((l) => l.cycles));
  for (const l of lengths) {
    if (l.cycles !== target) add('timing/wave-length', `lane ${l.name} spans ${l.cycles} cycles; the figure spans ${target}`, { lane: l.name }, { cycles: l.cycles, expected: target }, ['pad the wave with "." to the common length', 'trim the longer lanes']);
  }

  // Clocks are strictly periodic.
  const clockNames = new Set([...(doc.clock?.name ? [doc.clock.name] : []), ...lanes.filter(({ lane }) => [...lane.wave].some((c) => CLOCK_CHARS.has(c))).map(({ lane }) => lane.name)]);
  for (const name of clockNames) {
    const lane = byName.get(name);
    if (!lane) { add('timing/clock-irregular', `clock ${name} has no lane`, { lane: name }, {}, ['add the clock lane', 'fix clock.name']); continue; }
    const chars = [...lane.wave];
    const first = chars[0];
    const bad = !CLOCK_CHARS.has(first) || chars.slice(1).some((c) => c !== '.' && c !== '|' && c !== first);
    if (bad) add('timing/clock-irregular', `clock lane ${name} is not strictly periodic ("${lane.wave}"): a clock is one of p n P N followed only by "."`, { lane: name }, { wave: lane.wave }, [`write the clock as "${CLOCK_CHARS.has(first) ? first : 'p'}${'.'.repeat(Math.max(0, chars.length - 1))}"`]);
  }

  // Bus values: one data entry per value-starting character, and values fit the width.
  for (const { lane } of lanes) {
    const starts = [...lane.wave].filter((c) => VALUE_CHARS.has(c)).length;
    const data = dataEntries(lane);
    if (starts !== data.length && (starts || data.length)) add('timing/bus-data-count', `lane ${lane.name ?? '(unnamed)'}: ${starts} value start(s) (= or 2-9) but ${data.length} data entr${data.length === 1 ? 'y' : 'ies'}`, { lane: lane.name }, { starts, data: data.length }, ['give one data entry per value start', 'use "." to continue a value']);
    const width = doc.signals?.[lane.name]?.width;
    if (Number.isInteger(width) && width > 0) {
      for (const d of data) {
        const v = literalNumber(d);
        if (v !== null && v >= (1n << BigInt(width))) add('timing/bus-width-overflow', `lane ${lane.name}: value ${d} does not fit ${width} bits`, { lane: lane.name }, { value: d, width }, [`use a value below 2^${width}`, 'correct signals.<name>.width']);
      }
    }
  }

  // Latencies: the cycle distance between an edge's node letters equals cycles;
  // with a datapath figure, cycles equals the register stages on that path.
  const nodeAt = new Map();
  for (const { lane } of lanes) for (const [letter, cycle] of nodeCycles(lane)) nodeAt.set(letter, { cycle, lane: lane.name });
  let latenciesChecked = 0;
  for (const lat of doc.latencies || []) {
    const m = /^([A-Za-z0-9])\s*[-~<>|+]+\s*([A-Za-z0-9])$/.exec(lat.edge);
    const [a, b] = m ? [nodeAt.get(m[1]), nodeAt.get(m[2])] : [null, null];
    const drawn = (wj.edge || []).some((e) => new RegExp(`^\\s*${m?.[1]}\\s*[-~<>|+]+\\s*${m?.[2]}(\\s|$)`).test(e));
    if (!m || !a || !b) { add('timing/latency-mismatch', `latency ${lat.edge}: node ${!a ? m?.[1] : m?.[2]} is not placed on any lane`, { edge: lat.edge }, {}, ['place the node letters in the lanes\' node strings']); continue; }
    if (!drawn) add('timing/latency-mismatch', `latency ${lat.edge} has no drawn edge in wavejson.edge`, { edge: lat.edge }, {}, [`add "${lat.edge} ${lat.cycles} cycles" to wavejson.edge`]);
    latenciesChecked += 1;
    const distance = b.cycle - a.cycle;
    if (distance !== lat.cycles) add('timing/latency-mismatch', `latency ${lat.edge}: the nodes are ${distance} cycle(s) apart (${a.lane} cycle ${a.cycle} → ${b.lane} cycle ${b.cycle}); declared ${lat.cycles}`, { edge: lat.edge }, { drawn: distance, declared: lat.cycles }, ['move the node letter to the right cycle', 'correct cycles']);
    if (lat.datapath_ref && figureDir) {
      const file = path.resolve(figureDir, lat.datapath_ref.figure);
      if (!fs.existsSync(file)) { add('timing/latency-mismatch', `latency ${lat.edge}: datapath figure ${lat.datapath_ref.figure} not found`, { edge: lat.edge }, { figure: lat.datapath_ref.figure }, ['fix datapath_ref.figure']); continue; }
      const dp = JSON.parse(fs.readFileSync(file, 'utf8'));
      const stages = datapathStages(dp, lat.datapath_ref.from, lat.datapath_ref.to);
      if (stages === null) add('timing/latency-mismatch', `latency ${lat.edge}: no drawn path from ${lat.datapath_ref.from} to ${lat.datapath_ref.to} in ${lat.datapath_ref.figure}`, { edge: lat.edge }, {}, ['fix datapath_ref.from/to']);
      else if (stages !== lat.cycles) add('timing/latency-mismatch', `latency ${lat.edge}: ${lat.cycles} cycle(s) declared, but ${lat.datapath_ref.figure} has ${stages} register stage(s) from ${lat.datapath_ref.from} to ${lat.datapath_ref.to}`, { edge: lat.edge }, { declared: lat.cycles, stages }, ['correct cycles', 'check the datapath figure']);
    }
  }

  // Handshakes (warnings): valid stays high, and data stays stable, until the transfer.
  for (const hs of doc.handshakes || []) {
    const vLane = byName.get(hs.valid);
    const rLane = byName.get(hs.ready);
    if (!vLane || !rLane) { add('timing/handshake-violation', `handshake ${hs.valid}/${hs.ready}: ${!vLane ? hs.valid : hs.ready} has no lane`, { valid: hs.valid, ready: hs.ready }, {}, ['name existing lanes'], 'warning'); continue; }
    const v = levels(vLane);
    const r = levels(rLane);
    const dLane = hs.data ? byName.get(hs.data) : null;
    const seg = dLane ? segments(dLane) : null;
    let waiting = null;
    for (let k = 0; k < v.length; k += 1) {
      if (waiting !== null) {
        if (v[k] !== 1) { add('timing/handshake-violation', `handshake ${hs.valid}/${hs.ready}: ${hs.valid} drops at cycle ${k} before ${hs.ready} accepts (valid since cycle ${waiting})`, { valid: hs.valid, ready: hs.ready }, { cycle: k, since: waiting }, ['keep valid high until ready is high'], 'warning'); waiting = null; }
        else if (seg && seg[k] !== seg[k - 1]) { add('timing/handshake-violation', `handshake ${hs.valid}/${hs.ready}: ${hs.data} changes at cycle ${k} while waiting for ${hs.ready}`, { valid: hs.valid, ready: hs.ready, data: hs.data }, { cycle: k }, ['hold data stable until the transfer'], 'warning'); }
      }
      if (v[k] === 1 && r[k] === 1) { waiting = null; continue; }
      if (v[k] === 1 && waiting === null) waiting = k;
    }
  }

  // Printed lane names are readable (warning; error with --quality paper).
  const severity = quality === 'paper' ? 'error' : 'warning';
  for (const { lane } of lanes) {
    if (!lane.name) continue;
    const printed = laneName(doc, lane.name);
    const reason = unreadableReason(printed);
    if (reason) add('label/unreadable', `lane ${lane.name}: printed name "${printed}" is not a readable name (${reason})`, { lane: lane.name }, { printed, reason }, [`add signals.${lane.name}.label with a readable name`], severity);
  }

  return { diagnostics, report: { lanes: lanes.length, cycles: target, latencies_checked: latenciesChecked, handshakes_checked: (doc.handshakes || []).length } };
}
