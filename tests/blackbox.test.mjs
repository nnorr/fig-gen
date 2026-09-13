import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exprTextWidth, parseMissingModules, placeholderStubs, refineStubs, scanInstantiations, stripComments, stubSource,
} from '../lib/rtl/blackbox.mjs';

const RTL = `
module parent(input clk, input [5:0] addr_i, output [15:0] q_o);
  wire [5:0] a = addr_i;
  // gen_mem u_fake (.X(1));  commented out, must be ignored
  generate if (1) begin : g
    gen_mem #(.P(2)) u_m (
      .CK (clk),
      .A  ({2'b00, a[3:0]}),
      .D  ({16{1'b0}}),
      .Q  (q_o),
      .T  ()
    );
  end endgenerate
  other_ip u_pos (clk, a);
endmodule`;

test('missing-module parsing is generic', () => {
  const out = "%Error-MODMISSING: x.sv:3:1: Cannot find file containing module: 'gen_mem'\n%Error-MODMISSING: y.sv:9:1: Cannot find file containing module: 'other_ip'";
  assert.deepEqual(parseMissingModules(out), ['gen_mem', 'other_ip']);
});

test('instantiation scan finds named ports, skips comments, flags positional', () => {
  assert.ok(!stripComments(RTL).includes('u_fake'));
  const sites = scanInstantiations([{ file: 'p.sv', text: RTL }], ['gen_mem', 'other_ip']);
  const mem = sites.find((s) => s.module === 'gen_mem');
  assert.equal(mem.instance, 'u_m');
  assert.deepEqual(mem.ports.map((p) => p.name), ['CK', 'A', 'D', 'Q', 'T']);
  assert.equal(mem.ports.find((p) => p.name === 'T').expr, '');
  assert.equal(sites.find((s) => s.module === 'other_ip').positional, true);
  assert.equal(sites.filter((s) => s.module === 'gen_mem').length, 1);
});

test('placeholder stubs declare every port as a wide input', () => {
  const stubs = placeholderStubs(scanInstantiations([{ file: 'p.sv', text: RTL }], ['gen_mem']));
  const src = stubSource(stubs, { origin: 'auto' });
  assert.match(src, /module gen_mem \(/);
  assert.match(src, /input wire \[1023:0\] Q/);
});

test('expression text widths resolve literals, replication, concat, selects and params', () => {
  const nets = [
    { name: 'wen', width: 1, kind: 'port' },
    { name: 'waddr', width: 4, kind: 'port' },
    { name: 'EMA', width: 3, kind: 'param', value: '5' },
    { name: 'AW', width: 32, kind: 'param', value: '6' },
  ];
  const cases = {
    "1'b0": 1, "3'b101": 3, "{16{1'b0}}": 16, '{AW{1\'b0}}': 6, '(EMA)': 3, '~wen': 1, '!wen': 1,
    "{2'b00, waddr}": 6, 'waddr[3:0]': 4, 'waddr[1]': 1, 'wen': 1,
    "'0": null, '5': null, 'f(wen)': null, 'wen & waddr': null, '{N{1\'b0}}': null,
  };
  for (const [text, expected] of Object.entries(cases)) assert.equal(exprTextWidth(text, nets), expected, text);
});

test('refinement infers widths and directions; text widths beat placeholder-resized literals', () => {
  const sites = scanInstantiations([{ file: 'p.sv', text: RTL }], ['gen_mem']);
  const netlist = {
    modules: [{
      name: 'parent', orig_name: 'parent',
      ports: [{ name: 'clk', dir: 'in', width: 1 }, { name: 'addr_i', dir: 'in', width: 6 }, { name: 'q_o', dir: 'out', width: 16 }],
      nets: [{ name: 'clk', width: 1, kind: 'port' }, { name: 'a', width: 6, kind: 'wire' }, { name: 'q_o', width: 16, kind: 'port' }],
      deps: [{ target: 'a', sources: ['addr_i'], kind: 'comb' }],
      instances: [{
        name: 'g.u_m', module: 'gen_mem', orig_module: 'gen_mem',
        connections: [
          { port: 'CK', dir: 'in', width: 1024, expr: { kind: 'net', net: 'clk', width: 1024 } },
          { port: 'A', dir: 'in', width: 1024, expr: { kind: 'concat', nets: ['a'], width: 1024 } },
          { port: 'D', dir: 'in', width: 1024, expr: { kind: 'const', value: "1024'h0", width: 1024 } },
          { port: 'Q', dir: 'in', width: 1024, expr: { kind: 'net', net: 'q_o', width: 16 } },
          { port: 'T', dir: 'in', width: 1024, expr: { kind: 'open' } },
        ],
      }],
    }],
  };
  const { stubs, unresolved } = refineStubs(netlist, ['gen_mem'], sites);
  assert.deepEqual(stubs[0].ports, [
    { name: 'CK', dir: 'in', width: 1, direction_inferred: true },
    { name: 'A', dir: 'in', width: 6, direction_inferred: true },
    { name: 'D', dir: 'in', width: 16, direction_inferred: true },
    { name: 'Q', dir: 'out', width: 16, direction_inferred: true },
  ]);
  assert.deepEqual(unresolved.map((u) => u.port), ['T']);
});

test('without site text, placeholder-width connections are unresolved rather than guessed', () => {
  const netlist = { modules: [{ name: 'p', orig_name: 'p', ports: [], nets: [], deps: [], instances: [{
    name: 'u', module: 'm', orig_module: 'm',
    connections: [{ port: 'X', dir: 'in', width: 1024, expr: { kind: 'const', value: "1024'h0", width: 1024 } }],
  }] }] };
  const { stubs, unresolved } = refineStubs(netlist, ['m']);
  assert.deepEqual(stubs[0].ports, []);
  assert.match(unresolved[0].reason, /not determinable/);
});
