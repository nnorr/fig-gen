// Equivalence of a drawn gate-level region against the RTL expression it
// claims to depict (SPEC §4.6). Exhaustive for ≤ 16 input bits, otherwise
// seeded random vectors reported as "sampled".

import { diagnostic } from '../diagnostics.mjs';
import { buildModel } from '../ir/datapath-model.mjs';
import { NotEvaluable, evalTree, findModule, keyOf, mask, parseLiteral, resolveCone } from '../rtl/cone.mjs';

export const MAX_EXHAUSTIVE_BITS = 16;
export const DEFAULT_SAMPLES = 4096;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

const sliceOf = (text) => {
  if (text === undefined) return undefined;
  const [hi, lo = hi] = String(text).split(':').map(Number);
  return [hi, lo];
};

// Evaluate the nets driven by `members` given seeded net values.
export function evaluateRegion(model, members, seeds) {
  const values = new Map(seeds);
  const sinkNet = new Map();
  for (const n of model.nets) for (const s of n.sinks) if (!s.error) sinkNet.set(`${s.element.id}.${s.pin.id}`, n);
  const pending = model.nets.filter((n) => !n.driver.error && members.has(n.driver.element.id) && !values.has(n.net.id));
  const inputOf = (el, pin) => {
    const n = sinkNet.get(`${el.id}.${pin.id}`);
    if (!n || !values.has(n.net.id)) return undefined;
    let v = values.get(n.net.id);
    const idx = Number(pin.id.replace(/^in/, ''));
    if (el.invert_inputs?.includes(idx) && /^in\d+$/.test(pin.id)) v = ~v & mask(pin.width ?? n.width ?? 1);
    return v;
  };
  const outValue = (el, pins, pinId) => {
    const ins = pins.filter((p) => p.dir === 'in').map((p) => [p.id, inputOf(el, p)]);
    if (ins.some(([, v]) => v === undefined)) return undefined;
    const iv = Object.fromEntries(ins);
    const outPin = pins.find((p) => p.id === pinId);
    const w = outPin.width ?? 1;
    const list = ins.filter(([id]) => /^in\d+$/.test(id)).map(([, v]) => v);
    let v;
    switch (el.kind) {
      case 'const': v = parseLiteral(el.value); break;
      case 'mux': {
        const lanes = el.lanes ?? 1;
        const lw = w / lanes;
        const selW = Math.max(1, Math.ceil(Math.log2(el.inputs)));
        v = 0n;
        for (let j = 0; j < lanes; j += 1) {
          const s = Number((iv.sel >> BigInt(j * selW)) & mask(selW));
          const chosen = iv[`in${Math.min(s, el.inputs - 1)}`];
          v |= ((chosen >> BigInt(j * lw)) & mask(lw)) << BigInt(j * lw);
        }
        break;
      }
      case 'comb':
        switch (el.op) {
          case 'and': v = list.reduce((a, b) => a & b, mask(w)); break;
          case 'or': v = list.reduce((a, b) => a | b, 0n); break;
          case 'xor': v = list.reduce((a, b) => a ^ b, 0n); break;
          case 'nand': v = ~list.reduce((a, b) => a & b, mask(w)); break;
          case 'nor': v = ~list.reduce((a, b) => a | b, 0n); break;
          case 'xnor': v = ~list.reduce((a, b) => a ^ b, 0n); break;
          case 'not': v = ~iv.in0; break;
          case 'buf': v = iv.in0; break;
          case 'reduce': {
            const inW = pins.find((p) => p.id === 'in0').width;
            v = el.reduce === 'and' ? (iv.in0 === mask(inW) ? 1n : 0n) : el.reduce === 'or' ? (iv.in0 !== 0n ? 1n : 0n) : [...iv.in0.toString(2)].filter((c) => c === '1').length % 2 ? 1n : 0n;
            break;
          }
          case 'cmp': {
            const [a, b] = [iv.in0, iv.in1];
            v = ({ eq: a === b, ne: a !== b, lt: a < b, le: a <= b, gt: a > b, ge: a >= b }[el.cmp || 'eq']) ? 1n : 0n;
            break;
          }
          case 'add': v = iv.in0 + iv.in1 + (iv.cin ?? 0n); break;
          case 'sub': v = iv.in0 - iv.in1; break;
          case 'mul': v = iv.in0 * iv.in1; break;
          case 'shift': v = el.dir === 'left' ? iv.in0 << iv.amt : iv.in0 >> iv.amt; break;
          case 'extend': v = iv.in0; break;
          case 'replicate': {
            const inW = el.width ?? 1;
            v = 0n;
            for (let k = 0; k < (el.count ?? 1); k += 1) v = (v << BigInt(inW)) | (iv.in0 & mask(inW));
            break;
          }
          case 'concat': {
            v = 0n;
            pins.filter((p) => p.dir === 'in').forEach((p) => { v = (v << BigInt(p.width)) | iv[p.id]; });
            break;
          }
          case 'split': {
            const [hi, lo] = outPin.slice;
            v = (iv.in0 >> BigInt(Math.min(hi, lo))) & mask(Math.abs(hi - lo) + 1);
            break;
          }
          default: throw new NotEvaluable(`${el.op} block ${el.id} has no gate-level meaning`);
        }
        break;
      default: throw new NotEvaluable(`${el.kind} ${el.id} is not combinational`);
    }
    if (el.invert_output) v = ~v;
    return v & mask(w);
  };
  for (let guard = 0; guard <= pending.length && pending.some((n) => !values.has(n.net.id)); guard += 1) {
    for (const n of pending) {
      if (values.has(n.net.id)) continue;
      const entry = model.elements.get(n.driver.element.id);
      const v = outValue(entry.el, entry.pins, n.driver.pin.id);
      if (v === undefined) continue;
      const s = n.driver.ep.slice;
      values.set(n.net.id, s ? (v >> BigInt(s.lsb)) & mask(s.width) : v);
    }
  }
  return values;
}

