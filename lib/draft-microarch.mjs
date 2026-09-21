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
  [/^(xbar|crossbar|switch)$/, 'router'],
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
// A macro or generated SRAM wrapper has no body to inspect, so fall back to its
// port shape. The discriminator is not "has an address port" -- a Chisel
// controller has io_dma_req_bits_laddr_data and a TLB has io_ptw_0_resp_bits_pte_a,
// and a loose match calls both of them memories. What is distinctive is that an
// SRAM wrapper's ports are ALMOST ENTIRELY SRAM signals: Chipyard's mem_ext is
// exactly RW0_{addr,clk,wdata,rdata,en,wmode,wmask}.
const SRAM_PORT = /^(rw|r|w)?\d*_?(addr|clk|clock|din|dout|wdata|rdata|data|en|ce|cs|web?|we_?n|wmode|wmask|mask|oe|gwen|wen|ema\w*|ten|tcen)$/i;
const MEMORY_PORT_FRACTION = 0.6;
const looksLikeMemoryPorts = (mod) => {
  const names = (mod?.ports || []).map((p) => String(p.name));
  if (names.length < 3 || names.length > 24) return false;
  const hits = names.filter((n) => SRAM_PORT.test(n));
  if (hits.length / names.length < MEMORY_PORT_FRACTION) return false;
  const has = (re) => hits.some((n) => re.test(n));
  return has(/addr$/i) && has(/(data|din|dout|q)$/i);
};
// A systolic array is not a name, it is a shape: N identical children whose
// instance names carry a row and a column (Gemmini's Mesh holds mesh_0_0 ...
// mesh_15_15). The dimensions come straight from those names, so the label can
// state them instead of guessing.
export function systolicShape(childNames) {
  const byMod = new Map();
  for (const { name, module } of childNames) {
    if (!byMod.has(module)) byMod.set(module, []);
    byMod.get(module).push(name);
  }
  for (const [module, names] of byMod) {
    if (names.length < 4 || names.length !== childNames.length) continue;
    const rc = [];
    for (const n of names) {
      const g = /^.*?_(\d+)_(\d+)$/.exec(n);
      if (g) rc.push([Number(g[1]), Number(g[2])]);
    }
    if (rc.length !== names.length) continue;
    const rows = Math.max(...rc.map((x) => x[0])) + 1;
    const cols = Math.max(...rc.map((x) => x[1])) + 1;
    if (rows * cols !== names.length) continue;
    return { rows, cols, module };
  }
  return null;
}
// A banked scratchpad is N identical children that each hold a memory. Gemmini's
// Scratchpad has four ScratchpadBank instances (spad_mems_0..3), each wrapping a
// mem/mem_ext SRAM; none of that is visible from the Scratchpad module alone.
// A bank usually wraps its SRAM one or two levels down (ScratchpadBank -> mem ->
// mem_ext), so the bank module itself holds no array. Return the DEPTH found,
// not a boolean: counting alone picked Gemmini's eight Queue4_ScratchpadReadResp
// over its four real ScratchpadBanks. For a port-shape memory the depth comes
// from the address width, which is exact (mem_ext: RW0_addr[11:0] -> 4096).
export function subtreeMemoryDepth(name, netlist, seen = new Set(), depth = 0) {
  if (depth > 3 || !name || seen.has(name)) return 0;
  seen.add(name);
  const mod = netlist.modules.find((x) => x.name === name);
  if (!mod) return 0;
  let best = arrayDepth(mod);
  if (looksLikeMemoryPorts(mod)) {
    const a = (mod.ports || []).find((q) => /addr$/i.test(q.name));
    if (a?.width) best = Math.max(best, 2 ** a.width);
  }
  for (const i of mod.instances || []) best = Math.max(best, subtreeMemoryDepth(i.module, netlist, seen, depth + 1));
  return best;
}

export function bankShape(childNames, depthOf) {
  const counts = new Map();
  for (const { module } of childNames) counts.set(module, (counts.get(module) || 0) + 1);
  const MIN_BANK_DEPTH = 64;
  let best = null;
  for (const [module, n] of counts) {
    if (n < 2) continue;
    const d = depthOf(module);
    if (d < MIN_BANK_DEPTH) continue;
    if (!best || d > best.depth || (d === best.depth && n > best.banks)) best = { banks: n, module, depth: d };
  }
  return best;
}


const kindOfModule = (moduleName, mod) => {
  const tokens = String(moduleName).toLowerCase().split(/[^a-z0-9]+/);
  for (const [re, kind] of KIND_WORDS) if (tokens.some((t) => re.test(t))) return kind;
  if (arrayDepth(mod) >= MEMORY_MIN_DEPTH || looksLikeMemoryPorts(mod)) return 'memory';
  return 'custom';
};

