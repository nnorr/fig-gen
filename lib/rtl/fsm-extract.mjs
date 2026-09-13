// FSM extraction from Verilator's JSON AST (SPEC §5, §11.5). A state machine
// is a register R whose next value is chosen by a `case (R)` (or `R == K`
// comparisons), either in the clocked block itself or in a combinational
// block writing a next-state variable N that the clocked block loads.
//
// The next-state logic is evaluated symbolically once per concrete state
// value: comparisons of R against constants fold to true/false, the case item
// for that value is selected, and the result is a decision tree over the
// remaining conditions whose leaves are constant next states. Every leaf that
// leaves the state is a transition guarded by the conjunction of its path
// conditions. Assignments that keep the state (`n = c`, `R <= R`) are holds.
// Constant assignments in the clocked block that do not depend on R (a
// synchronous soft reset before `R <= N`) are any-state overrides.

const bigintOf = (text) => {
  const m = /^(\d+)?'s?([bodhBODH])([0-9a-fA-F_]+)$/.exec(String(text ?? ''));
  if (m) {
    const radix = { b: 2, o: 8, d: 10, h: 16 }[m[2].toLowerCase()];
    const digits = m[3].replace(/_/g, '');
    try { return radix === 10 ? BigInt(digits) : BigInt(`0${m[2].toLowerCase() === 'h' ? 'x' : m[2].toLowerCase()}${digits}`); } catch { return null; }
  }
  if (/^\d+$/.test(String(text ?? ''))) return BigInt(text);
  return null;
};
export const literalValue = bigintOf;

export const svLiteral = (value, width) => `${width}'h${BigInt(value).toString(16)}`;

const TRUE = { op: 'const', value: "1'h1", width: 1 };
const FALSE = { op: 'const', value: "1'h0", width: 1 };
const isTrue = (e) => e?.op === 'const' && bigintOf(e.value) !== null && bigintOf(e.value) !== 0n;
const isFalse = (e) => e?.op === 'const' && bigintOf(e.value) === 0n;
const boolConst = (b) => (b ? TRUE : FALSE);

export function conj(terms) {
  const kept = terms.filter((t) => t && !isTrue(t));
  if (kept.some(isFalse)) return FALSE;
  if (!kept.length) return null;
  return kept.slice(1).reduce((a, b) => ({ op: 'land', width: 1, args: [a, b] }), kept[0]);
}
export const negate = (e) => (isTrue(e) ? FALSE : isFalse(e) ? TRUE : e?.op === 'lnot' ? e.args[0] : { op: 'lnot', width: 1, args: [e] });

// Fold constants in an exprTree: the state register takes the concrete value
// `ctx.state` (a BigInt), or no named value at all (`ctx.state === null`,
// the "other encodings" of a default branch); the reset net takes its
// inactive level. Returns { e, usedState }.
export function foldExpr(e, ctx) {
  let usedState = false;
  const f = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (n.op === 'ref' && ctx.resetNet && n.name === ctx.resetNet) return { op: 'const', value: `1'h${ctx.resetLevel}`, width: 1 };
    if (n.op === 'ref' && n.name === ctx.register && ctx.state !== undefined && ctx.state !== null) {
      usedState = true;
      return { op: 'const', value: svLiteral(ctx.state, n.width ?? ctx.width ?? 32), width: n.width ?? ctx.width };
    }
    const args = (n.args || []).map(f);
    const out = { ...n, ...(n.args ? { args } : {}) };
    const [a, b] = args;
    const va = a?.op === 'const' ? bigintOf(a.value) : null;
    const vb = b?.op === 'const' ? bigintOf(b.value) : null;
    const refsState = (x) => x?.op === 'ref' && x.name === ctx.register;
    switch (n.op) {
      case 'extend': return a?.op === 'const' ? { ...a, width: n.width } : out;
      case 'eq': case 'neq': case 'lt': case 'lte': case 'gt': case 'gte': {
        if (va !== null && vb !== null) {
          const r = { eq: va === vb, neq: va !== vb, lt: va < vb, lte: va <= vb, gt: va > vb, gte: va >= vb }[n.op];
          return boolConst(r);
        }
        // The "other encodings" case: R equals none of the named states.
        if (ctx.state === null && (n.op === 'eq' || n.op === 'neq') && ((refsState(a) && vb !== null && ctx.named?.has(vb)) || (refsState(b) && va !== null && ctx.named?.has(va)))) {
          usedState = true;
          return boolConst(n.op === 'neq');
        }
        return out;
      }
      case 'lnot': return va !== null ? boolConst(va === 0n) : a?.op === 'lnot' ? a.args[0] : out;
      case 'not': return va !== null && (n.width ?? 1) === 1 ? boolConst(va === 0n) : out;
      case 'land': case 'and': {
        if (n.op === 'and' && (n.width ?? 1) !== 1) return va !== null && vb !== null ? { op: 'const', value: svLiteral(va & vb, n.width), width: n.width } : out;
        if (isFalse(a) || isFalse(b)) return FALSE;
        if (isTrue(a)) return b;
        if (isTrue(b)) return a;
        return out;
      }
      case 'lor': case 'or': {
        if (n.op === 'or' && (n.width ?? 1) !== 1) return va !== null && vb !== null ? { op: 'const', value: svLiteral(va | vb, n.width), width: n.width } : out;
        if (isTrue(a) || isTrue(b)) return TRUE;
        if (isFalse(a)) return b;
        if (isFalse(b)) return a;
        return out;
      }
      case 'cond': {
        const [c, t, el] = args;
        if (isTrue(c)) return t;
        if (isFalse(c)) return el;
        return out;
      }
      case 'redor': return va !== null ? boolConst(va !== 0n) : out;
      default: return out;
    }
  };
  const e2 = f(e);
  return { e: e2, usedState };
}

