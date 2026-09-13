// Skin-independent pin model for datapath elements (SPEC §4.2): pin ids,
// directions, widths, classes and timing, shared by semantic checks, the
// renderer and the RTL cross-check.

import { parseEndpoint } from './endpoints.mjs';
import { clog2, evalWidth, muxSelWidth } from './width.mjs';

export function literalWidth(value) {
  const m = /^(\d+)'/.exec(String(value));
  return m ? Number(m[1]) : null;
}

const pin = (id, dir, width, cls = 'data', extra = {}) => ({ id, dir, width, class: cls, ...extra });

function combPins(el, W) {
  const dw = W(el.width, 'width');
  const outW = el.out_width !== undefined ? W(el.out_width, 'out_width') : dw;
  switch (el.op) {
    case 'and': case 'or': case 'xor': case 'nand': case 'nor': case 'xnor':
      return [...Array.from({ length: el.inputs ?? 2 }, (_, i) => pin(`in${i}`, 'in', dw, 'data', { required: true })), pin('out', 'out', dw)];
    case 'not': case 'buf':
      return [pin('in0', 'in', dw, 'data', { required: true }), pin('out', 'out', dw)];
    case 'add': case 'sub':
      return [pin('in0', 'in', dw, 'data', { required: true }), pin('in1', 'in', dw, 'data', { required: true }),
        ...(el.carry_in ? [pin('cin', 'in', 1, 'control')] : []), pin('out', 'out', outW),
        ...(el.carry_out ? [pin('cout', 'out', 1, 'control')] : [])];
    case 'mul':
      return [pin('in0', 'in', dw, 'data', { required: true }), pin('in1', 'in', dw, 'data', { required: true }), pin('out', 'out', outW)];
    case 'cmp':
      return [pin('in0', 'in', dw, 'data', { required: true }), pin('in1', 'in', dw, 'data', { required: true }), pin('out', 'out', 1, 'control')];
    case 'shift':
      return [pin('in0', 'in', dw, 'data', { required: true }),
        pin('amt', 'in', el.in_widths?.[1] !== undefined ? W(el.in_widths[1], 'in_widths[1]') : (dw ? Math.max(1, clog2(dw)) : null), 'control', { required: true }),
        pin('out', 'out', dw)];
    case 'reduce':
      return [pin('in0', 'in', dw, 'data', { required: true }), pin('out', 'out', 1, 'control')];
    case 'extend':
      return [pin('in0', 'in', dw, 'data', { required: true }), pin('out', 'out', outW)];
    case 'replicate':
      return [pin('in0', 'in', dw, 'data', { required: true }), pin('out', 'out', dw === null ? null : dw * (el.count ?? 1))];
    case 'concat':
      return [...(el.in_widths || []).map((w, i) => pin(`in${i}`, 'in', W(w, `in_widths[${i}]`), 'data', { required: true })), pin('out', 'out', dw)];
    case 'split':
      return [pin('in0', 'in', dw, 'data', { required: true }), ...(el.slices || []).map((s, i) => {
        const [hi, lo = hi] = s.split(':').map(Number);
        return pin(`out${i}`, 'out', Math.abs(hi - lo) + 1, 'data', { slice: [hi, lo] });
      })];
    case 'lut': case 'rom': {
      const depth = W(el.depth, 'depth');
      return [pin('addr', 'in', depth ? Math.max(1, clog2(depth)) : null, 'data', { required: true }), pin('data', 'out', dw)];
    }
    case 'custom':
      return (el.ports || []).map((q) => pin(q.id, q.dir, W(q.width, `port ${q.id}`), q.class || 'data', { side: q.side, label: q.label, short_label: q.short_label }));
    default:
      return [];
  }
}

