// Draft a starting micro-architecture figure (overview) from a normalized
// netlist (N7). The draft is a starting point the author refines; every
// microarch check still applies to it.
//
// What is drawn, for the scope instance:
//   - one block per child instance (rtl.instance);
//   - the scope's own registers, one block per name-prefix group (rtl.covers
//     globs such as c_*), so microarch coverage is complete;
//   - buses and streams detected by port prefix: s_axil_/m_axil_ → an
//     AXI4-Lite fabric, s_axi_/m_axi_ → an AXI4 fabric, s_axis_/m_axis_ → an
//     AXI4-Stream interface. A slave (s_) port set is driven from outside: its
//     manager is an off-chip Host block; a master (m_) AXI port set reaches an
//     off-chip memory (or peripherals, for AXI4-Lite). Address windows are not
//     in the netlist: subordinates are marked address_unknown;
//   - links between blocks where a child input depends, through the scope's
//     own logic, on another child's output or a register group;
//   - a chip group holding the blocks inside the scope.

import { flattenNetlist } from './rtl/flatten.mjs';

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1').slice(0, 60);
const humanName = (name) => String(name).replace(/__.*$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 60);

// Port prefix → bus or stream. Checked in order (axil/axis before axi).
export const BUS_PREFIXES = Object.freeze([
  { re: /^([sm])_axil_(?:([a-z0-9]+)_(?=(?:aw|w|b|ar|r)[a-z]))?/, protocol: 'AXI4-Lite' },
  { re: /^([sm])_axis_(?:([a-z0-9]+)_(?=t[a-z]))?/, protocol: 'AXI4-Stream' },
  { re: /^([sm])_axi_(?:([a-z0-9]+)_(?=(?:aw|w|b|ar|r)[a-z]))?/, protocol: 'AXI4' },
]);

export function busOfPort(name) {
  for (const b of BUS_PREFIXES) {
    const m = String(name).match(b.re);
    if (m) return { protocol: b.protocol, role: m[1] === 's' ? 'slave' : 'master', name: m[2] ?? '', prefix: m[0] };
  }
  return null;
}

const KIND_WORDS = [
  [/^(fifo|queue)$/, 'fifo'],
  [/^(ram|sram|bram|dpram|rom|memory)$/, 'memory'],
  [/^bridge$/, 'bridge'],
];
const kindOfModule = (moduleName) => {
  const tokens = String(moduleName).toLowerCase().split(/[^a-z0-9]+/);
  for (const [re, kind] of KIND_WORDS) if (tokens.some((t) => re.test(t))) return kind;
  return 'custom';
};

