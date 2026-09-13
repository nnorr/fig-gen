// vcd2wavejson (SPEC §6.5): a cycle window of selected signals from a VCD as a
// timing IR. Cycle k shows the value held immediately before active clock
// edge k+1 (pre-edge sampling), so combinational glitches never appear.
//
// vcdToTiming(vcdFile, {
//   clock: path or glob naming one 1-bit signal, edge: 'pos'|'neg',
//   signals: [paths or globs], from: first cycle (default 0),
//   alignOn: { path, event: 'rise'|'fall'|'change', occurrence: 1 },
//   cycles: n, radix: { <path or lane name>: 'hex'|'dec'|'bin'|'label' },
//   aliases: { <path>: 'lane name' }, netlist (for enum/localparam labels),
//   title, stimulus (provenance.stimulus), simulation (evidence to record)
// }) -> { doc, diagnostics }

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readableIdentifier } from '../checks/labels.mjs';
import { stateLabels } from '../draft-fsm.mjs';
import { edgesOf, globMatcher, readVcd, valueBefore } from './vcd.mjs';

export const GENERATOR_VERSION = '1';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const sha256File = (file) => sha256(fs.readFileSync(file));

// The lanes hash: canonical JSON of wavejson.signal, so any edit to a lane
// (wave, data, name) changes it.
export function lanesSha256(wavejson) {
  return sha256(Buffer.from(JSON.stringify(wavejson?.signal ?? [])));
}

const bitsToBigInt = (bits) => (/^[01]+$/.test(bits) ? BigInt(`0b${bits}`) : null);

export function formatValue(bits, width, radix, labels) {
  if (/z/.test(bits) && /^z+$/.test(bits)) return { kind: 'z' };
  if (/[xz]/.test(bits)) return { kind: 'x', partial: !/^[xz]+$/.test(bits) };
  const n = bitsToBigInt(bits);
  if (radix === 'label' && labels?.has(n)) return { kind: 'value', text: labels.get(n) };
  if (radix === 'dec') return { kind: 'value', text: n.toString(10) };
  if (radix === 'bin') return { kind: 'value', text: `0b${n.toString(2).padStart(width, '0')}` };
  return { kind: 'value', text: `0x${n.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0')}` };
}

// Enum / localparam value -> printed name for a signal, from a netlist: the
// net's declared `type` in any module whose name matches the path's last
// segment. Item names print readably by the same rule as FSM state labels:
// the prefix all items share is dropped (OwnerSqueeze -> "Squeeze").
function labelsFor(netlist, path) {
  if (!netlist) return null;
  const base = path.split('.').at(-1);
  for (const m of netlist.modules || []) {
    const net = (m.nets || []).find((n) => n.name === base && (n.type || n.enum));
    if (!net) continue;
    const items = net.enum?.items ?? (netlist.types || []).find((t) => t.name === net.type || t.name.endsWith(`::${net.type}`) || t.name.endsWith(`.${net.type}`))?.items;
    if (items?.length) {
      const readable = stateLabels(items.map((i) => i.name));
      return new Map(items.map((i, k) => [BigInt(i.value), readable[k] || i.name]));
    }
  }
  return null;
}

function laneNames(paths, aliases) {
  const names = new Map();
  const taken = new Map();
  for (const p of paths) {
    const segs = p.split('.');
    let name = aliases?.[p] ?? readableIdentifier(segs.at(-1));
    for (let k = 2; !aliases?.[p] && taken.has(name) && k <= segs.length; k += 1) name = readableIdentifier(segs.slice(-k).join('_'));
    taken.set(name, p);
    names.set(p, name);
  }
  return names;
}

