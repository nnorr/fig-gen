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
import { readableName } from './checks/labels.mjs';

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1').slice(0, 60);
const humanName = (name) => readableName(name).slice(0, 60);

// Port prefix → bus or stream. Checked in order (axil/axis before axi).
export const BUS_PREFIXES = Object.freeze([
  { re: /^([sm])_axil_(?:([a-z0-9]+)_(?=(?:aw|w|b|ar|r)[a-z]))?/, protocol: 'AXI4-Lite' },
  { re: /^([sm])_axis_(?:([a-z0-9]+)_(?=t[a-z]))?/, protocol: 'AXI4-Stream' },
  { re: /^([sm])_axi_(?:([a-z0-9]+)_(?=(?:aw|w|b|ar|r)[a-z]))?/, protocol: 'AXI4' },
]);

// AHB / APB are named by signal, not by an s_/m_ prefix. Direction suffixes
// (_i/_o/_in/_out) and a channel tag (haddr_icode_i, psel_uart0_o) are stripped
// so every port of one interface lands in the same set.
const AHB_SIGNALS = ['readyout', 'addr', 'trans', 'write', 'size', 'burst', 'prot', 'wdata', 'rdata', 'ready', 'resp', 'sel', 'mastlock', 'master', 'excl', 'nonsec', 'unalign'];
const APB_SIGNALS = ['addr', 'sel', 'enable', 'write', 'wdata', 'rdata', 'ready', 'slverr', 'strb', 'prot'];
export function ahbApbOfPort(name) {
  const s = String(name).toLowerCase().replace(/^_+/, '').replace(/_(i|o|in|out)$/, '');
  for (const [protocol, sigs, letter] of [['AHB', AHB_SIGNALS, 'h'], ['APB', APB_SIGNALS, 'p']]) {
    if (s[0] !== letter) continue;
    const rest = s.slice(1);
    for (const sig of sigs) {
      if (!rest.startsWith(sig)) continue;
      const tail = rest.slice(sig.length);
      if (tail && !/^[_0-9]/.test(tail)) continue;
      return { protocol, signal: sig, tag: tail.replace(/^_/, '') };
    }
  }
  return null;
}
// One entry per bus interface on a module: its protocol, channel tag, and role.
// Whoever drives `addr` is the manager.
export function busSetsOf(mod) {
  const sets = new Map();
  for (const p of mod?.ports || []) {
    const b = ahbApbOfPort(p.name);
    if (!b) continue;
    const key = `${b.protocol}:${b.tag}`;
    if (!sets.has(key)) sets.set(key, { protocol: b.protocol, tag: b.tag, sigs: new Map() });
    sets.get(key).sigs.set(b.signal, p.dir);
  }
  const out = [];
  for (const set of sets.values()) {
    const has = (k) => set.sigs.has(k);
    if (!has('addr')) continue;
    if (set.protocol === 'AHB' && !(has('trans') || has('sel'))) continue;
    if (set.protocol === 'APB' && !(has('sel') || has('enable'))) continue;
    out.push({ ...set, role: set.sigs.get('addr') === 'out' ? 'manager' : 'subordinate' });
  }
  return out;
}
// Per protocol: which block fans it out (the interconnect), and every block's
// role on it. The owner is the block with the most manager-side interfaces.
export function detectBusFabrics(childModule) {
  const byProto = new Map();
  for (const [bid, mod] of childModule) {
    for (const set of busSetsOf(mod)) {
      if (!byProto.has(set.protocol)) byProto.set(set.protocol, new Map());
      const m = byProto.get(set.protocol);
      const cur = m.get(bid) || { manager: 0, subordinate: 0 };
      cur[set.role] += 1;
      m.set(bid, cur);
    }
  }
  const result = [];
  for (const [proto, counts] of byProto) {
    let owner = null; let best = 1;
    for (const [bid, c] of counts) if (c.manager > best) { best = c.manager; owner = bid; }
    if (!owner) continue; // no fan-out: not a fabric, just a point-to-point link
    const sets = new Map();
    for (const [bid, c] of counts) sets.set(bid, c.manager > 0 && bid !== owner ? 'manager' : 'subordinate');
    result.push([proto, { owner, sets }]);
  }
  return result;
}

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
// A module holding an arrayed register IS a memory, whatever it is called.
// Matching on the name alone misses both ends of the range: an inferred RAM
// (LZ4's history window is `logic [7:0] mem [0:65535]` inside a module called
// history_buffer) and a vendor macro whose name carries no ram/sram token
// (cmos28lpp_ra1w_hd_8192x32m8). The netlist already records `array` on the
// register; nothing downstream was reading it.
const MEMORY_MIN_DEPTH = 16;
const arrayDepth = (mod) => {
  let best = 0;
  for (const r of mod?.registers || []) {
    for (const dim of r.array || []) {
      const g = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(String(dim));
      if (g) best = Math.max(best, Math.abs(Number(g[1]) - Number(g[2])) + 1);
    }
  }
  return best;
};
// A blackboxed macro has no body to inspect, so fall back to its port shape:
// an address port together with a data port is a memory in any vendor's naming.
const looksLikeMemoryPorts = (mod) => {
  if (!mod?.blackbox) return false;
  const names = (mod.ports || []).map((p) => String(p.name).toLowerCase());
  const has = (re) => names.some((n) => re.test(n));
  return has(/^(a|ad|adr|addr|address)[0-9_]*$/) && has(/^(d|di|do|din|dout|q|data)[0-9_]*$/);
};
const kindOfModule = (moduleName, mod) => {
  const tokens = String(moduleName).toLowerCase().split(/[^a-z0-9]+/);
  for (const [re, kind] of KIND_WORDS) if (tokens.some((t) => re.test(t))) return kind;
  if (arrayDepth(mod) >= MEMORY_MIN_DEPTH || looksLikeMemoryPorts(mod)) return 'memory';
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
  // `clocks` only covers the SCOPE module's own registers. At SoC level the
  // clocks and resets live in the children, so it is nearly empty there and the
  // clock/reset/interrupt trees get drawn as ordinary links. They fan out to
  // almost every block, so they dominate the routing channels and bury the
  // dataflow the figure exists to show. Omit them by name as well; the blocks
  // that generate them stay, and the omission is reported in the notes.
  // Anchoring at the start of the name missed every real case: sysresetreq_o,
  // wdog_reset_i, poresetn_o, WDOGRES. Match the token wherever it sits.
  const CLK_RE = /(^|_)(clk|clock|clken|clkg)([_0-9]|$)|^[a-z]?clk/i;
  const RESET_RE = /reset|(^|_)rst([_0-9n]|$)|res$/i;
  const IRQ_RE = /((^|_)(interrupt|intr|irq|nmi|int)([_0-9]|$))|((int|irq)$)/i;
  const INFRA_RE = CLK_RE;
  const isInfra = (n) => n != null && (CLK_RE.test(String(n)) || RESET_RE.test(String(n)) || IRQ_RE.test(String(n)));
  let omittedInfra = 0;
  const blocks = [];
  const blockOf = new Map(); // child path or register name -> block id
  const childModule = new Map(); // block id -> module record
  const childPath = new Map(); // block id -> instance path

  // Child instances.
  for (const i of mod.instances) {
    const child = `${scopePath}.${i.name}`;
    const m = flat.instances.get(child);
    const id = uid(i.name);
    blocks.push({ id, kind: kindOfModule(m?.orig_name ?? i.module, m), label: humanName(m?.orig_name ?? i.module), rtl: { instance: R(child) } });
    blockOf.set(child, id);
    childModule.set(id, m);
    childPath.set(id, child);
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
    blocks.push({ id, kind: hasLite && single ? 'peripheral' : 'register_file', label, sublabel: `${names.length} register${names.length > 1 ? 's' : ''}`, rtl: { covers } });
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
  const becameFabric = new Set(); // interconnect blocks replaced by a bus bar

  // ---- internal AHB / APB fabrics ---------------------------------------
  // AXI is found by an s_/m_ port prefix, which AHB and APB never carry: they
  // are named hsel/haddr/htrans and PSEL/PADDR/PENABLE, sometimes with a channel
  // tag (haddr_icode_i, psel_uart0_o). Without this an AHB SoC reports
  // "0 fabrics", every block falls into one row, and the renderer's bus-bar
  // layout -- managers above the bar, subordinates below -- is never used.
  for (const [proto, owners] of detectBusFabrics(childModule)) {
    const sets = owners.sets;
    // A pure interconnect carries ONE protocol and nothing else. A block with
    // sets of two protocols is a bridge (apb_subsystem is an AHB subordinate and
    // the APB manager), so it stays a block and attaches to both bars.
    const ownerSets = busSetsOf(childModule.get(owners.owner));
    const pure = owners.owner
      && ownerSets.every((x) => x.protocol === proto)
      && [...(childModule.get(owners.owner)?.ports || [])].every((q) => ahbApbOfPort(q.name) || /^(clk|clock|hclk|pclk|pclkg|rst_n|reset|hrst_n|presetn|hresetn)$/i.test(q.name));
    const fid = uid(`f_${proto.toLowerCase()}`);
    const ownerPath = childPath.get(owners.owner);
    fabrics.push({ id: fid, protocol: proto, label: `${proto} bus`, topology: 'bus', ...(pure && ownerPath ? { rtl: { instance: R(ownerPath) } } : {}) });
    // A pure interconnect IS the bar: drop its block, it is not also a box.
    if (pure) {
      const idx = blocks.findIndex((b) => b.id === owners.owner);
      if (idx >= 0) blocks.splice(idx, 1);
      becameFabric.add(owners.owner);
    }
    for (const [bid, roles] of sets) {
      if (pure && bid === owners.owner) continue;
      // The block that fans the protocol out is its manager; everyone whose
      // addr is an input is a subordinate.
      const role = bid === owners.owner ? 'manager' : roles;
      // Address windows are not in a netlist, same as the AXI path.
      attachments.push({ id: uid(`at_${bid}_${fid}`), block: bid, fabric: fid, role, ...(role === 'subordinate' ? { address_unknown: true } : {}) });
    }
  }
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
      if (isInfra(c.port) || isInfra(c.expr?.net)) { omittedInfra += 1; continue; }
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
  // A request/response pair between the same two blocks is one wire, not two.
  // Emitting both directions separately is what fills the routing channels: on
  // a Rocket tile it turned 23 real connections into 43 links, each taking its
  // own orthogonal detour. `bidir` is in the schema for exactly this.
  const seen = new Map();
  for (const { from, to } of pairs.values()) {
    // A block that became a bus bar is no longer a node: its transfers are the
    // fabric's attachments, so a point-to-point link to it would dangle.
    if (becameFabric.has(from) || becameFabric.has(to)) continue;
    const key = [from, to].sort().join('\u0000');
    const prior = seen.get(key);
    if (prior && prior.from === to && prior.to === from) { prior.bidir = true; continue; }
    if (prior) continue;
    const link = { id: uid(`l_${from}_${to}`), from, to, class: regBlocks.has(from) || regBlocks.has(to) ? 'control' : 'data' };
    seen.set(key, link);
    links.push(link);
  }

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
  if (omittedInfra) notes.push(`clock, reset and interrupt connections omitted from the drawing: ${omittedInfra} (they fan out to nearly every block; the generating blocks are still drawn)`);
  notes.push(`microarch draft: ${all.length} blocks (${offchip.size} off-chip), ${fabrics.length} fabric${fabrics.length === 1 ? '' : 's'}, ${interfaces.length} stream interface${interfaces.length === 1 ? '' : 's'}, ${links.length} link${links.length === 1 ? '' : 's'}`);
  return { doc, notes };
}
