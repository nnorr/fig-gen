// Semantic checks of the FSM IR (SPEC §5, §8): states, encodings, guards,
// output kinds, reachability and printed names. Pure: no RTL here (the RTL
// cross-check is lib/checks/fsm-crosscheck.mjs).

import { diagnostic } from '../diagnostics.mjs';
import { guardIdentifiers, guardsOverlap, literalValue, normalizeGuard, parseGuard } from '../fsm/guard.mjs';
import { acronymCase, expandAbbreviations, unreadableReason } from './labels.mjs';

const d = (code, severity, message, subject = {}, evidence = {}, supportedFixes = []) => diagnostic({ code, severity, message, subject, evidence, supportedFixes });

// Words of an RTL state id: CamelCase and snake_case split, lower case.
const idWords = (id) => String(id).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[_\s]+/).filter(Boolean).map((w) => w.toLowerCase());

// Printed state names. An authored label wins; otherwise the id's words
// without the prefix every state shares (S_, ST_, CtrlIdle/CtrlResult → Ctrl),
// expanded and cased like other generated names ("OwnerMetaCounter0" →
// "Meta counter 0", "S_IDLE" → "Idle").
export function stateNames(doc, { mode = 'full' } = {}) {
  const states = doc.states || [];
  const words = new Map(states.map((s) => [s.id, idWords(s.id).flatMap((w) => w.split(/(?<=[a-z])(?=\d)/))]));
  let common = 0;
  const lists = [...words.values()];
  if (lists.length > 1) {
    while (lists.every((w) => w.length > common + 1 && w[common] === lists[0][common])) common += 1;
  }
  const out = new Map();
  for (const s of states) {
    const authored = mode === 'short' ? (s.short_label ?? s.label) : s.label;
    if (authored) { out.set(s.id, { text: authored, generated: false }); continue; }
    const phrase = acronymCase(expandAbbreviations(words.get(s.id).slice(common).join(' ')));
    out.set(s.id, { text: phrase ? phrase[0].toUpperCase() + phrase.slice(1) : s.id, generated: true });
  }
  return out;
}

// A figure with collapsed super-states (states[].collapsed, drawn in a linked
// sub-figure) as the RTL cross-check sees it: each collapsed state is replaced
// by its members (no encoding: the sub-figure draws them), arcs into it enter
// its entry member and arcs out of it leave its exit member, and the RTL
// transitions into its other members are covered by the sub-figure
// (machine.scope.omit_transitions_to, with the reason).
export function expandCollapsed(doc) {
  const groups = (doc.states || []).filter((s) => s.collapsed?.members?.length);
  if (!groups.length) return doc;
  const out = structuredClone(doc);
  const entry = new Map(groups.map((g) => [g.id, g.collapsed.entry ?? g.collapsed.members[0]]));
  const exit = new Map(groups.map((g) => [g.id, g.collapsed.exit ?? g.collapsed.members.at(-1)]));
  out.states = out.states.flatMap((s) => (s.collapsed?.members?.length ? s.collapsed.members.map((id) => ({ id })) : [s]));
  out.transitions = (out.transitions || []).map((t) => ({ ...t, from: exit.get(t.from) ?? t.from, to: entry.get(t.to) ?? t.to, ...(t.except ? { except: t.except.flatMap((x) => (entry.has(x) ? groups.find((g) => g.id === x).collapsed.members : [x])) } : {}) }));
  if (out.reset?.state && entry.has(out.reset.state)) out.reset = { ...out.reset, state: entry.get(out.reset.state) };
  const covered = groups.flatMap((g) => g.collapsed.members.filter((m) => m !== entry.get(g.id)));
  const scope = out.machine?.scope || {};
  out.machine = { ...out.machine, scope: { ...scope, omit_transitions_to: [...new Set([...(scope.omit_transitions_to || []), ...covered])], reason: scope.reason ?? `drawn in linked sub-figures: ${groups.map((g) => g.detail_ref?.figure ?? g.id).join(', ')}` } };
  return out;
}

// Declared width of an encoding literal and its value.
function encodingOf(state) {
  if (state.encoding === undefined) return null;
  const lit = literalValue(state.encoding);
  return lit.value === null ? { ...lit, raw: state.encoding } : { ...lit, raw: state.encoding };
}

