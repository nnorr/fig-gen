// Authoring tools (SPEC §4.12): scriptable, validated edit operations on a
// datapath figure. Hand-refining a draft is a list of ops (a patch script) that
// is applied atomically to a copy of the figure, re-validated with every check
// delivery runs with a netlist (schema, semantics, labels, function evidence,
// view, RTL cross-check, coverage, latency, detail references) and logged with
// author notes. An op that cannot apply, or a result with an error the input did
// not have, rejects the whole patch: nothing is written. Errors the input
// already had are reported as remaining, so a draft can be refined step by step.

import { checkDetailRefs } from './checks/detail-refs.mjs';
import { draftResiduals } from './draft-check.mjs';
import { parseEndpoint } from './ir/endpoints.mjs';

class PatchError extends Error {}
const fail = (message) => { throw new PatchError(message); };

const el = (doc, id) => doc.elements.find((e) => e.id === id) ?? null;
const net = (doc, id) => doc.nets.find((n) => n.id === id) ?? null;
const need = (value, message) => (value ?? fail(message));
const ids = (doc) => new Set([...doc.elements.map((e) => e.id), ...doc.nets.map((n) => n.id)]);
const fresh = (doc, id) => { if (ids(doc).has(id)) fail(`id "${id}" already exists`); return id; };
const setLabel = (obj, key, value) => { if (value === undefined) return; if (value === null) delete obj[key]; else obj[key] = value; };
const endpointsOf = (n) => [n.driver, ...n.sinks];
const elementOf = (text) => parseEndpoint(text)?.element ?? String(text).split('.')[0];
const pinOf = (text) => parseEndpoint(text)?.port ?? null;

// Rename every endpoint equal to `from` (a pin "el.pin" or a bare element) to `to`.
function rewire(doc, from, to) {
  let count = 0;
  for (const n of doc.nets) {
    if (n.driver === from) { n.driver = to; count += 1; }
    n.sinks = n.sinks.map((s) => (s === from ? (count += 1, to) : s));
  }
  return count;
}

// JSON pointer (/a/b/0) get/set on the document; a segment "@id" names the array item with that id
// (/elements/@u_core/function).
function pointer(doc, path, value, { remove = false } = {}) {
  const parts = String(path).split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!parts.length) fail('set: empty path');
  const resolve = (o, p) => {
    if (!p.startsWith('@')) return p;
    if (!Array.isArray(o)) fail(`set: ${path}: "${p}" needs an array`);
    const i = o.findIndex((x) => x?.id === p.slice(1));
    if (i < 0) fail(`set: ${path}: no item with id ${p.slice(1)}`);
    return String(i);
  };
  let o = doc;
  for (const [k, raw] of parts.slice(0, -1).entries()) {
    const p = resolve(o, raw);
    if (o[p] === undefined) o[p] = /^\d+$/.test(parts[k + 1] ?? '') ? [] : {};
    o = o[p];
    if (o === null || typeof o !== 'object') fail(`set: ${path} runs through a value`);
  }
  const last = resolve(o, parts.at(-1));
  if (remove || value === null) { if (Array.isArray(o)) o.splice(Number(last), 1); else delete o[last]; } else o[last] = value;
}

// Nets that cross the boundary of a set of elements, and nets wholly inside it.
function boundary(doc, members) {
  const inside = (e) => members.has(elementOf(e));
  const internal = [];
  const crossing = [];
  for (const n of doc.nets) {
    const ends = endpointsOf(n);
    if (ends.every(inside)) internal.push(n);
    else if (ends.some(inside)) crossing.push(n);
  }
  return { internal, crossing };
}

const WIDTH = (doc, n) => (typeof n.width === 'number' ? n.width : 1);

