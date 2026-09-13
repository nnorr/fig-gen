// FSM draft (`fig-gen draft --type fsm`): a starting fsm figure from the
// state machine the netlist extraction found (modules[].fsms). States keep
// their RTL names as ids with readable labels, encodings come from the RTL,
// guards are printed from the RTL expressions, outputs that depend only on the
// state are Moore outputs on the states, and states unreachable from reset are
// left out with the reason. The draft passes crosscheckFsm on the same netlist.

import { acronymCase, readableIdentifier, readableName } from './checks/labels.mjs';
import { crosscheckFsm, findFsm, findFsmModule, guardIdentifiers, printGuard, reachableStates } from './checks/fsm-crosscheck.mjs';
import { foldExpr, literalValue } from './rtl/fsm-extract.mjs';

const draftError = (message, fixes = []) => Object.assign(new Error(message), { diagnostic: { code: 'draft/fsm-not-found', severity: 'error', message, subject: {}, evidence: {}, supportedFixes: fixes } });

// "OwnerMetaCounter0" → [Owner, Meta, Counter, 0]; "S_IDLE" → [S, IDLE].
const words = (name) => String(name).split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])/).filter(Boolean);

// Labels: the words every state name starts with (S_, Owner, Ctrl) are dropped.
export function stateLabels(names) {
  const split = names.map(words);
  let common = 0;
  while (split.length > 1 && split.every((w) => w.length > common + 1 && w[common].toLowerCase() === split[0][common].toLowerCase())) common += 1;
  return names.map((_, i) => {
    const text = readableName(split[i].slice(common).map((w) => w.toLowerCase()).join('_'));
    return acronymCase(text).slice(0, 40);
  });
}

const literal = (value, width) => (width <= 8 ? `${width}'b${BigInt(value).toString(2).padStart(width, '0')}` : `${width}'h${BigInt(value).toString(16)}`);

function encodingKind(values) {
  if (values.every((v) => v !== 0n && (v & (v - 1n)) === 0n)) return 'onehot';
  if (values.every((v, i) => v === BigInt(i))) return 'binary';
  return 'custom';
}

