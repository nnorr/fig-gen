// Bus-functional-model helper (SPEC §6.5, stimulus): a SystemVerilog testbench
// wrapper generated from a port map and a scenario script. It instantiates the
// user's DUT, drives clock and reset, implements the protocol tasks and runs
// the steps, dumping a VCD. The generated file is stimulus only: it is never
// evidence of DUT behaviour beyond the given scenario.
//
// Port map (JSON):
// { "top": "dut_module", "instance": "dut",
//   "clock": { "port": "clk", "period_ps": 10000 },
//   "reset": { "port": "rst_n", "active": "low", "cycles": 4 },
//   "tie": { "port": "value", ... },                  // constant inputs
//   "params": { "NAME": "value" },
//   "interfaces": [
//     { "name": "bus", "protocol": "ahb-lite", "signals": { "hsel": "hsel_i", "htrans": "htrans_i", "hwrite": "hwrite_i",
//       "haddr": "haddr_i", "hwdata": "hwdata_i", "hrdata": "hrdata_o", "hready": "hready_i", "hreadyout": "hreadyout_o", "hresp": "hresp_o", "hsize": null } },
//     { "name": "cfg", "protocol": "apb", "signals": { "psel", "penable", "pwrite", "paddr", "pwdata", "prdata", "pready"? } },
//     { "name": "ctl", "protocol": "axi4-lite", "signals": { "awvalid", "awready", "awaddr", "wvalid", "wready", "wdata", "wstrb"?, "bvalid", "bready", "bresp"?, "arvalid", "arready", "araddr", "rvalid", "rready", "rdata" } },
//     { "name": "req", "protocol": "valid-ready", "direction": "source"|"sink", "signals": { "valid", "ready", "data": { "field": "port", ... } } }
//   ] }
//
// Scenario (JSON): { "name", "max_cycles", "steps": [
//   { "op": "reset" }, { "op": "wait_cycles", "n": 3 },
//   { "op": "write", "if": "bus", "addr": "0x10", "data": "0x24" },
//   { "op": "read", "if": "bus", "addr": "0x14", "expect": "0x1", "mask": "0x1" },
//   { "op": "poll", "if": "bus", "addr": "0x8", "mask": "0x2", "until": "0x2", "max": 200 },
//   { "op": "wait_until", "signal": "irq_o", "value": "1", "max": 100 },
//   { "op": "send", "if": "req", "fields": { "op": "1", "a": "0x..." } },
//   { "op": "expect_response", "if": "rsp", "fields": { "status": "0" }, "max": 1000 },
//   { "op": "set", "port": "start_i", "value": "1" }, { "op": "mark", "label": "done" } ] }

import fs from 'node:fs';
import path from 'node:path';

const PROTOCOLS = ['ahb-lite', 'apb', 'axi4-lite', 'valid-ready'];
const REQUIRED = {
  'ahb-lite': ['hsel', 'htrans', 'hwrite', 'haddr', 'hwdata', 'hrdata'],
  apb: ['psel', 'penable', 'pwrite', 'paddr', 'pwdata', 'prdata'],
  'axi4-lite': ['awvalid', 'awready', 'awaddr', 'wvalid', 'wready', 'wdata', 'bvalid', 'bready', 'arvalid', 'arready', 'araddr', 'rvalid', 'rready', 'rdata'],
  'valid-ready': ['valid', 'ready'],
};

