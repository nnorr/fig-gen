// FSM RTL cross-check (SPEC §5, §11.5): every drawn state, encoding and
// transition exists in the extracted netlist FSM (modules[].fsms), guards are
// logically equivalent, the reset matches, drawn states are reachable, and
// nothing in the RTL is left undrawn unless the figure narrows its scope.

import { foldExpr, literalValue } from '../rtl/fsm-extract.mjs';
import { expandCollapsed } from './fsm.mjs';

const err = (code, message, subject = {}, evidence = {}, supportedFixes = []) => ({ code, severity: 'error', message, subject, evidence, supportedFixes });

// --- guard expressions -------------------------------------------------------

// Parse the SV guard subset (identifiers, literals, ! ~ && || & | ^ == != < <=
// > >= ?:, parentheses, bit select) into the netlist exprTree format.
export function parseGuard(text) {
  const src = String(text ?? '');
  const tokens = [];
  const re = /\s*(\d+'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_?]+|\d+|[A-Za-z_][A-Za-z0-9_$]*(?:::[A-Za-z_][A-Za-z0-9_$]*)*|&&|\|\||==|!=|<=|>=|[!~&|^<>?:()[\]])/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) return { ast: null, error: `unexpected text at "${src.slice(pos, pos + 12)}"` };
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  let i = 0;
  const peek = () => tokens[i];
  const take = (t) => { if (tokens[i] === t) { i += 1; return true; } return false; };
  const fail = (msg) => { throw new Error(msg); };
  const bin = (next, ops) => () => {
    let left = next();
    for (;;) {
      const op = ops[peek()];
      if (!op) return left;
      i += 1;
      left = { op, args: [left, next()] };
    }
  };
  const primary = () => {
    const t = peek();
    if (t === undefined) fail('unexpected end of guard');
    if (take('(')) { const e = ternary(); if (!take(')')) fail('missing )'); return e; }
    i += 1;
    if (/^\d/.test(t)) return { op: 'const', value: t };
    if (/^[A-Za-z_]/.test(t)) return { op: 'ref', name: t };
    return fail(`unexpected "${t}"`);
  };
  const postfix = () => {
    let e = primary();
    while (take('[')) {
      const idx = ternary();
      if (!take(']')) fail('missing ]');
      e = idx.op === 'const' && literalValue(idx.value) !== null ? { op: 'sel', lsb: Number(literalValue(idx.value)), width: 1, args: [e] } : { op: 'sel', width: 1, args: [e], index_expr: idx };
    }
    return e;
  };
  const unary = () => {
    if (take('!')) return { op: 'lnot', width: 1, args: [unary()] };
    if (take('~')) return { op: 'not', args: [unary()] };
    return postfix();
  };
  const relational = bin(unary, { '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' });
  const equality = bin(relational, { '==': 'eq', '!=': 'neq' });
  const band = bin(equality, { '&': 'and' });
  const bxor = bin(band, { '^': 'xor' });
  const bor = bin(bxor, { '|': 'or' });
  const land = bin(bor, { '&&': 'land' });
  const lor = bin(land, { '||': 'lor' });
  function ternary() {
    const c = lor();
    if (!take('?')) return c;
    const a = ternary();
    if (!take(':')) fail('missing : in ?:');
    return { op: 'cond', args: [c, a, ternary()] };
  }
  try {
    if (!tokens.length) return { ast: null, error: 'empty guard' };
    const ast = ternary();
    if (i !== tokens.length) return { ast: null, error: `unexpected "${tokens[i]}"` };
    return { ast, error: null };
  } catch (e) {
    return { ast: null, error: e.message };
  }
}

const PREC = { cond: 1, lor: 2, land: 3, or: 4, xor: 5, and: 6, eq: 7, neq: 7, lt: 8, lte: 8, gt: 8, gte: 8, shl: 9, shr: 9, add: 10, sub: 10, mul: 11 };
const SYM = { lor: '||', land: '&&', or: '|', xor: '^', and: '&', eq: '==', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=', shl: '<<', shr: '>>', add: '+', sub: '-', mul: '*' };
const FLIP = { lt: 'gt', gt: 'lt', lte: 'gte', gte: 'lte', eq: 'eq', neq: 'neq' };
const isOneBit = (e) => (e?.width ?? 1) === 1;

// SV text of an exprTree, for guards drafted from the netlist: 1-bit & and |
// print as && and ||, a comparison puts its constant on the right, and a
// constant written as a parameter prints as that name. Returns null when a
// node cannot be printed in the guard subset.
export function printGuard(e) {
  let ok = true;
  const p = (n, outer = 0) => {
    if (!n) { ok = false; return '?'; }
    switch (n.op) {
      case 'ref': return n.name;
      case 'const': return n.param ?? n.value;
      case 'extend': return p(n.args[0], outer);
      case 'lnot': return `!${p(n.args[0], 12)}`;
      case 'not': return isOneBit(n) ? `!${p(n.args[0], 12)}` : `~${p(n.args[0], 12)}`;
      case 'redor': return `${p(n.args[0], 12)} != 0`;
      case 'sel': case 'index': {
        const idx = n.index_expr ? p(n.index_expr) : (n.lsb ?? n.index);
        if (idx === undefined) { ok = false; return '?'; }
        if (n.op === 'sel' && !n.index_expr && (n.width ?? 1) > 1) return `${p(n.args[0], 13)}[${n.lsb + n.width - 1}:${n.lsb}]`;
        return `${p(n.args[0], 13)}[${idx}]`;
      }
      case 'cond': {
        const s = `${p(n.args[0], 2)} ? ${p(n.args[1], 1)} : ${p(n.args[2], 1)}`;
        return outer > 1 ? `(${s})` : s;
      }
      default: {
        if (!SYM[n.op] || (n.args || []).length !== 2) { ok = false; return '?'; }
        let [a, b] = n.args;
        let op = n.op;
        if (FLIP[op] && a?.op === 'const' && b?.op !== 'const') { [a, b] = [b, a]; op = FLIP[op]; }
        if (op === 'and' && isOneBit(n)) op = 'land';
        if (op === 'or' && isOneBit(n)) op = 'lor';
        const prec = PREC[op];
        const s = `${p(a, prec)} ${SYM[op]} ${p(b, prec + 1)}`;
        return prec < outer ? `(${s})` : s;
      }
    }
  };
  const text = p(e);
  return ok ? text : null;
}

// Identifiers read by an exprTree (refs and index expressions).
export function guardIdentifiers(e, out = new Set()) {
  if (!e || typeof e !== 'object') return out;
  if (e.op === 'ref') out.add(e.name);
  for (const a of e.args || []) guardIdentifiers(a, out);
  if (e.index_expr) guardIdentifiers(e.index_expr, out);
  return out;
}

// --- boolean comparison ------------------------------------------------------

// Canonical boolean form over atoms. `env.width(name)` gives a signal width
// (1 when unknown), `env.param(name)` a parameter value (BigInt) or null.
function canon(e, env) {
  const constOf = (n) => {
    if (n?.op === 'const') return literalValue(n.value);
    if (n?.op === 'ref' && env.param(n.name) !== null) return env.param(n.name);
    return null;
  };
  const key = (n) => {
    if (!n) return '?';
    const c = constOf(n);
    if (c !== null) return `#${c}`;
    switch (n.op) {
      case 'ref': return n.name;
      case 'extend': return key(n.args[0]);
      case 'sel': case 'index': return `${key(n.args[0])}[${n.index_expr ? key(n.index_expr) : (n.lsb ?? n.index)}${n.op === 'sel' && (n.width ?? 1) > 1 && !n.index_expr ? `+${n.width}` : ''}]`;
      case 'func': return `${n.name}(${(n.args || []).map(key).join(',')})`;
      default: {
        const ks = (n.args || []).map(key);
        if (['and', 'or', 'xor', 'eq', 'neq', 'add', 'mul', 'land', 'lor'].includes(n.op)) ks.sort();
        return `${n.op}(${ks.join(',')})`;
      }
    }
  };
  const widthOf = (n) => {
    if (!n) return 1;
    if (n.op === 'ref') return env.width(n.name);
    if (n.op === 'const') return constOf(n) !== null && /^1'/.test(n.value) ? 1 : (n.width ?? (literalValue(n.value) > 1n ? 32 : 1));
    if (n.op === 'extend') return n.width ?? widthOf(n.args[0]);
    if (['lnot', 'land', 'lor', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'redor'].includes(n.op)) return 1;
    if (n.op === 'sel' || n.op === 'index') return n.width ?? 1;
    if (['and', 'or', 'xor'].includes(n.op)) return Math.max(...(n.args || []).map(widthOf));
    if (n.op === 'not') return widthOf(n.args[0]);
    return n.width ?? 32;
  };
  const atom = (k) => ({ t: 'var', k });
  const not = (x) => (x.t === 'const' ? { t: 'const', v: !x.v } : x.t === 'not' ? x.a : { t: 'not', a: x });
  const and = (a, b) => ({ t: 'and', a, b });
  const or = (a, b) => ({ t: 'or', a, b });
  const b = (n) => {
    if (!n) return { t: 'const', v: true };
    const c = constOf(n);
    if (c !== null) return { t: 'const', v: c !== 0n };
    switch (n.op) {
      case 'ref': return widthOf(n) === 1 ? atom(n.name) : not(atom(`eq(${n.name},#0)`));
      case 'extend': return b(n.args[0]);
      case 'lnot': return not(b(n.args[0]));
      case 'not': return widthOf(n.args[0]) === 1 ? not(b(n.args[0])) : not(atom(`eq(${key(n)},#0)`));
      case 'land': return and(b(n.args[0]), b(n.args[1]));
      case 'lor': return or(b(n.args[0]), b(n.args[1]));
      case 'and': case 'or': case 'xor':
        if (n.args.every((x) => widthOf(x) === 1)) {
          const [x, y] = n.args.map(b);
          return n.op === 'and' ? and(x, y) : n.op === 'or' ? or(x, y) : or(and(x, not(y)), and(not(x), y));
        }
        return not(atom(`eq(${key(n)},#0)`));
      case 'eq': case 'neq': {
        const [x, y] = n.args;
        if (widthOf(x) === 1 && widthOf(y) === 1 && constOf(x) === null && constOf(y) === null) {
          const [bx, by] = [b(x), b(y)];
          const same = or(and(bx, by), and(not(bx), not(by)));
          return n.op === 'eq' ? same : not(same);
        }
        const ks = [key(x), key(y)].sort();
        const a = atom(`eq(${ks.join(',')})`);
        return n.op === 'eq' ? a : not(a);
      }
      case 'lt': case 'lte': case 'gt': case 'gte': {
        let [x, y] = n.args;
        let op = n.op;
        if (constOf(x) !== null && constOf(y) === null) { [x, y] = [y, x]; op = FLIP[op]; }
        if (op === 'gt') return not(atom(`lte(${key(x)},${key(y)})`));
        if (op === 'gte') return not(atom(`lt(${key(x)},${key(y)})`));
        return atom(`${op}(${key(x)},${key(y)})`);
      }
      case 'redor': return not(atom(`eq(${key(n.args[0])},#0)`));
      case 'cond': {
        const [cc, t, el] = n.args.map(b);
        return or(and(cc, t), and(not(cc), el));
      }
      default:
        return widthOf(n) === 1 ? atom(key(n)) : not(atom(`eq(${key(n)},#0)`));
    }
  };
  return b(e);
}

const atomsOf = (f, out = new Set()) => {
  if (f.t === 'var') out.add(f.k);
  if (f.a) atomsOf(f.a, out);
  if (f.b) atomsOf(f.b, out);
  return out;
};
const evalF = (f, v) => (f.t === 'const' ? f.v : f.t === 'var' ? v[f.k] : f.t === 'not' ? !evalF(f.a, v) : f.t === 'and' ? evalF(f.a, v) && evalF(f.b, v) : evalF(f.a, v) || evalF(f.b, v));
const fString = (f) => (f.t === 'const' ? String(f.v) : f.t === 'var' ? f.k : f.t === 'not' ? `!${fString(f.a)}` : `(${[fString(f.a), fString(f.b)].sort().join(f.t === 'and' ? '&' : '|')})`);

const defaultEnv = { width: () => 1, param: () => null };

// Are two guards (exprTrees; null = always) logically equivalent? Truth table
// over their atoms when there are at most 16, else a structural comparison.
export function equivalentGuards(a, b, env = defaultEnv) {
  const fa = canon(a, env);
  const fb = canon(b, env);
  const atoms = [...new Set([...atomsOf(fa), ...atomsOf(fb)])].sort();
  if (atoms.length > 16) return { equivalent: fString(fa) === fString(fb), method: 'structural', atoms };
  for (let m = 0; m < 2 ** atoms.length; m += 1) {
    const v = Object.fromEntries(atoms.map((k, j) => [k, Boolean((m >> j) & 1)]));
    if (evalF(fa, v) !== evalF(fb, v)) return { equivalent: false, method: 'truth-table', atoms, counterexample: v };
  }
  return { equivalent: true, method: 'truth-table', atoms };
}
export const isAlwaysFalse = (g, env = defaultEnv) => equivalentGuards(g, { op: 'const', value: "1'h0" }, env).equivalent;

const orAll = (gs) => (gs.some((g) => !g) ? null : gs.slice(1).reduce((x, y) => ({ op: 'lor', width: 1, args: [x, y] }), gs[0]));
const andNot = (g, others) => others.reduce((x, o) => ({ op: 'land', width: 1, args: [x ?? { op: 'const', value: "1'h1" }, { op: 'lnot', width: 1, args: [o ?? { op: 'const', value: "1'h1" }] }] }), g);

// --- locating the machine ----------------------------------------------------

export function findFsmModule(netlist, { instance, module } = {}) {
  const modules = netlist?.modules || [];
  if (instance) {
    const want = `${netlist.top}.${String(instance).replace(/\//g, '.')}`;
    const h = (netlist.hierarchy || []).find((x) => x.path === want || x.path.endsWith(`.${String(instance).replace(/\//g, '.')}`));
    return h ? modules.find((m) => m.name === h.module) ?? null : null;
  }
  if (module) return modules.find((m) => m.orig_name === module || m.name === module) ?? null;
  return modules.find((m) => m.orig_name === netlist?.top) ?? null;
}

export function findFsm(netlist, rtl = {}) {
  const mod = findFsmModule(netlist, rtl);
  if (!mod) return { module: null, fsm: null };
  const fsms = mod.fsms || [];
  const fsm = rtl.state_register ? fsms.find((f) => f.register === rtl.state_register) : fsms.length === 1 ? fsms[0] : null;
  return { module: mod, fsm: fsm ?? null };
}

// States reachable from reset over the RTL transitions and overrides.
export function reachableStates(fsm) {
  const start = fsm.reset?.state ?? fsm.states[0]?.name;
  const seen = new Set(start ? [start] : []);
  const queue = [...seen];
  const overrides = fsm.transitions.filter((t) => t.from === '*');
  while (queue.length) {
    const s = queue.shift();
    for (const t of [...fsm.transitions.filter((x) => x.from === s), ...overrides]) {
      if (!seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
    }
  }
  return seen;
}

// Environment for guard comparison: widths from the figure's declared
// signals and the module's nets, parameter values from the figure, the
// module's localparams and named constants in the RTL guards.
function guardEnv(doc, mod, fsm) {
  const widths = new Map();
  for (const n of mod?.nets || []) if (Number.isInteger(n.width)) widths.set(n.name, n.width);
  for (const s of [...(doc.inputs || []), ...(doc.outputs || [])]) if (Number.isInteger(s.width)) widths.set(s.name, s.width);
  const params = new Map();
  for (const n of mod?.nets || []) if (n.kind === 'param' && n.value !== undefined && literalValue(n.value) !== null) params.set(n.name, literalValue(n.value));
  (function walk(e) {
    if (!e || typeof e !== 'object') return;
    if (e.op === 'const' && e.param && literalValue(e.value) !== null) params.set(e.param, literalValue(e.value));
    for (const a of e.args || []) walk(a);
    if (e.index_expr) walk(e.index_expr);
  })(fsm?.transitions?.map((t) => t.guard));
  for (const [k, v] of Object.entries(doc.params || {})) params.set(k, BigInt(v));
  // Named constants (enum items recovered from the netlist types) equal their value.
  for (const c of doc.constants || []) {
    const v = typeof c.value === 'number' ? BigInt(c.value) : literalValue(String(c.value));
    if (v !== null) params.set(c.name, v);
  }
  return { width: (name) => widths.get(name) ?? 1, param: (name) => (params.has(name) ? params.get(name) : null) };
}

// Stub (blackbox) modules in the fan-in cone of a machine's next-state logic:
// the state register's clocked sources, its next-state variable and the RTL
// guard signals, followed through combinational dependencies inside the module
// (stopping at registers) to the instance outputs that drive them; a stub
// counts when it sits inside such an instance. Returns null when the machine
// is not found.
export function fsmCone(netlist, rtl = {}) {
  const { module: mod, fsm } = findFsm(netlist, rtl);
  if (!mod || !fsm) return null;
  const registers = new Set((mod.registers || []).map((r) => r.name));
  const comb = new Map();
  const seq = new Map();
  for (const d of mod.deps || []) (d.kind === 'comb' ? comb : seq).set(d.target, d.sources || []);
  const drivenBy = new Map();
  for (const inst of mod.instances || []) {
    for (const c of inst.connections || []) {
      if (c.dir !== 'out') continue;
      for (const n of c.expr?.net ? [c.expr.net] : (c.expr?.nets || [])) drivenBy.set(n, inst.name);
    }
  }
  const start = new Set([...(seq.get(fsm.register) || []), ...(fsm.next ? [fsm.next] : [])]);
  for (const t of fsm.transitions) guardIdentifiers(t.guard, start);
  start.delete(fsm.register);
  const seen = new Set();
  const instances = new Set();
  const queue = [...start];
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    if (drivenBy.has(n)) instances.add(drivenBy.get(n));
    if (registers.has(n) && !start.has(n)) continue;
    if (registers.has(n) && n !== fsm.next) continue;
    for (const s of comb.get(n) || []) if (!seen.has(s)) queue.push(s);
  }
  // Stubs below those instances, from the hierarchy.
  const modPaths = (netlist.hierarchy || []).filter((h) => h.module === mod.name).map((h) => h.path);
  const byName = new Map((netlist.modules || []).map((m) => [m.name, m]));
  const stubs = new Set();
  for (const h of netlist.hierarchy || []) {
    const m = byName.get(h.module);
    if (!m?.blackbox) continue;
    if (modPaths.some((p) => [...instances].some((i) => h.path === `${p}.${i}` || h.path.startsWith(`${p}.${i}.`)))) stubs.add(m.orig_name);
  }
  return { module: mod.orig_name, register: fsm.register, signals: [...seen].sort(), instances: [...instances].sort(), stubs };
}

// --- cross-check ---------------------------------------------------------------

export function crosscheckFsm(doc, netlist, { quality } = {}) {
  doc = expandCollapsed(doc);
  const diagnostics = [];
  const rtl = doc.machine?.rtl || {};
  const { module: mod, fsm } = findFsm(netlist, rtl);
  if (!fsm) {
    diagnostics.push(err('fsm/rtl-not-found', `no state machine ${rtl.state_register ? `on register ${rtl.state_register} ` : ''}in ${rtl.instance ? `instance ${rtl.instance}` : rtl.module ? `module ${rtl.module}` : 'the netlist top'}${mod ? ` (module ${mod.orig_name} has ${(mod.fsms || []).map((f) => f.register).join(', ') || 'none'})` : ''}`, { rtl }, {}, ['set machine.rtl.module or machine.rtl.instance and machine.rtl.state_register to the RTL state register', 're-run check-rtl so the netlist carries modules[].fsms']));
    return { diagnostics, stats: null };
  }
  const env = guardEnv(doc, mod, fsm);
  const where = `${mod.orig_name}.${fsm.register}`;
  const rtlStates = new Map(fsm.states.map((s) => [s.name, s]));
  const scope = doc.machine?.scope || {};
  const omitStates = new Set(scope.omit_states || []);
  const omitTo = new Set(scope.omit_transitions_to || []);
  const omitted = [];
  const drawn = new Map((doc.states || []).map((s) => [s.id, s]));
  let guardsCompared = 0;

  // States and encodings.
  let statesChecked = 0;
  for (const s of doc.states || []) {
    const r = rtlStates.get(s.id);
    if (!r) {
      diagnostics.push(err('fsm/rtl-state-missing', `state ${s.id} is not a state of ${where} (RTL states: ${fsm.states.map((x) => x.name).join(', ')})`, { state: s.id }, { rtl_states: fsm.states.map((x) => x.name) }, ['use the RTL state name as the state id', 'remove the state']));
      continue;
    }
    statesChecked += 1;
    if (s.encoding !== undefined && doc.machine?.encoding !== 'auto') {
      const dv = literalValue(s.encoding);
      const rv = literalValue(r.value);
      if (dv === null || rv === null || dv !== rv) diagnostics.push(err('fsm/rtl-encoding-mismatch', `state ${s.id} is drawn with encoding ${s.encoding}; ${where} encodes it as ${r.value}`, { state: s.id }, { drawn: s.encoding, rtl: r.value }, [`set the encoding to ${r.value}`]));
    }
  }
  for (const r of fsm.states) {
    if (drawn.has(r.name)) continue;
    if (omitStates.has(r.name)) { omitted.push(`state ${r.name}`); continue; }
    diagnostics.push(err('fsm/undrawn-state', `RTL state ${r.name} of ${where} is not drawn`, { state: r.name }, {}, ['draw the state', 'narrow the figure: machine.scope.omit_states with a reason']));
  }

  // Reset.
  if (doc.reset && fsm.reset) {
    if (doc.reset.state !== fsm.reset.state) diagnostics.push(err('fsm/rtl-reset-mismatch', `the reset enters ${doc.reset.state}; ${where} resets to ${fsm.reset.state}`, { state: doc.reset.state }, { rtl: fsm.reset }, [`set reset.state to ${fsm.reset.state}`]));
    if (doc.reset.condition !== undefined) {
      const parsed = parseGuard(doc.reset.condition);
      const expected = fsm.reset.active === 'low' ? { op: 'lnot', width: 1, args: [{ op: 'ref', name: fsm.reset.net, width: 1 }] } : { op: 'ref', name: fsm.reset.net, width: 1 };
      if (!parsed.ast || !equivalentGuards(parsed.ast, expected, { ...env, width: () => 1 }).equivalent) diagnostics.push(err('fsm/rtl-reset-mismatch', `reset condition "${doc.reset.condition}" does not match ${where}: ${fsm.reset.active === 'low' ? '!' : ''}${fsm.reset.net}`, { state: doc.reset.state }, { rtl: fsm.reset }, [`write the condition as ${fsm.reset.active === 'low' ? '!' : ''}${fsm.reset.net}`]));
    }
    if (doc.reset.async !== undefined && doc.reset.async !== fsm.reset.async) diagnostics.push(err('fsm/rtl-reset-mismatch', `reset is drawn ${doc.reset.async ? 'asynchronous' : 'synchronous'}; ${where} resets ${fsm.reset.async ? 'asynchronously' : 'synchronously'}`, { state: doc.reset.state }, { rtl: fsm.reset }, [`set reset.async to ${fsm.reset.async}`]));
  }

  // Guards of the drawn transitions.
  const parse = (t) => {
    if (t.guard === undefined || t.guard === '') return null;
    const p = parseGuard(t.guard);
    return p.ast ?? { op: 'opaque', text: t.guard };
  };
  const rtlOverrides = fsm.transitions.filter((t) => t.from === '*');
  const rtlCase = fsm.transitions.filter((t) => t.from !== '*');
  const matchedOverrides = new Set();
  const stateIds = (doc.states || []).map((s) => s.id);
  const perState = new Map();
  const push = (s, entry) => { if (!perState.has(s)) perState.set(s, []); perState.get(s).push(entry); };
  let recoveryDrawn = null;
  for (const t of doc.transitions || []) {
    if (t.recovery) { recoveryDrawn = t; continue; }
    const g = parse(t);
    if (g?.op === 'opaque') continue; // fsm/guard-parse reports it
    if (t.from === '*') {
      const over = rtlOverrides.find((o) => !matchedOverrides.has(o.id) && o.to === t.to && equivalentGuards(g, o.guard, env).equivalent);
      guardsCompared += 1;
      if (over) { matchedOverrides.add(over.id); continue; }
      for (const s of stateIds.filter((x) => !(t.except || []).includes(x))) push(s, { t, g, to: t.to, anyState: true });
      continue;
    }
    push(t.from, { t, g, to: t.to });
  }
  let transitionsChecked = 0;
  const drawnPairs = new Set();
  for (const [s, list] of perState) {
    if (!rtlStates.has(s)) continue;
    const withPrio = list.every((x) => Number.isInteger(x.t.priority));
    const eff = list.map((x) => ({ ...x, eg: withPrio ? andNot(x.g, list.filter((y) => y.t.priority < x.t.priority).map((y) => y.g)) : x.g }));
    const byTo = new Map();
    for (const x of eff) { if (!byTo.has(x.to)) byTo.set(x.to, []); byTo.get(x.to).push(x); }
    const exits = rtlCase.filter((r) => r.from === s);
    for (const [to, xs] of byTo) {
      if (!rtlStates.has(to)) continue;
      drawnPairs.add(`${s}>${to}`);
      transitionsChecked += 1;
      const dg = orAll(xs.map((x) => x.eg));
      const ids = xs.map((x) => x.t.id).join(', ');
      if (to === s) {
        const stay = exits.length ? { op: 'lnot', width: 1, args: [orAll(exits.map((r) => r.guard))] } : null;
        guardsCompared += 1;
        const cmp = equivalentGuards(dg, stay, env);
        if (!cmp.equivalent) diagnostics.push(err('fsm/rtl-guard-mismatch', `self-loop ${ids} on ${s}: its guard is not "no exit taken" in ${where}`, { transition: ids, from: s, to }, { counterexample: cmp.counterexample, rtl_exits: exits.map((r) => printGuard(r.guard) ?? '(expression)') }, ['draw the self-loop with the negation of the exits', 'omit the self-loop (machine.default: "hold")']));
        continue;
      }
      const rs = exits.filter((r) => r.to === to);
      if (!rs.length) {
        diagnostics.push(err('fsm/rtl-transition-missing', `transition ${ids} ${s} → ${to} does not exist in ${where}`, { transition: ids, from: s, to }, { rtl_from_state: exits.map((r) => `${r.to}: ${printGuard(r.guard) ?? '(expression)'}`) }, ['remove the transition', 'correct its target state']));
        continue;
      }
      guardsCompared += 1;
      const rg = orAll(rs.map((r) => r.guard));
      const cmp = equivalentGuards(dg, rg, env);
      if (!cmp.equivalent) diagnostics.push(err('fsm/rtl-guard-mismatch', `transition ${ids} ${s} → ${to}: guard differs from ${where} (RTL: ${printGuard(rg) ?? 'expression'})`, { transition: ids, from: s, to }, { rtl_guard: printGuard(rg), drawn_guard: xs.map((x) => x.t.guard ?? 'true').join(' || '), counterexample: cmp.counterexample, method: cmp.method }, [`write the guard as ${printGuard(rg)}`]));
    }
  }
  // RTL transitions and overrides left undrawn.
  const pairs = new Map();
  for (const r of rtlCase) { const k = `${r.from}>${r.to}`; if (!pairs.has(k)) pairs.set(k, r); }
  for (const [k, r] of pairs) {
    if (drawnPairs.has(k)) continue;
    if (omitStates.has(r.from) || omitStates.has(r.to) || omitTo.has(r.to)) { omitted.push(`${r.from} -> ${r.to}`); continue; }
    diagnostics.push(err('fsm/undrawn-transition', `RTL transition ${r.from} → ${r.to} of ${where} is not drawn (guard ${printGuard(r.guard) ?? 'expression'})`, { from: r.from, to: r.to }, { guard: printGuard(r.guard) }, ['draw the transition', 'narrow the figure: machine.scope.omit_transitions_to with a reason']));
  }
  for (const o of rtlOverrides) {
    if (matchedOverrides.has(o.id)) continue;
    if (omitTo.has(o.to) || omitStates.has(o.to)) { omitted.push(`* -> ${o.to}`); continue; }
    diagnostics.push(err('fsm/undrawn-transition', `RTL override from every state to ${o.to} of ${where} (guard ${printGuard(o.guard) ?? 'expression'}) is not drawn as an any-state arc`, { from: '*', to: o.to }, { guard: printGuard(o.guard), sync_override: true }, [`draw one arc from "*" to ${o.to} with guard ${printGuard(o.guard)}`]));
  }

  // Default recovery.
  const unused = fsm.default?.kind === 'to' ? 2 ** fsm.width - fsm.states.length : 0;
  const defaultRecovery = fsm.default?.kind === 'to' ? { to: fsm.default.state, unused_encodings: unused } : null;
  if (recoveryDrawn && (!defaultRecovery || recoveryDrawn.to !== defaultRecovery.to)) diagnostics.push(err('fsm/rtl-transition-missing', `recovery arc ${recoveryDrawn.id} → ${recoveryDrawn.to}: ${where} ${defaultRecovery ? `recovers to ${defaultRecovery.to}` : 'has no default recovery branch'}`, { transition: recoveryDrawn.id }, { rtl_default: fsm.default }, defaultRecovery ? [`set its target to ${defaultRecovery.to}`] : ['remove the recovery arc']));
  if (doc.machine?.show_default_recovery && !recoveryDrawn && defaultRecovery) diagnostics.push(err('fsm/undrawn-transition', `machine.show_default_recovery is set but no recovery arc to ${defaultRecovery.to} is drawn`, { to: defaultRecovery.to }, {}, [`add { "from": "*", "to": "${defaultRecovery.to}", "recovery": true }`]));

  // Reachability.
  const reach = reachableStates(fsm);
  for (const s of doc.states || []) {
    if (rtlStates.has(s.id) && !reach.has(s.id)) diagnostics.push(err('fsm/unreachable', `state ${s.id} is not reachable from reset in ${where}`, { state: s.id }, { reset: fsm.reset?.state }, ['remove the state and list it in machine.scope.omit_states with the reason']));
  }

  // Moore output values: the RTL output expression with the state register
  // bound to the state's encoding must fold to the drawn value; a value that
  // still depends on other signals in that state is not a Moore value. A state
  // where the RTL asserts a declared Moore output the figure leaves out is
  // reported too (warning; error under paper quality). Mealy actions are not
  // compared.
  let outputsChecked = 0;
  const outputsUnresolved = [];
  for (const o of (doc.outputs || []).filter((x) => x.type === 'moore')) {
    const x = (mod.exprs || []).find((e) => e.target === o.name && e.index === undefined);
    if (!x) { outputsUnresolved.push(o.name); continue; }
    for (const s of doc.states || []) {
      const r = rtlStates.get(s.id);
      if (!r) continue;
      const { e } = foldExpr(x.expr, { register: fsm.register, width: fsm.width, state: literalValue(r.value) });
      const rv = e?.op === 'const' ? literalValue(e.value) : null;
      const drawnValue = s.outputs?.[o.name];
      if (drawnValue !== undefined) {
        outputsChecked += 1;
        if (rv === null) {
          diagnostics.push(err('fsm/rtl-output-not-moore', `state ${s.id} draws ${o.name} = ${drawnValue}, but in ${where} the output still depends on other signals in that state (not a Moore value)`, { state: s.id, output: o.name }, { rtl_expression: printGuard(x.expr) }, ['declare the output as mealy and draw it on the transitions', 'remove the value from the state']));
          continue;
        }
        const dv = literalValue(String(drawnValue).trim());
        if (dv === null || dv !== rv) diagnostics.push(err('fsm/rtl-output-mismatch', `state ${s.id} draws ${o.name} = ${drawnValue}; ${where} drives ${rv} in that state`, { state: s.id, output: o.name }, { drawn: drawnValue, rtl: String(rv) }, [`set ${o.name} to ${rv} on state ${s.id}`]));
      } else if (rv !== null && rv !== 0n) {
        diagnostics.push({ ...err('fsm/undrawn-output', `state ${s.id} leaves out Moore output ${o.name}; ${where} drives ${rv} in that state`, { state: s.id, output: o.name }, { rtl: String(rv) }, [`add ${o.name}: "${rv}" to state ${s.id}`]), severity: quality === 'paper' ? 'error' : 'warning' });
      }
    }
  }

  return {
    diagnostics,
    stats: {
      module: mod.orig_name,
      register: fsm.register,
      states_checked: statesChecked,
      transitions_checked: transitionsChecked,
      guards_compared: guardsCompared,
      reachable: fsm.states.filter((s) => reach.has(s.name)).map((s) => s.name),
      unreachable: fsm.states.filter((s) => !reach.has(s.name)).map((s) => s.name),
      omitted,
      default_recovery: defaultRecovery,
      encoding_source: fsm.encoding_source,
      outputs_checked: outputsChecked,
      outputs_unresolved: outputsUnresolved,
    },
  };
}
