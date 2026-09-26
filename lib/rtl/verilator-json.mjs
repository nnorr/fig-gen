// Normalize Verilator `--json-only` output (tree.json + tree.meta.json) into
// the adapter-neutral rtl-netlist IR. The tree is post-parameterization:
// modules are specialized (e.g. name__P2), generate blocks are resolved, and
// basic dtypes carry resolved ranges.

import fs from 'node:fs';
import path from 'node:path';
import { extractFsms } from './fsm-extract.mjs';

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

  const rawLoc = (text) => {
    const m = /^([^,]+),(\d+):(\d+)/.exec(text || '');
    return m ? { key: m[1], line: Number(m[2]), col: Number(m[3]) } : null;
  };
  const sourceCache = new Map();
  const sourceToken = (node) => {
    const p = rawLoc(node?.loc);
    const file = p && files[p.key]?.filename;
    if (!file) return null;
    try {
      if (!sourceCache.has(file)) sourceCache.set(file, fs.readFileSync(file, 'utf8').split(/\r?\n/));
      const line = sourceCache.get(file)[p.line - 1] || '';
      // Verilator columns are one-based and point at the original identifier
      // even when the JSON node has already been folded into a literal.
      const tail = line.slice(Math.max(0, p.col - 1));
      return /^[A-Za-z_][A-Za-z0-9_$]*/.exec(tail)?.[0] ?? null;
    } catch { return null; }
  };

  const diagnostics = [];
  const loc = (text) => {
    const m = /^([^,]+),(\d+):(\d+)/.exec(text || '');
    if (!m || !files[m[1]]) return undefined;
    const file = files[m[1]].filename;
    const rel = sourceRoot ? path.relative(sourceRoot, file) : file;
    return { file: rel.split(path.sep).join('/'), line: Number(m[2]), col: Number(m[3]) };
  };

  // Type resolution through Verilator's type table: typedef chains
  // (REFDTYPE), enums (base range plus item names and encodings), packed
  // structs/unions (member widths and bit offsets), packed arrays (element
  // width × count) and unpacked arrays (dimensions kept as `array`).
  const rangeText = (r) => String(r || '').replace(/^\[|\]$/g, '');
  const rangeCount = (r) => {
    const [a, b] = rangeText(r).split(':').map(Number);
    return Number.isInteger(a) && Number.isInteger(b) ? Math.abs(a - b) + 1 : null;
  };
  const sourceDtypeOf = (node) => {
    if (node?.type !== 'MEMBERDTYPE') return null;
    const p = rawLoc(node.loc);
    if (!p) return null;
    let best = null; let bestCol = -1;
    for (const candidate of index.values()) {
      if (!['BASICDTYPE', 'REFDTYPE', 'ENUMDTYPE', 'STRUCTDTYPE', 'PACKARRAYDTYPE'].includes(candidate.type)) continue;
      const q = rawLoc(candidate.loc);
      if (q?.key === p.key && q.line === p.line && q.col < p.col && q.col > bestCol) { best = candidate; bestCol = q.col; }
    }
    return best;
  };
  const childOf = (node) => node.refDTypep || node.subDTypep || node.childDTypep?.[0]?.addr || node.childDTypep?.[0] || sourceDtypeOf(node);
  const typeCache = new Map();
  const resolveType = (ref, depth = 0) => {
    const node = typeof ref === 'string' ? index.get(ref) : ref;
    if (!node || depth > 64) return { width: null };
    if (node.addr && typeCache.has(node.addr)) return typeCache.get(node.addr);
    let out;
    switch (node.type) {
      case 'REFDTYPE': {
        const target = resolveType(childOf(node) || (node.dtypep !== node.addr ? node.dtypep : undefined), depth + 1);
        out = { ...target, type_name: target.type_name ?? node.name };
        break;
      }
      case 'UNPACKARRAYDTYPE': {
        const elem = resolveType(childOf(node), depth + 1);
        out = { ...elem, unpacked: [rangeText(node.declRange), ...(elem.unpacked || [])] };
        break;
      }
      case 'ENUMDTYPE': {
        const base = resolveType(childOf(node), depth + 1);
        const items = (node.itemsp || []).map((item) => {
          const c = item.valuep?.[0];
          const value = c?.type === 'CONST' ? constValue(c.name) : undefined;
          return { name: item.name, ...(value !== undefined ? { value: typeof value === 'number' ? value : String(value) } : {}), ...(c?.type === 'CONST' ? { literal: c.name } : {}) };
        });
        out = { ...base, type_name: node.name, enum: { type: node.name, width: base.width, items } };
        break;
      }
      case 'STRUCTDTYPE':
      case 'UNIONDTYPE': {
        const union = node.type === 'UNIONDTYPE';
        const parts = (node.membersp || []).map((m) => ({ name: m.name, info: resolveType(childOf(m), depth + 1) }));
        if (node.packed === false || !parts.length || parts.some((p) => p.info.width === null)) { out = { width: null, dtype: node.type }; break; }
        const width = union ? Math.max(...parts.map((p) => p.info.width)) : parts.reduce((a, p) => a + p.info.width, 0);
        // Members are declared MSB first.
        let top = width;
        const members = parts.map((p) => {
          const lsb = union ? 0 : top - p.info.width;
          if (!union) top = lsb;
          return {
            name: p.name, width: p.info.width, msb: lsb + p.info.width - 1, lsb,
            ...(p.info.type_name ? { type: p.info.type_name } : {}),
            ...(p.info.enum ? { enum: p.info.enum } : {}),
          };
        });
        out = { width, msb: width - 1, lsb: 0, type_name: node.name, struct: { type: node.name, kind: union ? 'union' : 'struct', width, members } };
        break;
      }
      case 'PACKARRAYDTYPE': {
        const elem = resolveType(childOf(node), depth + 1);
        const count = rangeCount(node.declRange);
        if (elem.width === null || count === null) { out = { width: null, dtype: node.type }; break; }
        const width = elem.width * count;
        out = {
          width, msb: width - 1, lsb: 0,
          packed_array: {
            dims: [rangeText(node.declRange), ...(elem.packed_array?.dims || [])],
            element_width: elem.packed_array?.element_width ?? elem.width,
            ...(elem.type_name ? { element_type: elem.type_name } : {}),
          },
          ...(elem.struct ? { struct: elem.struct } : {}),
          ...(elem.enum ? { enum: elem.enum } : {}),
        };
        break;
      }
      default:
        if (typeof node.range === 'string') {
          const [msb, lsb] = node.range.split(':').map(Number);
          out = { width: Math.abs(msb - lsb) + 1, msb, lsb, signed: Boolean(node.signed) };
        } else if (node.type === 'BASICDTYPE') out = { width: 1, msb: 0, lsb: 0, signed: Boolean(node.signed) };
        else if (Number.isInteger(node.width)) out = { width: node.width };
        else out = { width: null, dtype: node.type };
    }
    if (node.addr) typeCache.set(node.addr, out);
    return out;
  };
  const dtypeInfo = (addr) => {
    const info = resolveType(addr);
    return { ...info, array: info.unpacked || [] };
  };
  // Type metadata carried on ports, nets and registers (phase-3 FSM input).
  const typeFields = (info) => ({
    ...(info.type_name ? { type: info.type_name } : {}),
    ...(info.enum ? { enum: info.enum } : {}),
    ...(info.struct ? { struct: info.struct } : {}),
    ...(info.packed_array ? { packed_array: info.packed_array } : {}),
  });

  const constValue = (text) => {
    const m = /^(\d+)?'s?([bodh])([0-9a-fA-FxXzZ_]+)$/.exec(text || '');
    if (!m) return text;
    if (/[xXzZ]/.test(m[3])) return text;
    const radix = { b: 2, o: 8, d: 10, h: 16 }[m[2]];
    const n = BigInt.asUintN(64, BigInt(radix === 10 ? m[3] : `0${m[2] === 'h' ? 'x' : m[2]}${m[3].replace(/_/g, '')}`));
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : `0x${n.toString(16)}`;
  };

  // A function or task call reads its arguments and every non-local signal
  // its body reads, so dependencies are built as if the call were inlined
  // (a helper such as `operand_for(op)` that selects among module registers).
  const funcRefsCache = new Map();
  const funcBodyRefs = (fn, depth) => {
    if (funcRefsCache.has(fn.addr)) return funcRefsCache.get(fn.addr);
    funcRefsCache.set(fn.addr, []);
    const locals = new Set();
    (function collect(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(collect); return; }
      if (n.type === 'VAR') locals.add(n.name);
      for (const [key, value] of Object.entries(n)) if (key !== 'dtypep' && value && typeof value === 'object') collect(value);
    })([fn.fvarp, fn.stmtsp]);
    const refs = varrefs(fn.stmtsp, null, [], depth + 1).filter((r) => r.access !== 'WR' && !locals.has(r.name));
    funcRefsCache.set(fn.addr, refs);
    return refs;
  };
  function varrefs(node, access, out = [], depth = 0) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => varrefs(n, access, out, depth)); return out; }
    if (node.type === 'VARREF' && (!access || node.access === access)) out.push(node);
    if ((node.type === 'FUNCREF' || node.type === 'TASKREF') && depth < 16 && access !== 'WR') {
      const fn = index.get(node.taskp);
      if (fn) out.push(...funcBodyRefs(fn, depth));
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'dtypep' || key === 'varp') continue;
      if (value && typeof value === 'object') varrefs(value, access, out, depth);
    }
    return out;
  }

  const varDeclCache = new Map();
  const modulesByName = new Map();
  const moduleNodes = (tree.modulesp || []).filter((m) => m.type === 'MODULE');
  for (const m of moduleNodes) modulesByName.set(m.name, m);

  // visitVar names a declaration inside a generate block with the block's
  // scope (`gen_w1.imm31`), but Verilator's VARREFs carry the bare name
  // (`imm31`). Registers and deps then named a different signal than the net
  // list, and coverage dropped live generate-block registers as dead logic
  // (serv_immdec: 6 registers). Point every reference at its declaration.
  const isParamVar = (v) => v.isParam || v.varType === 'GPARAM' || v.varType === 'LPARAM';
  const scopedVarName = new Map();
  for (const m of moduleNodes) {
    (function walk(stmts, scope) {
      for (const s of stmts || []) {
        if (s?.type === 'VAR' && scope.length && !isParamVar(s)) scopedVarName.set(s.addr, [...scope, s.name].join('.'));
        else if (s?.type === 'GENBLOCK') walk(s.itemsp, s.name ? [...scope, s.name] : scope);
        else if (s?.type === 'BEGIN') walk(s.stmtsp, s.name ? [...scope, s.name] : scope);
      }
    })(m.stmtsp, []);
  }
  if (scopedVarName.size) {
    (function rename(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(rename); return; }
      if (node.type === 'VARREF' && scopedVarName.has(node.varp)) node.name = scopedVarName.get(node.varp);
      for (const [key, value] of Object.entries(node)) if (key !== 'dtypep' && key !== 'varp' && value && typeof value === 'object') rename(value);
    })(tree);
  }

  const modules = moduleNodes.map((mod) => {
    const ports = [];
    const nets = [];
    const params = {};
    const paramNames = new Set();
    const registers = new Map();
    const instances = [];
    const deps = [];

    const visit = (stmts, scope) => {
      for (const stmt of stmts || []) {
        if (!stmt || typeof stmt !== 'object') continue;
        switch (stmt.type) {
          case 'VAR': visitVar(stmt, scope); break;
          case 'GENBLOCK': visit(stmt.itemsp, stmt.name ? [...scope, stmt.name] : scope); break;
          // Verilator 5.022 represents resolved if-generate branches as BEGIN
          // nodes (with generate=true), not GENBLOCK. Descend into them so
          // branch-local registers and assignments remain in the netlist.
          case 'BEGIN': visit(stmt.stmtsp, stmt.name ? [...scope, stmt.name] : scope); break;
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
        paramNames.add(v.name);
        nets.push({ name: v.name, width: info.width ?? 32, kind: 'param', ...(value !== undefined ? { value: String(value) } : {}), source: loc(v.loc) });
        return;
      }
      const name = [...scope, v.name].join('.');
      if (info.width === null) {
        diagnostics.push({ code: 'rtl/width-unresolved', severity: 'warning', message: `${mod.origName}.${name}: width of dtype ${info.dtype} not resolved`, subject: { module: mod.name, signal: name } });
      }
      const width = info.width ?? 1;
      if (DIRS[v.direction]) {
        // Unpacked dimensions travel with the port as they do with the net below:
        // a port declared `logic [33:0] x[2]` is 34 bits wide over 2 elements, and a
        // consumer that drops `array` sees 34 where the flattened signal is 68.
        ports.push({ name, dir: DIRS[v.direction], width, ...(info.msb !== undefined ? { msb: info.msb, lsb: info.lsb } : {}), ...(info.array.length ? { array: info.array } : {}), ...(info.signed ? { signed: true } : {}), ...typeFields(info), source: loc(v.loc) });
      }
      nets.push({ name, width, ...(info.msb !== undefined ? { msb: info.msb, lsb: info.lsb } : {}), ...(info.array.length ? { array: info.array } : {}), kind: DIRS[v.direction] ? 'port' : v.varType === 'WIRE' ? 'wire' : 'var', ...typeFields(info), source: loc(v.loc) });
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
        // Verilator <= 5.022 emits no modName on CELL: the module is reachable
        // only through modp, which `target` already resolves. Without this
        // fallback every instance loses its module and the adapter output
        // fails schema validation.
        module: cell.modName || target?.name,
        orig_module: target?.origName || cell.modName || target?.name,
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
    const alwaysBlocks = [];
    const assignDeps = (stmts) => {
      const out = new Map();
      // Bits each source contributes to a target. A reference wrapped in a
      // constant part-select records that range; a bare reference records '*'
      // (the whole signal). A source read both ways stays whole.
      const ranges = new Map();
      const noteRange = (target, source, range) => {
        if (!ranges.has(target)) ranges.set(target, new Map());
        const m = ranges.get(target);
        if (!m.has(source)) m.set(source, new Set());
        m.get(source).add(range);
      };
      const readRanges = (node, target) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach((n) => readRanges(n, target)); return; }
        if (node.type === 'SEL' && node.fromp?.[0]?.type === 'VARREF') {
          const lsb = node.lsbp?.[0]?.type === 'CONST' ? constValue(node.lsbp[0].name) : undefined;
          const w = node.widthp?.[0]?.type === 'CONST' ? constValue(node.widthp[0].name) : undefined;
          if (Number.isInteger(lsb) && Number.isInteger(w)) {
            noteRange(target, node.fromp[0].name, `${lsb + w - 1}:${lsb}`);
            return;
          }
        }
        if (node.type === 'VARREF' && node.access !== 'WR') noteRange(target, node.name, '*');
        for (const [key, value] of Object.entries(node)) {
          if (key === 'dtypep' || key === 'varp') continue;
          if (value && typeof value === 'object') readRanges(value, target);
        }
      };
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
            readRanges(node.rhsp, target);
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
      out.ranges = ranges;
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
      // A constant written as a localparam/parameter keeps that name (FSM guards print it).
      if (n.type === 'CONST') {
        const inferred = n.origParamName ?? sourceToken(n);
        return { op: 'const', value: n.name, width: w, ...(paramNames.has(inferred) ? { param: inferred } : {}) };
      }
      if (bin[n.type]) return { op: bin[n.type], width: w, args: [...kids('lhsp'), ...kids('rhsp')] };
      if (un[n.type]) return { op: un[n.type], width: w, args: kids('lhsp') };
      if (n.type === 'COND') return { op: 'cond', width: w, args: [...kids('condp'), ...kids('thenp'), ...kids('elsep')] };
      // A variable bit or element select keeps its index expression (index_expr).
      if (n.type === 'SEL') return { op: 'sel', width: w, lsb: constNum('lsbp'), args: kids('fromp'), ...(constNum('lsbp') === undefined && n.lsbp?.[0] ? { index_expr: exprTree(n.lsbp[0], depth + 1) } : {}) };
      if (n.type === 'ARRAYSEL') return { op: 'index', width: w, index: constNum('bitp'), args: kids('fromp'), ...(constNum('bitp') === undefined && n.bitp?.[0] ? { index_expr: exprTree(n.bitp[0], depth + 1) } : {}) };
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
      // Verilator <= 5.022 hangs the SENTREE off `sensesp` rather than
      // `sentreep`, so reading only `sentreep` finds no clocked sensitivity and
      // EVERY always_ff is misread as combinational: 0 registers extracted over
      // 602 modules on a Chipyard SoC. Accept both spellings.
      const sentree = always.sentreep?.[0] || (always.sensesp || []).find((n) => n.type === 'SENTREE');
      const items = (sentree?.sensesp || []).filter((s) => s.edgeType === 'POS' || s.edgeType === 'NEG');
      alwaysBlocks.push({ node: always, seq: items.length > 0 });
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
          ...typeFields(info),
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
        // A source read only as one constant part-select is recorded with that
        // range, so a 16-bit register loaded from `wide[15:0]` is not drawn as
        // if it latched all 32 bits.
        const rmap = perTarget.ranges?.get(target);
        const slices = {};
        for (const sName of new Set(sources)) {
          const set = rmap?.get(sName);
          if (set && set.size === 1 && !set.has('*')) slices[sName] = [...set][0];
        }
        deps.push({ target, sources: [...new Set(sources)].sort(), kind: 'seq', ...(Object.keys(slices).length ? { slices } : {}), source: loc(always.loc) });
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
    // State machines (SPEC §5): registers whose next value is chosen by a case
    // on themselves, with states, reset, transitions and default branch.
    let fsms = [];
    try {
      fsms = extractFsms({
        moduleName: mod.origName,
        always: alwaysBlocks,
        registers: [...registers.values()],
        varInfo: (name) => { const decl = findVarDecl(mod, name); return decl ? dtypeInfo(decl.dtypep) : null; },
        exprTree,
        loc,
        params: nets.filter((n) => n.kind === 'param'),
        paramName: (node) => { const name = sourceToken(node); return paramNames.has(name) ? name : null; },
        diagnostics,
      });
    } catch (error) {
      // FSM extraction never costs the netlist: an unexpected shape is a warning.
      diagnostics.push({ code: 'rtl/fsm-unparsed', severity: 'warning', message: `${mod.origName}: state machine extraction stopped (${String(error.message).slice(0, 160)})`, subject: { module: mod.name } });
    }
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
      ...(fsms.length ? { fsms } : {}),
    };
  });

  function findVarDecl(mod, name) {
    let map = varDeclCache.get(mod.name);
    if (!map) {
      map = new Map();
      (function walk(stmts) {
        for (const s of stmts || []) {
          if (s?.type === 'VAR') map.set(scopedVarName.get(s.addr) || s.name, s);
          else if (s?.type === 'GENBLOCK') walk(s.itemsp);
          else if (s?.type === 'BEGIN') walk(s.stmtsp);
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

  // Named enum and packed struct/union types of the design (packages and
  // modules), each once: item encodings and member offsets for FSM and
  // register-map figures.
  const types = [];
  const seenTypes = new Set();
  for (const node of index.values()) {
    if (!['ENUMDTYPE', 'STRUCTDTYPE', 'UNIONDTYPE'].includes(node.type) || !node.name || seenTypes.has(node.name)) continue;
    const info = resolveType(node);
    if (info.width === null) continue;
    seenTypes.add(node.name);
    const def = info.enum
      ? { name: node.name, kind: 'enum', width: info.width, items: info.enum.items }
      : { name: node.name, kind: info.struct.kind, width: info.width, members: info.struct.members };
    const where = loc(node.loc);
    types.push(where ? { ...def, source: where } : def);
  }
  types.sort((a, b) => a.name.localeCompare(b.name));

  return {
    schema_version: 1,
    kind: 'rtl-netlist',
    adapter: { id: 'verilator', version: adapterVersion || 'unknown' },
    top: topNode.origName,
    modules,
    hierarchy,
    ...(types.length ? { types } : {}),
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
