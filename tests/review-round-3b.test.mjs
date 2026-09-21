// Review round 3b: no orphan tags. A net into a figure output keeps its wire,
// each cut net has exactly one source and one target tag, a pair whose tags end
// up close is drawn as a wire, every tag or port glyph has a wire on the final
// SVG, and vague or port-colliding connector names are qualified.

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel } from '../lib/ir/datapath-model.mjs';
import { closeConnectorMarks, connectorNames, orphanTags, renderDatapath, withConnectors } from '../lib/render/datapath.mjs';

const block = (id, name, ins, outs) => ({ id, kind: 'comb', op: 'custom', width: 1, function: { kind: 'custom', name }, ports: [...ins.map((p) => ({ id: p, dir: 'in', width: 1 })), ...outs.map((p) => ({ id: p, dir: 'out', width: 1 }))] });
const figure = (elements, nets, extra = {}) => ({ schema_version: 1, figure_type: 'datapath', meta: { title: 't', print: { profile: 'ieee' }, ...(extra.meta || {}) }, clock_domains: [], elements, nets });

test('a net into a figure output is never cut, and one target tag feeds every cut sink of a net', () => {
  const doc = figure([
    { id: 'in', kind: 'port', dir: 'in', width: 1, label: 'value in' },
    block('a', 'First', ['i'], ['o']), block('b', 'Second', ['i'], ['o']), block('c', 'Third', ['i'], ['o']),
    { id: 'out', kind: 'port', dir: 'out', width: 1, label: 'result' },
  ], [
    { id: 'n0', width: 1, driver: 'in', sinks: ['a.i'] },
    { id: 'n1', width: 1, driver: 'a.o', sinks: ['b.i', 'c.i'] },
    { id: 'n2', width: 1, driver: 'b.o', sinks: ['out'] },
  ]);
  const cut = withConnectors(doc, buildModel(doc), [{ net: 'n0', sink: 0 }, { net: 'n1', sink: 0 }, { net: 'n1', sink: 1 }, { net: 'n2', sink: 0 }]);
  assert.deepEqual(cut.nets.find((n) => n.id === 'n0').sinks, ['a.i'], 'a net from a figure input keeps its wire');
  assert.deepEqual(cut.elements.filter((e) => e.connector).map((e) => [e.id, e.connector]), [['cx_n1', 'source'], ['cx_n1_to0', 'target']], 'two tags for the net');
  assert.deepEqual(cut.nets.find((n) => n.id === 'n1__cx0').sinks, ['b.i', 'c.i']);
  assert.deepEqual(cut.elements.find((e) => e.id === 'cx_n1_to0').connector_sinks, [0, 1]);
  assert.deepEqual(cut.nets.find((n) => n.id === 'n2').sinks, ['out'], 'the output keeps its wire');
});

test('vague single-word names and names equal to a figure port are qualified with the source instance', () => {
  const net = (id, signal, instance) => ({ id, width: 1, driver: 'a.o', sinks: ['b.i'], rtl: { ...(instance ? { instance } : {}), signal } });
  const doc = { elements: [{ id: 'p_owner', kind: 'port', dir: 'in', width: 1, label: 'owner' }], nets: [
    net('n1', 'c_state', 'u_engine_adapter/u_physical_shake'),
    net('n2', 'owner_o', 'u_single_engine/u_owner'),
    net('n3', 'busy'),
    net('n4', 'client_ready_o', 'u_owner'),
  ] };
  assert.deepEqual([...connectorNames(doc, ['n1', 'n2', 'n3', 'n4']).values()], ['Physical shake: state', 'Owner: owner', 'busy', 'client ready']);
});

test('a connector pair whose tags are within 60 pt or two drawn layers is dropped; far pairs stay', () => {
  const tag = (id, net, sinks) => ({ id, kind: 'port', connector: sinks ? 'target' : 'source', connector_net: net, ...(sinks ? { connector_sinks: sinks } : {}) });
  const blocks = [100, 200, 300, 400, 500].map((x, i) => ({ id: `k${i}`, kind: 'comb', x }));
  const doc = { elements: [...blocks, tag('cx_a', 'a'), tag('cx_a_to0', 'a', [0]), tag('cx_b', 'b'), tag('cx_b_to0', 'b', [1]), tag('cx_c', 'c'), tag('cx_c_to0', 'c', [2])] };
  const box = (x) => ({ x, y: 0, w: 40, h: 10 });
  const pos = new Map([...blocks.map((b) => [b.id, box(b.x)]), ['cx_a', box(600)], ['cx_a_to0', box(630)], ['cx_b', box(600)], ['cx_b_to0', box(50)], ['cx_c', box(600)], ['cx_c_to0', box(460)]]);
  // a: 30 pt apart; b: five block columns between (a long return); c: 140 pt apart but only one column between.
  assert.deepEqual(closeConnectorMarks(doc, pos), [{ net: 'a', sinks: [0] }, { net: 'c', sinks: [2] }]);
});

test('orphan tags are found on SVG geometry: a glyph with no wire end at its outline', () => {
  const svg = '<svg><path id="net-n-seg0" d="M10 10 L100 10"/><path id="net-n-arrow0" d="M300 10 L302 12"/></svg>';
  const glyphs = [{ el: 'wired', x: 100, y: 5, w: 30, h: 10 }, { el: 'arrowed', x: 105, y: 40, w: 30, h: 10 }, { el: 'near', x: 104, y: 5, w: 30, h: 10 }, { el: 'lonely', x: 300, y: 5, w: 30, h: 10 }];
  assert.deepEqual(orphanTags(svg, glyphs).map((g) => g.el), ['arrowed', 'lonely'], 'an arrow path is not a wire end');
});

