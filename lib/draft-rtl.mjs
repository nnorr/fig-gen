// Register-transfer datapath draft (SPEC §4.10, `draft --style rtl-datapath`).
//
// The lump draft groups a module's local logic into functional blocks; this
// style recovers the datapath structure a paper figure draws, from the
// netlist's dependency records and signal widths alone (no names are guessed):
//
//   - data signals are at least DATA_MIN bits wide; narrower signals are control;
//   - a data register whose next value holds it (reads itself) is a loaded
//     register: registers of one role share a register bank (inputs loaded
//     from figure inputs, outputs that drive figure outputs, temporaries); the
//     load condition is a dashed enable from the controller, the hold is
//     implicit in the register symbol;
//   - a data register loaded unconditionally from data is a pipeline register:
//     one bar per stage;
//   - a data signal selected among two or more registers or ports under
//     control is a multiplexer (one-hot select from the controller, or the
//     select signal itself for a 2:1 choice on one bit); a data signal chosen
//     among constants by control is a table (lut);
//   - an arithmetic or XOR expression is an operator; a function call is an
//     operator block named by the function; an instance is a collapsed
//     operator block with its RTL ports;
//   - control registers and all narrow logic are one Controller block whose
//     outputs are dashed selects and load enables;
//   - pure wiring (a slice, a copy, a concatenation) is absorbed into the
//     element that reads it.
// No layout hints are emitted: the renderer's flow layering places inputs and
// register banks left, selects and operators in the middle and outputs right;
// forced layers measured wider and more crowded.

import { acronymCase, expandAbbreviations, readableIdentifier, unreadableReason, VOCABULARY } from './checks/labels.mjs';
import { basisOf, exprTemplate, groupKey, isDivisionByTable, isHornerStep, isValueDivision, isZeroCompare, stepKey } from './draft-rtl-structure.mjs';
import { orderFanIn } from './lane-order.mjs';
import { repoReader } from './repo-files.mjs';
import { aliasClasses } from './checks/coverage.mjs';
import { minStages, stagesBetween } from './draft.mjs';
import { flattenNetlist } from './rtl/flatten.mjs';

export const DATA_MIN = 8;
export const STYLES = Object.freeze(['rtl-datapath', 'lumps']);

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1').slice(0, 60);
const portLabel = (name) => acronymCase(expandAbbreviations(String(name).replace(/_[io]$/, '').replace(/_+/g, ' ').trim()));
const WIRING = new Set(['ref', 'sel', 'index', 'concat', 'const', 'extend', 'replicate']);
const OPERATORS = { xor: 'xor', add: 'add', sub: 'sub', mul: 'mul' };