const id = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');
// An SV literal from a JSON value: "0x1F" -> 'h1F, "12" -> 12, "4'b0101" kept.
export function svLiteral(v) {
  const s = String(v).trim().replace(/_/g, '');
  if (/^\d*'[sS]?[bdhoBDHO][0-9a-fA-FxXzZ]+$/.test(s)) return s;
  if (/^0x[0-9a-f]+$/i.test(s)) return `'h${s.slice(2)}`;
  if (/^0b[01]+$/i.test(s)) return `'b${s.slice(2)}`;
  if (/^\d+$/.test(s)) return s;
  throw new Error(`bfm: "${v}" is not a number literal`);
}

export function validatePortMap(portmap, scenario) {
  const errors = [];
  if (!portmap?.top) errors.push('port map needs "top"');
  if (!portmap?.clock?.port) errors.push('port map needs "clock.port"');
  for (const itf of portmap?.interfaces || []) {
    if (!PROTOCOLS.includes(itf.protocol)) errors.push(`interface ${itf.name}: protocol must be one of ${PROTOCOLS.join(', ')}`);
    for (const s of REQUIRED[itf.protocol] || []) if (!itf.signals?.[s]) errors.push(`interface ${itf.name}: signal "${s}" is not mapped`);
    if (itf.protocol === 'valid-ready' && !['source', 'sink'].includes(itf.direction)) errors.push(`interface ${itf.name}: direction must be source (tb drives valid) or sink (tb drives ready)`);
  }
  const names = new Set((portmap?.interfaces || []).map((i) => i.name));
  for (const [i, st] of (scenario?.steps || []).entries()) {
    if (st.if && !names.has(st.if)) errors.push(`step ${i + 1} (${st.op}): no interface named ${st.if}`);
  }
  return errors;
}

// Width of a DUT port from a netlist (optional) for declaring tb signals.
function portWidths(netlist, top) {
  const mod = netlist?.modules?.find((m) => m.orig_name === top || m.name === top);
  return new Map((mod?.ports || []).map((p) => [p.name, { width: p.width, dir: p.dir }]));
}

// Standard widths of protocol control signals, used when no netlist gives the
// port width: clock, reset, valid/ready/select/enable/write are 1 bit and the
// AHB transfer type and AXI responses 2 bits; only addresses and data default wide.
const ROLE_WIDTH = {
  hsel: 1, hwrite: 1, hready: 1, hreadyout: 1, hresp: 1, htrans: 2,
  psel: 1, penable: 1, pwrite: 1, pready: 1, pslverr: 1,
  awvalid: 1, awready: 1, wvalid: 1, wready: 1, bvalid: 1, bready: 1, bresp: 2, arvalid: 1, arready: 1, rvalid: 1, rready: 1, rresp: 2,
  valid: 1, ready: 1,
};

export function generateBfm(portmap, scenario, { netlist, vcd = 'wave.vcd', dumpScope, dumpDepth = 0 } = {}) {
  const errors = validatePortMap(portmap, scenario);
  if (errors.length) throw new Error(`bfm: ${errors.join('; ')}`);
  const widths = portWidths(netlist, portmap.top);
  const inst = id(portmap.instance || 'dut');
  const tb = id(scenario.tb_name || `tb_${portmap.top}`);
  const clk = portmap.clock.port;
  const half = Math.max(1, Math.round((portmap.clock.period_ps ?? 10000) / 2));
  const rst = portmap.reset;
  // Every port the tb touches is a logic of the netlist width (or a wide default the connection truncates).
  const ports = new Map();
  const use = (port, dir, role) => { if (port && !ports.has(port)) ports.set(port, { dir, width: widths.get(port)?.width ?? ROLE_WIDTH[role] }); };
  use(clk, 'in', 'valid');
  if (rst) use(rst.port, 'in', 'valid');
  for (const p of Object.keys(portmap.tie || {})) use(p, 'in');
  const tbDriven = new Set([clk, rst?.port, ...Object.keys(portmap.tie || {})].filter(Boolean));
  for (const itf of portmap.interfaces || []) {
    const s = itf.signals;
    const out = (k) => { if (s[k]) { use(s[k], 'in', k); tbDriven.add(s[k]); } };
    const inp = (k) => { if (s[k]) use(s[k], 'out', k); };
    if (itf.protocol === 'ahb-lite') { ['hsel', 'htrans', 'hwrite', 'haddr', 'hwdata', 'hready', 'hsize', 'hburst', 'hprot'].forEach(out); ['hrdata', 'hreadyout', 'hresp'].forEach(inp); }
    if (itf.protocol === 'apb') { ['psel', 'penable', 'pwrite', 'paddr', 'pwdata', 'pstrb', 'pprot'].forEach(out); ['prdata', 'pready', 'pslverr'].forEach(inp); }
    if (itf.protocol === 'axi4-lite') { ['awvalid', 'awaddr', 'awprot', 'wvalid', 'wdata', 'wstrb', 'bready', 'arvalid', 'araddr', 'arprot', 'rready'].forEach(out); ['awready', 'wready', 'bvalid', 'bresp', 'arready', 'rvalid', 'rdata', 'rresp'].forEach(inp); }
    if (itf.protocol === 'valid-ready') {
      const fields = Object.values(s.data || {});
      if (itf.direction === 'source') { out('valid'); inp('ready'); fields.forEach((p) => { use(p, 'in'); tbDriven.add(p); }); } else { inp('valid'); out('ready'); fields.forEach((p) => use(p, 'out')); }
    }
  }
  for (const st of scenario.steps || []) {
    if (st.op === 'set') { use(st.port, 'in'); tbDriven.add(st.port); }
    if (st.op === 'wait_until' && !ports.has(st.signal)) use(st.signal, 'out');
  }
  const decl = [...ports].map(([p, { width }]) => `  logic ${width && width > 1 ? `[${width - 1}:0] ` : width === 1 ? '' : '[63:0] '}${id(p)};`);
  const initDriven = [...tbDriven].filter((p) => p !== clk).map((p) => `    ${id(p)} = '0;`);
  const L = [];
  const w = (s = '') => L.push(s);
  w('// Generated by fig-gen bfm: stimulus only. It drives the user\'s DUT through the');
  w('// mapped ports for one scenario; it is never evidence of DUT behaviour beyond it.');
  w('`timescale 1ps/1ps');
  w(`module ${tb};`);
  L.push(...decl);
  w('  int unsigned cycle = 0;');
  w('  int unsigned errors = 0;');
  w(`  initial ${id(clk)} = 1'b0;`);
  w(`  always #${half} ${id(clk)} = ~${id(clk)};`);
  w(`  always @(posedge ${id(clk)}) cycle <= cycle + 1;`);
  const paramList = Object.entries(portmap.params || {}).map(([k, v]) => `.${k}(${v})`).join(', ');
  w(`  ${portmap.top}${paramList ? ` #(${paramList})` : ''} ${inst} (`);
  w([...ports.keys()].map((p) => `    .${p}(${id(p)})`).join(',\n'));
  w('  );');
  const at = `@(posedge ${id(clk)})`;
  // Signals change 1 ps after the edge so the DUT samples stable values at the next edge.
  const drive = (lhs, rhs) => `${lhs} <= #1 ${rhs};`;
  for (const itf of portmap.interfaces || []) {
    const s = new Proxy(itf.signals, { get: (o, k) => (o[k] ? id(o[k]) : null) });
    const n = id(itf.name);
    if (itf.protocol === 'ahb-lite') {
      const waitReady = s.hreadyout ? `do ${at}; while (${s.hreadyout} !== 1'b1);` : `${at};`;
      w(`  task automatic ${n}_write(input logic [63:0] addr, input logic [63:0] data);`);
      w(`    ${drive(s.hsel, "1'b1")} ${drive(s.htrans, "2'b10")} ${drive(s.hwrite, "1'b1")} ${drive(s.haddr, 'addr')}${s.hready ? ` ${drive(s.hready, "1'b1")}` : ''}`);
      w(`    ${waitReady}`);
      w(`    ${drive(s.htrans, "2'b00")} ${drive(s.hsel, "1'b0")} ${drive(s.hwrite, "1'b0")} ${drive(s.hwdata, 'data')}`);
      w(`    ${waitReady}`);
      w('  endtask');
      w(`  task automatic ${n}_read(input logic [63:0] addr, output logic [63:0] data);`);
      w(`    ${drive(s.hsel, "1'b1")} ${drive(s.htrans, "2'b10")} ${drive(s.hwrite, "1'b0")} ${drive(s.haddr, 'addr')}${s.hready ? ` ${drive(s.hready, "1'b1")}` : ''}`);
      w(`    ${waitReady}`);
      w(`    ${drive(s.htrans, "2'b00")} ${drive(s.hsel, "1'b0")}`);
      w(`    ${waitReady}`);
      w(`    data = 64'(${s.hrdata});`);
      w('  endtask');
    }
    if (itf.protocol === 'apb') {
      w(`  task automatic ${n}_access(input logic wr, input logic [63:0] addr, input logic [63:0] wdata, output logic [63:0] rdata);`);
      w(`    ${drive(s.psel, "1'b1")} ${drive(s.pwrite, 'wr')} ${drive(s.paddr, 'addr')} ${drive(s.pwdata, 'wdata')} ${drive(s.penable, "1'b0")}`);
      w(`    ${at}; ${drive(s.penable, "1'b1")}`);
      w(`    ${s.pready ? `do ${at}; while (${s.pready} !== 1'b1);` : `${at};`}`);
      w(`    rdata = 64'(${s.prdata});`);
      w(`    ${drive(s.psel, "1'b0")} ${drive(s.penable, "1'b0")}`);
      w('  endtask');
      w(`  task automatic ${n}_write(input logic [63:0] addr, input logic [63:0] data); logic [63:0] unused; ${n}_access(1'b1, addr, data, unused); endtask`);
      w(`  task automatic ${n}_read(input logic [63:0] addr, output logic [63:0] data); ${n}_access(1'b0, addr, '0, data); endtask`);
    }
    if (itf.protocol === 'axi4-lite') {
      w(`  task automatic ${n}_write(input logic [63:0] addr, input logic [63:0] data);`);
      w(`    ${drive(s.awvalid, "1'b1")} ${drive(s.awaddr, 'addr')} ${drive(s.wvalid, "1'b1")} ${drive(s.wdata, 'data')}${s.wstrb ? ` ${drive(s.wstrb, "'1")}` : ''} ${drive(s.bready, "1'b1")}`);
      w(`    fork`);
      w(`      begin do ${at}; while (${s.awready} !== 1'b1); ${drive(s.awvalid, "1'b0")} end`);
      w(`      begin do ${at}; while (${s.wready} !== 1'b1); ${drive(s.wvalid, "1'b0")} end`);
      w('    join');
      w(`    while (${s.bvalid} !== 1'b1) ${at};`);
      w(`    ${at}; ${drive(s.bready, "1'b0")}`);
      w('  endtask');
      w(`  task automatic ${n}_read(input logic [63:0] addr, output logic [63:0] data);`);
      w(`    ${drive(s.arvalid, "1'b1")} ${drive(s.araddr, 'addr')} ${drive(s.rready, "1'b1")}`);
      w(`    do ${at}; while (${s.arready} !== 1'b1);`);
      w(`    ${drive(s.arvalid, "1'b0")}`);
      w(`    while (${s.rvalid} !== 1'b1) ${at};`);
      w(`    data = 64'(${s.rdata});`);
      w(`    ${at}; ${drive(s.rready, "1'b0")}`);
      w('  endtask');
    }
    if (itf.protocol === 'valid-ready' && itf.direction === 'source') {
      const fields = Object.entries(itf.signals.data || {});
      w(`  task automatic ${n}_send(${fields.map(([f]) => `input logic [127:0] f_${id(f)}`).join(', ')});`);
      w(`    ${drive(s.valid, "1'b1")} ${fields.map(([f, p]) => drive(id(p), `f_${id(f)}`)).join(' ')}`);
      w(`    do ${at}; while (${s.ready} !== 1'b1);`);
      w(`    ${drive(s.valid, "1'b0")}`);
      w('  endtask');
    }
    if (itf.protocol === 'valid-ready' && itf.direction === 'sink') {
      w(`  task automatic ${n}_accept(input int unsigned max_cycles, input int unsigned stall);`);
      w('    int unsigned waited = 0;');
      w(`    repeat (stall) ${at};`);
      w(`    ${drive(s.ready, "1'b1")}`);
      w(`    do begin ${at}; waited++; end while (${s.valid} !== 1'b1 && waited < max_cycles);`);
      w(`    if (${s.valid} !== 1'b1) begin $display("BFM ERROR: ${itf.name} no response within %0d cycles", max_cycles); errors++; end`);
      w(`    ${drive(s.ready, "1'b0")}`);
      w('  endtask');
    }
  }
  w('  logic [63:0] rd;');
  w('  initial begin');
  w(`    $dumpfile("${vcd}");`);
  w(`    $dumpvars(${dumpDepth}, ${dumpScope ? id(dumpScope) : tb});`);
  L.push(...initDriven);
  const resetStep = () => {
    if (!rst) return [];
    const on = rst.active === 'high' ? "1'b1" : "1'b0";
    const off = rst.active === 'high' ? "1'b0" : "1'b1";
    return [`    ${id(rst.port)} = ${on};`, `    repeat (${rst.cycles ?? 4}) ${at};`, `    ${id(rst.port)} <= #1 ${off};`, `    ${at};`];
  };
  const steps = scenario.steps?.length ? scenario.steps : [{ op: 'reset' }];
  if (!steps.some((s) => s.op === 'reset')) L.push(...resetStep());
  for (const st of steps) {
    const n = st.if ? id(st.if) : null;
    switch (st.op) {
      case 'reset': L.push(...resetStep()); break;
      case 'wait_cycles': w(`    repeat (${Number(st.n ?? 1)}) ${at};`); break;
      case 'set': w(`    ${id(st.port)} <= #1 ${svLiteral(st.value)};`); break;
      case 'write': w(`    ${n}_write(${svLiteral(st.addr)}, ${svLiteral(st.data)});`); break;
      case 'read':
        w(`    ${n}_read(${svLiteral(st.addr)}, rd);`);
        if (st.expect !== undefined) {
          const mask = st.mask !== undefined ? svLiteral(st.mask) : "64'hFFFFFFFFFFFFFFFF";
          w(`    if ((rd & ${mask}) !== (64'(${svLiteral(st.expect)}) & ${mask})) begin $display("BFM ERROR: read ${st.addr} = %h, expected ${st.expect}", rd); errors++; end`);
        }
        break;
      case 'poll':
        w(`    begin int unsigned tries = 0; do begin ${n}_read(${svLiteral(st.addr)}, rd); tries++; end while ((rd & ${svLiteral(st.mask)}) !== (64'(${svLiteral(st.until)}) & ${svLiteral(st.mask)}) && tries < ${Number(st.max ?? 1000)});`);
        w(`      if (tries >= ${Number(st.max ?? 1000)}) begin $display("BFM ERROR: poll ${st.addr} timed out"); errors++; end end`);
        break;
      case 'wait_until':
        w(`    begin int unsigned waited = 0; while (${id(st.signal)} !== ${svLiteral(st.value)} && waited < ${Number(st.max ?? 1000)}) begin ${at}; waited++; end`);
        w(`      if (${id(st.signal)} !== ${svLiteral(st.value)}) begin $display("BFM ERROR: ${st.signal} did not reach ${st.value}"); errors++; end end`);
        break;
      case 'send': {
        const itf = portmap.interfaces.find((i) => i.name === st.if);
        const fields = Object.keys(itf.signals.data || {});
        w(`    ${n}_send(${fields.map((f) => (st.fields?.[f] !== undefined ? svLiteral(st.fields[f]) : "'0")).join(', ')});`);
        break;
      }
      case 'expect_response': {
        const itf = portmap.interfaces.find((i) => i.name === st.if);
        w(`    ${n}_accept(${Number(st.max ?? 1000)}, ${Number(st.stall ?? 0)});`);
        for (const [f, v] of Object.entries(st.fields || {})) {
          const port = itf.signals.data?.[f];
          if (port) w(`    if (${id(port)} !== ${svLiteral(v)}) begin $display("BFM ERROR: ${st.if}.${f} = %h, expected ${v}", ${id(port)}); errors++; end`);
        }
        break;
      }
      case 'mark': w(`    $display("BFM MARK ${String(st.label ?? '').replace(/"/g, '')} at cycle %0d", cycle);`); break;
      default: throw new Error(`bfm: unknown step op "${st.op}"`);
    }
  }
  w(`    repeat (${Number(scenario.tail_cycles ?? 4)}) ${at};`);
  w('    if (errors) $display("BFM RESULT: %0d error(s)", errors); else $display("BFM RESULT: pass");');
  w('    $finish;');
  w('  end');
  w(`  initial begin repeat (${Number(scenario.max_cycles ?? 100000)}) @(posedge ${id(clk)}); $display("BFM ERROR: max_cycles reached"); $finish; end`);
  w('endmodule');
  return { top: tb, source: `${L.join('\n')}\n` };
}

export function writeBfm(portmap, scenario, outDir, opts = {}) {
  const { top, source } = generateBfm(portmap, scenario, opts);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${top}.sv`);
  fs.writeFileSync(file, source);
  return { top, file };
}