export function draftMicroarch(netlist, { scope = '', title } = {}) {
  const notes = [];
  const flat = flattenNetlist(netlist);
  const P = (rel) => [flat.top, ...(rel ? rel.split('/') : [])].join('.');
  const R = (p) => (p === flat.top ? '' : p.slice(flat.top.length + 1).replace(/\./g, '/'));
  const scopePath = P(scope);
  const mod = flat.instances.get(scopePath);
  if (!mod) throw new Error(`scope ${scope || '(top)'} is not an instance of ${flat.top}`);
  const used = new Set();
  const uid = (b) => { const s = sanitize(b); let id = s; for (let k = 2; used.has(id); k += 1) id = `${s.slice(0, 56)}_${k}`; used.add(id); return id; };

  const clocks = new Set(mod.registers.flatMap((r) => [r.clock?.net, r.reset?.net]).filter(Boolean));
  const blocks = [];
  const blockOf = new Map(); // child path or register name -> block id

  // Child instances.
  for (const i of mod.instances) {
    const child = `${scopePath}.${i.name}`;
    const m = flat.instances.get(child);
    const id = uid(i.name);
    blocks.push({ id, kind: kindOfModule(m?.orig_name ?? i.module), label: humanName(m?.orig_name ?? i.module), rtl: { instance: R(child) } });
    blockOf.set(child, id);
  }
  // The scope's own registers, grouped by the first word of their names.
  const registers = mod.registers.filter((r) => !r.name.startsWith('_V'));
  const regGroups = new Map();
  for (const r of registers) {
    const cut = r.name.indexOf('_');
    const key = cut > 0 ? r.name.slice(0, cut) : r.name;
    if (!regGroups.has(key)) regGroups.set(key, []);
    regGroups.get(key).push(r.name);
  }
  const hasLite = mod.ports.some((p) => busOfPort(p.name)?.protocol === 'AXI4-Lite' && busOfPort(p.name).role === 'slave');
  for (const [key, names] of regGroups) {
    const single = regGroups.size === 1;
    const label = single ? (hasLite ? 'Control registers' : 'State registers') : (key.length > 3 ? `${humanName(key)} registers` : `Registers ${key.toUpperCase()}`);
    const id = uid(`reg_${key}`);
    const covers = names.length > 1 || names[0] !== key ? [`${key}_*`, ...names.filter((n) => !n.startsWith(`${key}_`))] : [names[0]];
    blocks.push({ id, kind: hasLite && single ? 'peripheral' : 'custom', label, sublabel: `${names.length} register${names.length > 1 ? 's' : ''}`, rtl: { covers } });
    for (const n of names) blockOf.set(`${scopePath}.${n}`, id);
  }
  if (registers.length) notes.push(`${registers.length} scope registers in ${regGroups.size} block${regGroups.size > 1 ? 's' : ''} by name prefix (${[...regGroups.keys()].map((k) => `${k}_*`).join(', ')}); rename them`);

  // Which block a scope port reaches through the scope's own logic.
  const fwd = new Map();
  for (const [t, list] of flat.back) for (const { source } of list) { if (!fwd.has(source)) fwd.set(source, []); fwd.get(source).push(t); }
  const owner = (p) => {
    if (blockOf.has(p)) return blockOf.get(p);
    const sig = flat.signals.get(p);
    const inst = sig?.instance ?? p.slice(0, p.lastIndexOf('.'));
    for (const [child, id] of blockOf) if (inst === child || inst.startsWith(`${child}.`)) return id;
    return null;
  };
  const reach = (start, dirMap) => {
    const hits = new Map();
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length && seen.size < 20000) {
      const v = queue.shift();
      for (const next of (dirMap === 'fwd' ? fwd.get(v) : (flat.back.get(v) || []).map((e) => e.source)) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const o = owner(next);
        if (o) { hits.set(o, (hits.get(o) ?? 0) + 1); continue; }
        if (flat.signals.get(next)?.instance === scopePath || next.startsWith(`${scopePath}.`) && !next.slice(scopePath.length + 1).includes('.')) queue.push(next);
      }
    }
    return hits;
  };

  // Buses and streams by port prefix.
  const sets = new Map();
  const loose = [];
  for (const p of mod.ports) {
    if (clocks.has(p.name) || /^(clk|clock|rst|reset|aresetn|rst_n)/i.test(p.name)) continue;
    const bus = busOfPort(p.name);
    if (!bus) { loose.push(p.name); continue; }
    if (!sets.has(bus.prefix)) sets.set(bus.prefix, { ...bus, ports: [] });
    sets.get(bus.prefix).ports.push(p);
  }
  const offchip = new Map();
  const offchipBlock = (id, label, shortLabel) => {
    if (!offchip.has(id)) offchip.set(id, { id: uid(id), kind: 'offchip', label, ...(shortLabel ? { short_label: shortLabel } : {}) });
    return offchip.get(id).id;
  };
  const fabrics = [];
  const attachments = [];
  const interfaces = [];
  const portWidth = (set, re) => set.ports.find((q) => re.test(q.name.slice(set.prefix.length)))?.width;
  for (const set of sets.values()) {
    const hits = new Map();
    for (const q of set.ports) for (const [o, c] of reach(`${scopePath}.${q.name}`, q.dir === 'out' ? 'back' : 'fwd')) hits.set(o, (hits.get(o) ?? 0) + c);
    const inside = [...hits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const tag = set.name ? ` ${set.name}` : '';
    if (!inside) { notes.push(`${set.protocol} ports ${set.prefix}*: no block of the scope is reached from them; draw the connection by hand`); continue; }
    const end = scope ? { instance: scope, prefix: set.prefix } : { top: true, prefix: set.prefix };
    if (set.protocol === 'AXI4-Stream') {
      const host = offchipBlock('host', 'Host');
      const width = portWidth(set, /^tdata$/);
      const source = set.role === 'slave';
      interfaces.push({ id: uid(`s_${sanitize(set.prefix.replace(/_$/, ''))}`), protocol: 'AXI4-Stream', from: source ? host : inside, to: source ? inside : host, ...(width ? { data_width: width } : {}), label: `stream ${source ? 'input' : 'output'}${tag}`.slice(0, 40), rtl: source ? { to: end } : { from: end } });
      continue;
    }
    const lite = set.protocol === 'AXI4-Lite';
    const external = set.role === 'slave' ? offchipBlock('host', 'Host') : lite ? offchipBlock('ext_periph', 'External peripherals', 'Peripherals') : offchipBlock('ext_mem', 'External memory', 'Memory');
    const fid = uid(`f_${sanitize(set.prefix.replace(/_$/, ''))}`);
    const addr = portWidth(set, /^(aw|ar)addr$/);
    const data = portWidth(set, /^(w|r)data$/);
    fabrics.push({ id: fid, protocol: set.protocol, label: `${set.protocol} ${set.role === 'slave' ? (lite ? 'control' : 'slave') : (lite ? 'peripherals' : 'memory')}${tag}`.slice(0, 60), ...(addr ? { addr_width: addr } : {}), ...(data ? { data_width: data } : {}), topology: 'bus' });
    const [manager, subordinate] = set.role === 'slave' ? [external, inside] : [inside, external];
    attachments.push({ id: uid(`at_${manager}_${fid}`), fabric: fid, block: manager, role: 'manager' });
    attachments.push({ id: uid(`at_${subordinate}_${fid}`), fabric: fid, block: subordinate, role: 'subordinate', address_unknown: true });
    notes.push(`${set.prefix}*: ${set.protocol} ${set.role} ports; ${manager} manages ${subordinate} (address window unknown: add address {base, size} from the documentation)`);
  }
  if (loose.length) notes.push(`ports without a bus or stream prefix, not drawn: ${loose.slice(0, 12).join(', ')}${loose.length > 12 ? `, … (+${loose.length - 12})` : ''}`);

  // Links: a child input that depends on another block's output through the scope's logic.
  const links = [];
  const pairs = new Map();
  const connected = (a, b) => interfaces.some((i) => (i.from === a && i.to === b) || (i.from === b && i.to === a))
    || fabrics.some((f) => attachments.some((x) => x.fabric === f.id && x.block === a) && attachments.some((x) => x.fabric === f.id && x.block === b));
  const consider = (target, to) => {
    for (const from of reach(target, 'back').keys()) {
      if (from === to || connected(from, to)) continue;
      const key = `${from}>${to}`;
      if (!pairs.has(key)) pairs.set(key, { from, to });
    }
  };
  for (const i of mod.instances) {
    const child = `${scopePath}.${i.name}`;
    for (const c of i.connections.filter((x) => x.dir !== 'out')) {
      if (clocks.has(c.port) || (c.expr?.net && clocks.has(c.expr.net))) continue;
      consider(`${child}.${c.port}`, blockOf.get(child));
    }
  }
  for (const r of registers) {
    const p = `${scopePath}.${r.name}`;
    const to = blockOf.get(p);
    for (const { source } of flat.back.get(p) || []) {
      const o = owner(source);
      if (o && o !== to && !connected(o, to)) { if (!pairs.has(`${o}>${to}`)) pairs.set(`${o}>${to}`, { from: o, to }); continue; }
      if (flat.signals.get(source)?.instance === scopePath) consider(source, to);
    }
  }
  const regBlocks = new Set(blocks.filter((b) => b.rtl?.covers).map((b) => b.id));
  for (const { from, to } of pairs.values()) links.push({ id: uid(`l_${from}_${to}`), from, to, class: regBlocks.has(from) || regBlocks.has(to) ? 'control' : 'data' });

  const inner = blocks.map((b) => b.id);
  const all = [...[...offchip.values()].filter((b) => b.id === offchip.get('host')?.id), ...blocks, ...[...offchip.values()].filter((b) => b.id !== offchip.get('host')?.id)];
  const scopeWords = scope ? `instance ${scope}` : `the whole design (top ${mod.orig_name})`;
  const doc = {
    schema_version: 1,
    figure_type: 'microarch',
    meta: {
      title: title ?? `Overview of ${scope || mod.orig_name}`,
      caption: `Overview view of ${scopeWords}: one block per child instance, the scope registers grouped by name prefix, and buses and streams found by port prefix. Draft generated from the netlist: refine names, kinds and address windows.`,
      print: { profile: 'ieee', variants: ['2col', '1col'] },
    },
    view: { preset: 'overview', scope },
    blocks: all,
    ...(fabrics.length ? { fabrics } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(interfaces.length ? { interfaces } : {}),
    ...(links.length ? { links } : {}),
    ...(inner.length ? { groups: [{ id: uid('g_scope'), label: humanName(mod.orig_name), style: 'chip', members: inner }] } : {}),
  };
  notes.push(`microarch draft: ${all.length} blocks (${offchip.size} off-chip), ${fabrics.length} fabric${fabrics.length === 1 ? '' : 's'}, ${interfaces.length} stream interface${interfaces.length === 1 ? '' : 's'}, ${links.length} link${links.length === 1 ? '' : 's'}`);
  return { doc, notes };
}
