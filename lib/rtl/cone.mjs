// Gate-level regions grounded in RTL (SPEC §4.6): resolve the combinational
// cone of an RTL output from the netlist's continuous-assignment expression
// trees, evaluate it, and expand it into gate-level datapath elements.

import { flattenNetlist } from './flatten.mjs';

export const keyOf = (name, index, slice) => (slice ? `${name}[${slice[0]}:${slice[1]}]` : index !== undefined ? `${name}[${index}]` : name);

export class NotEvaluable extends Error {}

export function findModule(netlist, instanceRel) {
  const flat = flattenNetlist(netlist);
  const p = [flat.top, ...(instanceRel ? instanceRel.split('/') : [])].join('.');
  return flat.instances.get(p) || null;
}

// Inline continuous assignments backwards from `output` until a stop signal,
// a register, a port or an unassigned signal is reached. Leaves become
// { op: 'input', key } nodes.
export function resolveCone(mod, { output, index, stopAt = [], maxDepth = 64 }) {
  const table = new Map();
  for (const e of mod.exprs || []) table.set(keyOf(e.target, e.index), e);
  const stop = new Set(stopAt);
  const inputs = new Map();
  const root = table.get(keyOf(output, index));
  if (!root) return { error: `no unconditional continuous assignment to ${keyOf(output, index)} in ${mod.orig_name}` };
  const addInput = (name, idx, slice, width) => {
    const k = keyOf(name, idx, slice);
    if (!inputs.has(k)) inputs.set(k, { key: k, name, index: idx, slice, width });
    return k;
  };
  const inline = (node, depth) => {
    if (node.op === 'ref') {
      const e = table.get(node.name);
      if (e && !stop.has(node.name) && depth < maxDepth) return inline(e.expr, depth + 1);
      return { op: 'input', key: addInput(node.name, undefined, undefined, node.width), width: node.width };
    }
    if ((node.op === 'index' || node.op === 'sel') && node.args?.[0]?.op === 'ref') {
      const base = node.args[0];
      const idx = node.op === 'index' ? node.index : node.lsb;
      if (idx !== undefined && (node.op === 'index' || node.width === 1)) {
        const k = keyOf(base.name, idx);
        const e = table.get(k);
        if (e && !stop.has(base.name) && !stop.has(k) && depth < maxDepth) return inline(e.expr, depth + 1);
        const whole = table.get(base.name);
        if (node.op === 'sel' && whole && !stop.has(base.name) && depth < maxDepth) return { op: 'sel', lsb: idx, width: node.width, args: [inline(whole.expr, depth + 1)] };
        return { op: 'input', key: addInput(base.name, idx, undefined, node.width), width: node.width };
      }
      if (node.op === 'sel' && idx !== undefined) {
        const whole = table.get(base.name);
        if (whole && !stop.has(base.name) && depth < maxDepth) return { op: 'sel', lsb: idx, width: node.width, args: [inline(whole.expr, depth + 1)] };
        return { op: 'input', key: addInput(base.name, undefined, [idx + node.width - 1, idx], node.width), width: node.width };
      }
    }
    return node.args ? { ...node, args: node.args.map((a) => inline(a, depth)) } : node;
  };
  const tree = inline(root.expr, 0);
  return { tree, inputs: [...inputs.values()], width: root.width ?? tree.width, source: root.source };
}

export function parseLiteral(text) {
  const m = /^(\d+)?'[sS]?([bodhBODH])([0-9a-fA-F_xXzZ?]+)$/.exec(String(text));
  if (!m) return /^\d+$/.test(String(text)) ? BigInt(text) : null;
  const radix = m[2].toLowerCase();
  const digits = m[3].replace(/_/g, '').replace(/[xXzZ?]/g, '0');
  return radix === 'd' ? BigInt(digits) : BigInt(`0${radix === 'h' ? 'x' : radix}${digits}`);
}

export const mask = (w) => (1n << BigInt(w)) - 1n;
const popParity = (v) => { let p = 0n; for (let x = v; x; x >>= 1n) p ^= x & 1n; return p; };

