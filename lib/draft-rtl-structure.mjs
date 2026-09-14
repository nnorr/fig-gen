// Structure recognition for the register-transfer draft (SPEC §4.10):
// structural hashing of expression cones (isomorphic chains merge, the same
// step across stages is one staged function) and functional names recognized
// from the structure, each with a cited basis. Names never come from RTL
// identifiers; a block whose structure matches nothing gets a role name and is
// listed for review.

// A template of one expression: references to members of the same group are
// "M", other references (and indexed or sliced signals) "X", constants "C",
// operators and function calls keep their name, widths are kept so a byte-wide
// step never matches a word-wide one. Constant values are dropped: two Horner
// chains evaluating at different field constants share one template.
export function exprTemplate(expr, isMember = () => false) {
  const t = (n) => {
    if (!n || typeof n !== 'object') return '?';
    if (n.op === 'ref') return isMember(n.name) ? 'M' : 'X';
    if ((n.op === 'index' || n.op === 'sel') && n.args?.[0]?.op === 'ref') return isMember(n.args[0].name) ? 'M' : 'X';
    if (n.op === 'const') return 'C';
    const head = n.op === 'func' ? String(n.name) : n.op;
    return `${head}/${n.width ?? ''}(${(n.args || []).map(t).join(',')})`;
  };
  return t(expr);
}

// Structural key of a group of expressions: its sorted templates and their count.
export const groupKey = (exprs, isMember) => `${exprs.map((e) => exprTemplate(e, isMember)).sort().join('|')}#${exprs.length}`;
// The step a group repeats, independent of how many times: the same function across stages.
export const stepKey = (exprs, isMember) => [...new Set(exprs.map((e) => exprTemplate(e, isMember)))].sort().join('|');

const walk = (n, visit) => {
  if (!n || typeof n !== 'object') return;
  visit(n);
  for (const a of n.args || []) walk(a, visit);
};
const funcs = (expr) => { const out = []; walk(expr, (n) => { if (n.op === 'func') out.push(String(n.name)); }); return out; };
const isConst = (n) => n?.op === 'const';
const isZeroConst = (n) => isConst(n) && /^(?:\d+'[bhdo])?0+$/i.test(String(n.value).replace(/_/g, ''));

// Horner step: add(mul(prev, constant), next) with field helpers or operators.
export function isHornerStep(expr) {
  if (!expr) return false;
  const addLike = (n) => n.op === 'xor' || (n.op === 'func' && /add|xor/i.test(n.name));
  const mulLike = (n) => n.op === 'mul' || (n.op === 'func' && /mul/i.test(n.name));
  if (!addLike(expr) || (expr.args || []).length !== 2) return false;
  return expr.args.some((a) => mulLike(a) && (a.args || []).some(isConst) && (a.args || []).some((b) => !isConst(b)));
}

// Division of a value by the inverse of a constant table element: mul(x, inv(table[i])).
export function isDivisionByTable(expr, isConstTable) {
  const mulLike = (n) => n?.op === 'mul' || (n?.op === 'func' && /mul/i.test(n.name));
  const invLike = (n) => n?.op === 'func' && /inv|div/i.test(n.name);
  if (!mulLike(expr)) return false;
  return (expr.args || []).some((a) => invLike(a) && (a.args || []).some((b) => (b.op === 'index' || b.op === 'sel') && b.args?.[0]?.op === 'ref' && isConstTable(b.args[0].name)));
}

// Division of one value by another: mul(a, inv(b)) through intermediate members.
export function isValueDivision(exprs) {
  const all = exprs.flatMap(funcs);
  return all.some((f) => /inv|div/i.test(f)) && all.some((f) => /mul/i.test(f));
}

export const isZeroCompare = (expr) => (expr?.op === 'eq' || expr?.op === 'ne') && (expr.args || []).some(isZeroConst) && (expr.args || []).some((a) => !isConst(a));

// Basis source pin spanning the given source locations (one file).
export function basisOf(sources, structure) {
  const located = sources.filter((s) => s?.file && s?.line);
  if (!located.length) return null;
  const file = located[0].file;
  const lines = located.filter((s) => s.file === file).map((s) => s.line);
  const lo = Math.min(...lines);
  const hi = Math.max(...lines);
  return { source: { file, line: lo, ...(hi > lo ? { end_line: hi } : {}) }, structure: structure.slice(0, 120) };
}

// Readable role names from the data flow, for blocks no structure names.
export const roleName = (role) => role.slice(0, 40);
