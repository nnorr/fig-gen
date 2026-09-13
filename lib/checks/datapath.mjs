// Datapath semantic checks (SPEC §8). Pure functions over the IR; run after
// schema validation and before layout.

import { diagnostic } from '../diagnostics.mjs';
import { buildModel, pinLatency } from '../ir/datapath-model.mjs';

// Blocks whose outputs may declare latency per input or as "state" (SPEC §4.7).
export const STATEFUL_KINDS = Object.freeze(['controller', 'fsm', 'bus_slave', 'csr_bank', 'arbiter']);
// Any other block may opt in with holds_state: true; with a netlist the latency
// check requires a register with feedback in what the block represents.
export const declaresState = (el) => STATEFUL_KINDS.includes(el?.function?.kind) || el?.holds_state === true;

// A pin's bundle member list: the model pin, else the element's declared port.
const pinBundle = (end) => (Array.isArray(end?.pin?.bundle) ? end.pin.bundle : end?.element?.ports?.find((p) => p.id === end?.pin?.id)?.bundle);
const bundleEnd = (end) => Array.isArray(pinBundle(end));

export const DATAPATH_CHECK_CODES = Object.freeze([
  'ir/duplicate-id', 'ir/unknown-param', 'endpoint/unknown', 'endpoint/direction', 'endpoint/multiple-drivers',
  'endpoint/unconnected', 'width/mismatch', 'width/sub-bundle-cover', 'width/slice-range', 'width/concat-sum', 'mux/sel-width', 'mux/input-index',
  'mux/lanes', 'register/unknown-domain', 'memory/addr-width', 'comb/loop', 'comb/loop-unknown', 'comb/unknown-input', 'cdc/unsynchronized',
  'cdc/sync-domain-mismatch', 'cdc/multibit-ff-sync', 'cdc/domain-assertion', 'path/not-connected', 'latency/stage-count',
]);

// A net that carries several different signals: declared (bundle_of) or
// ending on a bundled pin (port_def.bundle).
export function isBundleNet(n) {
  if (n.net.bundle_of?.length >= 2) return true;
  return [n.driver, ...n.sinks].some((e) => !e.error && (e.pin?.bundle?.length ?? 0) >= 2);
}

