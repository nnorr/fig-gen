// Width expressions: integers, identifiers (params), + - * / (integer
// division), parentheses, clog2(x), max(a, b). No eval().

export function clog2(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`clog2 of non-positive value ${n}`);
  let bits = 0;
  while ((1 << bits) < n) bits += 1;
  return bits;
}

// Mux select width for n inputs: binary encoding needs at least one bit.
export function muxSelWidth(n, encoding = 'binary') {
  return encoding === 'onehot' ? n : Math.max(1, clog2(n));
}

export function evalWidth(expr, params = {}) {
  if (Number.isInteger(expr)) return expr;
  const tokens = tokenize(String(expr));
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (t) => {
    if (tokens[pos] !== t) throw new Error(`expected '${t}' in width expression '${expr}'`);
    pos += 1;
  };

  function primary() {
    const t = tokens[pos++];
    if (t === undefined) throw new Error(`unexpected end of width expression '${expr}'`);
    if (/^[0-9]+$/.test(t)) return Number(t);
    if (t === '(') { const v = sum(); take(')'); return v; }
    if (t === '-') return -primary();
    if (/^[A-Za-z_]\w*$/.test(t)) {
      if (peek() === '(') {
        take('(');
        const args = [sum()];
        while (peek() === ',') { take(','); args.push(sum()); }
        take(')');
        if (t === 'clog2' && args.length === 1) return clog2(args[0]);
        if (t === 'max' && args.length === 2) return Math.max(...args);
        throw new Error(`unknown function ${t}/${args.length} in width expression '${expr}'`);
      }
      if (!Object.hasOwn(params, t)) {
        const error = new Error(`unknown param '${t}' in width expression '${expr}'`);
        error.code = 'ir/unknown-param';
        error.param = t;
        throw error;
      }
      return params[t];
    }
    throw new Error(`unexpected token '${t}' in width expression '${expr}'`);
  }
  function product() {
    let v = primary();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[pos++];
      const r = primary();
      v = op === '*' ? v * r : Math.trunc(v / r);
    }
    return v;
  }
  function sum() {
    let v = product();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++];
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  const value = sum();
  if (pos !== tokens.length) throw new Error(`trailing tokens in width expression '${expr}'`);
  return value;
}

function tokenize(text) {
  const tokens = text.match(/[A-Za-z_]\w*|[0-9]+|[()+\-*/,]|\S/g) || [];
  for (const t of tokens) if (!/^([A-Za-z_]\w*|[0-9]+|[()+\-*/,])$/.test(t)) throw new Error(`invalid character '${t}' in width expression '${text}'`);
  return tokens;
}