export const OPS = {
  // Figure text and print settings.
  'set-meta': (doc, op) => {
    for (const key of ['title', 'caption']) setLabel(doc.meta, key, op[key]);
    if (op.print) doc.meta.print = { ...doc.meta.print, ...op.print };
    if (op.style) doc.meta.style = { ...(doc.meta.style || {}), ...op.style };
    return `meta ${Object.keys(op).filter((k) => !['op', 'note'].includes(k)).join(', ')}`;
  },
  set: (doc, op) => { need(op.path, 'set: path is required'); pointer(doc, op.path, op.value); return `${op.path} ${op.value === null ? 'removed' : 'set'}`; },

  // Names: an element, a net, a region, an element port ("el.port") or a bank lane ("el.lane").
  rename: (doc, op) => {
    need(op.id, 'rename: id is required');
    const apply = (obj) => { setLabel(obj, 'label', op.label); setLabel(obj, 'short_label', op.short_label); if (op.name !== undefined && obj.function) obj.function.name = op.name; };
    const target = op.target ?? null;
    const [owner, sub] = String(op.id).includes('.') ? String(op.id).split('.') : [op.id, null];
    if (sub && (!target || target === 'port' || target === 'lane')) {
      const e = need(el(doc, owner), `rename: no element ${owner}`);
      const item = (target !== 'lane' && (e.ports || []).find((p) => p.id === sub)) || (target !== 'port' && (e.lanes || []).find((l) => l.id === sub));
      apply(need(item, `rename: ${owner} has no port or lane ${sub}`));
      return `${op.id} renamed`;
    }
    const found = (target === 'net' ? null : el(doc, op.id)) ?? (target === 'element' ? null : net(doc, op.id)) ?? (doc.regions || []).find((r) => r.id === op.id);
    apply(need(found, `rename: no element, net or region ${op.id}`));
    return `${op.id} renamed`;
  },
  'label-placement': (doc, op) => {
    const n = need(net(doc, op.net), `label-placement: no net ${op.net}`);
    if (!['inline', 'leader', 'auto', null].includes(op.placement ?? null)) fail('label-placement: placement is inline, leader or auto');
    setLabel(n, 'label_placement', op.placement);
    if (op.leader_max_pt !== undefined) setLabel(n, 'leader_max_pt', op.leader_max_pt);
    return `${op.net} label ${op.placement}`;
  },

  // Declared abstraction (SPEC §4.11) and drill-down.
  'abstract-handshakes': (doc, op) => {
    if (op.enabled === false) { delete doc.view.abstract; return 'handshake abstraction removed'; }
    doc.view = { ...(doc.view || {}), abstract: { handshakes: true, reason: need(op.reason, 'abstract-handshakes: reason is required') } };
    return 'handshakes abstracted';
  },
  omit: (doc, op) => {
    const n = need(net(doc, op.net), `omit: no net ${op.net}`);
    if (op.reason === null) delete n.omit; else n.omit = { reason: need(op.reason, 'omit: reason is required') };
    return `${op.net} ${op.reason === null ? 'drawn' : 'omitted'}`;
  },
  'detail-ref': (doc, op) => {
    const e = need(el(doc, op.id), `detail-ref: no element ${op.id}`);
    if (op.figure === null) delete e.detail_ref; else e.detail_ref = { figure: need(op.figure, 'detail-ref: figure is required'), ...(op.element ? { id: op.element } : {}) };
    return `${op.id} → ${op.figure}`;
  },

  // Structure: elements and nets.
  'add-element': (doc, op) => { const e = need(op.element, 'add-element: element is required'); fresh(doc, e.id); const at = op.before ? doc.elements.findIndex((x) => x.id === op.before) : -1; if (at >= 0) doc.elements.splice(at, 0, e); else doc.elements.push(e); return `${e.id} added`; },
  'remove-element': (doc, op) => {
    need(el(doc, op.id), `remove-element: no element ${op.id}`);
    const touching = doc.nets.filter((n) => endpointsOf(n).some((x) => elementOf(x) === op.id));
    if (touching.length && !op.nets) fail(`remove-element: ${op.id} is still wired (${touching.map((n) => n.id).join(', ')}); pass nets: "remove" or rewire first`);
    if (op.nets === 'remove') doc.nets = doc.nets.filter((n) => !touching.includes(n));
    doc.elements = doc.elements.filter((e) => e.id !== op.id);
    for (const r of doc.regions || []) r.members = r.members.filter((m) => m !== op.id);
    return `${op.id} removed`;
  },
  'replace-element': (doc, op) => { const i = doc.elements.findIndex((e) => e.id === op.id); if (i < 0) fail(`replace-element: no element ${op.id}`); const e = need(op.element, 'replace-element: element is required'); if (e.id !== op.id) fresh(doc, e.id); doc.elements[i] = e; if (e.id !== op.id) for (const n of doc.nets) { if (elementOf(n.driver) === op.id) n.driver = n.driver.replace(op.id, e.id); n.sinks = n.sinks.map((s) => (elementOf(s) === op.id ? s.replace(op.id, e.id) : s)); } return `${op.id} replaced`; },
  'add-net': (doc, op) => { const n = need(op.net, 'add-net: net is required'); fresh(doc, n.id); doc.nets.push(n); return `${n.id} added`; },
  'remove-net': (doc, op) => { need(net(doc, op.id), `remove-net: no net ${op.id}`); doc.nets = doc.nets.filter((n) => n.id !== op.id); return `${op.id} removed`; },
  'set-nets': (doc, op) => { if (!Array.isArray(op.nets)) fail('set-nets: nets array is required'); doc.nets = op.nets; return `${op.nets.length} nets set`; },
  connect: (doc, op) => {
    const n = need(net(doc, op.net), `connect: no net ${op.net}`);
    if (op.driver) n.driver = op.driver;
    if (op.sinks) n.sinks = op.sinks;
    for (const s of op.add_sinks || []) if (!n.sinks.includes(s)) n.sinks.push(s);
    for (const s of op.remove_sinks || []) n.sinks = n.sinks.filter((x) => x !== s);
    return `${op.net} endpoints set`;
  },
  rewire: (doc, op) => { const k = rewire(doc, need(op.from, 'rewire: from is required'), need(op.to, 'rewire: to is required')); if (!k) fail(`rewire: no endpoint ${op.from}`); return `${op.from} → ${op.to} (${k})`; },

  // Order: element list slots, bank lanes, block ports.
  reorder: (doc, op) => {
    if (op.lanes) {
      const e = need(el(doc, op.id), `reorder: no element ${op.id}`);
      if (!Array.isArray(e.lanes) || op.lanes.length !== e.lanes.length || !op.lanes.every((l) => e.lanes.some((x) => x.id === l))) fail(`reorder: lanes of ${op.id} must list every lane once`);
      e.lanes = op.lanes.map((l) => e.lanes.find((x) => x.id === l));
      return `${op.id} lanes reordered`;
    }
    if (op.ports) {
      const e = need(el(doc, op.id), `reorder: no element ${op.id}`);
      if (!Array.isArray(e.ports) || op.ports.length !== e.ports.length || !op.ports.every((p) => e.ports.some((x) => x.id === p))) fail(`reorder: ports of ${op.id} must list every port once`);
      e.ports = op.ports.map((p) => e.ports.find((x) => x.id === p));
      return `${op.id} ports reordered`;
    }
    const list = need(op.elements, 'reorder: elements, lanes or ports is required');
    const slots = doc.elements.map((e, i) => (list.includes(e.id) ? i : -1)).filter((i) => i >= 0);
    if (slots.length !== list.length) fail(`reorder: unknown elements ${list.filter((id) => !el(doc, id)).join(', ')}`);
    const els = list.map((id) => el(doc, id));
    slots.forEach((slot, k) => { doc.elements[slot] = els[k]; });
    return `${list.length} elements reordered`;
  },

  // Register banks: split one bank into groups of lanes, or merge banks.
  'split-bank': (doc, op) => {
    const bank = need(el(doc, op.id), `split-bank: no element ${op.id}`);
    if (bank.kind !== 'register' || !Array.isArray(bank.lanes)) fail(`split-bank: ${op.id} is not a register bank`);
    const groups = need(op.groups, 'split-bank: groups are required');
    const all = groups.flatMap((g) => g.lanes);
    if (all.length !== bank.lanes.length || !bank.lanes.every((l) => all.includes(l.id))) fail(`split-bank: groups must cover every lane of ${op.id} once`);
    const covers = new Map(bank.lanes.map((l, i) => [l.id, bank.rtl?.covers?.[i]]));
    const enNets = doc.nets.filter((n) => n.sinks.includes(`${op.id}.en`));
    if (enNets.some((n) => WIDTH(doc, n) !== 1) && bank.enable) fail(`split-bank: ${op.id} has a ${WIDTH(doc, enNets[0])}-bit load; split banks share a 1-bit load (split the load at its source first)`);
    const made = groups.map((g) => {
      fresh(doc, g.id);
      const lanes = g.lanes.map((l) => structuredClone(bank.lanes.find((x) => x.id === l)));
      const c = g.lanes.map((l) => covers.get(l)).filter(Boolean);
      return { id: g.id, kind: 'register', domain: bank.domain, ...(g.label ? { label: g.label } : {}), ...(bank.enable ? { enable: true, enable_width: 1 } : {}), ...(bank.shared_d ? { shared_d: true } : {}), lanes, ...(c.length ? { rtl: { covers: c } } : {}) };
    });
    doc.elements.splice(doc.elements.indexOf(bank), 1, ...made);
    for (const g of groups) for (const l of g.lanes) { rewire(doc, `${op.id}.d_${l}`, `${g.id}.d_${l}`); rewire(doc, `${op.id}.q_${l}`, `${g.id}.q_${l}`); }
    for (const n of doc.nets) {
      if (n.sinks.includes(`${op.id}.en`)) n.sinks = [...n.sinks.filter((s) => s !== `${op.id}.en`), ...groups.map((g) => `${g.id}.en`)];
      if (n.sinks.includes(`${op.id}.d`)) n.sinks = [...n.sinks.filter((s) => s !== `${op.id}.d`), ...groups.map((g) => `${g.id}.d`)];
    }
    return `${op.id} split into ${groups.map((g) => g.id).join(', ')}`;
  },
  'merge-banks': (doc, op) => {
    const banks = need(op.ids, 'merge-banks: ids are required').map((id) => need(el(doc, id), `merge-banks: no element ${id}`));
    if (banks.some((b) => b.kind !== 'register' || !Array.isArray(b.lanes))) fail('merge-banks: every id must be a register bank');
    const id = op.id ?? banks[0].id;
    if (id !== banks[0].id) fresh(doc, id);
    const enNets = new Set(banks.flatMap((b) => doc.nets.filter((n) => n.sinks.includes(`${b.id}.en`)).map((n) => n.id)));
    if (enNets.size > 1) fail(`merge-banks: the banks load from different nets (${[...enNets].join(', ')})`);
    const merged = { id, kind: 'register', domain: banks[0].domain, ...(op.label ?? banks[0].label ? { label: op.label ?? banks[0].label } : {}), ...(banks[0].enable ? { enable: true, enable_width: 1 } : {}), ...(banks[0].shared_d ? { shared_d: true } : {}), lanes: banks.flatMap((b) => b.lanes) };
    const covers = banks.flatMap((b) => b.rtl?.covers || []);
    if (covers.length) merged.rtl = { covers };
    doc.elements.splice(doc.elements.indexOf(banks[0]), 1, merged);
    doc.elements = doc.elements.filter((e) => e === merged || !banks.includes(e));
    for (const b of banks) {
      for (const l of b.lanes) { rewire(doc, `${b.id}.d_${l.id}`, `${id}.d_${l.id}`); rewire(doc, `${b.id}.q_${l.id}`, `${id}.q_${l.id}`); }
    }
    for (const n of doc.nets) {
      const en = n.sinks.filter((s) => banks.some((b) => s === `${b.id}.en`));
      if (en.length) n.sinks = [...n.sinks.filter((s) => !en.includes(s)), `${id}.en`];
      const d = n.sinks.filter((s) => banks.some((b) => s === `${b.id}.d`));
      if (d.length) n.sinks = [...n.sinks.filter((s) => !d.includes(s)), `${id}.d`];
    }
    return `${banks.map((b) => b.id).join(', ')} merged into ${id}`;
  },

  // Insert a mux, register or bank on a net (cut before the chosen sinks).
  insert: (doc, op) => {
    const n = need(net(doc, op.net), `insert: no net ${op.net}`);
    const id = fresh(doc, need(op.id, 'insert: id is required'));
    const width = op.width ?? WIDTH(doc, n);
    const cut = op.sinks ?? n.sinks;
    if (!cut.every((s) => n.sinks.includes(s))) fail(`insert: ${op.net} does not reach ${cut.filter((s) => !n.sinks.includes(s)).join(', ')}`);
    const outId = fresh(doc, op.out_net ?? `${op.net}_${id}`);
    let element;
    let inPin;
    let outPin;
    if (op.kind === 'mux') {
      const inputs = op.inputs ?? [];
      element = { id, kind: 'mux', inputs: 1 + inputs.length, width, ...(op.encoding ? { encoding: op.encoding } : {}) };
      inPin = `${id}.in${op.index ?? 0}`;
      outPin = `${id}.out`;
      const sel = need(op.select, 'insert mux: select { from } is required');
      doc.nets.push({ id: fresh(doc, sel.id ?? `n_${id}_select`), width: sel.width ?? Math.max(1, Math.ceil(Math.log2(1 + inputs.length))), driver: sel.from, sinks: [`${id}.sel`], ...(sel.label ? { label: sel.label } : {}) });
      inputs.forEach((x, k) => {
        const other = need(net(doc, x.net ?? x), `insert mux: no net ${x.net ?? x}`);
        const index = k + ((op.index ?? 0) <= k ? 1 : 0);
        other.sinks.push(`${id}.in${index}`);
      });
    } else if (op.kind === 'register' || op.kind === 'bank') {
      element = op.kind === 'register'
        ? { id, kind: 'register', domain: need(op.domain ?? doc.clock_domains?.[0]?.id, 'insert register: domain is required'), width, ...(op.enable ? { enable: true } : {}), ...(op.rtl ? { rtl: op.rtl } : {}) }
        : { id, kind: 'register', domain: need(op.domain ?? doc.clock_domains?.[0]?.id, 'insert bank: domain is required'), ...(op.enable ? { enable: true, enable_width: 1 } : {}), lanes: need(op.lanes, 'insert bank: lanes are required'), shared_d: true };
      inPin = `${id}.d`;
      outPin = op.kind === 'register' ? `${id}.q` : `${id}.q_${op.lanes[0].id}`;
      if (op.enable) doc.nets.push({ id: fresh(doc, op.enable.id ?? `n_${id}_load`), width: 1, driver: need(op.enable.from, 'insert: enable.from is required'), sinks: [`${id}.en`], ...(op.enable.label ? { label: op.enable.label } : {}) });
    } else fail('insert: kind is mux, register or bank');
    if (op.label) element.label = op.label;
    doc.elements.push(element);
    n.sinks = [...n.sinks.filter((s) => !cut.includes(s)), inPin];
    doc.nets.push({ id: outId, width, driver: outPin, sinks: cut, ...(op.out_label ? { label: op.out_label } : {}) });
    return `${op.kind} ${id} on ${op.net}`;
  },

  // Collapse elements into one named block; expand restores them (from the collapse record).
  collapse: (doc, op, ctx) => {
    const members = new Set(need(op.ids, 'collapse: ids are required'));
    for (const m of members) need(el(doc, m), `collapse: no element ${m}`);
    const id = fresh(doc, need(op.id, 'collapse: id is required'));
    const { internal, crossing } = boundary(doc, members);
    const record = { elements: doc.elements.filter((e) => members.has(e.id)).map((e) => structuredClone(e)), nets: [...internal, ...crossing].map((n) => structuredClone(n)) };
    const ports = [];
    const pinFor = new Map();
    for (const n of crossing) {
      for (const end of endpointsOf(n)) {
        if (!members.has(elementOf(end)) || pinFor.has(end)) continue;
        const dir = end === n.driver ? 'out' : 'in';
        const pid = `${dir === 'out' ? 'o' : 'i'}_${(pinOf(end) ?? elementOf(end)).replace(/[^A-Za-z0-9_]/g, '_')}`;
        let unique = pid;
        for (let k = 2; ports.some((p) => p.id === unique); k += 1) unique = `${pid}_${k}`;
        ports.push({ id: unique, dir, width: WIDTH(doc, n) });
        pinFor.set(end, `${id}.${unique}`);
      }
    }
    const covers = [...new Set([
      ...record.elements.flatMap((e) => [e.rtl?.signal, ...(e.rtl?.covers || []), ...(e.lanes || []).map((l) => l.rtl?.signal)]),
      ...internal.flatMap((n) => [n.rtl?.signal]),
    ].filter(Boolean))];
    const block = { id, kind: 'comb', op: 'custom', width: Math.max(1, ...ports.map((p) => p.width)), ...(op.label ? { label: op.label } : {}), function: op.function ?? { kind: 'custom', name: op.label ?? id }, ports, ...(covers.length ? { rtl: { covers } } : {}), ...(record.elements.some((e) => e.kind === 'register' || e.holds_state) ? { holds_state: true } : {}) };
    const at = doc.elements.findIndex((e) => members.has(e.id));
    doc.elements = doc.elements.filter((e) => !members.has(e.id));
    doc.elements.splice(at, 0, block);
    doc.nets = doc.nets.filter((n) => !internal.includes(n));
    for (const n of crossing) {
      if (pinFor.has(n.driver)) n.driver = pinFor.get(n.driver);
      n.sinks = [...new Set(n.sinks.map((s) => pinFor.get(s) ?? s))];
    }
    ctx.records.push({ op: 'collapse', id, record });
    return `${[...members].join(', ')} collapsed into ${id} (${ports.length} ports, ${internal.length} internal nets)`;
  },
  expand: (doc, op, ctx) => {
    const block = need(el(doc, op.id), `expand: no element ${op.id}`);
    const rec = [...ctx.history].reverse().find((r) => r.op === 'collapse' && r.id === op.id)?.record;
    if (!rec) fail(`expand: no collapse record for ${op.id} in the edits log`);
    const at = doc.elements.indexOf(block);
    doc.elements.splice(at, 1, ...rec.elements.map((e) => structuredClone(e)));
    doc.nets = doc.nets.filter((n) => !endpointsOf(n).some((x) => elementOf(x) === op.id));
    for (const n of rec.nets) if (!net(doc, n.id)) doc.nets.push(structuredClone(n));
    return `${op.id} expanded into ${rec.elements.map((e) => e.id).join(', ')}`;
  },

  // Bundle parallel nets between two elements into one named net (members kept); unbundle restores them.
  bundle: (doc, op, ctx) => {
    const members = need(op.nets, 'bundle: nets are required').map((id) => need(net(doc, id), `bundle: no net ${id}`));
    if (members.length < 2) fail('bundle: at least two nets');
    const drivers = new Set(members.map((n) => elementOf(n.driver)));
    const sinkSets = new Set(members.map((n) => n.sinks.map(elementOf).sort().join(',')));
    if (drivers.size !== 1 || sinkSets.size !== 1) fail('bundle: the nets must share one driver element and the same sink elements');
    const id = fresh(doc, need(op.id, 'bundle: id is required'));
    const record = { nets: members.map((n) => structuredClone(n)), ports: [] };
    const signals = members.map((n) => n.rtl?.signal ?? n.id);
    const width = members.reduce((a, n) => a + WIDTH(doc, n), 0);
    const bundlePin = (endpoints, dir) => {
      const owner = el(doc, elementOf(endpoints[0]));
      if (!owner?.ports) return endpoints[0].includes('.') ? null : endpoints[0];
      const pins = endpoints.map(pinOf);
      record.ports.push({ element: owner.id, ports: owner.ports.filter((p) => pins.includes(p.id)).map((p) => structuredClone(p)) });
      const pid = op.port ?? id.replace(/^n_/, '');
      owner.ports = [...owner.ports.filter((p) => !pins.includes(p.id)), { id: pid, dir, width, bundle: pins }];
      return `${owner.id}.${pid}`;
    };
    const driver = bundlePin(members.map((n) => n.driver), 'out') ?? members[0].driver;
    const sinkElems = members[0].sinks.map(elementOf);
    const sinks = sinkElems.map((s) => bundlePin(members.map((n) => n.sinks.find((x) => elementOf(x) === s)), 'in') ?? s);
    doc.nets = doc.nets.filter((n) => !members.includes(n));
    doc.nets.push({ id, width, driver, sinks, ...(op.label ? { label: op.label } : {}), bundle_of: signals });
    ctx.records.push({ op: 'bundle', id, record });
    return `${members.map((n) => n.id).join(', ')} bundled as ${id}`;
  },
  unbundle: (doc, op, ctx) => {
    const b = need(net(doc, op.id), `unbundle: no net ${op.id}`);
    const rec = [...ctx.history].reverse().find((r) => r.op === 'bundle' && r.id === op.id)?.record;
    if (!rec) fail(`unbundle: no bundle record for ${op.id} in the edits log`);
    for (const p of rec.ports) {
      const owner = need(el(doc, p.element), `unbundle: no element ${p.element}`);
      const names = new Set(p.ports.map((x) => x.id));
      owner.ports = [...owner.ports.filter((x) => !(Array.isArray(x.bundle) && x.bundle.every((m) => names.has(m)))), ...p.ports];
    }
    doc.nets = doc.nets.filter((n) => n !== b);
    for (const n of rec.nets) doc.nets.push(structuredClone(n));
    return `${op.id} unbundled`;
  },

  // Staged functions: one block split into stages k/n, or stages merged back.
  'split-stage': (doc, op) => {
    const block = need(el(doc, op.id), `split-stage: no element ${op.id}`);
    if (!Array.isArray(block.ports)) fail(`split-stage: ${op.id} has no ports to divide`);
    const stages = need(op.stages, 'split-stage: stages are required');
    const listed = stages.flatMap((s) => s.ports);
    if (listed.length !== block.ports.length || !block.ports.every((p) => listed.includes(p.id))) fail(`split-stage: stages must take every port of ${op.id} once`);
    const name = block.function?.name ?? block.label ?? block.id;
    const made = stages.map((s, k) => {
      fresh(doc, s.id);
      const ports = [...block.ports.filter((p) => s.ports.includes(p.id)), ...(op.links || []).flatMap((l) => [l.from === s.id ? { id: l.out ?? `o_${l.id}`, dir: 'out', width: l.width } : null, l.to === s.id ? { id: l.in ?? `i_${l.id}`, dir: 'in', width: l.width } : null]).filter(Boolean)];
      return { ...structuredClone(block), id: s.id, ports, function: { ...(block.function || { kind: 'custom' }), name, stage: `${k + 1}/${stages.length}` }, width: Math.max(1, ...ports.map((p) => p.width ?? 1)) };
    });
    doc.elements.splice(doc.elements.indexOf(block), 1, ...made);
    for (const s of stages) for (const p of s.ports) rewire(doc, `${op.id}.${p}`, `${s.id}.${p}`);
    for (const l of op.links || []) doc.nets.push({ id: fresh(doc, l.id), width: l.width, driver: `${l.from}.${l.out ?? `o_${l.id}`}`, sinks: [`${l.to}.${l.in ?? `i_${l.id}`}`], ...(l.label ? { label: l.label } : {}), ...(l.rtl ? { rtl: l.rtl } : {}) });
    return `${op.id} split into ${stages.length} stages`;
  },
  'merge-stages': (doc, op) => {
    const parts = need(op.ids, 'merge-stages: ids are required').map((id) => need(el(doc, id), `merge-stages: no element ${id}`));
    const id = op.id ?? parts[0].id;
    if (id !== parts[0].id) fresh(doc, id);
    const members = new Set(parts.map((p) => p.id));
    const { internal } = boundary(doc, members);
    const linkPins = new Set(internal.flatMap((n) => endpointsOf(n)));
    const ports = parts.flatMap((p) => (p.ports || []).filter((q) => !linkPins.has(`${p.id}.${q.id}`)));
    const fn = { ...(parts[0].function || { kind: 'custom' }) };
    delete fn.stage;
    const merged = { ...structuredClone(parts[0]), id, ports, function: fn, width: Math.max(1, ...ports.map((p) => p.width ?? 1)) };
    doc.elements.splice(doc.elements.indexOf(parts[0]), 1, merged);
    doc.elements = doc.elements.filter((e) => e === merged || !members.has(e.id));
    doc.nets = doc.nets.filter((n) => !internal.includes(n));
    for (const p of parts) for (const q of p.ports || []) rewire(doc, `${p.id}.${q.id}`, `${id}.${q.id}`);
    return `${parts.map((p) => p.id).join(', ')} merged into ${id}`;
  },

  // Regions.
  'move-to-region': (doc, op) => {
    const list = need(op.ids, 'move-to-region: ids are required');
    for (const id of list) need(el(doc, id), `move-to-region: no element ${id}`);
    doc.regions = doc.regions || [];
    for (const r of doc.regions) r.members = r.members.filter((m) => !list.includes(m));
    let region = doc.regions.find((r) => r.id === op.region);
    if (!region) {
      if (!op.level) fail(`move-to-region: region ${op.region} does not exist; give level (and label) to create it`);
      region = { id: op.region, level: op.level, members: [], ...(op.label ? { label: op.label } : {}), ...(op.parent ? { parent: op.parent } : {}) };
      doc.regions.push(region);
    }
    region.members.push(...list);
    doc.regions = doc.regions.filter((r) => r.members.length);
    return `${list.join(', ')} → region ${op.region}`;
  },
};