export function draftFsm(netlist, { scope = '', state, format } = {}) {
  const notes = [];
  const byScope = scope && /[/.]/.test(scope) ? { instance: scope.replace(/\./g, '/') } : scope ? (findFsmModule(netlist, { module: scope }) ? { module: scope } : { instance: scope }) : {};
  const mod = findFsmModule(netlist, byScope);
  if (!mod) throw draftError(`draft --type fsm: no module or instance "${scope}" in the netlist`, ['give --scope an instance path from the top (a/b) or a module name']);
  const candidates = mod.fsms || [];
  if (!candidates.length) throw draftError(`draft --type fsm: module ${mod.orig_name} has no extracted state machine`, ['check that the next state is chosen by a case on the state register', 're-run check-rtl with this version so the netlist carries modules[].fsms']);
  const { fsm } = findFsm(netlist, { ...byScope, ...(state ? { state_register: state } : {}) });
  if (!fsm) throw draftError(`draft --type fsm: ${state ? `no state machine on register ${state}` : 'several state machines'} in ${mod.orig_name} (${candidates.map((f) => f.register).join(', ')})`, ['pass --state <register>']);

  const width = fsm.width;
  const reach = reachableStates(fsm);
  const unreachable = fsm.states.filter((s) => !reach.has(s.name)).map((s) => s.name);
  const shown = fsm.states.filter((s) => reach.has(s.name));
  const labels = stateLabels(shown.map((s) => s.name));
  const values = new Map(fsm.states.map((s) => [s.name, literalValue(s.value)]));

  // Moore outputs: output ports assigned from the state register alone.
  const ports = new Map((mod.ports || []).map((p) => [p.name, p]));
  const netWidth = (name) => ports.get(name)?.width ?? (mod.nets || []).find((n) => n.name === name)?.width ?? 1;
  const moore = [];
  for (const x of mod.exprs || []) {
    if (x.index !== undefined || ports.get(x.target)?.dir !== 'out') continue;
    const ids = guardIdentifiers(x.expr);
    if (!ids.size || [...ids].some((n) => n !== fsm.register)) continue;
    const perState = {};
    let ok = true;
    for (const s of shown) {
      const { e } = foldExpr(x.expr, { register: fsm.register, width, state: values.get(s.name), named: new Set(values.values()) });
      const v = e?.op === 'const' ? literalValue(e.value) : null;
      if (v === null) { ok = false; break; }
      perState[s.name] = (x.width ?? 1) === 1 ? String(v) : literal(v, x.width);
    }
    if (ok && !moore.some((m) => m.name === x.target)) moore.push({ name: x.target, width: x.width ?? netWidth(x.target), values: perState });
  }
  if (!moore.length) notes.push('no output depends on the state register alone; Moore outputs are left out (add them, or Mealy actions on transitions, by hand)');

  // Guards and the identifiers they read.
  const params = {};
  const usedIds = new Set();
  const print = (g) => {
    if (!g) return undefined;
    const text = printGuard(g);
    if (text === null) return null;
    guardIdentifiers(g, usedIds);
    (function walk(e) {
      if (!e || typeof e !== 'object') return;
      if (e.op === 'const' && e.param && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.param)) {
        const v = literalValue(e.value);
        if (v !== null && v <= BigInt(Number.MAX_SAFE_INTEGER)) params[e.param] = Number(v);
      }
      for (const a of e.args || []) walk(a);
      if (e.index_expr) walk(e.index_expr);
    })(g);
    return text;
  };
  const transitions = [];
  const unprintable = [];
  const shownNames = new Set(shown.map((s) => s.name));
  let n = 0;
  for (const o of fsm.transitions.filter((t) => t.from === '*')) {
    const guard = print(o.guard);
    if (guard === null) { unprintable.push(`* -> ${o.to}`); continue; }
    transitions.push({ id: `t${n++}`, from: '*', to: o.to, ...(guard ? { guard } : {}), style: 'any_state', ...(o.sync_override ? { sync_override: true } : {}) });
    notes.push(`${o.to} is also entered from every state when ${guard ?? 'always'} (a synchronous override in the clocked block), drawn once as an any-state arc`);
  }
  // Case transitions, one per (from, to). With `ordered`, an else-branch drops
  // the negated conditions of the earlier transitions from its state and the
  // state's transitions get priorities (if/else order), which reads like the
  // RTL; the draft keeps that form only if it still passes the cross-check.
  const overrideCount = transitions.length;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const conjuncts = (g) => (!g ? [] : g.op === 'land' ? [...conjuncts(g.args[0]), ...conjuncts(g.args[1])] : [g]);
  const rebuild = (cs) => (cs.length ? cs.slice(1).reduce((a, b) => ({ op: 'land', width: 1, args: [a, b] }), cs[0]) : null);
  const caseTransitions = (ordered) => {
    const out = [];
    const byState = new Map();
    for (const t of fsm.transitions.filter((x) => x.from !== '*' && shownNames.has(x.from))) {
      if (!byState.has(t.from)) byState.set(t.from, []);
      byState.get(t.from).push(t);
    }
    for (const [from, leaves] of byState) {
      leaves.sort((a, b) => a.priority - b.priority);
      let stripped = false;
      const guards = leaves.map((t, k) => {
        if (!ordered) return t.guard;
        const earlier = leaves.slice(0, k).map((x) => x.guard).filter(Boolean);
        const cs = conjuncts(t.guard);
        const kept = cs.filter((c) => !(c.op === 'lnot' && earlier.some((e) => same(c.args[0], e))));
        if (kept.length !== cs.length) stripped = true;
        return rebuild(kept);
      });
      const groups = new Map();
      leaves.forEach((t, k) => {
        if (!groups.has(t.to)) groups.set(t.to, { to: t.to, first: k, guards: [] });
        groups.get(t.to).guards.push(guards[k]);
      });
      let prio = 0;
      for (const g of [...groups.values()].sort((a, b) => a.first - b.first)) {
        const texts = g.guards.map((x) => print(x));
        if (texts.some((x) => x === null)) { unprintable.push(`${from} -> ${g.to}`); continue; }
        const guard = texts.some((x) => x === undefined) ? undefined : texts.length === 1 ? texts[0] : texts.map((x) => `(${x})`).join(' || ');
        out.push({ from, to: g.to, ...(guard ? { guard } : {}), ...(stripped ? { priority: prio } : {}) });
        prio += 1;
      }
    }
    return out;
  };
  for (const t of caseTransitions(true)) transitions.push({ id: `t${n++}`, ...t });
  if (unprintable.length) notes.push(`guards outside the SV guard subset were not drafted: ${unprintable.join(', ')}; draw them by hand`);

  // Default recovery from unused encodings.
  const unused = 2 ** width - fsm.states.length;
  const recovery = fsm.default?.kind === 'to' && unused > 0;
  if (recovery) {
    transitions.push({ id: `t${n++}`, from: '*', to: fsm.default.state, style: 'any_state', recovery: true });
    notes.push(`the RTL default branch recovers from the ${unused} unused encoding${unused > 1 ? 's' : ''} to ${fsm.default.state}; drawn as a recovery arc (machine.show_default_recovery)`);
  }

  // Declared signals.
  const inputs = [];
  const outputs = moore.map((m) => ({ name: m.name, width: m.width, type: 'moore', label: readableIdentifier(m.name).slice(0, 40) }));
  const internal = [];
  const readOutputs = [];
  for (const id of [...usedIds].sort()) {
    if (id === fsm.register || params[id] !== undefined || outputs.some((o) => o.name === id)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) continue;
    const p = ports.get(id);
    if (!p) internal.push(id);
    else if (p.dir === 'out') readOutputs.push(id);
    inputs.push({ name: id, width: netWidth(id), label: readableIdentifier(id).slice(0, 40) });
  }
  if (internal.length) notes.push(`guards read internal signals, declared as inputs: ${internal.join(', ')}`);
  if (readOutputs.length) notes.push(`guards read output ports that are not Moore outputs, declared as inputs: ${readOutputs.join(', ')}`);

  if (unreachable.length) notes.push(`states unreachable from reset in the RTL are left out (machine.scope): ${unreachable.join(', ')}`);
  notes.push(`${shown.length} of ${fsm.states.length} states reachable from ${fsm.reset?.state ?? shown[0]?.name}; ${transitions.length} transitions drafted`);
  if (!fsm.reset) notes.push('no reset found for the state register; reset.state is the first state, check it');

  const encoding = encodingKind(shown.map((s) => values.get(s.name)));
  const machine = {
    name: `${mod.orig_name}.${fsm.register}`,
    state_width: width,
    encoding,
    ...(moore.length ? { kind: 'moore' } : {}),
    default: 'hold',
    rtl: { ...(byScope.instance ? { instance: byScope.instance } : { module: mod.orig_name }), state_register: fsm.register },
    ...(recovery ? { show_default_recovery: true } : {}),
    ...(unreachable.length ? { scope: { omit_states: unreachable, reason: 'unreachable from reset in the RTL' } } : {}),
  };
  const doc = {
    schema_version: 1,
    figure_type: 'fsm',
    meta: {
      title: `State machine of ${mod.orig_name}`,
      caption: `State machine of ${mod.orig_name} (state register ${fsm.register}). Draft generated from the netlist: refine labels and guards.`,
      print: { profile: 'ieee', variants: ['2col'], ...(format ? { format } : {}) },
      ...(byScope.instance ? { rtl: { instance: byScope.instance } } : {}),
    },
    ...(Object.keys(params).length ? { params } : {}),
    machine,
    inputs,
    outputs,
    reset: fsm.reset
      ? { state: fsm.reset.state, condition: `${fsm.reset.active === 'low' ? '!' : ''}${fsm.reset.net}`, async: fsm.reset.async }
      : { state: shown[0].name },
    states: shown.map((s, i) => ({
      id: s.name,
      label: labels[i],
      encoding: literal(values.get(s.name), width),
      ...(moore.length ? { outputs: Object.fromEntries(moore.map((m) => [m.name, m.values[s.name]])) } : {}),
    })),
    transitions,
  };
  // The if/else form must mean exactly what the RTL does; otherwise the plain
  // mutually exclusive guards are drafted.
  if (crosscheckFsm(doc, netlist).diagnostics.some((d) => d.code === 'fsm/rtl-guard-mismatch')) {
    const plain = caseTransitions(false);
    const tail = doc.transitions.slice(overrideCount).filter((t) => t.recovery);
    doc.transitions = [...doc.transitions.slice(0, overrideCount), ...plain.map((t, i) => ({ id: `t${overrideCount + i}`, ...t })), ...tail.map((t, i) => ({ ...t, id: `t${overrideCount + plain.length + i}` }))];
    notes.push('guards are drafted as mutually exclusive conditions (the if/else form did not match the RTL)');
  }
  return { doc, notes };
}
