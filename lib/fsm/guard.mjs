// FSM guard language (SPEC §5): a small SystemVerilog expression subset.
// parseGuard builds an AST; printGuard writes it as readable text for the
// figure; normalizeGuard gives a canonical string for comparisons;
// guardsOverlap decides whether two guards can both be true.
//
// Grammar (lowest precedence first):
//   cond   := lor ('?' cond ':' cond)?
//   lor    := land ('||' land)*
//   land   := bor ('&&' bor)*
//   bor    := bxor ('|' bxor)*
//   bxor   := band ('^' band)*
//   band   := eq ('&' eq)*
//   eq     := rel (('=='|'!=') rel)*
//   rel    := unary (('<'|'<='|'>'|'>=') unary)*
//   unary  := ('!'|'~') unary | postfix
//   postfix:= primary ('[' cond (':' cond)? ']')*
//   primary:= identifier | literal | '(' cond ')'

const OPS = ['||', '&&', '==', '!=', '<=', '>=', '::', '?', ':', '|', '^', '&', '<', '>', '!', '~', '(', ')', '[', ']'];

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = String(src ?? '');
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i += 1; continue; }
    const lit = /^(?:\d+)?'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_?]+|^'[01xXzZ]|^\d[\d_]*/.exec(s.slice(i));
    if (lit) { tokens.push({ kind: 'lit', text: lit[0], at: i }); i += lit[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_$]*(?:::[A-Za-z_][A-Za-z0-9_$]*)*/.exec(s.slice(i));
    if (id) { tokens.push({ kind: 'id', text: id[0], at: i }); i += id[0].length; continue; }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (op && op !== '::') { tokens.push({ kind: 'op', text: op, at: i }); i += op.length; continue; }
    throw Object.assign(new Error(`unexpected character '${c}'`), { at: i });
  }
  return tokens;
}