export const PATCH_OP_NAMES = Object.freeze(Object.keys(OPS));

// The checks delivery runs; keys identify an error independent of its order.
async function errorsOf(doc, { netlist, figureDir, quality }) {
  const residual = await draftResiduals(structuredClone(doc), netlist, { quality, figureDir });
  const refs = checkDetailRefs(doc, { figureDir }).diagnostics.filter((d) => d.severity === 'error').map((d) => ({ source: 'detail-refs', code: d.code, message: d.message }));
  return [...residual, ...refs];
}
const keyOf = (d) => `${d.code}|${d.message}`;

// Apply ops to a copy of doc. history: earlier edits-log records (collapse and bundle records for expand/unbundle).
export async function applyPatch(doc, ops, { netlist = null, figureDir = process.cwd(), quality = 'paper', history = [], validate = true } = {}) {
  const work = structuredClone(doc);
  const ctx = { records: [], history: [...history] };
  const applied = [];
  const list = Array.isArray(ops) ? ops : ops?.ops ?? [];
  for (const [index, op] of list.entries()) {
    const fn = OPS[op?.op];
    if (!fn) return { ok: false, doc, applied, diagnostics: [{ severity: 'error', code: 'patch/unknown-op', message: `op ${index}: unknown op "${op?.op}" (known: ${PATCH_OP_NAMES.join(', ')})`, subject: { index } }] };
    try {
      const summary = fn(work, op, ctx);
      ctx.history.push(...ctx.records.splice(0));
      applied.push({ index, op: op.op, summary, ...(op.note ? { note: op.note } : {}) });
    } catch (error) {
      if (!(error instanceof PatchError)) throw error;
      return { ok: false, doc, applied, diagnostics: [{ severity: 'error', code: 'patch/invalid-op', message: `op ${index} (${op.op}): ${error.message}`, subject: { index, op: op.op } }] };
    }
  }
  const records = ctx.history.slice(history.length);
  if (!validate) return { ok: true, doc: work, applied, records, diagnostics: [], remaining: [] };
  const before = await errorsOf(doc, { netlist, figureDir, quality });
  const after = await errorsOf(work, { netlist, figureDir, quality });
  const known = new Set(before.map(keyOf));
  const introduced = after.filter((d) => !known.has(keyOf(d)));
  const fixed = before.filter((d) => !after.some((a) => keyOf(a) === keyOf(d)));
  if (introduced.length) {
    return { ok: false, doc, applied, records, remaining: after, fixed, diagnostics: introduced.map((d) => ({ severity: 'error', code: 'patch/validation', message: `${d.source}: ${d.code}: ${d.message}`, subject: { check: d.source, code: d.code } })) };
  }
  return { ok: true, doc: work, applied, records, remaining: after, fixed, diagnostics: after.map((d) => ({ severity: 'warning', code: 'patch/remaining', message: `${d.source}: ${d.code}: ${d.message}`, subject: { check: d.source, code: d.code } })) };
}