export function elementPins(el, ctx) {
  const W = (expr, what) => {
    if (expr === undefined || expr === null) return null;
    try {
      return evalWidth(expr, ctx.params);
    } catch (error) {
      ctx.errors.push({ element: el.id, what, error });
      return null;
    }
  };
  switch (el.kind) {
    case 'port':
      return [pin('p', el.dir === 'in' ? 'out' : el.dir === 'out' ? 'in' : 'inout', W(el.width, 'width'), el.class || 'data')];
    case 'const':
      return [pin('out', 'out', literalWidth(el.value))];
    case 'mux': {
      const n = el.inputs;
      const dw = W(el.width, 'width');
      const lanes = el.lanes ?? 1;
      return [
        ...Array.from({ length: n }, (_, i) => pin(`in${i}`, 'in', dw, 'data', { required: true, index: i })),
        pin('sel', 'in', lanes * muxSelWidth(n, el.encoding), 'control', { required: true }),
        pin('out', 'out', dw),
      ];
    }
    case 'register': {
      const dw = W(el.width, 'width');
      return [pin('d', 'in', dw, 'data', { required: true }), pin('q', 'out', dw, 'data', { sequential: true, latency: 1 }),
        ...(el.enable ? [pin('en', 'in', 1, 'control', { required: true })] : []),
        ...(el.reset && el.reset !== 'none' ? [pin('rst', 'in', 1, 'reset')] : [])];
    }
    case 'pipeline_register':
      return el.lanes.flatMap((l) => {
        const lw = W(l.width, `lane ${l.id}`);
        return [pin(`d_${l.id}`, 'in', lw, l.class || 'data', { required: true, lane: l.id }), pin(`q_${l.id}`, 'out', lw, l.class || 'data', { sequential: true, latency: 1, lane: l.id })];
      }).concat(el.enable ? [pin('en', 'in', 1, 'control', { required: true })] : []);
    case 'memory': {
      const depth = W(el.depth, 'depth');
      const dw = W(el.width, 'width');
      const aw = depth ? Math.max(1, clog2(depth)) : null;
      return el.ports.flatMap((p) => {
        const out = [pin(`${p.id}_addr`, 'in', aw, 'data', { required: true, addr: true })];
        if (p.type !== 'read') {
          out.push(pin(`${p.id}_wdata`, 'in', dw, 'data', { required: true }));
          if (p.we !== false) out.push(pin(`${p.id}_we`, 'in', 1, 'control', { required: true }));
        }
        if (p.type !== 'write') {
          const latency = p.read_latency ?? 1;
          out.push(pin(`${p.id}_rdata`, 'out', dw, 'data', { sequential: latency >= 1, latency }));
          if (p.re) out.push(pin(`${p.id}_re`, 'in', 1, 'control'));
        }
        return out;
      });
    }
    case 'synchronizer': {
      const dw = W(el.width, 'width');
      const stages = el.style === 'ff3' ? 3 : 2;
      return [pin('in', 'in', dw, 'data', { required: true }), pin('out', 'out', dw, 'data', { sequential: true, latency: stages })];
    }
    case 'instance': {
      const defs = el.ports ?? ctx.modules?.[el.module]?.ports ?? [];
      return defs.map((p) => pin(p.id, p.dir, W(p.width, `port ${p.id}`), p.class || 'data', {
        side: p.side, label: p.label, short_label: p.short_label, bundle: p.bundle,
        sequential: p.dir === 'out' && p.registered === true, latency: p.registered ? 1 : 0,
        unknownTiming: p.dir === 'out' && p.registered === undefined,
      }));
    }
    case 'comb':
      return combPins(el, W);
    default:
      return [];
  }
}

export function buildModel(doc) {
  const ctx = { params: doc.params || {}, modules: doc.modules || {}, errors: [] };
  const elements = new Map();
  for (const el of doc.elements || []) elements.set(el.id, { el, pins: elementPins(el, ctx) });
  const resolve = (text) => {
    const ep = parseEndpoint(text);
    if (!ep) return { text, error: 'syntax' };
    if (ep.path.length > 1) return { text, ep, error: 'hierarchy' };
    const entry = elements.get(ep.element);
    if (!entry) return { text, ep, error: 'element' };
    const pinId = ep.port ?? (entry.el.kind === 'port' ? 'p' : null);
    const p = entry.pins.find((x) => x.id === pinId);
    if (!p) return { text, ep, element: entry.el, error: 'pin' };
    const width = ep.slice ? ep.slice.width : p.width;
    return { text, ep, element: entry.el, pin: p, width, sliceOk: !ep.slice || (ep.slice.valid && (p.width === null || ep.slice.msb < p.width)) };
  };
  const nets = (doc.nets || []).map((net) => {
    let width = null;
    try {
      width = evalWidth(net.width, ctx.params);
    } catch (error) {
      ctx.errors.push({ net: net.id, what: 'width', error });
    }
    return { net, width, driver: resolve(net.driver), sinks: net.sinks.map(resolve) };
  });
  return { ctx, elements, nets };
}

// Cycles of delay an element adds between one of its inputs and `pin`.
export function pinLatency(el, p) {
  if (!p?.sequential) return 0;
  return p.latency ?? 1;
}