export function draftMicroarch(netlist, { scope = '', title, keepControl = false, classColors = false } = {}) {
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
    // Shape beats name: look at this child's OWN children before falling back to
    // kindOfModule. Gemmini's Mesh is called "Mesh"; what makes it a systolic
    // array is that it holds mesh_0_0 .. mesh_15_15.
    const grandKids = [...flat.instances.keys()]
      .filter((q) => q.startsWith(`${child}.`) && !q.slice(child.length + 1).includes('.'))
      .map((q) => ({ name: q.slice(child.length + 1), module: flat.instances.get(q)?.name }));
    const grid = systolicShape(grandKids);
    const banked = grid ? null : bankShape(grandKids, (name) => subtreeMemoryDepth(name, netlist));
    // The dimension is not decoration: a systolic-array or banked-scratchpad
    // symbol that does not state rows x cols or the bank count claims a shape it
    // has not shown. Force the sublabel on for these two kinds even when the
    // figure is otherwise in short mode.
    const shaped = grid
      ? { kind: 'systolic_array', sublabel: `${grid.rows}x${grid.cols} PEs`, show_details: true }
      : banked ? { kind: 'scratchpad', sublabel: `${banked.banks} banks`, show_details: true } : null;
    blocks.push({ id, ...(shaped || { kind: kindOfModule(m?.orig_name ?? i.module, m) }), label: humanName(m?.orig_name ?? i.module), ...(shaped?.sublabel ? { sublabel: shaped.sublabel } : {}), rtl: { instance: R(child) } });
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
  // A pipelined core names its state after the stage that holds it: Rocket has
  // id_*, ex_*, mem_*, wb_*. Drawn as generic "Registers EX" among a dozen
  // one-register groups, the pipeline is invisible -- which is the whole
  // micro-architecture. Require at least three stage prefixes before believing
  // it, so an unrelated ex_ prefix elsewhere is not read as a pipeline.
  const STAGE_ORDER = ['if', 'ifetch', 'id', 'dec', 'decode', 'rr', 'ex', 'exe', 'execute', 'mem', 'ma', 'wb', 'com', 'ret'];
  const stageKeys = [...regGroups.keys()].filter((k) => STAGE_ORDER.includes(k.toLowerCase()));
  const pipelined = stageKeys.length >= 3;
  // One-register groups are name noise, not structure. Fold them into a single
  // block so the stages stand out instead of competing with eight singletons.
  const MIN_GROUP = 2;
  const small = pipelined ? [...regGroups.entries()].filter(([k, n]) => n.length < MIN_GROUP && !STAGE_ORDER.includes(k.toLowerCase())) : [];
  const smallNames = small.flatMap(([, n]) => n);
  for (const [key] of small) regGroups.delete(key);
  for (const [key, names] of regGroups) {
    const single = regGroups.size === 1 && !smallNames.length;
    const isStage = pipelined && STAGE_ORDER.includes(key.toLowerCase());
    const label = isStage
      ? `${key.toUpperCase()} stage`
      : single ? (hasLite ? 'Control registers' : 'State registers') : (key.length > 3 ? `${humanName(key)} registers` : `Registers ${key.toUpperCase()}`);
    const id = uid(`reg_${key}`);
    const covers = names.length > 1 || names[0] !== key ? [`${key}_*`, ...names.filter((n) => !n.startsWith(`${key}_`))] : [names[0]];
    blocks.push({ id, kind: isStage ? 'stage' : (hasLite && single ? 'peripheral' : 'register_file'), label, sublabel: `${names.length} register${names.length > 1 ? 's' : ''}`, ...(isStage ? { show_details: true } : {}), rtl: { covers } });
    for (const n of names) blockOf.set(`${scopePath}.${n}`, id);
  }
  if (smallNames.length) {
    const id = uid('reg_misc');
    blocks.push({ id, kind: 'register_file', label: 'Other core state', sublabel: `${smallNames.length} registers`, rtl: { covers: smallNames } });
    for (const n of smallNames) blockOf.set(`${scopePath}.${n}`, id);
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
  // Carry the transfer width so control and data can be told apart honestly.
  // Calling every link that touches a register block "control" is not a
  // classification, it is a proxy: on a Rocket core it dashed 42 of 55 links,
  // including EX -> IBuf, which is the redirect datapath.
  const consider = (target, to, width) => {
    for (const from of reach(target, 'back').keys()) {
      if (from === to || connected(from, to)) continue;
      const key = `${from}>${to}`;
      const prior = pairs.get(key);
      if (!prior) pairs.set(key, { from, to, width: width ?? null });
      else if (width != null) prior.width = Math.max(prior.width ?? 0, width);
    }
  };
  for (const i of mod.instances) {
    const child = `${scopePath}.${i.name}`;
    for (const c of i.connections.filter((x) => x.dir !== 'out')) {
      if (clocks.has(c.port) || (c.expr?.net && clocks.has(c.expr.net))) continue;
      if (isInfra(c.port) || isInfra(c.expr?.net)) { omittedInfra += 1; continue; }
      consider(`${child}.${c.port}`, blockOf.get(child), c.width);
    }
  }
  for (const r of registers) {
    const p = `${scopePath}.${r.name}`;
    const to = blockOf.get(p);
    for (const { source } of flat.back.get(p) || []) {
      const o = owner(source);
      if (o && o !== to && !connected(o, to)) { if (!pairs.has(`${o}>${to}`)) pairs.set(`${o}>${to}`, { from: o, to }); continue; }
      if (flat.signals.get(source)?.instance === scopePath) consider(source, to, flat.signals.get(source)?.width);
    }
  }
  // A 1-bit transfer is a control signal (enable, valid, stall); anything wider
  // carries data. Control lines fan out across the figure and, drawn, they bury
  // the dataflow -- so they are omitted by declaration, like the clock tree, and
  // counted in the notes.
  const seen = new Map();
  let omittedControl = 0;
  for (const { from, to, width } of pairs.values()) {
    if (becameFabric.has(from) || becameFabric.has(to)) continue;
    const isCtl = width != null && width <= 1;
    if (isCtl && !keepControl) { omittedControl += 1; continue; }
    const key = [from, to].sort().join('\u0000');
    const prior = seen.get(key);
    if (prior && prior.from === to && prior.to === from) { prior.bidir = true; continue; }
    if (prior) continue;
    const link = { id: uid(`l_${from}_${to}`), from, to, class: isCtl ? 'control' : 'data' };
    seen.set(key, link);
    links.push(link);
  }
  if (omittedControl) notes.push(`1-bit control connections omitted from the drawing: ${omittedControl}`);

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
      ...(classColors ? { style: { class_colors: true } } : {}),
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