// Differences between two figures (for reproducing a hand-built figure from its draft).
export function figureDiff(a, b, path = '') {
  const out = [];
  const isObj = (x) => x && typeof x === 'object';
  if (Array.isArray(a) && Array.isArray(b)) {
    const byId = (list) => (list.every((x) => isObj(x) && typeof x.id === 'string') ? new Map(list.map((x) => [x.id, x])) : null);
    const ma = byId(a);
    const mb = byId(b);
    if (ma && mb) {
      const orderA = a.map((x) => x.id).join(',');
      const orderB = b.map((x) => x.id).join(',');
      if (orderA !== orderB && ma.size === mb.size && [...ma.keys()].every((k) => mb.has(k))) out.push({ path, kind: 'order', a: orderA, b: orderB });
      for (const [k, v] of ma) { if (!mb.has(k)) out.push({ path: `${path}[${k}]`, kind: 'only-in-a' }); else out.push(...figureDiff(v, mb.get(k), `${path}[${k}]`)); }
      for (const k of mb.keys()) if (!ma.has(k)) out.push({ path: `${path}[${k}]`, kind: 'only-in-b' });
      return out;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, kind: 'value', a, b });
    return out;
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b)) out.push({ path: `${path}.${k}`, kind: 'only-in-a', a: a[k] });
      else if (!(k in a)) out.push({ path: `${path}.${k}`, kind: 'only-in-b', b: b[k] });
      else out.push(...figureDiff(a[k], b[k], `${path}.${k}`));
    }
    return out;
  }
  if (a !== b) out.push({ path, kind: 'value', a, b });
  return out;
}