export function checkRegionEquivalence(doc, region, netlist, { samples = DEFAULT_SAMPLES } = {}) {
  const diagnostics = [];
  const add = (code, message, evidence = {}, supportedFixes = []) => diagnostics.push(diagnostic({ code, message, subject: { region: region.id }, evidence, supportedFixes }));
  const model = buildModel(doc);
  const members = new Set(region.members);
  const touches = (n) => [n.driver, ...n.sinks].some((e) => !e.error && members.has(e.element.id));
  const regionNets = model.nets.filter(touches);
  const isInput = (n) => n.driver.error || !members.has(n.driver.element.id) || n.driver.element.kind === 'port';
  const inputs = regionNets.filter((n) => isInput(n) && n.sinks.some((s) => !s.error && members.has(s.element.id)));
  const outputs = regionNets.filter((n) => !isInput(n) && n.net.rtl?.signal && (n.sinks.some((s) => s.error || !members.has(s.element.id) || s.element.kind === 'port')));
  const mod = findModule(netlist, region.rtl?.instance ?? doc.meta?.rtl?.instance);
  if (!mod) { add('equiv/instance-missing', `region ${region.id}: RTL instance not found`, {}, ['fix region.rtl.instance']); return { diagnostics }; }
  if (!outputs.length) { add('equiv/no-outputs', `region ${region.id}: no RTL-mapped output nets leave the region`, {}, ['map the region outputs with rtl.signal']); return { diagnostics }; }

  const inputKey = new Map();
  for (const n of inputs) {
    if (!n.net.rtl?.signal) { add('equiv/input-unmapped', `region ${region.id}: input net ${n.net.id} has no rtl.signal`, {}, ['map every region input to its RTL signal']); continue; }
    inputKey.set(n.net.id, keyOf(n.net.rtl.signal, n.net.rtl.index, sliceOf(n.net.rtl.slice)));
  }
  if (diagnostics.length) return { diagnostics };
  const stopAt = [...new Set([...inputKey.values(), ...inputs.map((n) => n.net.rtl.signal), ...(region.rtl?.stop_at || [])])];
  const cones = [];
  for (const o of outputs) {
    const cone = resolveCone(mod, { output: o.net.rtl.signal, index: o.net.rtl.index, stopAt });
    if (cone.error) { add('equiv/no-rtl-expression', `region ${region.id}: ${cone.error}`, {}, ['map the output to a continuously assigned signal', 'draw the region at block level']); continue; }
    const known = new Set(inputKey.values());
    const extra = cone.inputs.filter((i) => !known.has(i.key));
    if (extra.length) add('equiv/unmapped-input', `region ${region.id}: RTL cone of ${o.net.rtl.signal} also depends on ${extra.map((e) => e.key).join(', ')}, which the drawn region does not take as input`, { extra: extra.map((e) => e.key) }, ['add the missing inputs to the drawn region', 'set region.rtl.stop_at']);
    cones.push({ net: o, cone });
  }
  if (diagnostics.length) return { diagnostics };

  const widths = inputs.map((n) => n.width ?? 1);
  const bits = widths.reduce((a, b) => a + b, 0);
  const exhaustive = bits <= MAX_EXHAUSTIVE_BITS;
  const seed = region.equivalence?.seed ?? 1;
  const rng = mulberry32(seed);
  const vectors = exhaustive ? 2 ** bits : (region.equivalence?.vectors ?? samples);
  const randomBits = (w) => {
    let v = 0n;
    for (let got = 0; got < w; got += 32) v = (v << 32n) | BigInt(rng());
    return v & mask(w);
  };
  try {
    for (let k = 0; k < vectors; k += 1) {
      const seeds = new Map();
      const env = new Map();
      let offset = 0n;
      const flat = BigInt(k);
      inputs.forEach((n, i) => {
        const w = widths[i];
        const value = exhaustive ? (flat >> offset) & mask(w) : randomBits(w);
        offset += BigInt(w);
        seeds.set(n.net.id, value);
        env.set(inputKey.get(n.net.id), value);
      });
      const values = evaluateRegion(model, members, seeds);
      for (const { net, cone } of cones) {
        const w = net.width ?? 1;
        const drawn = values.get(net.net.id);
        const rtl = evalTree(cone.tree, env) & mask(w);
        if (drawn === undefined) {
          add('equiv/not-evaluable', `region ${region.id}: output ${net.net.id} could not be evaluated from the region inputs`, {}, ['check that every gate input is connected']);
          return { diagnostics };
        }
        if ((drawn & mask(w)) !== rtl) {
          const example = Object.fromEntries(inputs.map((n) => [inputKey.get(n.net.id), `0x${seeds.get(n.net.id).toString(16)}`]));
          add('equiv/mismatch', `region ${region.id}: ${net.net.rtl.signal}${net.net.rtl.index !== undefined ? `[${net.net.rtl.index}]` : ''} differs from the RTL for inputs ${JSON.stringify(example)}: drawn 0x${drawn.toString(16)}, RTL 0x${rtl.toString(16)}`, { counterexample: example, drawn: `0x${drawn.toString(16)}`, rtl: `0x${rtl.toString(16)}` }, ['fix the drawn gates', 're-expand the region from the RTL']);
          return { diagnostics, result: { method: exhaustive ? 'exhaustive' : 'sampled', vectors: k + 1, input_bits: bits, ...(exhaustive ? {} : { seed }), result: 'fail' } };
        }
      }
    }
  } catch (error) {
    if (error instanceof NotEvaluable) {
      add('equiv/not-evaluable', `region ${region.id}: ${error.message}`, {}, ['draw this part at block level', 'stop the cone before it']);
      return { diagnostics };
    }
    throw error;
  }
  return { diagnostics, result: { method: exhaustive ? 'exhaustive' : 'sampled', vectors, input_bits: bits, ...(exhaustive ? {} : { seed }), result: 'pass' } };
}