// Symbolic values of the state target.
const HOLD = { k: 'hold' };
// Values hold BigInt encodings; compare them by a BigInt-safe serialization
// that ignores source locations.
const serialize = (v) => JSON.stringify(v, (key, x) => (key === 'loc' || key === 'source' ? undefined : typeof x === 'bigint' ? `${x}n` : x));
const sameValue = (a, b) => serialize(a) === serialize(b);

function unwrap(node) {
  let n = node;
  while (n && (n.type === 'EXTEND' || n.type === 'EXTENDS') && n.lhsp?.[0]) n = n.lhsp[0];
  return n;
}

export function extractFsms({ moduleName, always, registers, varInfo, exprTree, loc, params = [], diagnostics = [] }) {
  const fsms = [];
  const assignsTo = (node, name, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => assignsTo(n, name, out)); return out; }
    if ((node.type === 'ASSIGN' || node.type === 'ASSIGNDLY' || node.type === 'ASSIGNW') && node.lhsp?.[0]?.type === 'VARREF' && node.lhsp[0].name === name) out.push(node);
    for (const [k, v] of Object.entries(node)) if (k !== 'dtypep' && k !== 'notParallelp' && v && typeof v === 'object') assignsTo(v, name, out);
    return out;
  };
  const hasStateCase = (node, reg) => {
    let found = false;
    (function walk(n) {
      if (found || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.type === 'CASE' && n.exprp?.[0]?.type === 'VARREF' && n.exprp[0].name === reg) { found = true; return; }
      for (const [k, v] of Object.entries(n)) if (k !== 'dtypep' && k !== 'notParallelp' && v && typeof v === 'object') walk(v);
    })(node);
    return found;
  };
  // IF conditions that test the register for equality with a constant
  // (if-chains); ordering compares (a counter's `cnt <= 1`) do not count.
  const hasStateCompareIf = (node, reg) => {
    let found = false;
    const eqTest = (c) => {
      let hit = false;
      (function walk(n) {
        if (hit || !n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if ((n.type === 'EQ' || n.type === 'NEQ') && [n.lhsp?.[0], n.rhsp?.[0]].some((x) => x?.type === 'VARREF' && x.name === reg) && [n.lhsp?.[0], n.rhsp?.[0]].some((x) => x?.type === 'CONST')) { hit = true; return; }
        for (const [k, v] of Object.entries(n)) if (k !== 'dtypep' && v && typeof v === 'object') walk(v);
      })(c);
      return hit;
    };
    (function walk(n) {
      if (found || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.type === 'IF' && eqTest(n.condp)) { found = true; return; }
      for (const [k, v] of Object.entries(n)) if (k !== 'dtypep' && k !== 'notParallelp' && v && typeof v === 'object') walk(v);
    })(node);
    return found;
  };

  for (const reg of registers) {
    if (!reg || reg.array || (reg.width ?? 0) > 32) continue;
    const R = reg.name;
    const seqBlocks = always.filter((a) => a.seq && assignsTo(a.node.stmtsp, R).length);
    if (seqBlocks.length !== 1) continue;
    const seq = seqBlocks[0];
    // Candidate next-state variables: variables loaded into R.
    const rhsNames = new Set();
    for (const a of assignsTo(seq.node.stmtsp, R)) {
      (function collect(n) {
        const u = unwrap(n);
        if (!u) return;
        if (u.type === 'VARREF' && u.name !== R) rhsNames.add(u.name);
        if (u.type === 'COND') { collect(u.thenp?.[0]); collect(u.elsep?.[0]); }
      })(a.rhsp?.[0]);
    }
    let next = null;
    let comb = null;
    for (const N of rhsNames) {
      const blocks = always.filter((a) => !a.seq && assignsTo(a.node.stmtsp, N).length && (hasStateCase(a.node.stmtsp, R) || hasStateCompareIf(a.node.stmtsp, R)));
      if (blocks.length === 1) { next = N; comb = blocks[0]; break; }
    }
    if (!next && !hasStateCase(seq.node.stmtsp, R)) continue;

    const info = varInfo(R) || {};
    const width = reg.width;
    // States: enum items, else named case labels / assigned constants.
    const constsOfInterest = [];
    const collectConsts = (node, target) => {
      (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.type === 'CASE' && n.exprp?.[0]?.type === 'VARREF' && n.exprp[0].name === R) {
          for (const item of n.itemsp || []) for (const c of item.condsp || []) if (c.type === 'CONST') constsOfInterest.push(c);
        }
        if ((n.type === 'ASSIGN' || n.type === 'ASSIGNDLY') && n.lhsp?.[0]?.type === 'VARREF' && n.lhsp[0].name === target) {
          (function rhs(x) {
            const u = unwrap(x);
            if (!u) return;
            if (u.type === 'CONST') constsOfInterest.push(u);
            if (u.type === 'COND') { rhs(u.thenp?.[0]); rhs(u.elsep?.[0]); }
          })(n.rhsp?.[0]);
        }
        for (const [k, v] of Object.entries(n)) if (k !== 'dtypep' && k !== 'notParallelp' && v && typeof v === 'object') walk(v);
      })(node);
    };
    collectConsts(seq.node.stmtsp, R);
    if (comb) collectConsts(comb.node.stmtsp, next);

    let states;
    let encodingSource;
    const enumInfo = reg.enum ?? info.enum;
    if (enumInfo?.items?.length) {
      encodingSource = 'enum';
      states = enumInfo.items.filter((it) => it.value !== undefined).map((it) => ({ name: it.name, value: BigInt(it.value) }));
    } else {
      const byValue = new Map();
      for (const c of constsOfInterest) {
        const v = bigintOf(c.name);
        if (v === null) continue;
        const prev = byValue.get(v);
        if (!prev || (!prev.param && c.origParamName)) byValue.set(v, { value: v, param: c.origParamName });
      }
      const order = new Map(params.map((p, i) => [p.name, i]));
      const list = [...byValue.values()].sort((a, b) => (order.get(a.param) ?? 1e9) - (order.get(b.param) ?? 1e9) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
      encodingSource = list.length && list.every((s) => s.param) ? 'localparam' : list.some((s) => s.param) ? 'localparam' : 'literal';
      states = list.map((s) => ({ name: s.param ?? `S0x${s.value.toString(16)}`, value: s.value }));
    }
    if (states.length < 2) continue;
    const nameOf = new Map(states.map((s) => [s.value, s.name]));
    const named = new Set(states.map((s) => s.value));
    const resetNet = reg.reset?.net;
    const resetActive = reg.reset?.active === 'high' ? 1 : 0;
    // Warnings wait until the register is known to be a state machine: a
    // counter tested with `cnt == K` is not one, and says nothing.
    const pending = [];

    // Symbolic evaluation of a statement list for target T.
    const evalStmts = (stmts, value, ctx, T, dep) => {
      let v = value;
      for (const s of stmts || []) v = evalStmt(s, v, ctx, T, dep);
      return v;
    };
    const valueOf = (rhs, ctx, T, dep, node) => {
      const u = unwrap(rhs);
      if (!u) return { k: 'unknown', loc: loc(node?.loc) };
      if (u.type === 'VARREF' && (u.name === R || (T !== R && u.name === T))) return HOLD;
      if (u.type === 'VARREF' && T === R && u.name === next) return { k: 'next', dep };
      if (u.type === 'CONST') {
        const val = bigintOf(u.name);
        return val === null ? { k: 'unknown', loc: loc(node?.loc) } : { k: 'const', value: val, param: u.origParamName, dep, loc: loc(node?.loc) };
      }
      if (u.type === 'COND') {
        const { e: c, usedState } = foldExpr(exprTree(u.condp?.[0]), ctx);
        const d = dep || usedState;
        if (isTrue(c)) return valueOf(u.thenp?.[0], ctx, T, d, node);
        if (isFalse(c)) return valueOf(u.elsep?.[0], ctx, T, d, node);
        return { k: 'ite', cond: c, then: valueOf(u.thenp?.[0], ctx, T, d, node), else: valueOf(u.elsep?.[0], ctx, T, d, node) };
      }
      return { k: 'unknown', loc: loc(node?.loc), type: u.type };
    };
    const evalStmt = (s, v, ctx, T, dep) => {
      if (!s || typeof s !== 'object') return v;
      switch (s.type) {
        case 'BEGIN': return evalStmts(s.stmtsp, v, ctx, T, dep);
        case 'ASSIGN': case 'ASSIGNDLY':
          if (s.lhsp?.[0]?.type === 'VARREF' && s.lhsp[0].name === T) return valueOf(s.rhsp?.[0], ctx, T, dep, s);
          return v;
        case 'IF': {
          const { e: c, usedState } = foldExpr(exprTree(s.condp?.[0]), ctx);
          const d = dep || usedState;
          if (isTrue(c)) return evalStmts(s.thensp, v, ctx, T, d);
          if (isFalse(c)) return evalStmts(s.elsesp, v, ctx, T, d);
          const t = evalStmts(s.thensp, v, ctx, T, d);
          const el = evalStmts(s.elsesp, v, ctx, T, d);
          return sameValue(t, el) ? t : { k: 'ite', cond: c, then: t, else: el };
        }
        case 'CASE': {
          const onState = s.exprp?.[0]?.type === 'VARREF' && s.exprp[0].name === R;
          const items = s.itemsp || [];
          if (onState) {
            if (ctx.state === undefined) return v;
            let chosen = null;
            if (ctx.state !== null) chosen = items.find((it) => (it.condsp || []).some((c) => c.type === 'CONST' && bigintOf(c.name) === ctx.state));
            const viaDefault = !chosen;
            if (!chosen) chosen = items.find((it) => !(it.condsp || []).length);
            if (!chosen) return v;
            if (items.some((it) => (it.condsp || []).some((c) => c.type !== 'CONST'))) pending.push({ code: 'rtl/fsm-unparsed', severity: 'warning', message: `${moduleName}.${R}: case label that is not a constant; states may be incomplete`, subject: { module: moduleName, signal: R }, evidence: { source: loc(s.loc) } });
            ctx.viaDefault = viaDefault && ctx.state !== null;
            return evalStmts(chosen.stmtsp, v, ctx, T, true);
          }
          // A case on another expression is an if-chain of equality tests.
          const subject = exprTree(s.exprp?.[0]);
          const build = (i) => {
            if (i >= items.length) return null;
            const it = items[i];
            if (!(it.condsp || []).length) return { default: it };
            const tests = it.condsp.map((c) => ({ op: 'eq', width: 1, args: [subject, exprTree(c)] }));
            const cond = tests.slice(1).reduce((a, b) => ({ op: 'lor', width: 1, args: [a, b] }), tests[0]);
            return { cond, item: it, rest: build(i + 1) };
          };
          const walkChain = (node, val, d) => {
            if (!node) return val;
            if (node.default) return evalStmts(node.default.stmtsp, val, ctx, T, d);
            const { e: c, usedState } = foldExpr(node.cond, ctx);
            const dd = d || usedState;
            if (isTrue(c)) return evalStmts(node.item.stmtsp, val, ctx, T, dd);
            if (isFalse(c)) return walkChain(node.rest, val, dd);
            const t = evalStmts(node.item.stmtsp, val, ctx, T, dd);
            const el = walkChain(node.rest, val, dd);
            return sameValue(t, el) ? t : { k: 'ite', cond: c, then: t, else: el };
          };
          return walkChain(build(0), v, dep);
        }
        default: return v;
      }
    };
    const leaves = (v, path = [], out = []) => {
      if (v.k === 'ite') {
        leaves(v.then, [...path, v.cond], out);
        leaves(v.else, [...path, negate(v.cond)], out);
      } else {
        const g = conj(path);
        if (!isFalse(g)) out.push({ ...v, guard: g });
      }
      return out;
    };
    const warnUnknown = (leaf) => pending.push({ unknown: true, code: 'rtl/fsm-unparsed', severity: 'warning', message: `${moduleName}.${R}: next state assigned from an expression that is not a constant state (${leaf.type ?? 'unknown'}); that assignment is not a transition`, subject: { module: moduleName, signal: R }, evidence: { source: leaf.loc } });

    const base = (state) => ({ register: R, width, state, named, resetNet, resetLevel: 1 - resetActive });
    // Reset state: the clocked block with the reset asserted.
    let reset = null;
    if (resetNet) {
      const ctx = { ...base(undefined), resetLevel: resetActive };
      const v = evalStmts(seq.node.stmtsp, HOLD, ctx, R, false);
      const ls = leaves(v).filter((l) => l.k === 'const' && !l.guard);
      if (ls.length === 1 && nameOf.has(ls[0].value)) reset = { state: nameOf.get(ls[0].value), net: resetNet, active: reg.reset.active ?? 'low', async: Boolean(reg.reset.async) };
    }

    const transitions = [];
    const overrides = [];
    const emitted = new Set();
    let tid = 0;
    // Overrides: state-independent constant assignments in the clocked block.
    {
      const ctx = base(states[0].value);
      const v = evalStmts(seq.node.stmtsp, HOLD, ctx, R, false);
      let p = 0;
      const ls = leaves(v);
      const count = ls.filter((l) => l.k === 'const' && !l.dep).length;
      for (const l of ls) {
        if (l.k === 'const' && !l.dep && nameOf.has(l.value)) {
          const id = `t${tid++}`;
          overrides.push(id);
          transitions.push({ id, from: '*', to: nameOf.get(l.value), guard: l.guard, priority: p - count, sync_override: true, ...(l.loc ? { source: l.loc } : {}) });
          p += 1;
          emitted.add(`*>${l.value}>${JSON.stringify(l.guard)}`);
        } else if (l.k === 'unknown') warnUnknown(l);
      }
    }
    for (const st of states) {
      const ctx = base(st.value);
      const v = next ? evalStmts(comb.node.stmtsp, HOLD, ctx, next, false) : evalStmts(seq.node.stmtsp, HOLD, ctx, R, false);
      let prio = 0;
      for (const l of leaves(v)) {
        if (l.k === 'unknown') { warnUnknown(l); continue; }
        if (l.k !== 'const') continue;
        if (!next && !l.dep) continue; // an override, recorded once above
        if (l.value === st.value) continue;
        if (!nameOf.has(l.value)) {
          pending.push({ code: 'rtl/fsm-unparsed', severity: 'warning', message: `${moduleName}.${R}: ${st.name} goes to value ${l.value} that is not a named state`, subject: { module: moduleName, signal: R }, evidence: { source: l.loc } });
          continue;
        }
        transitions.push({ id: `t${tid++}`, from: st.name, to: nameOf.get(l.value), guard: l.guard, priority: prio++, ...(ctx.viaDefault ? { via_default: true } : {}), ...(l.loc ? { source: l.loc } : {}) });
      }
    }
    // Default branch: the other encodings.
    let deflt = null;
    {
      const ctx = base(null);
      const v = next ? evalStmts(comb.node.stmtsp, HOLD, ctx, next, false) : evalStmts(seq.node.stmtsp, HOLD, ctx, R, false);
      const ls = leaves(v).filter((l) => next || l.dep);
      if (ls.length && ls.every((l) => l.k === 'hold')) deflt = { kind: 'hold' };
      else if (ls.length === 1 && ls[0].k === 'const' && !ls[0].guard && nameOf.has(ls[0].value)) deflt = { kind: 'to', state: nameOf.get(ls[0].value) };
    }
    // No case on the register and a next value that is not a constant state:
    // a counter or data register, not a state machine.
    const caseOnState = hasStateCase(seq.node.stmtsp, R) || (comb ? hasStateCase(comb.node.stmtsp, R) : false);
    if (!caseOnState && pending.some((p) => p.unknown)) continue;
    if (!transitions.length && !overrides.length) continue;
    diagnostics.push(...pending.map(({ unknown: _u, ...d }) => d));
    const caseNode = (() => {
      let found = null;
      (function walk(n) {
        if (found || !n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.type === 'CASE' && n.exprp?.[0]?.type === 'VARREF' && n.exprp[0].name === R) { found = n; return; }
        for (const [k, val] of Object.entries(n)) if (k !== 'dtypep' && val && typeof val === 'object') walk(val);
      })((comb ?? seq).node.stmtsp);
      return found;
    })();
    const where = loc(caseNode?.loc) ?? reg.source;
    fsms.push({
      register: R,
      next,
      width,
      encoding_source: encodingSource,
      ...(encodingSource === 'enum' && enumInfo?.type ? { enum_type: enumInfo.type } : {}),
      states: states.map((s) => ({ name: s.name, value: svLiteral(s.value, width) })),
      reset,
      transitions,
      ...(overrides.length ? { overrides } : {}),
      default: deflt,
      ...(where ? { source: where } : {}),
    });
  }
  return fsms;
}
