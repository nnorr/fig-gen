// Normalize Verilator `--json-only` output (tree.json + tree.meta.json) into
// the adapter-neutral rtl-netlist IR. The tree is post-parameterization:
// modules are specialized (e.g. name__P2), generate blocks are resolved, and
// basic dtypes carry resolved ranges.

import path from 'node:path';

const DIRS = { INPUT: 'in', OUTPUT: 'out', INOUT: 'inout' };

export function normalizeVerilatorJson(tree, meta, { adapterVersion, sourceRoot, top, stubModules = new Map() } = {}) {
  const files = meta.files || {};
  const index = new Map();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.addr) index.set(node.addr, node);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  })(tree);

  const diagnostics = [];
  const loc = (text) => {
    const m = /^([^,]+),(\d+):(\d+)/.exec(text || '');
    if (!m || !files[m[1]]) return undefined;
    const file = files[m[1]].filename;
    const rel = sourceRoot ? path.relative(sourceRoot, file) : file;
    return { file: rel.split(path.sep).join('/'), line: Number(m[2]), col: Number(m[3]) };
  };

  const dtypeInfo = (addr) => {
    let node = index.get(addr);
    const array = [];
    for (let guard = 0; node && guard < 32; guard += 1) {
      if (node.type === 'UNPACKARRAYDTYPE') {
        array.push((node.declRange || '').replace(/^\[|\]$/g, ''));
        node = index.get(node.refDTypep) || index.get(node.childDTypep?.[0]?.addr) || node.childDTypep?.[0];
      } else if (node.type === 'REFDTYPE' || node.type === 'ENUMDTYPE') {
        node = index.get(node.refDTypep) || index.get(node.subDTypep) || index.get(node.dtypep === node.addr ? undefined : node.dtypep);
      } else break;
    }
    if (!node) return { width: null, array };
    if (typeof node.range === 'string') {
      const [msb, lsb] = node.range.split(':').map(Number);
      return { width: Math.abs(msb - lsb) + 1, msb, lsb, signed: Boolean(node.signed), array };
    }
    if (node.type === 'BASICDTYPE') return { width: 1, msb: 0, lsb: 0, signed: Boolean(node.signed), array };
    if (Number.isInteger(node.width)) return { width: node.width, array };
    return { width: null, dtype: node.type, array };
  };

  const constValue = (text) => {
    const m = /^(\d+)?'s?([bodh])([0-9a-fA-FxXzZ_]+)$/.exec(text || '');
    if (!m) return text;
    if (/[xXzZ]/.test(m[3])) return text;
    const radix = { b: 2, o: 8, d: 10, h: 16 }[m[2]];
    const n = BigInt.asUintN(64, BigInt(radix === 10 ? m[3] : `0${m[2] === 'h' ? 'x' : m[2]}${m[3].replace(/_/g, '')}`));
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : `0x${n.toString(16)}`;
  };

  const varrefs = (node, access, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => varrefs(n, access, out)); return out; }
    if (node.type === 'VARREF' && (!access || node.access === access)) out.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'dtypep' || key === 'varp') continue;
      if (value && typeof value === 'object') varrefs(value, access, out);
    }
    return out;
  };

  const varDeclCache = new Map();
  const modulesByName = new Map();
  const moduleNodes = (tree.modulesp || []).filter((m) => m.type === 'MODULE');
  for (const m of moduleNodes) modulesByName.set(m.name, m);

  const modules = moduleNodes.map((mod) => {
    const ports = [];
    const nets = [];
    const params = {};
    const registers = new Map();
    const instances = [];
    const deps = [];

    const visit = (stmts, scope) => {
      for (const stmt of stmts || []) {
        if (!stmt || typeof stmt !== 'object') continue;
        switch (stmt.type) {
          case 'VAR': visitVar(stmt, scope); break;
          case 'GENBLOCK': visit(stmt.itemsp, stmt.name ? [...scope, stmt.name] : scope); break;
          case 'CELL': visitCell(stmt, scope); break;
          case 'ALWAYS': visitAlways(stmt, scope); break;
          case 'ASSIGNW': visitComb(stmt, scope); break;
          default: break;
        }
      }
    };

    const visitVar = (v, scope) => {
      const info = dtypeInfo(v.dtypep);
      if (v.isParam || v.varType === 'GPARAM' || v.varType === 'LPARAM') {
        const valueNode = v.valuep?.[0];
        const value = valueNode?.type === 'CONST' ? constValue(valueNode.name) : undefined;
        if (v.isGParam) params[v.name] = value ?? null;
        nets.push({ name: v.name, width: info.width ?? 32, kind: 'param', ...(value !== undefined ? { value: String(value) } : {}), source: loc(v.loc) });
        return;
      }
      const name = [...scope, v.name].join('.');
      if (info.width === null) {
        diagnostics.push({ code: 'rtl/width-unresolved', severity: 'warning', message: `${mod.origName}.${name}: width of dtype ${info.dtype} not resolved`, subject: { module: mod.name, signal: name } });
      }
      const width = info.width ?? 1;
      if (DIRS[v.direction]) {
        ports.push({ name, dir: DIRS[v.direction], width, ...(info.msb !== undefined ? { msb: info.msb, lsb: info.lsb } : {}), ...(info.signed ? { signed: true } : {}), source: loc(v.loc) });
      }
      nets.push({ name, width, ...(info.msb !== undefined ? { msb: info.msb, lsb: info.lsb } : {}), ...(info.array.length ? { array: info.array } : {}), kind: DIRS[v.direction] ? 'port' : v.varType === 'WIRE' ? 'wire' : 'var', source: loc(v.loc) });
    };

    const exprSummary = (expr) => {
      if (!expr) return { kind: 'open' };
      // Width adaption to the port inserts EXTEND/EXTENDS; report the
      // connected expression itself so its own width is visible.
      while ((expr.type === 'EXTEND' || expr.type === 'EXTENDS') && expr.lhsp?.[0]) expr = expr.lhsp[0];
      const width = dtypeInfo(expr.dtypep).width ?? undefined;
      if (expr.type === 'VARREF') return { kind: 'net', net: expr.name, width };
      if (expr.type === 'CONST') return { kind: 'const', value: expr.name, width };
      if (expr.type === 'SEL' && expr.fromp?.[0]?.type === 'VARREF') {
        const lsb = expr.lsbp?.[0]?.type === 'CONST' ? constValue(expr.lsbp[0].name) : undefined;
        const w = expr.widthp?.[0]?.type === 'CONST' ? constValue(expr.widthp[0].name) : width;
        if (Number.isInteger(lsb) && Number.isInteger(w)) return { kind: 'slice', net: expr.fromp[0].name, msb: lsb + w - 1, lsb, width: w };
      }
      const refs = [...new Set(varrefs(expr).map((r) => r.name))].sort();
      return { kind: expr.type === 'CONCAT' ? 'concat' : 'expr', nets: refs, width };
    };

    const visitCell = (cell, scope) => {
      const target = index.get(cell.modp) || modulesByName.get(cell.modName);
      instances.push({
        name: [...scope, cell.name].join('.'),
        ...(scope.length ? { scope: scope.join('.') } : {}),
        module: cell.modName,
        orig_module: target?.origName || cell.modName,
        source: loc(cell.loc),
        connections: (cell.pinsp || []).map((pin) => {
          const modVar = index.get(pin.modVarp);
          const expr = exprSummary(pin.exprp?.[0]);
          return {
            port: pin.name,
            dir: DIRS[modVar?.direction] || 'unknown',
            ...(modVar ? { width: dtypeInfo(modVar.dtypep).width ?? undefined } : {}),
            expr: Object.fromEntries(Object.entries(expr).filter(([, v]) => v !== undefined)),
          };
        }),
      });
    };

    // Per-target dependencies: each assignment's targets depend on its RHS,
    // its LHS index expressions, and every enclosing IF/CASE condition.
    const muxes = [];
    const exprs = [];
    const assignDeps = (stmts) => {
      const out = new Map();
      const names = (node, access) => varrefs(node, access).map((r) => r.name);
      const visitNode = (node, cond) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach((n) => visitNode(n, cond)); return; }
        if (node.type === 'ASSIGN' || node.type === 'ASSIGNDLY' || node.type === 'ASSIGNW') {
          // A top-level ternary on the RHS is a 2:1 mux: record which signals
          // feed the select, the "then" (sel=1) and the "else" (sel=0) side.
          let rhs = node.rhsp?.[0];
          while (rhs && (rhs.type === 'EXTEND' || rhs.type === 'EXTENDS') && rhs.lhsp?.[0]) rhs = rhs.lhsp[0];
          if (rhs?.type === 'COND') {
            const uniq = (xs) => [...new Set(xs)].sort();
            for (const target of names(node.lhsp, 'WR')) {
              const rec = { target, sel: uniq(names(rhs.condp)), in1: uniq(names(rhs.thenp)), in0: uniq(names(rhs.elsep)), source: loc(node.loc) };
              if (!muxes.some((m) => m.target === rec.target && JSON.stringify([m.sel, m.in0, m.in1]) === JSON.stringify([rec.sel, rec.in0, rec.in1]))) muxes.push(rec);
            }
          }
          const sources = [...names(node.rhsp), ...names(node.lhsp, 'RD'), ...cond];
          for (const target of names(node.lhsp, 'WR')) {
            if (!out.has(target)) out.set(target, new Set());
            for (const s of sources) out.get(target).add(s);
          }
          return;
        }
        if (node.type === 'IF') {
          const c = [...cond, ...names(node.condp)];
          visitNode(node.thensp, c);
          visitNode(node.elsesp, c);
          return;
        }
        if (node.type === 'CASE') {
          const c = [...cond, ...names(node.exprp)];
          for (const item of node.itemsp || []) visitNode(item.stmtsp, [...c, ...names(item.condsp)]);
          return;
        }
        for (const [key, value] of Object.entries(node)) if (key !== 'dtypep' && value && typeof value === 'object') visitNode(value, cond);
      };
      visitNode(stmts, []);
      return out;
    };

    // Signal names are module-level base names (Verilator VARREF names), so
    // generate-block scope is metadata, not part of the dependency name.
    // Expression trees of unconditional continuous assignments: the ground
    // truth for gate-level cone expansion and equivalence checks.
    const exprTree = (n, depth = 0) => {
      if (!n || depth > 400) return { op: 'opaque', type: 'depth' };
      const w = dtypeInfo(n.dtypep).width ?? undefined;
      const kids = (key) => (n[key] || []).map((c) => exprTree(c, depth + 1));
      const constNum = (key) => (n[key]?.[0]?.type === 'CONST' ? constValue(n[key][0].name) : undefined);
      const bin = { AND: 'and', OR: 'or', XOR: 'xor', LOGAND: 'land', LOGOR: 'lor', EQ: 'eq', NEQ: 'neq', LT: 'lt', LTS: 'lt', LTE: 'lte', LTES: 'lte', GT: 'gt', GTS: 'gt', GTE: 'gte', GTES: 'gte', ADD: 'add', SUB: 'sub', MUL: 'mul', MULS: 'mul', SHIFTL: 'shl', SHIFTR: 'shr', SHIFTRS: 'shr', CONCAT: 'concat' };
      const un = { NOT: 'not', LOGNOT: 'lnot', REDAND: 'redand', REDOR: 'redor', REDXOR: 'redxor', EXTEND: 'extend', EXTENDS: 'extend', NEGATE: 'neg' };
      if (n.type === 'VARREF') return { op: 'ref', name: n.name, width: w };
      if (n.type === 'CONST') return { op: 'const', value: n.name, width: w };
      if (bin[n.type]) return { op: bin[n.type], width: w, args: [...kids('lhsp'), ...kids('rhsp')] };
      if (un[n.type]) return { op: un[n.type], width: w, args: kids('lhsp') };
      if (n.type === 'COND') return { op: 'cond', width: w, args: [...kids('condp'), ...kids('thenp'), ...kids('elsep')] };
      if (n.type === 'SEL') return { op: 'sel', width: w, lsb: constNum('lsbp'), args: kids('fromp') };
      if (n.type === 'ARRAYSEL') return { op: 'index', width: w, index: constNum('bitp'), args: kids('fromp') };
      if (n.type === 'REPLICATE') return { op: 'repl', width: w, count: constNum('countp'), args: kids('srcp') };
      if (n.type === 'FUNCREF') return { op: 'func', name: n.name, width: w, args: (n.argsp || []).map((a) => exprTree(a.exprp?.[0], depth + 1)) };
      return { op: 'opaque', type: n.type, width: w };
    };
    const lhsTarget = (lhs) => {
      if (lhs?.type === 'VARREF') return { target: lhs.name };
      if ((lhs?.type === 'ARRAYSEL' || lhs?.type === 'SEL') && lhs.fromp?.[0]?.type === 'VARREF') {
        const idxNode = lhs.type === 'ARRAYSEL' ? lhs.bitp?.[0] : lhs.lsbp?.[0];
        const widthNode = lhs.widthp?.[0];
        if (idxNode?.type === 'CONST' && (lhs.type === 'ARRAYSEL' || (widthNode?.type === 'CONST' && constValue(widthNode.name) === 1))) {
          return { target: lhs.fromp[0].name, index: constValue(idxNode.name) };
        }
      }
      return null;
    };
    const recordExprs = (stmt) => {
      const assigns = stmt.type === 'ASSIGNW' ? [stmt] : stmt.type === 'ALWAYS' && stmt.keyword === 'cont_assign' ? (stmt.stmtsp || []).filter((s) => s.type === 'ASSIGNW' || s.type === 'ASSIGN') : [];
      for (const a of assigns) {
        const lhs = lhsTarget(a.lhsp?.[0]);
        if (!lhs || lhs.target.startsWith('_V')) continue;
        exprs.push({ ...lhs, width: dtypeInfo(a.lhsp[0].dtypep).width ?? undefined, expr: exprTree(a.rhsp?.[0]), source: loc(a.loc) });
      }
    };

    const visitComb = (stmt) => {
      recordExprs(stmt);
      const perTarget = stmt.type === 'ALWAYS' ? assignDeps(stmt.stmtsp) : assignDeps([stmt]);
      for (const [target, sources] of [...perTarget.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (target.startsWith('_V')) continue;
        deps.push({ target, sources: [...sources].filter((s) => !s.startsWith('_V')).sort(), kind: 'comb', source: loc(stmt.loc) });
      }
    };

    const visitAlways = (always, scope) => {
      const items = (always.sentreep?.[0]?.sensesp || []).filter((s) => s.edgeType === 'POS' || s.edgeType === 'NEG');
      if (!items.length) { visitComb(always, scope); return; }
      const sens = items.map((s) => ({ net: s.sensp?.[0]?.name, edge: s.edgeType === 'POS' ? 'pos' : 'neg' })).filter((s) => s.net);
      const firstIf = firstIfOf(always.stmtsp);
      let reset;
      let clock = sens[0];
      if (sens.length > 1) {
        const condRefs = firstIf ? varrefs(firstIf.condp).map((r) => r.name) : [];
        // Single-statement if/else is folded into `q <= c ? a : b` (COND), so
        // also look at every IF/COND condition in the block.
        const conditions = [];
        (function collect(node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(collect); return; }
          if ((node.type === 'IF' || node.type === 'COND') && node.condp) conditions.push(node.condp);
          for (const [key, value] of Object.entries(node)) if (key !== 'dtypep' && value && typeof value === 'object') collect(value);
        })(always.stmtsp);
        const anyCondRefs = conditions.flatMap((c) => varrefs(c).map((r) => r.name));
        const resetItem = sens.find((s) => condRefs.includes(s.net))
          || sens.find((s) => anyCondRefs.includes(s.net))
          || sens.find((s) => /rst|reset/i.test(s.net));
        if (resetItem) {
          const inferredBy = condRefs.includes(resetItem.net) ? 'first-if' : anyCondRefs.includes(resetItem.net) ? 'condition' : 'name';
          const condNode = inferredBy === 'first-if' ? firstIf.condp : conditions.find((c) => varrefs(c).some((r) => r.name === resetItem.net));
          const negated = Boolean(condNode) && /^(NOT|LOGNOT)$/.test(condNode[0]?.type);
          reset = { net: resetItem.net, active: negated || resetItem.edge === 'neg' ? 'low' : 'high', async: true, inferred_by: inferredBy };
          clock = sens.find((s) => s !== resetItem);
        } else {
          diagnostics.push({ code: 'rtl/multi-clock-always', severity: 'warning', message: `${mod.origName}: always block with ${sens.length} edges and no identifiable reset`, subject: { module: mod.name }, evidence: { sens }, ...{} });
        }
      } else if (firstIf) {
        const condRefs = varrefs(firstIf.condp).map((r) => r.name);
        if (condRefs.length === 1 && /rst|reset/i.test(condRefs[0])) {
          const negated = /^(NOT|LOGNOT)$/.test(firstIf.condp?.[0]?.type);
          reset = { net: condRefs[0], active: negated ? 'low' : 'high', async: false, inferred_by: 'name' };
        }
      }
      // Loop indices (read by a LOOPTEST) and Verilator-internal `_V*`
      // variables (e.g. from $past in assertions) are not design registers.
      const loopTests = [];
      (function collect(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(collect); return; }
        if (node.type === 'LOOPTEST') loopTests.push(node);
        for (const [key, value] of Object.entries(node)) if (key !== 'dtypep' && value && typeof value === 'object') collect(value);
      })(always.stmtsp);
      const loopIndices = new Set(loopTests.flatMap((t) => varrefs(t).map((r) => r.name)));
      const writes = [...new Set(varrefs(always, 'WR').map((r) => r.name))]
        .filter((n) => !loopIndices.has(n) && !n.startsWith('_V')).sort();
      const reads = [...new Set(varrefs(always, 'RD').map((r) => r.name))].filter((n) => n !== clock?.net && !loopIndices.has(n)).sort();
      for (const target of writes) {
        const decl = findVarDecl(mod, target);
        const info = decl ? dtypeInfo(decl.dtypep) : { width: null, array: [] };
        const key = target;
        const existing = registers.get(key);
        const record = {
          name: target,
          width: info.width ?? 1,
          ...(info.array.length ? { array: info.array } : {}),
          ...(scope.length ? { scope: scope.join('.') } : {}),
          clock: { net: clock.net, edge: clock.edge },
          ...(reset ? { reset } : {}),
          source: loc(always.loc),
        };
        if (existing && existing.clock.net !== record.clock.net) {
          diagnostics.push({ code: 'rtl/multi-clock-register', severity: 'warning', message: `${mod.origName}.${target} written under clocks ${existing.clock.net} and ${record.clock.net}`, subject: { module: mod.name, signal: target } });
        }
        if (!existing) registers.set(key, record);
      }
      const perTarget = assignDeps(always.stmtsp);
      for (const target of writes) {
        const sources = [...(perTarget.get(target) || [])]
          .filter((n) => n !== clock?.net && !loopIndices.has(n) && !n.startsWith('_V'));
        deps.push({ target, sources: [...new Set(sources)].sort(), kind: 'seq', source: loc(always.loc) });
      }
      void reads;
    };

    visit(mod.stmtsp, []);
    // Generate loops emit one assignment per iteration; merge edges so each
    // (target, kind) appears once with the union of its sources.
    const merged = new Map();
    for (const d of deps) {
      const key = `${d.kind}:${d.target}`;
      if (!merged.has(key)) merged.set(key, { ...d, sources: new Set(d.sources) });
      else for (const s of d.sources) merged.get(key).sources.add(s);
    }
    deps.length = 0;
    for (const d of [...merged.values()].sort((a, b) => a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind))) {
      deps.push({ ...d, sources: [...d.sources].sort() });
    }
    const stub = stubModules.get(mod.origName);
    return {
      name: mod.name,
      orig_name: mod.origName,
      params,
      source: loc(mod.loc),
      ...(stub ? { blackbox: stub } : {}),
      ports,
      nets,
      registers: [...registers.values()],
      instances,
      deps,
      muxes,
      exprs,
    };
  });

  function findVarDecl(mod, name) {
    let map = varDeclCache.get(mod.name);
    if (!map) {
      map = new Map();
      (function walk(stmts) {
        for (const s of stmts || []) {
          if (s?.type === 'VAR') map.set(s.name, s);
          else if (s?.type === 'GENBLOCK') walk(s.itemsp);
        }
      })(mod.stmtsp);
      varDeclCache.set(mod.name, map);
    }
    return map.get(name);
  }

  const instantiated = new Set(modules.flatMap((m) => m.instances.map((i) => i.module)));
  const roots = moduleNodes.filter((m) => !instantiated.has(m.name));
  const topNode = roots.find((m) => m.origName === top) || moduleNodes.find((m) => m.origName === top) || roots[0] || moduleNodes[0];
  if (top && topNode.origName !== top) {
    diagnostics.push({ code: 'rtl/top-not-found', severity: 'error', message: `requested top '${top}' not found; using '${topNode.origName}'`, subject: { module: top } });
  }
  const byName = new Map(modules.map((m) => [m.name, m]));
  const hierarchy = [];
  (function descend(moduleName, instPath) {
    const m = byName.get(moduleName);
    if (!m) return;
    hierarchy.push({ path: instPath, module: m.name, ...(m.blackbox ? { blackbox: true } : {}) });
    for (const inst of m.instances) descend(inst.module, `${instPath}.${inst.name}`);
  })(topNode.name, topNode.origName);

  assignClockRoots(modules, byName, topNode, hierarchy);

  return {
    schema_version: 1,
    kind: 'rtl-netlist',
    adapter: { id: 'verilator', version: adapterVersion || 'unknown' },
    top: topNode.origName,
    modules,
    hierarchy,
    diagnostics,
  };
}