export function checkFsm(doc, { quality } = {}) {
  const diagnostics = [];
  const labelSeverity = quality === 'paper' ? 'error' : 'warning';
  const states = doc.states || [];
  const transitions = doc.transitions || [];
  const stateIds = new Set(states.map((s) => s.id));
  const inputs = new Map((doc.inputs || []).map((s) => [s.name, s]));
  const outputs = new Map((doc.outputs || []).map((s) => [s.name, s]));
  const params = new Set(Object.keys(doc.params || {}));
  const machine = doc.machine || {};

  // Unknown state references.
  const known = (id, where, subject) => {
    if (id === '*' || stateIds.has(id)) return true;
    diagnostics.push(d('fsm/unknown-state', 'error', `${where} names state '${id}', which is not declared`, subject, { state: id, declared: [...stateIds] }, ['declare the state in states[]', 'fix the state id']));
    return false;
  };
  if (doc.reset?.state) known(doc.reset.state, 'reset.state', { field: 'reset.state' });
  for (const t of transitions) {
    known(t.from, `transition ${t.id} from`, { id: t.id });
    known(t.to, `transition ${t.id} to`, { id: t.id });
    for (const x of t.except || []) known(x, `transition ${t.id} except`, { id: t.id });
    if (t.except && t.from !== '*') diagnostics.push(d('fsm/unknown-state', 'error', `transition ${t.id} lists except but is not an any-state arc (from "*")`, { id: t.id }, {}, ['set from: "*"', 'remove except']));
  }

  // Encodings: present (unless auto), within the state width, distinct.
  const width = machine.state_width;
  const seen = new Map();
  for (const s of states) {
    const enc = encodingOf(s);
    if (!enc) {
      if (machine.encoding !== 'auto') diagnostics.push(d('fsm/encoding-width', 'error', `state ${s.id} has no encoding; machine.encoding is ${machine.encoding}, so every state needs one (or use "auto")`, { id: s.id }, {}, ['add states[].encoding', 'set machine.encoding "auto"']));
      continue;
    }
    if (enc.value === null) {
      diagnostics.push(d('fsm/encoding-width', 'error', `state ${s.id}: encoding ${s.encoding} has x/z digits; a state code is a fixed value`, { id: s.id }, { encoding: s.encoding }));
      continue;
    }
    if (width && ((enc.width !== null && enc.width !== width) || enc.value >= (1n << BigInt(width)))) {
      diagnostics.push(d('fsm/encoding-width', 'error', `state ${s.id}: encoding ${s.encoding} does not fit the ${width}-bit state register`, { id: s.id }, { encoding: s.encoding, state_width: width }, ['write the literal with the state width', 'fix machine.state_width']));
    }
    if (machine.encoding === 'onehot' && enc.value !== 0n && (enc.value & (enc.value - 1n)) !== 0n) {
      diagnostics.push(d('fsm/encoding-width', 'error', `state ${s.id}: encoding ${s.encoding} is not one-hot`, { id: s.id }, { encoding: s.encoding }));
    }
    const key = enc.value.toString();
    if (seen.has(key)) diagnostics.push(d('fsm/encoding-duplicate', 'error', `states ${seen.get(key)} and ${s.id} share encoding ${s.encoding}`, { ids: [seen.get(key), s.id] }, { encoding: s.encoding }, ['give each state a distinct code']));
    else seen.set(key, s.id);
  }

  // Guards: parse, identifiers declared.
  const allowed = new Set([...inputs.keys(), ...outputs.keys(), ...params, ...(doc.constants || []).map((c) => c.name), 'state', ...stateIds]);
  const parsed = new Map();
  const parseField = (text, subject, field) => {
    if (text === undefined || text === null || String(text).trim() === '') return null;
    const r = parseGuard(text);
    if (!r.ok) {
      diagnostics.push(d('fsm/guard-parse', 'error', `${subject.id ?? 'reset'}: ${field} "${text}" does not parse: ${r.error} (column ${r.at + 1})`, { ...subject, field }, { text, at: r.at }, ['write the guard in the SPEC §5 subset: identifiers, literals, ! ~ && || & | ^ == != < <= > >= ?:, parentheses, bit select']));
      return undefined;
    }
    for (const name of guardIdentifiers(r.ast)) {
      const base = name.includes('::') ? name.split('::').at(-1) : name;
      if (!allowed.has(name) && !allowed.has(base)) {
        diagnostics.push(d('fsm/guard-unknown-identifier', 'error', `${subject.id ?? 'reset'}: ${field} reads '${name}', which is not a declared input, output, parameter or state`, { ...subject, field }, { identifier: name }, [`declare ${name} in inputs[] (or params)`, 'fix the identifier']));
      }
    }
    return r.ast;
  };
  for (const t of transitions) {
    const ast = parseField(t.guard, { id: t.id }, 'guard');
    parsed.set(t.id, ast);
    if (t.short_guard) parseField(t.short_guard, { id: t.id }, 'short_guard');
  }
  if (doc.reset?.condition) {
    const r = parseGuard(doc.reset.condition);
    if (!r.ok) diagnostics.push(d('fsm/guard-parse', 'error', `reset.condition "${doc.reset.condition}" does not parse: ${r.error}`, { field: 'reset.condition' }, { text: doc.reset.condition }));
  }

  // Output kinds: Moore on states, Mealy on transitions, all declared.
  for (const s of states) {
    for (const name of Object.keys(s.outputs || {})) {
      const o = outputs.get(name);
      if (!o) diagnostics.push(d('fsm/output-kind', 'error', `state ${s.id} sets output '${name}', which is not declared`, { id: s.id }, { output: name }, ['declare it in outputs[] with type "moore"']));
      else if (o.type !== 'moore') diagnostics.push(d('fsm/output-kind', 'error', `state ${s.id} sets ${o.type} output '${name}'; only Moore outputs belong on states`, { id: s.id }, { output: name, type: o.type }, ['move the value to the transitions as actions', 'declare the output as moore']));
    }
  }
  for (const t of transitions) {
    for (const name of Object.keys(t.actions || {})) {
      const o = outputs.get(name);
      if (!o) diagnostics.push(d('fsm/output-kind', 'error', `transition ${t.id} sets output '${name}', which is not declared`, { id: t.id }, { output: name }, ['declare it in outputs[] with type "mealy"']));
      else if (o.type !== 'mealy') diagnostics.push(d('fsm/output-kind', 'error', `transition ${t.id} sets ${o.type} output '${name}'; only Mealy outputs belong on transitions`, { id: t.id }, { output: name, type: o.type }, ['move the value to the target state outputs', 'declare the output as mealy']));
    }
  }

  // Duplicate transitions: same endpoints and equivalent guard.
  const signatures = new Map();
  for (const t of transitions) {
    const ast = parsed.get(t.id);
    if (ast === undefined) continue;
    const key = `${t.from}>${t.to}:${normalizeGuard(ast)}:${(t.except || []).slice().sort().join(',')}`;
    if (signatures.has(key)) diagnostics.push(d('fsm/duplicate-transition', 'error', `transitions ${signatures.get(key)} and ${t.id} are the same arc (${t.from} → ${t.to}, same guard)`, { ids: [signatures.get(key), t.id] }, {}, ['remove one of them', 'merge their guards with ||']));
    else signatures.set(key, t.id);
  }

  // Reachability from the reset state over drawn arcs.
  if (doc.reset?.state && stateIds.has(doc.reset.state)) {
    const reached = new Set([doc.reset.state]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of transitions) {
        if (!stateIds.has(t.to) || reached.has(t.to)) continue;
        const fromReached = t.from === '*' ? [...reached].some((s) => !(t.except || []).includes(s)) : reached.has(t.from);
        if (fromReached) { reached.add(t.to); grew = true; }
      }
    }
    for (const s of states) {
      if (!reached.has(s.id)) diagnostics.push(d('fsm/unreachable', 'error', `state ${s.id} is not reachable from the reset state ${doc.reset.state} over the drawn transitions`, { id: s.id }, { reset: doc.reset.state, reachable: [...reached] }, ['draw the transition that enters it', 'remove the state if the RTL cannot reach it']));
    }
  }

  // Overlapping guards out of one state at the same priority.
  const byFrom = new Map();
  for (const t of transitions) {
    if (t.from === '*') continue;
    if (!byFrom.has(t.from)) byFrom.set(t.from, []);
    byFrom.get(t.from).push(t);
  }
  for (const [from, list] of byFrom) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [a, b] = [list[i], list[j]];
        if (a.to === b.to) continue;
        if ((a.priority ?? 0) !== (b.priority ?? 0)) continue;
        const ga = parsed.get(a.id);
        const gb = parsed.get(b.id);
        if (ga === undefined || gb === undefined) continue;
        const overlap = guardsOverlap(ga, gb);
        if (overlap) diagnostics.push(d('fsm/ambiguous-guards', 'warning', `state ${from}: guards of ${a.id} (→ ${a.to}) and ${b.id} (→ ${b.to}) can both be true at the same priority`, { id: from, ids: [a.id, b.id] }, { guards: [a.guard ?? '', b.guard ?? ''] }, ['set priority to mirror the RTL if/else order', 'make the guards exclusive']));
      }
    }
  }

  // Printed state names are readable; a generated one is a renderer defect.
  // A short plain word ("Run", "Idle") is a name, not a mnemonic.
  const nameReason = (textValue) => {
    const reason = unreadableReason(textValue);
    return reason && /3 characters or fewer/.test(reason) && /^[A-Z]?[a-z]+$/.test(String(textValue).trim()) ? null : reason;
  };
  for (const [id, n] of stateNames(doc)) {
    const reason = nameReason(n.text);
    if (reason) diagnostics.push(d('label/unreadable', n.generated ? 'error' : labelSeverity, `state ${id}: ${n.generated ? 'generated name' : 'label'} "${n.text}" is not a readable name (${reason})`, { id, field: n.generated ? 'generated state name' : 'label' }, { label: n.text, reason, ...(n.generated ? { generated: true } : {}) }, ['give the state a readable label']));
  }
  for (const s of states.filter((x) => x.short_label)) {
    const reason = unreadableReason(s.short_label);
    if (reason) diagnostics.push(d('label/unreadable', labelSeverity, `state ${s.id}: short_label "${s.short_label}" is not a readable name (${reason})`, { id: s.id, field: 'short_label' }, { label: s.short_label, reason }));
  }
  return { diagnostics };
}