export function evalTree(node, env) {
  const w = node.width ?? 1;
  const v = (i) => evalTree(node.args[i], env);
  const aw = (i) => node.args[i].width ?? 1;
  const all = () => node.args.map((_, i) => v(i));
  switch (node.op) {
    case 'input': {
      if (!env.has(node.key)) throw new NotEvaluable(`input ${node.key} has no value`);
      return env.get(node.key) & mask(w);
    }
    case 'const': {
      const x = parseLiteral(node.value);
      if (x === null) throw new NotEvaluable(`literal ${node.value}`);
      return x & mask(w);
    }
    case 'and': return all().reduce((a, b) => a & b, mask(w)) & mask(w);
    case 'or': return all().reduce((a, b) => a | b, 0n) & mask(w);
    case 'xor': return all().reduce((a, b) => a ^ b, 0n) & mask(w);
    case 'not': return ~v(0) & mask(w);
    case 'neg': return (-v(0)) & mask(w);
    case 'lnot': return v(0) === 0n ? 1n : 0n;
    case 'land': return v(0) !== 0n && v(1) !== 0n ? 1n : 0n;
    case 'lor': return v(0) !== 0n || v(1) !== 0n ? 1n : 0n;
    case 'redand': return v(0) === mask(aw(0)) ? 1n : 0n;
    case 'redor': return v(0) !== 0n ? 1n : 0n;
    case 'redxor': return popParity(v(0));
    case 'eq': return v(0) === v(1) ? 1n : 0n;
    case 'neq': return v(0) !== v(1) ? 1n : 0n;
    case 'lt': return v(0) < v(1) ? 1n : 0n;
    case 'lte': return v(0) <= v(1) ? 1n : 0n;
    case 'gt': return v(0) > v(1) ? 1n : 0n;
    case 'gte': return v(0) >= v(1) ? 1n : 0n;
    case 'add': return (v(0) + v(1)) & mask(w);
    case 'sub': return (v(0) - v(1)) & mask(w);
    case 'mul': return (v(0) * v(1)) & mask(w);
    case 'shl': return (v(0) << v(1)) & mask(w);
    case 'shr': return (v(0) >> v(1)) & mask(w);
    case 'cond': return (v(0) !== 0n ? v(1) : v(2)) & mask(w);
    case 'concat': return ((v(0) << BigInt(aw(1))) | v(1)) & mask(w);
    case 'sel': return (v(0) >> BigInt(node.lsb)) & mask(w);
    case 'repl': {
      let out = 0n;
      for (let i = 0; i < node.count; i += 1) out = (out << BigInt(aw(0))) | v(0);
      return out & mask(w);
    }
    case 'extend': return v(0) & mask(w);
    case 'func': throw new NotEvaluable(`function call ${node.name}`);
    default: throw new NotEvaluable(`operator ${node.op}${node.type ? ` (${node.type})` : ''}`);
  }
}

const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');