function resolveOne(signals, pattern, diagnostics, role) {
  const exact = signals.find((s) => s.path === pattern);
  if (exact) return exact;
  const match = globMatcher([pattern]);
  const found = signals.filter((s) => match(s.path));
  if (found.length === 1) return found[0];
  diagnostics.push({ code: 'timing/vcd-signal-missing', severity: 'error', message: `${role} ${pattern} ${found.length ? `matches ${found.length} signals (${found.slice(0, 4).map((s) => s.path).join(', ')})` : 'is not in the VCD'}`, subject: { signal: pattern }, evidence: { candidates: found.slice(0, 8).map((s) => s.path) }, supportedFixes: ['give the full hierarchical path', 'check $dumpvars scope in the testbench'] });
  return null;
}

export function sampleCycles(changes, edges, first, cycles) {
  const out = [];
  for (let k = 0; k < cycles; k += 1) {
    const at = edges[first + k + 1];
    out.push(at === undefined ? null : valueBefore(changes, at));
  }
  return out;
}

// First cycle (pre-edge samples) where `event` happens on a sampled 1-bit or bus value.
export function eventCycle(samples, event, occurrence = 1) {
  let seen = 0;
  for (let k = 1; k < samples.length; k += 1) {
    const prev = samples[k - 1];
    const cur = samples[k];
    if (prev === null || cur === null) continue;
    const hit = event === 'rise' ? /^0+$/.test(prev) && /1/.test(cur) && !/[xz]/.test(cur)
      : event === 'fall' ? /1/.test(prev) && /^0+$/.test(cur)
        : prev !== cur;
    if (hit && ++seen === occurrence) return k;
  }
  return null;
}