// Value of a literal as { value: BigInt|null, width: number|null }; x/z digits give null.
export function literalValue(text) {
  const t = String(text).replace(/_/g, '');
  if (/^\d+$/.test(t)) return { value: BigInt(t), width: null };
  if (/^'[01]$/.test(t)) return { value: BigInt(t[1]), width: null, fill: true };
  const m = /^(\d+)?'[sS]?([bBoOdDhH])([0-9a-fA-FxXzZ?]+)$/.exec(t);
  if (!m) return { value: null, width: null };
  if (/[xXzZ?]/.test(m[3])) return { value: null, width: m[1] ? Number(m[1]) : null };
  const base = { b: 2, o: 8, d: 10, h: 16 }[m[2].toLowerCase()];
  const digits = m[3].toLowerCase();
  let value = 0n;
  for (const d of digits) value = value * BigInt(base) + BigInt(parseInt(d, base));
  return { value, width: m[1] ? Number(m[1]) : null };
}

export function parseGuard(src) {
  let tokens;
  try {
    tokens = tokenize(src);
  } catch (error) {
    return { ok: false, error: error.message, at: error.at ?? 0 };
  }
  if (!tokens.length) return { ok: true, ast: null };
  let k = 0;
  const peek = () => tokens[k];
  const isOp = (...ops) => peek()?.kind === 'op' && ops.includes(peek().text);
  const expect = (op) => {
    if (!isOp(op)) throw Object.assign(new Error(`expected '${op}'${peek() ? ` at '${peek().text}'` : ' at end'}`), { at: peek()?.at ?? String(src).length });
    k += 1;
  };
  const binary = (next, ops) => () => {
    let left = next();
    while (isOp(...ops)) {
      const op = tokens[k++].text;
      left = { type: 'bin', op, l: left, r: next() };
    }
    return left;
  };
  const primary = () => {
    const t = peek();
    if (!t) throw Object.assign(new Error('unexpected end of guard'), { at: String(src).length });
    if (t.kind === 'id') { k += 1; return { type: 'id', name: t.text }; }
    if (t.kind === 'lit') { k += 1; return { type: 'lit', raw: t.text, ...literalValue(t.text) }; }
    if (isOp('(')) { k += 1; const inner = cond(); expect(')'); return inner; }
    throw Object.assign(new Error(`unexpected '${t.text}'`), { at: t.at });
  };
  const postfix = () => {
    let base = primary();
    while (isOp('[')) {
      k += 1;
      const first = cond();
      if (isOp(':')) { k += 1; const lsb = cond(); expect(']'); base = { type: 'range', base, msb: first, lsb }; } else { expect(']'); base = { type: 'index', base, index: first }; }
    }
    return base;
  };
  const unary = () => {
    if (isOp('!', '~')) { const op = tokens[k++].text; return { type: 'un', op, arg: unary() }; }
    return postfix();
  };
  const rel = binary(unary, ['<', '<=', '>', '>=']);
  const eq = binary(rel, ['==', '!=']);
  const band = binary(eq, ['&']);
  const bxor = binary(band, ['^']);
  const bor = binary(bxor, ['|']);
  const land = binary(bor, ['&&']);
  const lor = binary(land, ['||']);
  function cond() {
    const c = lor();
    if (!isOp('?')) return c;
    k += 1;
    const t = cond();
    expect(':');
    return { type: 'cond', c, t, e: cond() };
  }
  try {
    const ast = cond();
    if (k < tokens.length) throw Object.assign(new Error(`unexpected '${tokens[k].text}'`), { at: tokens[k].at });
    return { ok: true, ast };
  } catch (error) {
    return { ok: false, error: error.message, at: error.at ?? 0 };
  }
}

// Every identifier the guard reads (package-qualified names keep their scope).
export function guardIdentifiers(ast, out = new Set()) {
  if (!ast) return out;
  switch (ast.type) {
    case 'id': out.add(ast.name); break;
    case 'un': guardIdentifiers(ast.arg, out); break;
    case 'bin': guardIdentifiers(ast.l, out); guardIdentifiers(ast.r, out); break;
    case 'cond': guardIdentifiers(ast.c, out); guardIdentifiers(ast.t, out); guardIdentifiers(ast.e, out); break;
    case 'index': guardIdentifiers(ast.base, out); guardIdentifiers(ast.index, out); break;
    case 'range': guardIdentifiers(ast.base, out); guardIdentifiers(ast.msb, out); guardIdentifiers(ast.lsb, out); break;
    default: break;
  }
  return out;
}

const PREC = { '?': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '==': 7, '!=': 7, '<': 8, '<=': 8, '>': 8, '>=': 8, un: 9, post: 10 };
const WORD = { '||': 'or', '&&': 'and', '==': '=', '!=': 'is not', '|': '|', '^': 'xor', '&': '&', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };

// A literal as a reader writes it: decimal for small values, hex for large ones.
export function readableLiteral(lit) {
  if (lit.value === null || lit.value === undefined) return String(lit.raw).replace(/^\d*'[sS]?/, '');
  return lit.value >= 256n ? `0x${lit.value.toString(16).toUpperCase()}` : String(lit.value);
}

// Readable text of a guard AST. `name(identifier)` maps an identifier to its
// printed name (the caller applies the label dictionary and state names).
export function printGuard(ast, { name = (s) => s } = {}) {
  const go = (n, parent = 0) => {
    if (!n) return '';
    let s;
    let p;
    switch (n.type) {
      case 'id': return name(n.name);
      case 'lit': return readableLiteral(n);
      case 'un': p = PREC.un; s = `not ${go(n.arg, p)}`; break;
      case 'bin': {
        p = PREC[n.op];
        // left-associative: a right operand of equal precedence needs parentheses
        s = `${go(n.l, p)} ${WORD[n.op]} ${go(n.r, p + 0.5)}`;
        break;
      }
      case 'cond': p = PREC['?']; s = `if ${go(n.c, p + 0.5)} then ${go(n.t, p + 0.5)} else ${go(n.e, p)}`; break;
      case 'index': p = PREC.post; s = `${go(n.base, p)}[${go(n.index)}]`; break;
      case 'range': p = PREC.post; s = `${go(n.base, p)}[${go(n.msb)}:${go(n.lsb)}]`; break;
      default: return '?';
    }
    return p < parent ? `(${s})` : s;
  };
  return go(ast);
}

// Canonical form: no whitespace, literals by value, commutative && / || operands sorted.
export function normalizeGuard(ast) {
  const go = (n) => {
    if (!n) return '1';
    switch (n.type) {
      case 'id': return n.name;
      case 'lit': return n.value === null ? n.raw : n.value.toString();
      case 'un': return `${n.op === '~' ? '!' : n.op}(${go(n.arg)})`;
      case 'bin': {
        const parts = [go(n.l), go(n.r)];
        if (['&&', '||', '==', '!=', '&', '|', '^'].includes(n.op)) parts.sort();
        return `(${parts[0]}${n.op}${parts[1]})`;
      }
      case 'cond': return `(${go(n.c)}?${go(n.t)}:${go(n.e)})`;
      case 'index': return `${go(n.base)}[${go(n.index)}]`;
      case 'range': return `${go(n.base)}[${go(n.msb)}:${go(n.lsb)}]`;
      default: return '?';
    }
  };
  return go(ast);
}

// Boolean atoms of a guard: comparisons of a named signal with a literal are
// multi-valued variables (so a == 1 and a == 2 exclude each other); every other
// non-logical subexpression is a free boolean atom.
function atomsOf(ast, vars) {
  if (!ast) return;
  if (ast.type === 'un' && ast.op === '!') return atomsOf(ast.arg, vars);
  if (ast.type === 'bin' && (ast.op === '&&' || ast.op === '||')) { atomsOf(ast.l, vars); atomsOf(ast.r, vars); return; }
  if (ast.type === 'bin' && (ast.op === '==' || ast.op === '!=')) {
    const [id, lit] = ast.l.type === 'lit' ? [ast.r, ast.l] : [ast.l, ast.r];
    if (lit?.type === 'lit' && lit.value !== null && id.type !== 'lit') {
      const key = normalizeGuard(id);
      if (!vars.has(key)) vars.set(key, { kind: 'multi', values: new Set() });
      if (vars.get(key).kind === 'multi') vars.get(key).values.add(lit.value.toString());
      return;
    }
  }
  const key = normalizeGuard(ast);
  if (!vars.has(key)) vars.set(key, { kind: 'bool' });
}

function evaluate(ast, env) {
  if (!ast) return true;
  if (ast.type === 'un' && ast.op === '!') return !evaluate(ast.arg, env);
  if (ast.type === 'bin' && ast.op === '&&') return evaluate(ast.l, env) && evaluate(ast.r, env);
  if (ast.type === 'bin' && ast.op === '||') return evaluate(ast.l, env) || evaluate(ast.r, env);
  if (ast.type === 'bin' && (ast.op === '==' || ast.op === '!=')) {
    const [id, lit] = ast.l.type === 'lit' ? [ast.r, ast.l] : [ast.l, ast.r];
    if (lit?.type === 'lit' && lit.value !== null && id.type !== 'lit' && env.has(normalizeGuard(id)) && typeof env.get(normalizeGuard(id)) === 'string') {
      const eq = env.get(normalizeGuard(id)) === lit.value.toString();
      return ast.op === '==' ? eq : !eq;
    }
  }
  return Boolean(env.get(normalizeGuard(ast)));
}

// Whether two guards can both be true, or null when there are more than
// `maxAtoms` atoms (the check is skipped rather than guessed).
export function guardsOverlap(a, b, { maxAtoms = 16 } = {}) {
  const vars = new Map();
  atomsOf(a, vars);
  atomsOf(b, vars);
  const entries = [...vars.entries()];
  const bits = entries.reduce((n, [, v]) => n + (v.kind === 'bool' ? 1 : Math.ceil(Math.log2(v.values.size + 1))), 0);
  if (bits > maxAtoms) return null;
  const domains = entries.map(([key, v]) => [key, v.kind === 'bool' ? [false, true] : [...v.values, '__other__']]);
  const env = new Map();
  const search = (i) => {
    if (i === domains.length) return evaluate(a, env) && evaluate(b, env);
    for (const value of domains[i][1]) {
      env.set(domains[i][0], value);
      if (search(i + 1)) return true;
    }
    return false;
  };
  return search(0);
}
