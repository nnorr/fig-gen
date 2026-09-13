// Structural cross-checks of figures against a normalized netlist
// (SPEC §11.5, §7). They yield at most verification level structural-only.
// Callers delivering real figures must run the evidence guard first
// (lib/evidence.mjs); these functions only compare structure.

import { diagnostic } from '../diagnostics.mjs';
import { buildModel, pinLatency } from '../ir/datapath-model.mjs';
import { netSignalPaths } from '../checks/bundle-members.mjs';
import { parseHex } from '../checks/memory-map.mjs';
import { backwardReach, flattenNetlist } from './flatten.mjs';

const instPath = (top, rel) => [top, ...(rel ? rel.split('/') : [])].join('.');

export function crosscheckDatapath(doc, netlist) {
  const diagnostics = [];
  const add = (code, message, subject = {}, evidence = {}, supportedFixes = [], severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  const flat = flattenNetlist(netlist);
  const model = buildModel(doc);
  const base = doc.meta?.rtl?.instance;
  const stats = { netsMapped: 0, netsTotal: model.nets.length, registersMatched: 0, transfersChecked: 0, muxOrderChecked: 0, latenciesChecked: 0, boundariesChecked: 0 };

  if (!flat.instances.has(instPath(flat.top, base))) {
    add('rtl/instance-missing', `figure instance ${base ?? '(top)'} not found under ${flat.top}`, { instance: base }, { hierarchy: [...flat.instances.keys()] }, ['fix meta.rtl.instance']);
    return { diagnostics, stats };
  }
  const sigPath = (rtl) => (rtl?.signal ? `${instPath(flat.top, rtl.instance ?? base)}.${rtl.signal}` : null);
  const netSig = new Map();
  for (const n of model.nets) {
    const p = sigPath(n.net.rtl);
    if (!p) continue;
    const s = flat.signals.get(p);
    if (!s) { add('rtl/unknown-signal', `net ${n.net.id}: ${p} not found in the netlist`, { id: n.net.id }, { path: p }, ['fix rtl.signal / rtl.instance']); continue; }
    netSig.set(n.net.id, p);
    stats.netsMapped += 1;
    const bits = n.net.rtl.slice ? sliceWidth(n.net.rtl.slice) : s.bits;
    if (n.width !== null && bits !== n.width) add('rtl/width-mismatch', `net ${n.net.id} is ${n.width} bits, ${p}${n.net.rtl.slice ? `[${n.net.rtl.slice}]` : ''} is ${bits} bits`, { id: n.net.id }, { figure: n.width, rtl: bits }, ['fix the net width', 'map the net to the right signal or slice']);
  }

  // Signals a net stands for: its mapping, or the resolvable members of a bundle.
  const sigsOf = (n) => (netSig.has(n.net.id) ? [netSig.get(n.net.id)] : n.net.rtl?.signal ? [] : netSignalPaths(n, flat, base).paths.filter((p) => flat.signals.has(p)));
  stats.bundleMembersChecked = 0;
  const domains = new Map((doc.clock_domains || []).map((d) => [d.id, d]));
  const netsInto = (id, pinId) => model.nets.filter((n) => n.sinks.some((s) => !s.error && s.element.id === id && (!pinId || s.pin.id === pinId)));
  const netsOutOf = (id, pinId) => model.nets.filter((n) => !n.driver.error && n.driver.element.id === id && (!pinId || n.driver.pin.id === pinId));
  const reaches = (target, sources, maxSeq, exactSeq) => {
    const dist = backwardReach(flat, target, { maxSeq });
    return sources.filter((s) => dist.has(s) && (exactSeq === undefined || dist.get(s) === exactSeq));
  };

  const checkRegister = (el, qSig, dSigs, label) => {
    const s = flat.signals.get(qSig);
    if (!s.register) { add('rtl/not-a-register', `${label}: ${qSig} is not a register in the RTL`, { id: el.id }, {}, ['map to the register signal', 'model the element as combinational']); return; }
    stats.registersMatched += 1;
    const dom = domains.get(el.domain);
    if (dom && s.register.clock.net !== dom.clock && s.register.clock_root !== dom.clock) {
      add('rtl/domain-mismatch', `${label}: ${qSig} is clocked by ${s.register.clock.net} (root ${s.register.clock_root}), figure domain ${el.domain} uses ${dom.clock}`, { id: el.id }, {}, ['fix the clock domain', 'fix the mapping']);
    }
    if (dSigs.length) {
      stats.transfersChecked += 1;
      if (!reaches(qSig, dSigs, 1, 1).length) add('rtl/no-structural-path', `${label}: ${qSig} is not loaded from ${dSigs.join(', ')} through one register stage`, { id: el.id }, { q: qSig, d: dSigs }, ['fix the d/q net mappings', 'fix the figure structure']);
    }
  };

  // A d-net carried by an unnamed RTL expression has no signal; fall back to
  // the mapped inputs of the element that drives it (still one stage away).
  const dSignals = (nets) => {
    const direct = nets.map((n) => netSig.get(n.net.id)).filter(Boolean);
    if (direct.length) return direct;
    return nets.flatMap((n) => (n.driver.error ? [] : netsInto(n.driver.element.id).map((m) => netSig.get(m.net.id)).filter(Boolean)));
  };
  for (const { el, pins } of model.elements.values()) {
    if (el.kind === 'register') {
      const q = netsOutOf(el.id, 'q').map((n) => netSig.get(n.net.id)).find(Boolean) ?? sigPath(el.rtl);
      if (q && flat.signals.has(q)) checkRegister(el, q, dSignals(netsInto(el.id, 'd')), `register ${el.id}`);
      continue;
    }
    if (el.kind === 'pipeline_register') {
      for (const lane of el.lanes) {
        const q = netsOutOf(el.id, `q_${lane.id}`).map((n) => netSig.get(n.net.id)).find(Boolean) ?? sigPath(lane.rtl ? { instance: el.rtl?.instance, ...lane.rtl } : null);
        if (q && flat.signals.has(q)) checkRegister(el, q, dSignals(netsInto(el.id, `d_${lane.id}`)), `pipeline ${el.id}.${lane.id}`);
      }
      continue;
    }
    if (el.kind === 'instance' && el.rtl?.instance) {
      const p = instPath(flat.top, el.rtl.instance);
      const mod = flat.instances.get(p);
      if (!mod) add('rtl/instance-missing', `instance ${el.id}: ${p} not found`, { id: el.id }, {}, ['fix rtl.instance']);
      else {
        stats.boundariesChecked += 1;
        diagnostics.push(...boundaryDiagnostics(`instance ${el.id}`, el.id, pins.map((q) => ({ id: q.id, dir: q.dir, width: q.width, bundle: q.bundle })), mod));
      }
    }
    if (el.kind === 'port') continue;
    // Clock and reset nets are not data dependencies; don't reachability-check them.
    const dataIns = netsInto(el.id).filter((n) => n.net.class !== 'clock' && n.net.class !== 'reset');
    // A bundle net is checked through its member signals (G3): mapped when any member resolves.
    const ins = dataIns.flatMap((n) => sigsOf(n));
    const outNets = netsOutOf(el.id).filter((n) => sigsOf(n).length);
    if (!ins.length || !outNets.length) continue;
    // An output may also depend on an input the figure does not map; then
    // "no mapped input reaches it" proves nothing.
    const unmappedIn = dataIns.some((n) => !sigsOf(n).length);
    const baseSeq = el.kind === 'memory' || el.kind === 'synchronizer' || el.kind === 'instance' ? 4 : 0;
    const usedInputs = new Set();
    for (const n of outNets) {
      const outs = sigsOf(n);
      // A registered output (collapsed block with registers) reaches its inputs through its declared stages.
      const maxSeq = Math.max(baseSeq, pinLatency(el, pins.find((q) => q.id === n.driver.pin.id)));
      stats.transfersChecked += 1;
      if (outs.length > 1) stats.bundleMembersChecked += outs.length;
      const hit = outs.flatMap((o) => reaches(o, ins, maxSeq));
      hit.forEach((h) => usedInputs.add(h));
      if (!hit.length && !unmappedIn) add('rtl/no-structural-path', `${el.kind} ${el.id}: ${outs.length > 1 ? `no member of bundle ${n.net.id}` : outs[0]} does not depend on any mapped input (${ins.join(', ')})${maxSeq ? '' : ' through combinational logic'}`, { id: el.id }, { output: outs, inputs: ins }, ['fix the net mappings', 'fix the figure structure']);
    }
    // An input (or every member of an input bundle) that reaches no mapped output.
    for (const n of dataIns.filter((x) => sigsOf(x).length && !sigsOf(x).some((s) => usedInputs.has(s)))) add('rtl/input-unused', `${el.kind} ${el.id}: mapped input ${sigsOf(n).length > 1 ? `bundle ${n.net.id}` : sigsOf(n)[0]} does not reach any mapped output`, { id: el.id }, {}, ['check the mapping'], 'warning');
  }

  // mux input order against extracted RTL conditionals (2:1)
  for (const { el } of model.elements.values()) {
    if (el.kind !== 'mux' || el.inputs !== 2) continue;
    const outSig = netsOutOf(el.id, 'out').map((n) => netSig.get(n.net.id)).find(Boolean);
    if (!outSig) continue;
    const s = flat.signals.get(outSig);
    const mod = flat.instances.get(s.instance);
    const rec = (mod.muxes || []).find((m) => m.target === s.name);
    const candidates = (pinId) => {
      const nets = netsInto(el.id, pinId);
      const direct = nets.map((n) => netSig.get(n.net.id)).filter(Boolean);
      const viaDriver = nets.flatMap((n) => (n.driver.error ? [] : netsInto(n.driver.element.id).map((m) => netSig.get(m.net.id)).filter(Boolean)));
      return new Set([...direct, ...viaDriver].map((p) => p.split('.').pop()));
    };
    if (!rec) { add('rtl/mux-unverified', `mux ${el.id}: no conditional assignment to ${s.name} found in the RTL`, { id: el.id }, {}, [], 'info'); continue; }
    const in0 = candidates('in0');
    const in1 = candidates('in1');
    const T = new Set(rec.in1);
    const E = new Set(rec.in0);
    const count = (set, ref) => [...set].filter((x) => ref.has(x)).length;
    const straight = count(in0, E) + count(in1, T);
    const swapped = count(in0, T) + count(in1, E);
    stats.muxOrderChecked += 1;
    if (swapped > straight) add('rtl/mux-order', `mux ${el.id}: inputs appear swapped relative to ${s.name} = ${rec.sel.join('&')} ? {${rec.in1}} : {${rec.in0}}`, { id: el.id }, { rtl: rec }, ['swap in0/in1 in the figure']);
    else if (swapped === straight) add('rtl/mux-unverified', `mux ${el.id}: input order could not be distinguished from the RTL`, { id: el.id }, { rtl: rec }, [], 'info');
  }

  // latency annotations
  const sigAt = (text) => model.nets.find((n) => netSig.has(n.net.id) && (n.driver.text === text || n.sinks.some((s) => s.text === text)));
  for (const a of (doc.annotations || []).filter((x) => x.kind === 'latency' && x.from && x.to && x.cycles !== undefined)) {
    const f = sigAt(a.from);
    const t = sigAt(a.to);
    if (!f || !t) { add('rtl/latency-unverified', `latency ${a.from}→${a.to}: endpoints are not mapped to RTL signals`, { from: a.from, to: a.to }, {}, ['map the nets at both ends'], 'warning'); continue; }
    const dist = backwardReach(flat, netSig.get(t.net.id), { maxSeq: 64 });
    const got = dist.get(netSig.get(f.net.id));
    stats.latenciesChecked += 1;
    if (got === undefined) add('rtl/latency-unverified', `latency ${a.from}→${a.to}: no RTL path found`, { from: a.from, to: a.to }, {}, [], 'warning');
    else if (got !== a.cycles) add('rtl/latency-mismatch', `latency ${a.from}→${a.to}: figure says ${a.cycles} cycles, RTL minimum register stages ${got}`, { from: a.from, to: a.to }, { figure: a.cycles, rtl: got }, ['fix the annotation', 'fix the figure structure']);
  }

  return { diagnostics, stats };
}

function sliceWidth(slice) {
  const [hi, lo = hi] = String(slice).split(':').map(Number);
  return Math.abs(hi - lo) + 1;
}

// A drawn boundary (blackbox / collapsed block / SoC block) must expose
// exactly the RTL module's ports with the same directions and widths.
export function boundaryDiagnostics(label, id, drawnPorts, mod) {
  const out = [];
  const rtl = new Map(mod.ports.map((p) => [p.name, p]));
  const drawn = new Map(drawnPorts.flatMap((p) => (p.bundle ? p.bundle.map((b) => [b, p]) : [[p.id, p]])));
  const push = (message, evidence) => out.push(diagnostic({ code: 'rtl/boundary-mismatch', message: `${label}: ${message}`, subject: { id }, evidence, supportedFixes: ['make the drawn ports equal the RTL module ports', 'map the block to the right module'] }));
  for (const p of drawnPorts.filter((q) => q.bundle)) {
    // A bundled pin stands for several RTL ports: each must exist with the
    // pin's direction, and their widths must add up to the drawn width.
    const parts = p.bundle.map((b) => rtl.get(b));
    p.bundle.forEach((b, k) => {
      if (!parts[k]) push(`bundled port ${b} (in ${p.id}) does not exist on ${mod.orig_name}`, { port: b, bundle: p.id });
      else if (parts[k].dir !== 'unknown' && parts[k].dir !== p.dir) push(`bundled port ${b} (in ${p.id}) is ${parts[k].dir} in ${mod.orig_name}, the bundle is ${p.dir}`, { port: b, bundle: p.id });
    });
    const sum = parts.reduce((a, r) => a + (r?.width ?? 0), 0);
    if (parts.every(Boolean) && p.width !== null && p.width !== undefined && sum !== p.width) push(`bundle ${p.id} is ${p.width} bits in the figure, its ports ${p.bundle.join('+')} total ${sum} bits`, { bundle: p.id, figure: p.width, rtl: sum });
  }
  for (const p of drawnPorts.filter((q) => !q.bundle)) {
    const r = rtl.get(p.id);
    if (!r) { push(`port ${p.id} does not exist on ${mod.orig_name}`, { port: p.id }); continue; }
    if (r.dir !== 'unknown' && r.dir !== p.dir) push(`port ${p.id} is ${p.dir} in the figure, ${r.dir} in ${mod.orig_name}`, { port: p.id });
    if (p.width !== null && p.width !== undefined && r.width !== p.width) push(`port ${p.id} is ${p.width} bits in the figure, ${r.width} bits in ${mod.orig_name}`, { port: p.id, figure: p.width, rtl: r.width });
  }
  for (const r of mod.ports) if (!drawn.has(r.name)) push(`RTL port ${r.name} [${r.width}] of ${mod.orig_name} is missing from the figure`, { port: r.name });
  return out;
}

export function crosscheckSoc(doc, netlist) {
  const diagnostics = [];
  const add = (code, message, subject = {}, evidence = {}, supportedFixes = [], severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  const flat = flattenNetlist(netlist);
  const stats = { blocksChecked: 0, boundariesChecked: 0, paramsChecked: 0, windowsChecked: 0, busPortsChecked: 0, irqChecked: 0, streamEndsChecked: 0 };
  const topModule = flat.instances.get(flat.top);
  const pathOf = (rtl) => (rtl?.top ? flat.top : instPath(flat.top, rtl?.instance));
  const paramValue = (moduleRec, name) => {
    if (!moduleRec) return undefined;
    if (moduleRec.params && Object.hasOwn(moduleRec.params, name)) return moduleRec.params[name];
    return moduleRec.nets.find((n) => n.kind === 'param' && n.name === name)?.value;
  };
  const asBig = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return BigInt(v);
    if (/^0x[0-9a-f]+$/i.test(v) || /^-?\d+$/.test(v)) return BigInt(v);
    return null;
  };

  const blocks = new Map((doc.blocks || []).map((b) => [b.id, b]));
  for (const b of blocks.values()) {
    if (!b.rtl?.instance && !b.rtl?.top) continue;
    stats.blocksChecked += 1;
    const p = pathOf(b.rtl);
    const mod = flat.instances.get(p);
    if (!mod) { add('rtl/instance-missing', `block ${b.id}: instance ${p} not found`, { id: b.id }, { hierarchy: [...flat.instances.keys()] }, ['fix rtl.instance']); continue; }
    if (b.rtl.module && mod.orig_name !== b.rtl.module) add('rtl/module-mismatch', `block ${b.id}: ${p} is ${mod.orig_name}, figure says ${b.rtl.module}`, { id: b.id }, {}, ['fix rtl.module']);
    if (b.ports) {
      stats.boundariesChecked += 1;
      diagnostics.push(...boundaryDiagnostics(`block ${b.id}`, b.id, b.ports, mod));
    }
  }

  const parentAndInst = (rel) => {
    const parts = rel.split('/');
    const parent = flat.instances.get(instPath(flat.top, parts.slice(0, -1).join('/') || undefined));
    return { parent, inst: parent?.instances.find((i) => i.name === parts[parts.length - 1]) };
  };

  for (const at of doc.attachments || []) {
    if (!at.rtl?.instance && !at.rtl?.top) continue;
    const childMod = flat.instances.get(pathOf(at.rtl));
    if (!childMod) { add('rtl/instance-missing', `attachment ${at.id}: instance ${pathOf(at.rtl)} not found`, { id: at.id }, {}, ['fix rtl.instance']); continue; }
    const { parent, inst } = at.rtl.top ? { parent: null, inst: null } : parentAndInst(at.rtl.instance);
    for (const [key, expected] of [['base_param', at.address?.base], ['size_param', at.address?.size]]) {
      const name = at.rtl[key];
      if (!name || !expected) continue;
      stats.paramsChecked += 1;
      const value = paramValue(childMod, name) ?? paramValue(parent, name) ?? paramValue(topModule, name);
      if (value === undefined) { add('rtl/param-missing', `attachment ${at.id}: parameter ${name} not found on ${pathOf(at.rtl)} or its parent`, { id: at.id }, {}, [`fix rtl.${key}`]); continue; }
      const got = asBig(value);
      if (got === null || got !== parseHex(expected)) add('rtl/param-mismatch', `attachment ${at.id}: ${name} = ${value} in RTL, figure says ${expected}`, { id: at.id }, { rtl: String(value), figure: expected }, ['fix the figure address', 'fix the RTL parameter']);
    }
    if (at.rtl.addr_port && at.address) {
      stats.windowsChecked += 1;
      const port = childMod.ports.find((q) => q.name === at.rtl.addr_port);
      const base = parseHex(at.address.base);
      const size = at.address.size ? parseHex(at.address.size) : parseHex(at.address.end) - base + 1n;
      if (!port) add('rtl/addr-window-mismatch', `attachment ${at.id}: address port ${at.rtl.addr_port} not found on ${childMod.orig_name}`, { id: at.id }, {}, ['fix rtl.addr_port']);
      else if (size !== 1n << BigInt(port.width)) add('rtl/addr-window-mismatch', `attachment ${at.id}: window size 0x${size.toString(16)} does not match ${at.rtl.addr_port}[${port.width - 1}:0] (0x${(1n << BigInt(port.width)).toString(16)})`, { id: at.id }, { size: `0x${size.toString(16)}`, port_width: port.width }, ['fix the window size', 'fix rtl.addr_port']);
    }
    if (at.rtl.port && inst) {
      const conns = inst.connections.filter((c) => c.port.startsWith(at.rtl.port));
      stats.busPortsChecked += conns.length;
      if (!conns.length) add('rtl/bus-port-unconnected', `attachment ${at.id}: no ports with prefix '${at.rtl.port}' on ${at.rtl.instance}`, { id: at.id }, {}, ['fix rtl.port']);
      for (const c of conns.filter((x) => x.expr.kind === 'open')) add('rtl/bus-port-unconnected', `attachment ${at.id}: ${at.rtl.instance}.${c.port} is unconnected`, { id: at.id, port: c.port }, {}, ['connect the port in RTL']);
    }
  }

  // Stream interfaces (G13): the source end drives tvalid and tdata and reads
  // tready; the sink end the opposite; tdata is data_width bits.
  for (const i of doc.interfaces || []) {
    for (const [end, role] of [['from', 'source'], ['to', 'sink']]) {
      const e = i.rtl?.[end];
      if (!e || (!e.instance && !e.top)) continue;
      const p = pathOf(e);
      const m = flat.instances.get(p);
      if (!m) { add('rtl/instance-missing', `interface ${i.id}.${end}: instance ${p} not found`, { id: i.id, end }, {}, [`fix rtl.${end}.instance`]); continue; }
      stats.streamEndsChecked += 1;
      const want = { tvalid: role === 'source' ? 'out' : 'in', tready: role === 'source' ? 'in' : 'out', tdata: role === 'source' ? 'out' : 'in' };
      for (const [suffix, dir] of Object.entries(want)) {
        const q = m.ports.find((x) => x.name.toLowerCase() === `${e.prefix}${suffix}`.toLowerCase());
        if (!q) {
          if (suffix !== 'tdata' || i.data_width) add('rtl/stream-port-missing', `interface ${i.id}: ${m.orig_name} has no port ${e.prefix}${suffix} for the ${role} end`, { id: i.id, end }, {}, [`fix rtl.${end}.prefix`]);
          continue;
        }
        if (q.dir !== dir) add('rtl/stream-direction', `interface ${i.id}: ${m.orig_name}.${q.name} is an ${q.dir}put, but the ${role} end of a stream has ${suffix} as ${dir}put`, { id: i.id, end, port: q.name }, {}, ['swap from/to', `fix rtl.${end}.prefix`]);
        if (suffix === 'tdata' && i.data_width && q.width !== i.data_width) add('rtl/stream-width', `interface ${i.id}: ${m.orig_name}.${q.name} is ${q.width} bits, the figure says ${i.data_width}`, { id: i.id, end, port: q.name }, { rtl: q.width, figure: i.data_width }, ['fix data_width']);
      }
    }
  }

  for (const l of (doc.links || []).filter((x) => x.class === 'interrupt')) {
    const from = blocks.get(l.from);
    const to = blocks.get(l.to);
    if (!(from?.rtl?.instance || from?.rtl?.top) || !(to?.rtl?.instance || to?.rtl?.top)) continue;
    const fromPath = pathOf(from.rtl);
    const toPath = pathOf(to.rtl);
    const fromMod = flat.instances.get(fromPath);
    const toMod = flat.instances.get(toPath);
    if (!fromMod || !toMod) continue;
    stats.irqChecked += 1;
    const srcPorts = fromMod.ports.filter((p) => p.dir === 'out' && (l.rtl?.port ? p.name === l.rtl.port : /irq|int/i.test(p.name)));
    const dstPorts = toMod.ports.filter((p) => p.dir === 'in' && (l.rtl?.signal ? p.name === l.rtl.signal : /irq|int/i.test(p.name)));
    const connectedPair = dstPorts.some((d) => {
      const dist = backwardReach(flat, `${toPath}.${d.name}`, { maxSeq: 0 });
      return srcPorts.some((s) => dist.has(`${fromPath}.${s.name}`));
    });
    if (!connectedPair) add('rtl/irq-unconnected', `interrupt link ${l.id}: no combinational connection from ${fromPath} (${srcPorts.map((p) => p.name).join(', ') || 'no irq output'}) to ${toPath} (${dstPorts.map((p) => p.name).join(', ') || 'no irq input'})`, { id: l.id }, {}, ['fix the RTL wiring', 'set link rtl.port / rtl.signal']);
    else if (l.irq !== undefined) add('rtl/irq-line-unverified', `interrupt link ${l.id}: connection found; line number ${l.irq} is not checked structurally`, { id: l.id }, {}, [], 'info');
  }

  return { diagnostics, stats };
}