export function vcdToTiming(vcdFile, opts = {}) {
  const { clock, edge = 'pos', signals = [], from = 0, alignOn, cycles, radix = {}, aliases = {}, netlist, title, stimulus, simulation } = opts;
  const diagnostics = [];
  const header = readVcd(vcdFile, { select: () => false });
  const clk = resolveOne(header.signals, clock, diagnostics, 'clock');
  const wanted = [];
  for (const pattern of signals) {
    const exact = header.signals.find((s) => s.path === pattern);
    const hits = exact ? [exact] : header.signals.filter((s) => globMatcher([pattern])(s.path));
    if (!hits.length) diagnostics.push({ code: 'timing/vcd-signal-missing', severity: 'error', message: `signal ${pattern} is not in the VCD`, subject: { signal: pattern }, evidence: {}, supportedFixes: ['give the full hierarchical path', 'check $dumpvars scope in the testbench'] });
    // A signal dumped at several scopes (port and its connection) is kept once, at the shallowest path.
    for (const h of hits) if (!wanted.some((w) => w.path === h.path)) wanted.push(h);
  }
  if (!clk || diagnostics.some((d) => d.severity === 'error')) return { doc: null, diagnostics };
  const keep = new Set([clk.path, ...wanted.map((w) => w.path), ...(alignOn ? [alignOn.path] : [])]);
  const dump = readVcd(vcdFile, { select: (p) => keep.has(p) });
  const edges = edgesOf(dump.changes.get(clk.path) || [], edge);
  let first = from;
  if (alignOn) {
    const target = resolveOne(dump.signals, alignOn.path, diagnostics, 'align-on signal');
    if (target) {
      const all = sampleCycles(dump.changes.get(target.path) || [], edges, 0, Math.max(0, edges.length - 1));
      const k = eventCycle(all, alignOn.event ?? 'rise', alignOn.occurrence ?? 1);
      if (k === null) diagnostics.push({ code: 'timing/vcd-window', severity: 'error', message: `no ${alignOn.event ?? 'rise'} of ${target.path} in the VCD`, subject: { signal: target.path }, evidence: { edges: edges.length }, supportedFixes: ['check the event and occurrence', 'use --from <cycle>'] });
      else first = Math.max(0, k - (alignOn.before ?? 0));
    }
  }
  const n = cycles ?? Math.max(0, edges.length - 1 - first);
  if (first + n + 1 > edges.length) diagnostics.push({ code: 'timing/vcd-window', severity: 'error', message: `the VCD has ${edges.length} ${edge} edges of ${clk.path}; cycles ${first}..${first + n - 1} need ${first + n + 1}`, subject: { signal: clk.path }, evidence: { edges: edges.length, first_cycle: first, cycles: n }, supportedFixes: ['run the simulation longer', 'reduce --cycles or --from'] });
  if (diagnostics.some((d) => d.severity === 'error')) return { doc: null, diagnostics };

  const names = laneNames([clk.path, ...wanted.map((w) => w.path)], aliases);
  const lanes = [{ name: names.get(clk.path), wave: `${edge === 'neg' ? 'n' : 'p'}${'.'.repeat(Math.max(0, n - 1))}` }];
  const signalsMeta = {};
  const rtlMap = { [names.get(clk.path)]: clk.path };
  for (const w of wanted) {
    const name = names.get(w.path);
    rtlMap[name] = w.path;
    const samples = sampleCycles(dump.changes.get(w.path) || [], edges, first, n);
    if (w.width === 1) {
      let wave = '';
      let prev = null;
      for (const s of samples) {
        const c = s === null ? 'x' : s;
        wave += c === prev ? '.' : c;
        prev = c;
      }
      lanes.push({ name, wave });
      continue;
    }
    const r = radix[w.path] ?? radix[name] ?? 'hex';
    const labels = r === 'label' ? labelsFor(netlist, w.path) : null;
    if (r === 'label' && !labels) diagnostics.push({ code: 'timing/vcd-radix-label', severity: 'warning', message: `${w.path}: no enum or localparam names found in the netlist; values print in hex`, subject: { signal: w.path }, evidence: {}, supportedFixes: ['pass --netlist with the design', 'use radix hex'] });
    let wave = '';
    const data = [];
    let prev = null;
    let partial = false;
    for (const s of samples) {
      const f = s === null ? { kind: 'x' } : formatValue(s, w.width, labels ? 'label' : r === 'label' ? 'hex' : r, labels);
      const key = f.kind === 'value' ? `v:${f.text}` : f.kind;
      if (f.partial) partial = true;
      if (key === prev) { wave += '.'; continue; }
      prev = key;
      if (f.kind === 'value') { wave += '='; data.push(f.text); } else wave += f.kind;
    }
    if (partial) diagnostics.push({ code: 'timing/vcd-partial-x', severity: 'warning', message: `${w.path}: some cycles carry partly unknown bits; they are drawn as x`, subject: { signal: w.path }, evidence: {}, supportedFixes: [] });
    lanes.push({ name, wave, ...(data.length ? { data } : {}) });
    signalsMeta[name] = { width: w.width, radix: labels ? 'label' : r === 'label' ? 'hex' : r };
  }
  const wavejson = { signal: lanes, head: { tick: first } };
  const scopes = [clk.path, ...wanted.map((w) => w.path)].map((p) => p.split('.').slice(0, -1));
  const common = scopes.reduce((acc, s) => acc.slice(0, s.findIndex((seg, i) => acc[i] !== seg) === -1 ? Math.min(acc.length, s.length) : s.findIndex((seg, i) => acc[i] !== seg)), scopes[0] ?? []);
  const doc = {
    schema_version: 1,
    figure_type: 'timing',
    meta: { title: title ?? `Simulated window of ${names.get(clk.path)}`, print: { profile: 'ieee' } },
    wavejson,
    clock: { name: names.get(clk.path), edge },
    ...(Object.keys(signalsMeta).length ? { signals: signalsMeta } : {}),
    provenance: {
      kind: 'vcd',
      vcd: vcdFile,
      vcd_sha256: sha256File(vcdFile),
      scope: common.join('.'),
      clock: clk.path,
      first_cycle: first,
      cycles: n,
      sample: 'pre_edge',
      rtl_map: rtlMap,
      ...(stimulus ? { stimulus } : {}),
      ...(simulation ? { simulation } : {}),
      generator: { version: GENERATOR_VERSION, lanes_sha256: lanesSha256(wavejson) },
    },
  };
  return { doc, diagnostics };
}