export function draftRtlDatapath(netlist, { scope = '', title, format, budget, repository } = {}) {
  const notes = [];
  // Blocks named by role (no structure matched) and labels still derived from RTL identifiers.
  const review = [];
  const reader = repository ? repoReader({ meta: { repository } }, process.cwd()) : null;
  if (!repository) notes.push('no repository revision: vocabulary names cannot cite a basis, so blocks get role names (pass --repo-root and --revision)');
  // The same time budget as the lump draft: a draft past it stops with draft/budget-exceeded.
  const started = Date.now();
  const tick = (phase) => {
    if (!budget?.seconds || Date.now() - started <= budget.seconds * 1000) return;
    const error = new Error(`draft budget exceeded while ${phase}`);
    error.diagnostic = { code: 'draft/budget-exceeded', severity: 'error', message: `the register-transfer draft of ${scope || '(top)'} stopped while ${phase}: it did not finish within ${budget.seconds} s`, subject: { scope }, evidence: { phase, seconds: budget.seconds }, supportedFixes: ['narrow --scope to one module', 'raise --budget-seconds'] };
    throw error;
  };
  const flat = flattenNetlist(netlist);
  const aliases = aliasClasses(netlist);
  const canon = (p) => aliases.find(p);
  const P = (rel) => [flat.top, ...(rel ? rel.split('/') : [])].join('.');
  const scopePath = P(scope);
  const mod = flat.instances.get(scopePath);
  if (!mod) throw new Error(`scope ${scope || '(top)'} is not an instance of ${flat.top}`);
  const S = (name) => `${scopePath}.${name}`;
  const sig = (name) => flat.signals.get(S(name));
  const bits = (name) => sig(name)?.bits ?? null;

  tick('reading the netlist');
  // Canonical dependency graph (as the lump draft builds it) for latency maps.
  const back = new Map();
  for (const [t, list] of flat.back) {
    const ct = canon(t);
    for (const { source, kind } of list) {
      const cs = canon(source);
      if (cs === ct) continue;
      if (!back.has(ct)) back.set(ct, []);
      back.get(ct).push({ s: cs, seq: kind === 'seq' });
    }
  }
  const clockNets = new Set(mod.registers.flatMap((r) => [r.clock?.net, r.reset?.net].filter(Boolean)));
  const allClocks = new Set([...flat.instances.entries()].flatMap(([p, m]) => (m.registers || []).flatMap((r) => [r.clock?.net, r.reset?.net].filter(Boolean).map((n) => canon(`${p}.${n}`)))));
  const isClock = (name) => clockNets.has(name);

  const comb = new Map();
  const seq = new Map();
  for (const d of mod.deps || []) {
    const map = d.kind === 'seq' ? seq : comb;
    map.set(d.target, [...new Set([...(map.get(d.target) || []), ...d.sources.filter((s) => !isClock(s))])]);
  }
  const exprOf = new Map((mod.exprs || []).filter((e) => e.index === undefined).map((e) => [e.target, e.expr]));
  // An array computed element by element with one operator (every element a gf_mult, every element a cond) is that operator.
  for (const [t, list] of Object.entries(Object.groupBy((mod.exprs || []).filter((e) => e.index !== undefined), (e) => e.target))) {
    if (exprOf.has(t)) continue;
    const key = (x) => `${x.op}:${x.name ?? ''}`;
    if (list.every((e) => key(e.expr) === key(list[0].expr)) && !WIRING.has(list[0].expr.op)) exprOf.set(t, list[0].expr);
  }
  // Every assignment of a signal (all elements of an array), its source lines, and helpers on expression trees.
  const assignsOf = (name) => (mod.exprs || []).filter((x) => x.target === name);
  const sourcesOf = (name) => [...assignsOf(name).map((x) => x.source), ...(mod.deps || []).filter((d) => d.target === name).map((d) => d.source)].filter(Boolean);
  const leafName = (n) => (n?.op === 'ref' ? n.name : (n?.op === 'index' || n?.op === 'sel') && n.args?.[0]?.op === 'ref' ? n.args[0].name : null);
  const leafRefs = (n, out = []) => { if (!n || typeof n !== 'object') return out; const l = leafName(n); if (l) out.push(l); else for (const a of n.args || []) leafRefs(a, out); return out; };
  const indexCount = (name) => Math.max(1, assignsOf(name).filter((x) => x.index !== undefined).length);
  // A constant table: an array every element of which is a constant.
  const isConstTable = (name) => { const list = assignsOf(name); return list.length > 1 && list.every((x) => x.expr?.op === 'const'); };
  // The cited line for a structure: the first line from a location on that matches (the operator may sit on a continuation line).
  const citeLine = (src, re, span = 4) => {
    if (!src || !reader?.valid) return src ?? null;
    const lines = reader.lines(src.file);
    if (!lines) return src;
    for (let k = src.line; k <= Math.min(lines.length, src.line + span); k += 1) if (re.test(lines[k - 1])) return { file: src.file, line: k };
    return src;
  };
  const ports = mod.ports.filter((p) => !isClock(p.name));
  const portNames = new Set(ports.map((p) => p.name));
  const inPorts = new Set(ports.filter((p) => p.dir !== 'out').map((p) => p.name));
  const outPorts = new Set(ports.filter((p) => p.dir === 'out').map((p) => p.name));
  const fsmRegs = new Set((mod.fsms || []).map((f) => f.register));
  // Array registers copied as a whole from one source are kept (a pipeline of symbols); addressed arrays are memories.
  const registers = mod.registers.filter((r) => !r.array || (seq.get(r.name) || []).length === 1);
  const regNames = new Set(registers.map((r) => r.name));
  const isData = (name) => (bits(name) ?? 0) >= DATA_MIN;

  // Instance outputs (signals driven by an instance port) and inputs.
  const instOut = new Map();
  const instIn = new Map();
  for (const inst of mod.instances) {
    for (const c of inst.connections) {
      if (c.expr?.kind !== 'net') continue;
      (c.dir === 'out' ? instOut : instIn).set(c.expr.net, { inst, port: c.port });
    }
  }

  // Registers: next-value signal, hold, load sources.
  const regInfo = new Map();
  for (const r of registers) {
    const nexts = (seq.get(r.name) || []).filter((s) => s !== r.name);
    const next = nexts.length === 1 ? nexts[0] : null;
    const srcs = next ? (comb.get(next) || [next]) : nexts;
    const hold = srcs.includes(r.name);
    // A register that holds is loaded through its next-value logic; one that does not is loaded from its direct source.
    const load = hold ? srcs.filter((s) => s !== r.name) : nexts;
    regInfo.set(r.name, { r, next: hold && next && comb.has(next) ? next : null, hold, dataSrc: load.filter(isData), ctrlSrc: load.filter((s) => !isData(s)) });
  }
  // A register loaded every cycle from one source (no hold, no load condition) is a pipeline register, data or control (valid bits).
  const isPipeline = (r) => {
    const i = regInfo.get(r.name);
    if (fsmRegs.has(r.name) || i.hold) return false;
    return isData(r.name) ? !i.ctrlSrc.length && i.dataSrc.length === 1 : i.ctrlSrc.length + i.dataSrc.length === 1;
  };
  const pipelineRegs = registers.filter(isPipeline);
  const dataRegs = registers.filter((r) => isData(r.name) && !fsmRegs.has(r.name) && !isPipeline(r));
  const controlRegs = registers.filter((r) => !dataRegs.includes(r) && !isPipeline(r));
  // Signals that join several signals into one of exactly their total width (a symbol vector) are concatenations.
  const joins = new Set([...comb.keys()].filter((t) => !regNames.has(t) && !outPorts.has(t) && isData(t) && (!exprOf.get(t) || WIRING.has(exprOf.get(t).op)) && (comb.get(t) || []).length >= 2 && (comb.get(t) || []).every(isData) && (comb.get(t) || []).reduce((a, x) => a + (bits(x) ?? 0), 0) === bits(t)));
  // Registers, ports and computed signals a data signal is chosen among, through wiring.
  const dataLeaves = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    seen.add(name);
    if (regNames.has(name) || inPorts.has(name) || instOut.has(name) || joins.has(name)) return [name];
    const e = exprOf.get(name);
    if (e && !WIRING.has(e.op)) return [name];
    return (comb.get(name) || []).filter(isData).flatMap((s) => dataLeaves(s, seen));
  };

  // Roles of loaded data registers.
  const drivesOut = (name) => [...outPorts].some((o) => (comb.get(o) || []).length === 1 && comb.get(o)[0] === name);
  const loaded = dataRegs;
  const pipeline = pipelineRegs;
  const roleOf = (r) => {
    const info = regInfo.get(r.name);
    if (drivesOut(r.name)) return 'output';
    if (info.dataSrc.length && info.dataSrc.every((s) => inPorts.has(s))) return 'input';
    return 'temporary';
  };
  const ROLE_LABEL = { input: 'input registers', temporary: 'temporary registers', output: 'output registers' };
  const banks = [];
  // Lanes are ordered by which selects read them (first select only, several, last only), so fan-outs do not cross.
  const targetOrder = [...comb.keys()];
  const readScore = (name) => {
    const idx = [...comb.entries()].filter(([t, srcs]) => srcs.includes(name) && isData(t) && !outPorts.has(t) && !regInfo.has(t) && t !== regInfo.get(name)?.next && ![...regInfo.values()].some((i) => i.next === t)).map(([t]) => targetOrder.indexOf(t));
    return idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : Infinity;
  };
  for (const role of ['input', 'temporary', 'output']) {
    const members = loaded.filter((r) => roleOf(r) === role).sort((a, b) => readScore(a.name) - readScore(b.name) || a.name.localeCompare(b.name));
    if (!members.length) continue;
    for (const [w, group] of Object.entries(Object.groupBy(members, (r) => String(r.width)))) {
      banks.push({ role, width: Number(w), members: group });
    }
  }

  // Data signals (other than output ports) that read a register.
  const dataReaders = (name) => [...comb.entries()].filter(([t, srcs]) => srcs.includes(name) && !outPorts.has(t) && t !== regInfo.get(name)?.next).map(([t]) => t);

  tick('classifying registers');
  // Owners: which element represents each signal.
  const owner = new Map();
  const elements = [];
  const nets = [];
  const used = new Set();
  const uid = (base) => {
    let id = sanitize(base);
    for (let k = 2; used.has(id); k += 1) id = `${sanitize(base).slice(0, 56)}_${k}`;
    used.add(id);
    return id;
  };
  const domain = { id: 'sys', clock: registers[0]?.clock?.net ?? 'clk' };

  // Ports. A module-local prefix shared by several ports ("dec_" in dec_data_i, dec_err_detected_o) is
  // dropped when the names stay distinct, as FSM guards drop theirs.
  const token = (n) => n.split('_')[0];
  const prefixCount = Object.groupBy(ports, (p) => token(p.name));
  const stripped = (p) => {
    const t = token(p.name);
    const rest = p.name.slice(t.length + 1);
    // (kept when the rest would not be a readable name: operand_a_i stays "operand a", not "a")
    if (!rest || (prefixCount[t]?.length ?? 0) < 2 || /^[io]$/.test(rest) || unreadableReason(portLabel(rest))) return p.name;
    return ports.some((q) => q !== p && (q.name === rest || q.name.replace(/^[a-z0-9]+_/, '') === rest && token(q.name) !== t)) ? p.name : rest;
  };
  // A data port whose name is only a word another port's name ends with ("corrected" beside
  // "error corrected") says what it carries: "corrected data".
  const baseLabels = new Map(ports.map((p) => [p.name, portLabel(stripped(p))]));
  const portText = (p) => {
    const label = baseLabels.get(p.name);
    // (only a whole label that another label ends with: "corrected" vs "error corrected"; "x real part" vs "o0 real part" is no collision)
    const collides = p.width >= DATA_MIN && [...baseLabels.entries()].some(([other, l]) => other !== p.name && l !== label && l.endsWith(` ${label}`));
    return collides ? `${label} data` : label;
  };
  for (const p of ports) {
    const id = uid(`p_${p.name}`);
    // Ports whose names share a leading word ("error detected", "error corrected") get a short label without it,
    // unless another port's label or short label would read the same ("in valid" and "out valid" both "valid").
    const text = portText(p);
    const shortOf = (q) => { const t = portText(q); const w = t.split(' ')[0]; return t.includes(' ') && ports.some((o) => o !== q && portText(o).split(' ')[0] === w && portText(o).includes(' ')) && !unreadableReason(t.slice(w.length + 1)) ? t.slice(w.length + 1) : null; };
    const shortText = shortOf(p);
    const clash = shortText && ports.some((q) => q !== p && (portText(q) === shortText || shortOf(q) === shortText));
    elements.push({ id, kind: 'port', dir: p.dir === 'out' ? 'out' : 'in', width: p.width, label: text, ...(shortText && !clash ? { short_label: shortText } : {}), ...(p.width === 1 && /(^|_)(valid|ready)(_|$)/.test(p.name) ? { role: 'handshake' } : {}), rtl: { signal: p.name } });
    owner.set(p.name, { id, pin: null });
  }

  // Register banks and pipeline bars.
  const bankEls = [];
  for (const b of banks) {
    const id = uid(`reg_${b.role}${banks.filter((x) => x.role === b.role).length > 1 ? `_${b.width}` : ''}`);
    const shared = b.members.every((r) => regInfo.get(r.name).ctrlSrc.length === 1 && bits(regInfo.get(r.name).ctrlSrc[0]) === 1)
      && new Set(b.members.map((r) => regInfo.get(r.name).ctrlSrc[0])).size === 1;
    const sources = b.members.map((r) => regInfo.get(r.name).dataSrc.flatMap((x) => dataLeaves(x)));
    const sharedD = b.members.length > 1 && sources.every((l) => l.length === 1 && l[0] === sources[0][0]);
    // One register of a role is a plain register with an enable; two or more share a bank.
    const single = b.members.length === 1;
    const el = single
      ? { id, kind: 'register', domain: domain.id, width: bits(b.members[0].name) ?? b.members[0].width, enable: true, rtl: { signal: b.members[0].name, covers: [regInfo.get(b.members[0].name).next].filter(Boolean) } }
      : {
        id, kind: 'register', domain: domain.id, label: ROLE_LABEL[b.role], enable: true, enable_width: shared ? 1 : b.members.length, ...(sharedD ? { shared_d: true } : {}),
        lanes: b.members.map((r) => ({ id: sanitize(r.name), width: r.width, rtl: { signal: r.name } })),
        rtl: { covers: b.members.flatMap((r) => [regInfo.get(r.name).next].filter(Boolean)) },
      };
    if (single && !el.rtl.covers.length) delete el.rtl.covers;
    if (!single && !el.rtl.covers.length) delete el.rtl;
    elements.push(el);
    bankEls.push({ el, bank: b, shared, single });
    for (const r of b.members) owner.set(r.name, { id, pin: single ? 'q' : `q_${sanitize(r.name)}` });
    for (const r of b.members) if (regInfo.get(r.name).next) owner.set(regInfo.get(r.name).next, { id, pin: null, internal: true });
    notes.push(`${id}: ${b.members.length} ${b.role} register${b.members.length > 1 ? 's' : ''} (${b.members.map((r) => r.name).join(', ')}), loaded under ${shared ? 'one shared' : 'per-register'} enable${shared ? '' : 's'}; hold is implicit`);
  }
  if (pipeline.length) {
    const inputs = new Set([...inPorts].map((n) => canon(S(n))));
    const byStage = Object.groupBy(pipeline, (r) => String(Math.max(1, minStages(back, canon(S(r.name)), inputs, allClocks))));
    for (const [k, group] of Object.entries(byStage).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const id = uid(`preg_s${k}`);
      // A 1-bit valid/ready lane carries the handshake, not a value: control class, drawn dashed through the bar.
      const laneOf = (r) => { const w = bits(r.name) ?? r.width; return { id: sanitize(r.name), width: w, ...(w === 1 && /(^|_)(valid|ready)(_|$)/.test(r.name) ? { class: 'control' } : {}) }; };
      elements.push({ id, kind: 'pipeline_register', domain: domain.id, stage: Number(k), label: `S${Number(k) - 1}|S${k}`, lanes: group.map(laneOf) });
      for (const r of group) {
        owner.set(r.name, { id, pin: `q_${sanitize(r.name)}` });
      }
    }
  }

  // Instances: collapsed operator blocks with their RTL ports and latency maps.
  const instanceEls = new Map();
  for (const inst of mod.instances) {
    const childPath = `${scopePath}.${inst.name}`;
    const m = flat.instances.get(childPath);
    if (!m) continue;
    const id = uid(inst.name.startsWith('u_') ? inst.name : `u_${inst.name}`);
    const readable = acronymCase(expandAbbreviations(readableIdentifier(m.orig_name)));
    const arithmetic = (m.exprs || []).some((e) => /"op":"(add|sub|mul|div)"/.test(JSON.stringify(e.expr))) || m.instances.length > 0;
    const el = {
      id, kind: 'instance', module: sanitize(m.orig_name), level: m.blackbox ? 'blackbox' : 'block', pin_labels: false,
      function: arithmetic ? { kind: 'arithmetic_unit' } : { kind: 'custom', name: readable },
      ...(arithmetic ? { label: readable } : {}),
      rtl: { instance: `${scope ? `${scope}/` : ''}${inst.name}` },
      ports: m.ports.map((q) => ({ id: q.name, dir: q.dir === 'out' ? 'out' : 'in', width: q.width, ...(allClocks.has(canon(`${childPath}.${q.name}`)) ? { class: /rst|reset/i.test(q.name) ? 'reset' : 'clock' } : q.dir !== 'out' && q.width === 1 && /(^|_)(valid|ready)(_|$)/.test(q.name) ? { role: 'handshake' } : {}) })),
    };
    const dataIn = m.ports.filter((x) => x.dir !== 'out' && !allClocks.has(canon(`${childPath}.${x.name}`)));
    for (const q of el.ports.filter((x) => x.dir === 'out')) {
      const per = Object.fromEntries(dataIn.map((x) => [x.name, stagesBetween(back, canon(`${childPath}.${q.id}`), canon(`${childPath}.${x.name}`), allClocks)]).filter(([, v]) => v !== null));
      const values = [...new Set(Object.values(per))];
      if (!values.length) continue;
      if (values.length === 1) {
        if (values[0] >= 1) { q.registered = true; if (values[0] > 1) q.latency = values[0]; }
        continue;
      }
      q.latency = per;
      el.holds_state = true;
    }
    elements.push(el);
    instanceEls.set(inst.name, el);
    for (const c of inst.connections) if (c.dir === 'out' && c.expr?.kind === 'net') owner.set(c.expr.net, { id, pin: c.port });
  }

  tick('drawing registers and instances');
  // Combinational targets: classify data signals; narrow logic is control.
  const targets = [...comb.keys()].filter((t) => !portNames.has(t) || outPorts.has(t)).filter((t) => !owner.has(t) || outPorts.has(t));
  const muxEls = [];
  const opEls = [];
  const armMuxes = [];
  const controlSignals = new Set(controlRegs.map((r) => r.name));
  for (const r of controlRegs) if (regInfo.get(r.name).next) controlSignals.add(regInfo.get(r.name).next);
  const absorbed = new Map();
  const plainCopy = (o) => { const srcs = comb.get(o) || []; const e = exprOf.get(o); return srcs.length === 1 && (!e || e.op === 'ref') && !inPorts.has(srcs[0]); };
  for (const t of targets) {
    if (outPorts.has(t) && plainCopy(t)) continue;
    if (joins.has(t)) {
      const hi = (x) => Math.max(-1, ...assignsOf(t).filter((a) => leafRefs(a.expr).includes(x)).map((a) => a.index ?? -1));
      const srcs = [...comb.get(t)].sort((x, y) => hi(y) - hi(x));
      const id = uid(`cat_${t}`);
      elements.push({ id, kind: 'comb', op: 'concat', width: bits(t), in_widths: srcs.map((x) => bits(x)) });
      opEls.push({ id, t, data: srcs });
      owner.set(t, { id, pin: 'out' });
      continue;
    }
    if (!isData(t)) { controlSignals.add(t); continue; }
    const srcs = comb.get(t) || [];
    const ctrl = srcs.filter((s) => !isData(s));
    const data = [...new Set(srcs.filter(isData).flatMap((s) => dataLeaves(s)))];
    const e = exprOf.get(t);
    if (e && OPERATORS[e.op] && data.length >= 1) {
      const id = uid(`op_${t}`);
      elements.push({ id, kind: 'comb', op: OPERATORS[e.op], width: bits(t) });
      opEls.push({ id, t, data: data.slice(0, 2) });
      owner.set(t, { id, pin: 'out' });
      continue;
    }
    if (e?.op === 'func' && data.length && !ctrl.length) {
      const id = uid(`fn_${t}`);
      elements.push({ id, kind: 'comb', op: 'custom', width: bits(t), function: { kind: 'custom', name: acronymCase(expandAbbreviations(readableIdentifier(e.name))) }, ports: [...data.map((s, k) => ({ id: `in${k}`, dir: 'in', width: bits(s) })), { id: 'out', dir: 'out', width: bits(t) }] });
      opEls.push({ id, t, data, custom: true, fn: e.name });
      owner.set(t, { id, pin: 'out' });
      continue;
    }
    // A conditional whose then-arm applies an operator to the else value (c ? a ^ e : a) keeps the operator
    // visible: the operator, then a mux with one select bit per element, the select computed by narrow logic.
    const armOp = e?.op === 'cond' && e.args?.[1] && !WIRING.has(e.args[1].op) && e.args[1].op !== 'cond' ? e.args[1] : null;
    const elseLeaf = armOp ? leafName(e.args[2]) : null;
    const armOther = armOp ? data.filter((d) => d !== elseLeaf) : [];
    if (armOp && elseLeaf && data.includes(elseLeaf) && armOther.length === 1) {
      const lanes = indexCount(t);
      const opId = uid(`op_${t}`);
      const isXor = armOp.op === 'xor' || (armOp.op === 'func' && /add|xor/i.test(armOp.name));
      const src = citeLine(assignsOf(t)[0]?.source, /\^|xor/i);
      const basis = isXor && reader?.valid ? basisOf([src], 'XOR of a value and a computed error') : null;
      elements.push(isXor
        ? { id: opId, kind: 'comb', op: 'xor', width: bits(t), function: { kind: 'gf_add', ...(basis ? { basis } : {}) } }
        : { id: opId, kind: 'comb', op: 'custom', width: bits(t), function: { kind: 'custom', name: `${portLabel(t)} update`.slice(0, 40) }, ports: [{ id: 'in0', dir: 'in', width: bits(t) }, { id: 'in1', dir: 'in', width: bits(t) }, { id: 'out', dir: 'out', width: bits(t) }] });
      opEls.push({ id: opId, t: null, data: [elseLeaf, armOther[0]] });
      const muxId = uid(`mux_${t}`);
      elements.push({ id: muxId, kind: 'mux', inputs: 2, width: bits(t), ...(lanes > 1 ? { lanes } : {}) });
      armMuxes.push({ id: muxId, t, opId, elseLeaf, selLeaves: [...new Set(leafRefs(e.args[0]))], lanes, isXor });
      owner.set(t, { id: muxId, pin: 'out' });
      continue;
    }
    if (data.length >= 2 && ctrl.length) {
      const id = uid(`mux_${t}`);
      const binary = data.length === 2 && ctrl.length === 1 && bits(ctrl[0]) === 1;
      // 2:1 order from the netlist's conditional record: in0 is the else side, in1 the input only the then side adds
      // (a then side that also reads the else value, as in "match ? sym ^ err : sym", is still the second input).
      const rec = (mod.muxes || []).find((x) => x.target === t);
      const thenOnly = rec ? data.filter((d) => rec.in1.includes(d) && !rec.in0.includes(d)) : [];
      const elseSide = rec ? data.filter((d) => rec.in0.includes(d)) : [];
      // Wider selects: inputs by which selects read them (only this one first for the first select, shared ones
      // toward the neighbouring select), so a register feeding two stacked selects runs straight between them.
      const order = data.length === 2 && thenOnly.length === 1 && elseSide.length === 1 ? [elseSide[0], thenOnly[0]] : bankOrder(data).sort((x, y) => readScore(x) - readScore(y));
      elements.push({ id, kind: 'mux', inputs: order.length, width: bits(t), ...(binary ? {} : { encoding: 'onehot' }) });
      muxEls.push({ id, t, data: order, ctrl, binary });
      owner.set(t, { id, pin: 'out' });
      continue;
    }
    if (!data.length && ctrl.length) {
      const id = uid(`lut_${t}`);
      const addr = ctrl.reduce((a, s) => a + (bits(s) ?? 1), 0);
      const params = constNames(e);
      elements.push({ id, kind: 'comb', op: 'lut', width: bits(t), depth: 2 ** addr, label: params.length ? `${portLabel(commonPrefix(params)) || 'constant'} table` : 'constant table' });
      opEls.push({ id, t, lut: true, ctrl });
      owner.set(t, { id, pin: 'data' });
      continue;
    }
    // Wiring that takes a contiguous part of a vector is a slice: a split with one slice, drawn as a
    // truncation label on a straight wire (CONVENTIONS §2.3.2), never a block.
    if (data.length === 1 && bits(data[0]) !== null && bits(data[0]) !== bits(t)) {
      const range = sliceRange(e, data[0]);
      if (range) {
        const id = uid(`slice_${t}`);
        elements.push({ id, kind: 'comb', op: 'split', width: bits(data[0]), slices: [`${range[0]}:${range[1]}`] });
        opEls.push({ id, t, data });
        owner.set(t, { id, pin: 'out0' });
        continue;
      }
      notes.push(`${t}: takes a non-contiguous part of ${data[0]}; drawn as a block to review`);
      const id = uid(`sel_${t}`);
      elements.push({ id, kind: 'comb', op: 'custom', width: bits(t), function: { kind: 'custom', name: `${portLabel(t)} bits`.slice(0, 40) }, ports: [{ id: 'in0', dir: 'in', width: bits(data[0]) }, { id: 'out', dir: 'out', width: bits(t) }] });
      review.push(`${id}: bit regrouping of ${data[0]}`);
      opEls.push({ id, t, data, custom: true });
      owner.set(t, { id, pin: 'out' });
      continue;
    }
    absorbed.set(t, data);
  }
  // [msb:lsb] of the bits of `src` an expression takes: indexed elements or part-selects, contiguous.
  function sliceRange(expr, src) {
    const count = indexCount(src);
    const elemW = count > 1 ? (bits(src) ?? 0) / count : null;
    const spans = [];
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.op === 'index' && leafName(n) === src && elemW) { spans.push([(n.index + 1) * elemW - 1, n.index * elemW]); return; }
      if (n.op === 'sel' && leafName(n) === src) { spans.push([n.lsb + n.width - 1, n.lsb]); return; }
      if (n.op === 'ref' && n.name === src) { spans.push([(bits(src) ?? 1) - 1, 0]); return; }
      for (const a of n.args || []) visit(a);
    };
    visit(expr);
    if (!spans.length) return null;
    spans.sort((a, b) => b[0] - a[0]);
    for (let k = 1; k < spans.length; k += 1) if (spans[k][0] !== spans[k - 1][1] - 1) return null;
    return [spans[0][0], spans.at(-1)[1]];
  }
  function bankOrder(list) {
    const rank = (s) => {
      for (const [k, b] of bankEls.entries()) { const i = b.bank.members.findIndex((r) => r.name === s); if (i >= 0) return k * 64 + i; }
      return 4096 + [...inPorts].indexOf(s);
    };
    return [...list].sort((a, b) => rank(a) - rank(b));
  }
  function constNames(e) {
    const out = [];
    const walk = (x) => { if (!x || typeof x !== 'object') return; if (x.op === 'const' && x.param) out.push(x.param); for (const v of Object.values(x)) if (typeof v === 'object') walk(v); };
    walk(e);
    return [...new Set(out)];
  }
  function commonPrefix(list) {
    let p = list[0] ?? '';
    for (const s of list) while (!s.startsWith(p)) p = p.slice(0, -1);
    return p.replace(/[0-9_]+$/, '');
  }

  // Function-call cones (rules 1 and 2 of SPEC §4.10). A chain of calls with no register
  // between them is one cone. Cones with the same structure (templates, widths, constant
  // pattern) in the same stage feeding the same element merge into one block with several
  // outputs; cones repeating the same step in different stages are one staged function.
  // Names come from structure with a cited basis; otherwise a role name, listed for review.
  {
    const fnOps = opEls.filter((o) => o.fn);
    const byTarget = new Map(fnOps.map((o) => [o.t, o]));
    const parent = new Map(fnOps.map((o) => [o.t, o.t]));
    const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
    for (const o of fnOps) for (const d of o.data) if (byTarget.has(d)) parent.set(find(d), find(o.t));
    const inputsOf = new Set([...inPorts].map((n) => canon(S(n))));
    const cones = Object.values(Object.groupBy(fnOps, (o) => find(o.t))).map((g) => {
      const members = new Set(g.map((o) => o.t));
      const isMember = (n) => members.has(n);
      const exprs = [...members].map((t) => exprOf.get(t)).filter(Boolean);
      const inputs = [...new Set(g.flatMap((o) => o.data).filter((d) => !members.has(d)))];
      const readOutside = (t) => [...comb.entries()].some(([x, srcs]) => !members.has(x) && srcs.includes(t)) || [...seq.values()].some((srcs) => srcs.includes(t)) || instIn.has(t);
      const outs = [...members].filter(readOutside);
      const readers = new Set(outs.flatMap((t) => [...[...seq.entries()].filter(([, srcs]) => srcs.includes(t)).map(([r]) => owner.get(r)?.id ?? r), ...[...comb.entries()].filter(([x, srcs]) => !members.has(x) && srcs.includes(t)).map(([x]) => owner.get(x)?.id ?? x)]));
      const stage = outs.length ? minStages(back, canon(S(outs[0])), inputsOf, allClocks) : 0;
      return { g, members, isMember, exprs, inputs, outs, readers, stage, key: groupKey(exprs, isMember), step: stepKey(exprs, isMember) };
    });
    // Rule 1: isomorphic cones in one stage feeding the same element are one block.
    const merged = Object.values(Object.groupBy(cones, (c) => `${c.key}@${c.stage}@${[...c.readers].sort().join(',')}`)).map((list) => ({
      list,
      members: new Set(list.flatMap((c) => [...c.members])),
      exprs: list.flatMap((c) => c.exprs),
      inputs: [...new Set(list.flatMap((c) => c.inputs))],
      outs: list.flatMap((c) => c.outs),
      stage: list[0].stage,
      step: list[0].step,
    }));
    // Rule 2: names from structure. Staging: the same step in several stages.
    const staged = Object.groupBy(merged, (m) => m.step);
    for (const m of merged) {
      const sources = [...m.members].flatMap((t) => sourcesOf(t));
      const cite = (kind, structure) => {
        const basis = reader?.valid ? basisOf(sources, structure) : null;
        return basis ? { kind, basis } : null;
      };
      let fn = null;
      if (m.exprs.length && m.exprs.every(isHornerStep)) fn = cite('syndrome', 'Horner steps: multiply by a field constant, add the next symbol');
      else if (m.members.size === 1 && m.exprs.length === 1 && isDivisionByTable(m.exprs[0], isConstTable)) fn = cite('error_evaluator', 'per position: multiply by the inverse of a constant power');
      else if (isValueDivision(m.exprs) && m.inputs.length >= 2) fn = cite('error_locator', 'one value divided by another: multiply by the inverse');
      const peers = staged[m.step].filter((x) => x.stage !== m.stage || x === m).sort((a, b) => a.stage - b.stage);
      if (fn && peers.length > 1 && new Set(peers.map((x) => x.stage)).size === peers.length) fn.stage = `${peers.indexOf(m) + 1}/${peers.length}`;
      if (!fn) {
        fn = { kind: 'custom', name: `stage-${m.stage + 1} computation` };
        review.push(`${portLabel(m.outs[0] ?? [...m.members][0])}: no structure recognized (${[...new Set(m.exprs.map((x) => exprTemplate(x, (n) => m.members.has(n))))].slice(0, 2).join('; ')}); named by role`);
      }
      const id = uid(`fn_${m.outs[0] ?? [...m.members][0]}`);
      const covers = [...m.members].filter((t) => !m.outs.includes(t));
      const el = { id, kind: 'comb', op: 'custom', width: Math.max(1, ...m.outs.map((t) => bits(t) ?? 1)), function: fn, ...(covers.length ? { rtl: { covers } } : {}), ports: [...m.inputs.map((d) => ({ id: `i_${sanitize(d)}`, dir: 'in', width: bits(d) })), ...m.outs.map((t) => ({ id: `o_${sanitize(t)}`, dir: 'out', width: bits(t) }))] };
      const drop = new Set(m.list.flatMap((c) => c.g.map((o) => o.id)));
      elements.splice(0, elements.length, ...elements.filter((e) => !drop.has(e.id)));
      opEls.splice(0, opEls.length, ...opEls.filter((o) => !drop.has(o.id)), { id, t: null, data: m.inputs, cluster: true });
      elements.push(el);
      for (const t of m.members) owner.set(t, m.outs.includes(t) ? { id, pin: `o_${sanitize(t)}` } : { id, pin: null, internal: true });
      if (m.list.length > 1 || m.members.size > 1) notes.push(`${id}: ${m.list.length} isomorphic cone${m.list.length > 1 ? 's' : ''} (${m.members.size} assignments) drawn as one block${fn.stage ? `, stage ${fn.stage}` : ''}`);
    }
  }

  // Narrow logic without state (rule 3): one block per output-cone group instead of one lump.
  // Anchors are narrow signals computed from data (compares), narrow signals read outside
  // narrow logic, and the selects of conditional arms. Output cones that share members
  // merge; compares with the same structure merge. The controller (state) stays as it is.
  const narrowGroups = [];
  if (!controlRegs.length) {
    const narrow = new Set([...controlSignals]);
    const fromData = (x) => (comb.get(x) || []).some((y) => isData(y));
    const readOutsideNarrow = (x) => [...outPorts].some((o) => (comb.get(o) || []).includes(x)) || [...comb.entries()].some(([t, srcs]) => !narrow.has(t) && !outPorts.has(t) && srcs.includes(x)) || [...seq.values()].some((srcs) => srcs.includes(x)) || instIn.has(x);
    const compares = [...narrow].filter(fromData);
    const outputs = [...narrow].filter((x) => !compares.includes(x) && (readOutsideNarrow(x) || outPorts.has(x)));
    const cone = (x) => {
      const seen = new Set();
      const stack = [x];
      while (stack.length) {
        const v = stack.pop();
        if (seen.has(v)) continue;
        seen.add(v);
        for (const src of comb.get(v) || []) if (narrow.has(src) && !compares.includes(src) && !seen.has(src)) stack.push(src);
      }
      return seen;
    };
    // compares: merged by structure (e.g. every syndrome compared with zero)
    const cmpKey = (x) => (exprOf.get(x) ? exprTemplate(exprOf.get(x)) : `deps:${(comb.get(x) || []).map((y) => (isConstTable(y) ? 'table' : isData(y) ? 'data' : 'narrow')).sort().join(',')}`);
    for (const list of Object.values(Object.groupBy(compares, cmpKey))) narrowGroups.push({ outs: list, members: new Set(list) });
    // output cones: merged when they share members
    const groups = outputs.map((x) => ({ outs: [x], members: cone(x) }));
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < groups.length && !merged; i += 1) for (let j = i + 1; j < groups.length && !merged; j += 1) {
        if ([...groups[i].members].some((m) => groups[j].members.has(m))) {
          groups[i] = { outs: [...groups[i].outs, ...groups[j].outs], members: new Set([...groups[i].members, ...groups[j].members]) };
          groups.splice(j, 1);
          merged = true;
        }
      }
    }
    narrowGroups.push(...groups);
    // selects of conditional arms: one block per select, computed from its select leaves
    for (const m of armMuxes) narrowGroups.push({ outs: [], members: new Set(), select: m });
    for (const grp of narrowGroups) {
      const sigs = [...grp.members];
      const outsRead = grp.outs.filter((x) => readOutsideNarrow(x) || [...narrow].some((y) => !grp.members.has(y) && (comb.get(y) || []).includes(x)) || armMuxes.some((m) => m.selLeaves.includes(x)) || outPorts.has(x));
      const inputs = grp.select ? grp.select.selLeaves : [...new Set(sigs.flatMap((x) => comb.get(x) || []).filter((y) => !grp.members.has(y) && !isClock(y)))];
      const drawnInputs = inputs.filter((y) => !isConstTable(y));
      const exprs = sigs.map((x) => exprOf.get(x)).filter(Boolean);
      const sources = sigs.flatMap((x) => sourcesOf(x));
      let fn = null;
      const cite = (kind, structure, srcs = sources) => { const basis = reader?.valid ? basisOf(srcs, structure) : null; return basis ? { kind, basis } : null; };
      if (grp.select) fn = grp.select.isXor ? { kind: 'correction_enable' } : null;
      else if (exprs.length === sigs.length && exprs.every(isZeroCompare)) fn = cite('zero_detect', 'compare of each value with zero');
      else if (sigs.length === 1 && !exprOf.get(sigs[0]) && inputs.some(isConstTable) && reader?.valid) {
        const src = citeLine(sourcesOf(sigs[0])[0], /==|!=/, 0);
        const text = src ? reader.pinText(src) : '';
        if (/==|!=/.test(text ?? '') && /\[/.test(text ?? '')) fn = cite('position_match', 'equality compare against a constant table, one per position', [src]);
      } else if (grp.outs.length >= 2 && grp.outs.every((x) => bits(x) === 1) && grp.outs.every((x) => [...outPorts].some((o) => (comb.get(o) || []).includes(x)))) fn = { kind: 'classifier' };
      else if (exprs.length && exprs.every((x) => x.op === 'eq' || x.op === 'ne' || ['or', 'and'].includes(x.op) && (x.args || []).every((a) => a.op === 'eq' || a.op === 'ne'))) fn = cite('comparator', 'equality compares against constants');
      const outNames = grp.select ? [] : outsRead;
      if (!fn) {
        const what = grp.select ? `${portLabel(grp.select.t)} select` : outNames.length ? `${portLabel(outNames[0])} logic` : 'control logic';
        fn = { kind: 'custom', name: what.slice(0, 40) };
        review.push(`${what}: no structure recognized; named by role`);
      }
      const id = uid(grp.select ? `sel_${grp.select.t}` : `logic_${outNames[0] ?? sigs[0]}`);
      const covers = [...sigs.filter((x) => !outNames.includes(x)), ...inputs.filter(isConstTable)];
      const ports2 = [...drawnInputs.map((y) => ({ id: `i_${sanitize(y)}`, dir: 'in', width: bits(y) })), ...outNames.map((x) => ({ id: `o_${sanitize(x)}`, dir: 'out', width: bits(x) })), ...(grp.select ? [{ id: 'o_select', dir: 'out', width: grp.select.lanes }] : [])];
      const el = { id, kind: 'comb', op: 'custom', width: Math.max(1, ...ports2.filter((q) => q.dir === 'out').map((q) => q.width ?? 1)), function: fn, ...(covers.length ? { rtl: { covers } } : {}), ports: ports2 };
      elements.push(el);
      for (const x of sigs) owner.set(x, outNames.includes(x) ? { id, pin: `o_${sanitize(x)}` } : { id, pin: null, internal: true });
      opEls.push({ id, t: null, data: drawnInputs, group: true, select: grp.select ? { mux: grp.select.id, width: grp.select.lanes, label: fn.kind === 'correction_enable' ? 'correction enable' : `${portLabel(grp.select.t)} select` } : null });
    }
    for (const x of narrow) controlSignals.delete(x);
  }

  // Controller: control registers and narrow logic, when the module holds any.
  const ctrlInputs = new Set();
  const controllerNeeded = controlRegs.length > 0 ? true : controlSignals.size > 0 || muxEls.some((m) => !m.binary) || bankEls.length > 0;
  let controller = null;
  if (controllerNeeded) {
    const id = uid(controlRegs.length ? 'controller' : 'decode');
    controller = { id, kind: 'comb', op: 'custom', width: 1, function: controlRegs.length ? { kind: fsmRegs.size ? 'fsm' : 'controller' } : { kind: 'custom', name: 'Decode' }, rtl: { covers: [...controlSignals] }, ports: [] };
    if (controlRegs.length) controller.holds_state = true;
    elements.push(controller);
    for (const s of controlSignals) owner.set(s, { id, pin: null, internal: true });
  }

  tick('classifying selects and operators');
  // Nets: one per drawn signal from its owner's output pin to every reader pin.
  const netFor = new Map();
  const ctrlPort = (sigName, dir, width, extra = {}) => {
    const pid = `${dir === 'in' ? 'i' : 'o'}_${sanitize(sigName)}`;
    if (!controller.ports.some((q) => q.id === pid)) controller.ports.push({ id: pid, dir, width, label: extra.label ?? portLabel(sigName), ...(dir === 'in' && width === 1 && /(^|_)(valid|ready)(_|$)/.test(sigName) ? { role: 'handshake' } : {}), ...extra });
    return `${controller.id}.${pid}`;
  };
  // The endpoint that drives a signal (an owner's pin, or a controller output).
  const driverOf = (name) => {
    if (absorbed.has(name) && absorbed.get(name).length === 1) return driverOf(absorbed.get(name)[0]);
    const o = owner.get(name);
    if (!o) return null;
    if (o.pin) return { text: `${o.id}.${o.pin}`, signal: name };
    if (controller && o.id === controller.id) return { text: ctrlPort(name, 'out', bits(name)), signal: name };
    const port = elements.find((e) => e.id === o.id && e.kind === 'port' && e.dir === 'in');
    if (port) return { text: o.id, signal: name };
    return null;
  };
  const connect = (name, sinkText) => {
    const d = driverOf(name);
    if (!d) { notes.push(`no drawn driver for ${name} (read by ${sinkText})`); return; }
    const key = `${d.text}|${d.signal}`;
    if (!netFor.has(key)) {
      const n = { id: uid(`n_${d.signal}`), width: bits(d.signal), driver: d.text, sinks: [], rtl: { signal: d.signal } };
      netFor.set(key, n);
      nets.push(n);
    }
    if (!netFor.get(key).sinks.includes(sinkText)) netFor.get(key).sinks.push(sinkText);
  };
  const conceptual = (label, driver, sink, width) => nets.push({ id: uid(`n_${sanitize(label)}`), width, label, driver, sinks: [sink] });

  // Register banks: data into lanes, enables from the controller.
  for (const { el, bank, shared, single } of bankEls) {
    for (const r of bank.members) {
      const info = regInfo.get(r.name);
      for (const s of info.dataSrc.flatMap((x) => dataLeaves(x))) connect(s, el.shared_d || single ? `${el.id}.d` : `${el.id}.d_${sanitize(r.name)}`);
      for (const s of info.ctrlSrc) ctrlInputs.add(s);
    }
    if (controller) { const label = `${ROLE_LABEL[bank.role].replace(/ registers$/, '')} load${shared || single ? '' : 's'}`; const w = el.enable_width ?? 1; conceptual(label, ctrlPort(`load_${el.id}`, 'out', w, { ...(controlRegs.length ? { latency: 'state' } : {}), side: 'south', label }), `${el.id}.en`, w); }
  }
  // Pipeline bars: each lane from its data source.
  for (const e of elements.filter((x) => x.kind === 'pipeline_register')) {
    for (const lane of e.lanes) {
      const r = registers.find((x) => sanitize(x.name) === lane.id);
      for (const s of [...regInfo.get(r.name).dataSrc, ...regInfo.get(r.name).ctrlSrc]) connect(s, `${e.id}.d_${lane.id}`);
    }
  }
  // Muxes: inputs in bank order; select from the controller (or the select bit).
  for (const m of muxEls) {
    m.data.forEach((s, k) => connect(s, `${m.id}.in${k}`));
    if (m.binary) connect(m.ctrl[0], `${m.id}.sel`);
    else if (controller) {
      const label = `${portLabel(m.t)} select`;
      conceptual(label, ctrlPort(`sel_${m.t}`, 'out', m.data.length, { ...(controlRegs.length ? { latency: 'state' } : {}), side: 'south', label }), `${m.id}.sel`, m.data.length);
      for (const s of m.ctrl) ctrlInputs.add(s);
    }
  }
  // Conditional arms: the else value into in0, the operator result into in1.
  for (const m of armMuxes) {
    connect(m.elseLeaf, `${m.id}.in0`);
    nets.push({ id: uid(`n_${m.t}_update`), width: bits(m.t), driver: `${m.opId}.out`, sinks: [`${m.id}.in1`] });
  }
  // Operators, tables and narrow-logic blocks.
  for (const o of opEls) {
    if (o.group) {
      o.data.forEach((x) => connect(x, `${o.id}.i_${sanitize(x)}`));
      if (o.select) nets.push({ id: uid(`n_${sanitize(o.select.label)}`), width: o.select.width, label: o.select.label, driver: `${o.id}.o_select`, sinks: [`${o.select.mux}.sel`] });
      continue;
    }
    if (o.lut) { const addrW = o.ctrl.reduce((a, s) => a + (bits(s) ?? 1), 0); if (o.ctrl.length === 1 && bits(o.ctrl[0]) === addrW) connect(o.ctrl[0], `${o.id}.addr`); continue; }
    o.data.forEach((s, k) => connect(s, o.cluster ? `${o.id}.i_${sanitize(s)}` : `${o.id}.in${k}`));
  }
  // Instance inputs.
  for (const [netName, { inst, port }] of instIn) {
    const el = instanceEls.get(inst.name);
    if (!el || allClocks.has(canon(S(netName)))) continue;
    connect(netName, `${el.id}.${port}`);
  }
  // Output ports.
  for (const o of outPorts) {
    const srcs = comb.get(o) || [];
    const src = srcs.length === 1 ? srcs[0] : null;
    const pe = elements.find((e) => e.kind === 'port' && e.rtl?.signal === o);
    if (owner.get(o)?.id !== pe.id && owner.get(o)?.pin) connect(o, pe.id);
    else if (src && plainCopy(o) && owner.has(src) && !(controller && owner.get(src).id === controller.id)) connect(src, pe.id);
    else if (controller) {
      // An output port computed by control logic from several signals is a controller output.
      controlSignals.add(o);
      if (!controller.rtl.covers.includes(o)) controller.rtl.covers.push(o);
      owner.set(o, { id: controller.id, pin: null, internal: true });
      nets.push({ id: uid(`n_${o}`), width: bits(o), driver: ctrlPort(o, 'out', bits(o)), sinks: [pe.id], rtl: { signal: o } });
    }
  }
  // Controller inputs: every non-controller signal its logic reads.
  if (controller) {
    const reads = new Set();
    for (const s of controlSignals) for (const src of comb.get(s) || []) reads.add(src);
    for (const r of controlRegs) for (const src of [...(seq.get(r.name) || [])]) reads.add(src);
    for (const s of ctrlInputs) reads.add(s);
    for (const s of reads) {
      if (controlSignals.has(s) || isClock(s)) continue;
      const o = owner.get(s);
      if (!o || o.id === controller.id) continue;
      if (o.internal) continue;
      connect(s, ctrlPort(s, 'in', bits(s)));
    }
    const portSignals = new Map();
    const sigsOfPort = (q) => portSignals.get(q.id) ?? [q.id.slice(2)];
    // Output latency: per controller input, as the lump draft declares controller outputs (a bundle: its fastest member).
    const inSigs = controller.ports.filter((q) => q.dir === 'in').map((q) => ({ id: q.id, paths: sigsOfPort(q).map((x) => canon(S(x))) }));
    const stages = (outSigs, inPaths) => { const v = outSigs.flatMap((o) => inPaths.map((i) => stagesBetween(back, canon(S(o)), i, allClocks))).filter((x) => x !== null); return v.length ? Math.min(...v) : null; };
    for (const q of controller.ports.filter((x) => x.dir === 'out' && x.latency === undefined && controlRegs.length)) {
      const per = Object.fromEntries(inSigs.map((i) => [i.id, stages(sigsOfPort(q), i.paths)]).filter(([, v]) => v !== null));
      q.latency = Object.keys(per).length ? per : 'state';
    }
    controller.width = Math.max(1, ...controller.ports.map((q) => q.width ?? 1));
  }

  // Readable names from roles: an input register by the input that loads it, an
  // output register by the output it drives, a temporary by its place in its bank.
  const laneName = new Map();
  for (const { el, bank } of bankEls) {
    bank.members.forEach((r, k) => {
      const info = regInfo.get(r.name);
      const loadPort = info.dataSrc.find((x) => inPorts.has(x));
      const outPort = [...outPorts].find((o) => (comb.get(o) || []).length === 1 && comb.get(o)[0] === r.name);
      const name = bank.role === 'input' && loadPort ? portLabel(loadPort) : bank.role === 'output' && outPort ? portLabel(outPort) : `${bank.role} ${k + 1}`;
      laneName.set(r.name, name);
      const lane = el.lanes?.find((l) => l.id === sanitize(r.name));
      if (lane) lane.label = name;
    });
  }
  // Nets that run in parallel between the same two elements need names; a net
  // ending on a figure port is named by the port, and a lone net needs none.
  const portIds = new Set(elements.filter((e) => e.kind === 'port').map((e) => e.id));
  const elOf = (text) => String(text).split('.')[0];
  const pairCount = new Map();
  for (const n of nets) for (const k of new Set(n.sinks.map((x) => `${elOf(n.driver)}>${elOf(x)}`))) pairCount.set(k, (pairCount.get(k) || 0) + 1);
  for (const n of nets) {
    if (n.label || !n.rtl?.signal) continue;
    if (portIds.has(n.driver) || n.sinks.some((x) => portIds.has(x))) continue;
    if (!n.sinks.some((x) => pairCount.get(`${elOf(n.driver)}>${elOf(x)}`) > 1) && !laneName.has(n.rtl.signal)) continue;
    const name = laneName.get(n.rtl.signal) ?? portLabel(n.rtl.signal);
    // (an unreadable identifier is not printed; the role pass below names the net or lists it for review)
    if (/^[a-z]{1,3}( ?\d+)*$/i.test(name.replace(/ /g, '')) || name.replace(/[^a-z]/gi, '').length <= 3) continue;
    n.label = name;
  }
  // Net labels from roles (rule 5): the producing block's function and the value's role; a
  // pipeline lane carries its source's role; a label left derived from an RTL identifier is listed.
  const elById = new Map(elements.map((x) => [x.id, x]));
  const ROLE = { syndrome: 'syndrome', error_locator: 'error location', error_evaluator: 'error values', position_match: 'position match', zero_detect: 'zero flag', correction_enable: 'correction enable', gf_add: 'corrected values', classifier: null };
  const roleOfNet = (n, depth = 0) => {
    if (depth > 8) return null;
    const [elId, pin] = String(n.driver).split('.');
    const el = elById.get(elId);
    if (!el || el.kind === 'port') return null;
    if (el.kind === 'pipeline_register' && pin?.startsWith('q_')) { const d = nets.find((x) => x.sinks.includes(`${elId}.d_${pin.slice(2)}`)); return d ? roleOfNet(d, depth + 1) : null; }
    if (el.kind === 'comb' && el.op === 'concat') return n.sinks.some((x) => elById.get(String(x).split('.')[0])?.function?.kind === 'syndrome') ? 'symbols' : 'joined word';
    if (el.kind === 'mux' && armMuxes.some((m) => m.id === el.id)) return 'corrected symbols';
    const base = ROLE[el.function?.kind];
    if (!base) return null;
    const outsOf = (el.ports || []).filter((q) => q.dir === 'out');
    const k = outsOf.findIndex((q) => q.id === pin);
    return outsOf.length > 1 && k >= 0 ? `${base} ${k + 1}` : base;
  };
  const usedLabels = new Set(nets.map((n) => n.label).filter(Boolean));
  for (const n of nets) {
    const role = roleOfNet(n);
    const isRtlDerived = n.label && n.rtl?.signal && n.label === portLabel(n.rtl.signal) && !laneName.has(n.rtl.signal);
    if (role && (!n.label || isRtlDerived) && !usedLabels.has(role) && !portIds.has(n.driver) && !n.sinks.some((x) => portIds.has(x))) {
      if (n.label) usedLabels.delete(n.label);
      n.label = role;
      usedLabels.add(role);
      continue;
    }
    // The role is already printed upstream, or the net is a pipeline lane carrying a figure input on: no second label.
    const laneOut = elById.get(String(n.driver).split('.')[0])?.kind === 'pipeline_register';
    if (isRtlDerived && ((role && usedLabels.has(role)) || laneOut)) { usedLabels.delete(n.label); delete n.label; continue; }
    if (isRtlDerived && n.label) review.push(`net ${n.id}: label "${n.label}" is derived from the RTL identifier ${n.rtl.signal}`);
  }
  for (const r of review) notes.push(`name to review: ${r}`);

  // Internal signals no element owns (constants, absorbed wiring) are covered by the element that reads them.
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const t of [...comb.keys()]) {
    if (owner.has(t) || portNames.has(t)) continue;
    const reader = [...comb.entries()].find(([x, srcs]) => srcs.includes(t) && owner.has(x) && byId.get(owner.get(x).id)?.kind !== 'port');
    const el = reader ? byId.get(owner.get(reader[0]).id) : null;
    if (!el || ['port', 'mux', 'register', 'pipeline_register'].includes(el.kind) || (el.kind === 'comb' && el.op !== 'custom')) continue;
    el.rtl = { ...(el.rtl || {}), covers: [...new Set([...(el.rtl?.covers || []), t])] };
  }

  const modName = mod.orig_name;
  const scopeText = scope ? `instance ${scope} (${modName})` : `the whole design (top ${modName})`;
  const doc = {
    schema_version: 1,
    figure_type: 'datapath',
    meta: {
      title: title ?? `register-transfer view of ${modName}`,
      caption: `Block view of ${scopeText}, drawn as a register-transfer datapath: register banks with load enables, operand selects, operators and a controller with dashed selects and enables. Draft generated from the netlist: refine names.`,
      print: { profile: 'ieee', variants: ['1col', '2col'], ...(format ? { format } : {}) },
      scope: { ...(scope ? { instance: scope } : {}), hierarchy: 'all' },
      ...(scope ? { rtl: { instance: scope } } : {}),
      ...(repository ? { repository } : {}),
    },
    view: { preset: 'block', scope },
    clock_domains: [domain],
    elements,
    nets,
  };
  notes.push(`register-transfer style: ${bankEls.length} register bank(s), ${elements.filter((e) => e.kind === 'pipeline_register').length} pipeline bar(s), ${muxEls.length} mux(es), ${opEls.length} operator(s), ${instanceEls.size} instance block(s)${controller ? `, ${controller.id} with ${controller.ports.length} ports` : ''}`);
  // Mux fan-in: bank lanes, bank order and mux stacking ordered for the fewest crossings; mux inputs keep their select order.
  const fan = orderFanIn(doc);
  if (fan.report) notes.push(fan.report.changed
    ? `mux fan-in: ${fan.report.before} → ${fan.report.after} crossings between bank lanes and mux inputs (lanes and bank order permuted; mux input order unchanged)`
    : `mux fan-in: ${fan.report.before} crossings between bank lanes and mux inputs, already the fewest with each bank drawn whole (lane order kept)`);
  return { doc: fan.doc, notes };
}