function firstIfOf(stmts) {
  for (let node = stmts?.[0], guard = 0; node && guard < 8; guard += 1) {
    if (node.type === 'IF') return node;
    if (node.type === 'BEGIN') node = node.stmtsp?.[0];
    else return undefined;
  }
  return undefined;
}

// Trace each register's clock net up through instance port connections to a
// top-level net. A register keeps `clock_root` only when every instance path
// of its module agrees.
function assignClockRoots(modules, byName, topNode, hierarchy) {
  const parentOf = new Map();
  for (const m of modules) for (const inst of m.instances) {
    if (!parentOf.has(inst.module)) parentOf.set(inst.module, []);
    parentOf.get(inst.module).push({ parent: m, inst });
  }
  const resolve = (moduleName, net, depth = 0) => {
    const m = byName.get(moduleName);
    if (depth > 64 || !m) return [];
    if (moduleName === topNode.name) return [net];
    const isInput = m.ports.some((p) => p.name === net && p.dir === 'in');
    if (!isInput) return [`${m.orig_name}:${net}`];
    const roots = [];
    for (const { parent, inst } of parentOf.get(moduleName) || []) {
      const conn = inst.connections.find((c) => c.port === net);
      if (!conn || !conn.expr.net) { roots.push(`${parent.orig_name}.${inst.name}:${net}?`); continue; }
      roots.push(...resolve(parent.name, conn.expr.net, depth + 1));
    }
    return roots;
  };
  const reachable = new Set(hierarchy.map((h) => h.module));
  for (const m of modules) {
    if (!reachable.has(m.name)) continue;
    for (const r of m.registers) {
      const roots = [...new Set(resolve(m.name, r.clock.net))];
      if (roots.length === 1) r.clock_root = roots[0];
    }
  }
}
