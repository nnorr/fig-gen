// Flatten a normalized rtl-netlist into hierarchical signals with backward
// dependency edges (comb, seq, port), for structural cross-checks.

export function flattenNetlist(netlist) {
  const byName = new Map(netlist.modules.map((m) => [m.name, m]));
  const signals = new Map();
  const back = new Map();
  const instances = new Map();
  const addEdge = (target, source, kind) => {
    if (!back.has(target)) back.set(target, []);
    back.get(target).push({ source, kind });
  };
  for (const h of netlist.hierarchy) {
    const m = byName.get(h.module);
    if (!m) continue;
    instances.set(h.path, m);
    const regs = new Map(m.registers.map((r) => [r.name, r]));
    for (const n of m.nets) {
      if (n.kind === 'param') continue;
      const count = (n.array || []).reduce((acc, d) => {
        const [a, b] = d.split(':').map(Number);
        return acc * (Math.abs(a - b) + 1);
      }, 1);
      signals.set(`${h.path}.${n.name}`, {
        path: `${h.path}.${n.name}`, name: n.name, instance: h.path, module: m.orig_name,
        width: n.width, bits: n.width * count, register: regs.get(n.name),
        blackbox: Boolean(m.blackbox), portDir: m.ports.find((p) => p.name === n.name)?.dir,
      });
    }
    for (const d of m.deps || []) for (const s of d.sources) addEdge(`${h.path}.${d.target}`, `${h.path}.${s}`, d.kind);
    for (const inst of m.instances) {
      const child = `${h.path}.${inst.name}`;
      for (const c of inst.connections) {
        const nets = c.expr.net ? [c.expr.net] : (c.expr.nets || []);
        for (const net of nets) {
          if (c.dir === 'out') addEdge(`${h.path}.${net}`, `${child}.${c.port}`, 'port');
          else addEdge(`${child}.${c.port}`, `${h.path}.${net}`, 'port');
        }
      }
    }
  }
  return { signals, back, instances, top: netlist.hierarchy[0]?.path, byName };
}

// 0-1 BFS backwards from `start`: comb/port edges cost 0, seq edges cost 1.
// Returns Map(signal path -> minimum register stages).
export function backwardReach(flat, start, { maxSeq = 0, maxNodes = 50000 } = {}) {
  const dist = new Map([[start, 0]]);
  const dq = [start];
  while (dq.length && dist.size < maxNodes) {
    const v = dq.shift();
    for (const { source, kind } of flat.back.get(v) || []) {
      const nd = dist.get(v) + (kind === 'seq' ? 1 : 0);
      if (nd > maxSeq) continue;
      if (!dist.has(source) || nd < dist.get(source)) {
        dist.set(source, nd);
        if (kind === 'seq') dq.push(source); else dq.unshift(source);
      }
    }
  }
  return dist;
}