export function checkDatapath(doc) {
  const diagnostics = [];
  const add = (code, message, subject = {}, evidence = {}, supportedFixes = [], severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  const model = buildModel(doc);
  const { elements, nets } = model;

  // ids
  for (const [label, list] of [['element', doc.elements || []], ['net', doc.nets || []], ['clock domain', doc.clock_domains || []]]) {
    const seen = new Set();
    for (const item of list) {
      if (seen.has(item.id)) add('ir/duplicate-id', `duplicate ${label} id '${item.id}'`, { id: item.id }, {}, ['rename one of the duplicates']);
      seen.add(item.id);
    }
  }
  for (const e of model.ctx.errors) {
    const code = e.error.code === 'ir/unknown-param' ? 'ir/unknown-param' : 'width/mismatch';
    add(code, `${e.element ? `element ${e.element}` : `net ${e.net}`}: ${e.error.message}`, { id: e.element ?? e.net }, { what: e.what }, ['define the param in params', 'fix the width expression']);
  }

  const domains = new Map((doc.clock_domains || []).map((d) => [d.id, d]));
  for (const { el } of elements.values()) {
    for (const key of ['domain', 'from', 'to']) {
      if (['register', 'pipeline_register', 'memory', 'synchronizer'].includes(el.kind) && el[key] && !domains.has(el[key])) {
        add('register/unknown-domain', `element ${el.id}: ${key} '${el[key]}' is not a declared clock domain`, { id: el.id }, {}, ['declare the domain in clock_domains', 'fix the domain id']);
      }
    }
    if (el.kind === 'mux') {
      for (const k of Object.keys(el.input_labels || {})) if (Number(k) >= el.inputs) add('mux/input-index', `mux ${el.id}: input_labels key ${k} is not < inputs (${el.inputs})`, { id: el.id }, {}, ['remove the label', 'increase inputs']);
      const dw = elements.get(el.id).pins.find((p) => p.id === 'out').width;
      if (el.lanes && dw !== null && dw % el.lanes !== 0) add('mux/lanes', `mux ${el.id}: width ${dw} is not divisible by lanes ${el.lanes}`, { id: el.id }, {}, ['fix lanes or width']);
    }
    if (el.kind === 'comb' && el.op === 'concat') {
      const pins = elements.get(el.id).pins;
      const sum = pins.filter((p) => p.dir === 'in').reduce((a, p) => (a === null || p.width === null ? null : a + p.width), 0);
      const out = pins.find((p) => p.id === 'out').width;
      if (sum !== null && out !== null && sum !== out) add('width/concat-sum', `concat ${el.id}: inputs sum to ${sum} bits, output is ${out}`, { id: el.id }, { sum, out }, ['fix in_widths', 'fix width']);
    }
    if (el.kind === 'synchronizer' && ['ff2', 'ff3'].includes(el.style)) {
      const w = elements.get(el.id).pins[0].width;
      if (w > 1) add('cdc/multibit-ff-sync', `synchronizer ${el.id}: ${w}-bit bus through a flop synchronizer can capture torn values`, { id: el.id }, {}, ['use style gray, handshake or async_fifo'], 'warning');
    }
  }

  // endpoints, directions, widths
  const sinkUse = new Map();
  const connected = new Set();
  for (const n of nets) {
    const ends = [['driver', n.driver], ...n.sinks.map((s) => ['sink', s])];
    for (const [role, end] of ends) {
      if (end.error) {
        const why = { syntax: 'is not a valid endpoint', hierarchy: 'uses hierarchy, which needs an expanded instance (not supported yet)', element: 'names an unknown element', pin: 'names an unknown pin' }[end.error];
        add('endpoint/unknown', `net ${n.net.id}: ${role} '${end.text}' ${why}`, { id: n.net.id }, { endpoint: end.text }, ['fix the element or pin name']);
        continue;
      }
      connected.add(`${end.element.id}.${end.pin.id}`);
      if (!end.sliceOk) add('width/slice-range', `net ${n.net.id}: slice in '${end.text}' is outside ${end.pin.width}-bit pin or msb < lsb`, { id: n.net.id }, {}, ['fix the slice']);
      const okDir = role === 'driver' ? ['out', 'inout'].includes(end.pin.dir) : ['in', 'inout'].includes(end.pin.dir);
      if (!okDir) add('endpoint/direction', `net ${n.net.id}: ${role} '${end.text}' is an ${end.pin.dir} pin`, { id: n.net.id }, {}, ['swap driver and sink', 'connect the other pin']);
      if (role === 'sink') {
        const key = `${end.element.id}.${end.pin.id}`;
        sinkUse.set(key, [...(sinkUse.get(key) || []), n.net.id]);
      }
      // A named heterogeneous bundle (the driver pin lists its members) may reach
      // sink pins that each take a named sub-bundle; their cover is checked below.
      if (role === 'sink' && n.width !== null && end.width !== null && end.width < n.width && !end.ep?.slice && bundleEnd(n.driver) && bundleEnd(end)) continue;
      if (n.width !== null && end.width !== null && end.width !== n.width) {
        const isSel = end.element.kind === 'mux' && end.pin.id === 'sel';
        const isAddr = end.element.kind === 'memory' && end.pin.addr;
        const code = isSel ? 'mux/sel-width' : isAddr ? 'memory/addr-width' : 'width/mismatch';
        const expectation = isSel ? ` (a ${end.element.inputs}-input ${end.element.encoding || 'binary'} mux${end.element.lanes ? ` × ${end.element.lanes} lanes` : ''} needs ${end.pin.width})` : '';
        add(code, `net ${n.net.id} is ${n.width} bits but ${role} ${end.text} is ${end.width} bits${expectation}`, { id: n.net.id }, { netWidth: n.width, endpointWidth: end.width }, ['correct the net width', 'slice the endpoint', 'insert a split/concat element']);
      }
    }
  }
  // Sub-bundle cover: sinks with the same member list count once; together they
  // carry exactly the bundle's width (nothing lost, nothing counted twice).
  for (const n of nets) {
    if (n.driver.error || n.width === null || !bundleEnd(n.driver)) continue;
    const subs = n.sinks.filter((s) => !s.error && s.width !== null && s.width < n.width && !s.ep?.slice && bundleEnd(s));
    if (!subs.length) continue;
    const groups = new Map(subs.map((s) => [JSON.stringify(pinBundle(s)), s.width]));
    const whole = n.sinks.some((s) => !s.error && s.width === n.width);
    const sum = [...groups.values()].reduce((a, w) => a + w, 0);
    if (whole || sum !== n.width) add('width/sub-bundle-cover', `net ${n.net.id}: sub-bundle sinks carry ${sum} of ${n.width} bits${whole ? ' and a sink also takes the whole bundle' : ''} (${subs.map((s) => `${s.text} ${s.width}`).join(', ')})`, { id: n.net.id }, { netWidth: n.width, groups: [...groups.entries()].map(([members, width]) => ({ members: JSON.parse(members), width })) }, ['give each sub-bundle its own pin bundle list', 'correct the net width', 'split the bundle into separate nets']);
  }
  for (const [key, list] of sinkUse) {
    if (list.length > 1) add('endpoint/multiple-drivers', `pin ${key} is driven by ${list.length} nets (${list.join(', ')})`, { id: key }, {}, ['merge the nets', 'insert a mux']);
  }
  for (const { el, pins } of elements.values()) {
    for (const p of pins.filter((x) => x.required && !connected.has(`${el.id}.${x.id}`))) {
      const severity = el.kind === 'mux' && p.id === 'sel' ? 'error' : 'warning';
      add('endpoint/unconnected', `${el.kind} ${el.id}: pin ${p.id} is not connected`, { id: el.id, pin: p.id }, {}, [`connect a net to ${el.id}.${p.id}`], severity);
    }
  }

  // element graph
  const valid = nets.filter((n) => !n.driver.error);
  const out = new Map();
  for (const n of valid) {
    for (const s of n.sinks.filter((x) => !x.error)) {
      if (!out.has(n.driver.element.id)) out.set(n.driver.element.id, []);
      out.get(n.driver.element.id).push({ to: s.element.id, driverPin: n.driver.pin, sinkPin: s.pin, net: n });
    }
  }

  // Combinational loops, found on pins (Tarjan). Nets connect a driver pin to
  // its sink pins; inside an element an input pin reaches an output pin
  // combinationally unless the output is sequential. A per-input latency map
  // is exact: only the inputs with 0 stages reach the output combinationally,
  // so a controller whose ready depends on one input only does not close a
  // loop through its other inputs.
  const pinNode = (elId, pinId) => `${elId} ${pinId}`;
  const pinGraph = new Map();
  const edge = (a, b) => { if (!pinGraph.has(a)) pinGraph.set(a, []); pinGraph.get(a).push(b); };
  for (const n of valid) {
    if (elements.get(n.driver.element.id).el.kind === 'port') continue;
    for (const s of n.sinks.filter((x) => !x.error)) edge(pinNode(n.driver.element.id, n.driver.pin.id), pinNode(s.element.id, s.pin.id));
  }
  const combThrough = (inPin, outPin) => {
    const spec = outPin.latencySpec;
    if (spec && typeof spec === 'object') return (spec[inPin.id] ?? spec.default ?? Math.max(0, ...Object.values(spec))) === 0;
    if (outPin.sequential) return false;
    // comb_from names the inputs with a register-free path to this output.
    return Array.isArray(outPin.combFrom) ? outPin.combFrom.includes(inPin.id) : true;
  };
  for (const { el, pins } of elements.values()) {
    if (el.kind === 'port') continue;
    const ins = pins.filter((p) => p.dir !== 'out');
    const outs = pins.filter((p) => p.dir !== 'in');
    for (const i of ins) for (const o of outs) if (i !== o && combThrough(i, o)) edge(pinNode(el.id, i.id), pinNode(el.id, o.id));
  }
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const sccs = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index += 1; stack.push(v); onStack.add(v);
    for (const w of pinGraph.get(v) || []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const v of pinGraph.keys()) if (!idx.has(v)) strong(v);
  for (const comp of sccs) {
    const selfLoop = comp.length === 1 && (pinGraph.get(comp[0]) || []).includes(comp[0]);
    if (comp.length < 2 && !selfLoop) continue;
    const ids = [...new Set(comp.map((v) => v.split(' ')[0]))];
    const unknown = ids.some((id) => elements.get(id).pins.some((p) => p.unknownTiming));
    add(unknown ? 'comb/loop-unknown' : 'comb/loop', `combinational loop through ${ids.sort().join(' → ')}`, { ids }, { pins: comp.map((v) => v.replace(' ', '.')).sort() }, ['insert a register on the loop', 'mark a registered instance output (registered: true)', 'declare a per-input latency map on a controller output that is registered from some of its inputs'], unknown ? 'warning' : 'error');
  }

  // clock-domain propagation and CDC
  const netDomains = new Map(valid.map((n) => [n.net.id, new Set()]));
  const inputsOf = (id) => valid.filter((n) => n.sinks.some((s) => !s.error && s.element.id === id));
  for (let iter = 0; iter < valid.length + 2; iter += 1) {
    let changed = false;
    for (const n of valid) {
      const { element: d, pin } = n.driver;
      let next;
      if (d.kind === 'port') next = new Set(d.domain ? [d.domain] : []);
      else if (d.kind === 'synchronizer') next = new Set([d.to]);
      else if (pin.sequential) next = new Set(d.domain ? [d.domain] : []);
      else next = new Set(inputsOf(d.id).flatMap((i) => [...netDomains.get(i.net.id)]));
      const cur = netDomains.get(n.net.id);
      if (next.size !== cur.size || [...next].some((x) => !cur.has(x))) { netDomains.set(n.net.id, next); changed = true; }
    }
    if (!changed) break;
  }
  for (const n of valid) {
    const doms = netDomains.get(n.net.id);
    if (n.net.domain && doms.size && !(doms.size === 1 && doms.has(n.net.domain))) {
      add('cdc/domain-assertion', `net ${n.net.id} is asserted in ${n.net.domain} but carries ${[...doms].join(', ')}`, { id: n.net.id }, {}, ['fix the net domain', 'insert a synchronizer']);
    }
    for (const s of n.sinks.filter((x) => !x.error)) {
      const el = s.element;
      if (el.kind === 'synchronizer') {
        const foreign = [...doms].filter((x) => x !== el.from);
        if (foreign.length) add('cdc/sync-domain-mismatch', `synchronizer ${el.id} (from ${el.from}) receives ${foreign.join(', ')}`, { id: el.id, net: n.net.id }, {}, ['fix the synchronizer from domain']);
        continue;
      }
      const sinkDomain = ['register', 'pipeline_register', 'memory'].includes(el.kind) ? el.domain : null;
      if (!sinkDomain) continue;
      const foreign = [...doms].filter((x) => x !== sinkDomain);
      if (foreign.length) add('cdc/unsynchronized', `net ${n.net.id} carries ${foreign.join(', ')} into ${el.kind} ${el.id} in ${sinkDomain} without a synchronizer`, { id: n.net.id, sink: el.id }, { from: foreign, to: sinkDomain }, ['insert a synchronizer element', 'fix the element domain']);
    }
  }

  // annotations: latency and critical paths
  const endpointElement = (text) => {
    const r = model.nets.flatMap((n) => [n.driver, ...n.sinks]).find((e) => e.text === text && !e.error);
    return r?.element.id ?? (elements.has(text) ? text : null);
  };
  const shortest = (from, to) => {
    const dist = new Map([[from, 0]]);
    const dq = [from];
    while (dq.length) {
      const v = dq.shift();
      for (const e of out.get(v) || []) {
        const nd = dist.get(v) + pinLatency(elements.get(v).el, e.driverPin);
        if (!dist.has(e.to) || nd < dist.get(e.to)) {
          dist.set(e.to, nd);
          if (nd === dist.get(v)) dq.unshift(e.to); else dq.push(e.to);
        }
      }
    }
    return dist.has(to) ? dist.get(to) : null;
  };
  let latenciesChecked = 0;
  for (const a of doc.annotations || []) {
    if (a.kind === 'latency' && a.from && a.to) {
      const f = endpointElement(a.from);
      const t = endpointElement(a.to);
      const got = f && t ? shortest(f, t) : null;
      if (got === null) add('path/not-connected', `latency annotation ${a.id || `${a.from}→${a.to}`}: no path`, { from: a.from, to: a.to }, {}, ['fix the endpoints']);
      else {
        latenciesChecked += 1;
        if (a.cycles !== undefined && got !== a.cycles) add('latency/stage-count', `latency ${a.from}→${a.to} is annotated ${a.cycles} cycles, the datapath has ${got} register stages`, { from: a.from, to: a.to }, { annotated: a.cycles, stages: got }, ['fix the annotation', 'fix the register elements']);
      }
    }
    if (a.kind === 'critical_path' && Array.isArray(a.path)) {
      for (let i = 1; i < a.path.length; i += 1) {
        const f = endpointElement(a.path[i - 1]);
        const t = endpointElement(a.path[i]);
        if (!f || !t || !(out.get(f) || []).some((e) => e.to === t)) add('path/not-connected', `critical_path step ${a.path[i - 1]} → ${a.path[i]} is not a net`, { id: a.id }, {}, ['fix the path list']);
      }
    }
  }

  // Heterogeneous bundles carry a name, never a summed width (CONVENTIONS §2.1).
  for (const n of nets) {
    if (!isBundleNet(n)) continue;
    const named = n.net.label || [n.driver, ...n.sinks].some((e) => !e.error && e.element.kind === 'port' && e.element.label);
    if (!named) add('width/bundle-sum', `net ${n.net.id} bundles different signals (${(n.net.bundle_of || [n.driver, ...n.sinks].find((e) => e.pin?.bundle)?.pin.bundle || []).join(', ')}); its summed width ${n.width} means nothing: name it (label "AHB-Lite", "mem ctrl")`, { id: n.net.id }, { width: n.width }, ['set the net label to the protocol or group name', 'draw the signals as separate nets']);
  }

  // A latency per input pin, or "state", describes a stateful protocol block
  // (SPEC §4.7): a controller, FSM, bus slave, CSR bank or arbiter; other
  // blocks have one latency per output.
  for (const { el } of elements.values()) {
    const inputs = new Set((el.ports || []).filter((q) => q.dir !== 'out').map((q) => q.id));
    for (const p of (el.ports || []).filter((q) => Array.isArray(q.comb_from))) {
      if (p.dir !== 'out') add('comb/unknown-input', `${el.kind} ${el.id}: input pin ${p.id} declares comb_from; only outputs do`, { id: el.id, pin: p.id }, {}, ['remove comb_from from the input pin']);
      for (const k of p.comb_from.filter((x) => !inputs.has(x))) add('comb/unknown-input', `${el.kind} ${el.id}: output ${p.id} lists ${k} in comb_from, which is not an input pin`, { id: el.id, pin: p.id }, { input: k }, ['use the input pin ids of the block']);
    }
    for (const p of el.ports || []) {
      if (p.latency === undefined || typeof p.latency === 'number') continue;
      if (p.dir !== 'out') add('latency/controller-only', `${el.kind} ${el.id}: input pin ${p.id} declares a latency; only outputs do`, { id: el.id, pin: p.id }, {}, ['remove the latency from the input pin']);
      if (!declaresState(el)) add('latency/controller-only', `${el.kind} ${el.id}: output ${p.id} declares latency ${JSON.stringify(p.latency)}; per-input and state latencies are for stateful blocks (${STATEFUL_KINDS.join(', ')}, or holds_state: true)`, { id: el.id, pin: p.id }, { latency: p.latency }, ['set function.kind "controller" (or "fsm") if the block is one', 'set holds_state: true if the block holds registers with feedback (verified against the netlist)', 'split the block at its registers and give each output one latency']);
      if (typeof p.latency === 'object') {
        for (const k of Object.keys(p.latency)) if (k !== 'default' && !inputs.has(k)) add('latency/unknown-input', `${el.kind} ${el.id}: output ${p.id} declares a latency from ${k}, which is not an input pin`, { id: el.id, pin: p.id }, { input: k }, ['use the input pin ids of the block (or "default")']);
      }
    }
  }

  // abstraction regions (SPEC §4.6)
  const GATE_LEVEL = new Set(['and', 'or', 'xor', 'nand', 'nor', 'xnor', 'not', 'buf', 'reduce', 'split', 'concat']);
  const regionIds = new Set();
  for (const r of doc.regions || []) {
    if (regionIds.has(r.id)) add('ir/duplicate-id', `duplicate region id '${r.id}'`, { id: r.id }, {}, ['rename one region']);
    regionIds.add(r.id);
    if (r.parent && !(doc.regions || []).some((x) => x.id === r.parent)) add('region/unknown-parent', `region ${r.id}: parent ${r.parent} does not exist`, { id: r.id }, {}, ['fix region.parent']);
    for (const m of r.members) {
      const entry = elements.get(m);
      if (!entry) { add('region/unknown-member', `region ${r.id}: member ${m} is not an element`, { id: r.id }, {}, ['fix the member id']); continue; }
      const e = entry.el;
      if (r.level === 'gate' && !(e.kind === 'const' || e.kind === 'port' || (e.kind === 'mux' && e.inputs === 2) || (e.kind === 'comb' && GATE_LEVEL.has(e.op)))) {
        add('region/non-gate-member', `gate region ${r.id} contains ${e.kind}${e.op ? `/${e.op}` : ''} ${m}, which has no gate-level meaning`, { id: r.id, member: m }, {}, ['move the element to an rtl/block region', 'expand it with expand-cone']);
      }
      if (r.level === 'blackbox' && e.kind !== 'instance') add('region/non-blackbox-member', `blackbox region ${r.id} contains ${e.kind} ${m}; blackboxes are instances with only their ports`, { id: r.id, member: m }, {}, ['model the blackbox as an instance element']);
    }
    if (r.level === 'gate') {
      const gates = r.members.filter((m) => elements.get(m) && !['port', 'const'].includes(elements.get(m).el.kind)).length;
      if (gates > (r.max_gates ?? 30)) add('gate/too-many', `gate region ${r.id} draws ${gates} gates (limit ${r.max_gates ?? 30})`, { id: r.id }, { gates }, ['narrow the cone', 'draw the region at block level', 'raise max_gates']);
    }
  }
  for (const { el } of elements.values()) {
    for (const i of el.invert_inputs || []) if (i >= (el.inputs ?? 1)) add('gate/invert-index', `${el.id}: invert_inputs index ${i} is not < inputs (${el.inputs ?? 1})`, { id: el.id }, {}, ['fix invert_inputs']);
  }

  return { diagnostics, model, stats: { elements: elements.size, nets: nets.length, latenciesChecked, regions: (doc.regions || []).length } };
}