test('authored boundary ports use arrow tags while local constants may remain plain labels', async () => {
  const doc = figure([
    { id: 'input', kind: 'port', dir: 'in', width: 1, label: 'request', connector: 'target' },
    { id: 'one', kind: 'const', value: "1'b1", label: 'logic 1', display: 'label' },
    { id: 'gate', kind: 'comb', op: 'and', width: 1, inputs: 2 },
    { id: 'output', kind: 'port', dir: 'out', width: 1, label: 'accepted', connector: 'source' },
  ], [
    { id: 'request', width: 1, driver: 'input', sinks: ['gate.in0'] },
    { id: 'one', width: 1, driver: 'one.out', sinks: ['gate.in1'] },
    { id: 'accepted', width: 1, driver: 'gate.out', sinks: ['output'] },
  ]);
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'boundary-tags' });
  assert.equal(r.diagnostics.some((d) => d.severity === 'error'), false);
  assert.match(r.svg, /<path id="port-input-body"/);
  assert.match(r.svg, /<path id="port-output-body"/);
  assert.doesNotMatch(r.svg, /id="const-one-body"/);
  assert.match(r.svg, /id="const-one-label"/);
});

test('datapath memories are hatched while registers retain the gray storage fill', async () => {
  const doc = figure([
    { id: 'addr', kind: 'port', dir: 'in', width: 4, label: 'read address' },
    { id: 'mem', kind: 'memory', label: 'History memory', depth: 16, width: 8, domain: 'sys', ports: [{ id: 'r', type: 'read', read_latency: 0 }] },
    { id: 'reg', kind: 'register', width: 8, domain: 'sys', label: 'Data register' },
    { id: 'out', kind: 'port', dir: 'out', width: 8, label: 'read data' },
  ], [
    { id: 'a', width: 4, driver: 'addr', sinks: ['mem.r_addr'] },
    { id: 'd', width: 8, driver: 'mem.r_rdata', sinks: ['reg.d'] },
    { id: 'q', width: 8, driver: 'reg.q', sinks: ['out'] },
  ]);
  doc.clock_domains = [{ id: 'sys', clock: 'clk' }];
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'storage-style' });
  assert.match(r.svg, /id="memory-mem-body"[^>]*fill="#FFFFFF"/);
  assert.match(r.svg, /id="memory-mem-hatch"/);
  assert.match(r.svg, /id="reg-reg-body"[^>]*fill="#D9D9D9"/);
});

test('connector/orphan-tag and connector/duplicate-name are errors on the drawn figure; an unread input is reported; off_page is exempt', async () => {
  const doc = figure([
    { id: 'in', kind: 'port', dir: 'in', width: 1, label: 'value in' },
    { id: 'spare', kind: 'port', dir: 'in', width: 1, label: 'spare input' },
    { id: 'remote', kind: 'port', dir: 'out', width: 1, label: 'to the host', off_page: true },
    { id: 'lonely', kind: 'port', dir: 'out', width: 1, label: 'lonely output' },
    { id: 'ready_port', kind: 'port', dir: 'in', width: 1, label: 'ready' },
    block('p', 'Producer', ['i', 'r'], ['o']), block('s', 'Sink', ['i', 'j'], ['o']),
    { id: 'cx_n1', kind: 'port', dir: 'out', width: 1, label: 'ready', connector: 'source', connector_net: 'n1' },
    { id: 'cx_n1_to0', kind: 'port', dir: 'in', width: 1, label: 'ready', connector: 'target', connector_net: 'n1' },
    { id: 'cx_n1_to1', kind: 'port', dir: 'in', width: 1, label: 'ready', connector: 'target', connector_net: 'n1' },
    { id: 'result', kind: 'port', dir: 'out', width: 1, label: 'result' },
  ], [
    { id: 'n_in', width: 1, driver: 'in', sinks: ['p.i'] },
    { id: 'n_ready', width: 1, driver: 'ready_port', sinks: ['p.r'] },
    { id: 'n1', width: 1, driver: 'p.o', sinks: ['cx_n1'] },
    { id: 'n1__cx0', width: 1, driver: 'cx_n1_to0', sinks: ['s.i'] },
    { id: 'n1__cx1', width: 1, driver: 'cx_n1_to1', sinks: ['s.j'] },
    { id: 'n_out', width: 1, driver: 's.o', sinks: ['result'] },
  ], { meta: { style: { connectors: false } } });
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'orphans' });
  const of = (code) => r.diagnostics.filter((d) => d.code === code);
  assert.deepEqual(of('connector/orphan-tag').map((d) => [d.severity, d.subject.id]), [['error', 'lonely']]);
  assert.deepEqual(of('port/no-sink').map((d) => [d.severity, d.subject.id]), [['warning', 'spare']]);
  assert.deepEqual(of('connector/duplicate-name').map((d) => d.message.replace(/^2col: /, '')), ['the name "ready" is on 3 connector tags; a name belongs to one source and one target tag', '"ready" names both a connector tag and a figure port']);
});
