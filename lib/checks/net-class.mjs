// Net line style follows usage, not naming (CONVENTIONS §1, SPEC §8).
// A net is CONTROL (dashed) only if every sink uses it as a select, an
// enable (register/memory enable, write/chip enable) or a handshake
// (valid/ready) input; clock and reset keep their own classes. Any sink that
// consumes the net as a value makes it DATA (solid) — computed values,
// 1-bit flags and status outputs included. A net with both value and control
// sinks is drawn solid as a whole (the select pin symbol already marks the
// branch into it). An authored `class` that differs from the derived one
// needs `class_reason`, otherwise `net/class-style` is an error.

import { diagnostic } from '../diagnostics.mjs';
import { buildModel } from '../ir/datapath-model.mjs';

const CONTROL_ROLES = new Set(['select', 'enable', 'handshake']);

// Role of one sink pin: select | enable | handshake | clock | reset | value.
export function sinkRole(sink) {
  const el = sink.element;
  const pin = sink.pin;
  if (!el || !pin) return 'value';
  if (pin.class === 'clock') return 'clock';
  if (pin.class === 'reset') return 'reset';
  if (el.kind === 'mux' && pin.id === 'sel') return 'select';
  if ((el.kind === 'register' || el.kind === 'pipeline_register') && pin.id === 'en') return 'enable';
  if (el.kind === 'memory' && /_(we|re)$/.test(pin.id)) return 'enable';
  if (el.kind === 'pipeline_register' && pin.lane) {
    const lane = el.lanes.find((l) => l.id === pin.lane);
    return lane?.role ?? (lane?.class === 'control' ? 'handshake' : 'value');
  }
  if (el.kind === 'port') return el.role ?? 'value';
  if (el.kind === 'comb' || el.kind === 'instance') return (el.ports || []).find((p) => p.id === pin.id)?.role ?? 'value';
  return 'value';
}

export function deriveNetClasses(model) {
  const out = new Map();
  for (const n of model.nets) {
    const roles = n.sinks.filter((s) => !s.error).map(sinkRole);
    let derived = 'data';
    if (roles.length && roles.every((r) => r === 'reset')) derived = 'reset';
    else if (roles.length && roles.every((r) => r === 'clock')) derived = 'clock';
    else if (roles.length && roles.every((r) => CONTROL_ROLES.has(r) || r === 'reset' || r === 'clock')) derived = 'control';
    const authored = n.net.class;
    const drawn = authored && authored !== derived && n.net.class_reason ? authored : derived;
    out.set(n.net.id, { derived, authored, drawn, roles });
  }
  return out;
}

export function checkNetClasses(doc, model = buildModel(doc)) {
  const diagnostics = [];
  for (const [id, c] of deriveNetClasses(model)) {
    if (!c.authored || c.authored === c.derived) continue;
    const sinks = model.nets.find((n) => n.net.id === id).sinks.map((s, i) => `${s.text} (${c.roles[i]})`).join(', ');
    if (c.net_reason || model.nets.find((n) => n.net.id === id).net.class_reason) {
      diagnostics.push(diagnostic({ code: 'net/class-style', severity: 'info', message: `net ${id}: drawn as ${c.authored} instead of the derived ${c.derived} (override with reason)`, subject: { id }, evidence: { sinks }, supportedFixes: [] }));
    } else {
      diagnostics.push(diagnostic({ code: 'net/class-style', severity: 'error', message: `net ${id}: class "${c.authored}" does not match its usage, which makes it ${c.derived} (sinks: ${sinks})`, subject: { id }, evidence: { authored: c.authored, derived: c.derived, sinks }, supportedFixes: ['remove the class (it is derived from the sinks)', 'give the sink port a role (select, enable, handshake) if it really is control', 'keep the class and add class_reason'] }));
    }
  }
  return { diagnostics };
}