// Expand a resolved cone into datapath elements/nets at gate level.
export function expandToGates(cone, { maxGates = 30, bitblast = true, prefix = 'g', outputLabel = 'out' } = {}) {
  const elements = [];
  const nets = [];
  const diagnostics = [];
  const inputPorts = new Map();
  let counter = 0;
  const nextId = (kind) => `${prefix}_${kind}${counter++}`;
  const connect = (driver, sink, width) => {
    const existing = nets.find((n) => n.driver === driver);
    if (existing) existing.sinks.push(sink);
    else nets.push({ id: `${prefix}_n${nets.length}`, width, driver, sinks: [sink] });
  };
  const flatten = (node, op) => node.args.flatMap((a) => (a.op === op && a.width === node.width ? flatten(a, op) : [a]));
  const boolify = (node) => (node.width > 1 ? { op: 'redor', width: 1, args: [node] } : node);
  const inversions = { and: 'nand', or: 'nor', xor: 'xnor' };

  const gate = (op, args, width) => {
    const id = nextId(op);
    const bubble = op !== 'not';
    const infos = args.map((a) => (bubble && a.op === 'not' && !inversions[a.args[0].op] && (a.args[0].width ?? 1) === (a.width ?? 1) ? { inv: true, node: a.args[0] } : { inv: false, node: a }));
    const el = { id, kind: 'comb', op, width, ...(op !== 'not' ? { inputs: args.length } : {}) };
    const inv = infos.map((x, i) => (x.inv ? i : null)).filter((x) => x !== null);
    if (inv.length) el.invert_inputs = inv;
    elements.push(el);
    infos.forEach((info, i) => {
      const r = build(info.node);
      connect(r.driver, `${id}.in${i}`, r.width);
    });
    return { driver: `${id}.out`, width };
  };

  const build = (node) => {
    const w = node.width ?? 1;
    switch (node.op) {
      case 'input': {
        if (!inputPorts.has(node.key)) {
          const pid = `${prefix}_in_${sanitize(node.key)}`;
          elements.push({ id: pid, kind: 'port', dir: 'in', width: w, label: node.key, class: w === 1 ? 'control' : 'data' });
          inputPorts.set(node.key, pid);
        }
        return { driver: inputPorts.get(node.key), width: w };
      }
      case 'const': {
        const id = nextId('k');
        elements.push({ id, kind: 'const', value: /'/.test(node.value) ? node.value : `${w}'d${node.value}` });
        return { driver: `${id}.out`, width: w };
      }
      case 'and': case 'or': case 'xor': return gate(node.op, flatten(node, node.op), w);
      case 'not': {
        const a = node.args[0];
        if (inversions[a.op] && a.width === w) return gate(inversions[a.op], flatten(a, a.op), w);
        return gate('not', [a], w);
      }
      case 'lnot': return gate('not', [boolify(node.args[0])], 1);
      case 'land': return gate('and', [boolify(node.args[0]), boolify(node.args[1])], 1);
      case 'lor': return gate('or', [boolify(node.args[0]), boolify(node.args[1])], 1);
      case 'redand': case 'redor': case 'redxor': {
        const id = nextId('red');
        elements.push({ id, kind: 'comb', op: 'reduce', reduce: node.op.slice(3), width: node.args[0].width });
        const r = build(node.args[0]);
        connect(r.driver, `${id}.in0`, r.width);
        return { driver: `${id}.out`, width: 1 };
      }
      case 'cond': {
        const id = nextId('mux');
        elements.push({ id, kind: 'mux', inputs: 2, width: w });
        const s = build(boolify(node.args[0]));
        connect(s.driver, `${id}.sel`, 1);
        const t = build(node.args[1]);
        connect(t.driver, `${id}.in1`, t.width);
        const e = build(node.args[2]);
        connect(e.driver, `${id}.in0`, e.width);
        return { driver: `${id}.out`, width: w };
      }
      case 'eq': case 'neq': {
        const [l, r] = node.args;
        const constSide = l.op === 'const' ? l : r.op === 'const' ? r : null;
        const other = constSide === l ? r : l;
        const cw = other.width ?? 1;
        if (bitblast && constSide && cw <= 16) {
          const k = parseLiteral(constSide.value) ?? 0n;
          const src = build(other);
          const gid = nextId(node.op === 'eq' ? 'and' : 'nand');
          const inv = [];
          if (cw === 1) {
            const g = { id: gid, kind: 'comb', op: node.op === 'eq' ? 'and' : 'nand', width: 1, inputs: 1 };
            if ((k & 1n) === 0n) g.invert_inputs = [0];
            elements.push(g);
            connect(src.driver, `${gid}.in0`, 1);
            return { driver: `${gid}.out`, width: 1 };
          }
          const sid = nextId('bits');
          elements.push({ id: sid, kind: 'comb', op: 'split', width: cw, slices: Array.from({ length: cw }, (_, i) => String(cw - 1 - i)) });
          connect(src.driver, `${sid}.in0`, cw);
          for (let i = 0; i < cw; i += 1) if (((k >> BigInt(cw - 1 - i)) & 1n) === 0n) inv.push(i);
          elements.push({ id: gid, kind: 'comb', op: node.op === 'eq' ? 'and' : 'nand', width: 1, inputs: cw, ...(inv.length ? { invert_inputs: inv } : {}) });
          for (let i = 0; i < cw; i += 1) connect(`${sid}.out${i}`, `${gid}.in${i}`, 1);
          return { driver: `${gid}.out`, width: 1 };
        }
        return block('cmp', node, { cmp: node.op === 'eq' ? 'eq' : 'ne' });
      }
      case 'lt': case 'lte': case 'gt': case 'gte': return block('cmp', node, { cmp: { lt: 'lt', lte: 'le', gt: 'gt', gte: 'ge' }[node.op] });
      case 'add': case 'sub': case 'mul': return block(node.op, node, {});
      case 'shl': case 'shr': return block('shift', node, { dir: node.op === 'shl' ? 'left' : 'right' });
      case 'concat': {
        const id = nextId('cat');
        const parts = node.args.map((a) => a.width ?? 1);
        elements.push({ id, kind: 'comb', op: 'concat', width: w, in_widths: parts });
        node.args.forEach((a, i) => { const r = build(a); connect(r.driver, `${id}.in${i}`, r.width); });
        return { driver: `${id}.out`, width: w };
      }
      case 'sel': {
        const id = nextId('bits');
        const inner = node.args[0].width ?? 1;
        elements.push({ id, kind: 'comb', op: 'split', width: inner, slices: [w === 1 ? String(node.lsb) : `${node.lsb + w - 1}:${node.lsb}`] });
        const r = build(node.args[0]);
        connect(r.driver, `${id}.in0`, r.width);
        return { driver: `${id}.out0`, width: w };
      }
      case 'extend': {
        const inner = node.args[0].width ?? 1;
        if (inner === w) return build(node.args[0]);
        const id = nextId('ext');
        // Zero extension is a zext box (CONVENTIONS §2.3.4), not a concat with zeros.
        elements.push({ id, kind: 'comb', op: 'extend', extend: 'zero', width: inner, out_width: w });
        const r = build(node.args[0]);
        connect(r.driver, `${id}.in0`, r.width);
        return { driver: `${id}.out`, width: w };
      }
      default: {
        diagnostics.push({ code: 'gate/not-expandable', severity: 'error', message: `${node.op === 'func' ? `function ${node.name}` : `operator ${node.op}`} cannot be drawn at gate level`, subject: {}, evidence: {}, supportedFixes: ['draw this region at block level', 'stop the cone before this expression (stop_at)'] });
        const id = nextId('opaque');
        const ins = (node.args || []).map((a, i) => ({ id: `in${i}`, dir: 'in', width: a.width ?? 1 }));
        elements.push({ id, kind: 'comb', op: 'custom', width: w, function: { kind: 'custom', name: `${node.name ?? node.op} (not expandable)` }, ports: [...ins, { id: 'out', dir: 'out', width: w }] });
        (node.args || []).forEach((a, i) => { const r = build(a); connect(r.driver, `${id}.in${i}`, r.width); });
        return { driver: `${id}.out`, width: w };
      }
    }
  };

  const block = (op, node, extra) => {
    const id = nextId(op);
    const inW = node.args[0].width ?? 1;
    elements.push({ id, kind: 'comb', op, width: inW, ...extra, ...(op === 'cmp' ? {} : { out_width: node.width }) });
    const pins = op === 'shift' ? ['in0', 'amt'] : ['in0', 'in1'];
    node.args.forEach((a, i) => { const r = build(a); connect(r.driver, `${id}.${pins[i]}`, r.width); });
    return { driver: `${id}.out`, width: node.width ?? 1 };
  };

  const root = build(cone.tree);
  const outId = `${prefix}_out`;
  elements.push({ id: outId, kind: 'port', dir: 'out', width: cone.width ?? root.width, label: outputLabel, class: (cone.width ?? root.width) === 1 ? 'control' : 'data' });
  connect(root.driver, outId, root.width);
  const gateCount = elements.filter((e) => e.kind !== 'port' && e.kind !== 'const').length;
  if (gateCount > maxGates) diagnostics.push({ code: 'gate/too-many', severity: 'error', message: `cone of ${outputLabel} expands to ${gateCount} gates (limit ${maxGates})`, subject: {}, evidence: { gateCount, maxGates }, supportedFixes: ['narrow the cone with stop_at signals', 'draw this region at block level', 'raise max_gates for this region'] });
  return { elements, nets, diagnostics, gateCount, inputs: [...inputPorts.entries()].map(([key, id]) => ({ key, id })), output: outId };
}
