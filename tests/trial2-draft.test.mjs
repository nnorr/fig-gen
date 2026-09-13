// Trial-2 draft and latency fixes (generic fixtures only):
//   N1  latency/unverified, holds_state per-input maps, latency/holds-state;
//   N2  the draft's fast layout pass;
//   N6  draft --bundle prefix|handshake;
//   N7  draft --type microarch;
//   N11 latency/state-escape.

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDatapath } from '../lib/checks/datapath.mjs';
import { checkLatency } from '../lib/checks/latency.mjs';
import { checkMicroarchCoverage } from '../lib/checks/microarch-coverage.mjs';
import { draftLayout, draftMicroarchResiduals, draftResiduals } from '../lib/draft-check.mjs';
import { busOfPort, draftMicroarch } from '../lib/draft-microarch.mjs';
import { bundleKey, draftFigure } from '../lib/draft.mjs';
import { validateSchema } from '../lib/validate.mjs';

const codes = (diags, code) => diags.filter((d) => d.code === code);
const reg = (name, width = 1) => ({ name, width, clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true }, clock_root: 'clk' });
const port = (name, dir, width = 1) => ({ name, dir, width });
const net = (name, width = 1, kind = 'port') => ({ name, width, kind });
const conn = (p, n, dir = 'in') => ({ port: p, dir, expr: { kind: 'net', net: n } });
const header = (top, hierarchy) => ({ schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top, diagnostics: [], hierarchy });

// Shaped like a service hub: one child holding registers with feedback whose
// output latency differs by input (result: 1 stage from operand, 0 from
// offset), and a combinational mixer without state.
function hubNetlist() {
  const hubPorts = [port('clk', 'in'), port('rst_n', 'in'), port('operand', 'in', 8), port('offset', 'in', 8), port('start', 'in'), port('result', 'out', 8), port('busy', 'out')];
  return {
    ...header('top', [{ path: 'top', module: 'top' }, { path: 'top.u_hub', module: 'hub' }, { path: 'top.u_mix', module: 'mix' }]),
    modules: [
      {
        name: 'top', orig_name: 'top',
        ports: [...hubPorts, port('mixed', 'out', 8)],
        nets: [...hubPorts, port('mixed', 'out', 8)].map((p) => net(p.name, p.width)),
        registers: [],
        instances: [
          { name: 'u_hub', module: 'hub', connections: hubPorts.map((p) => conn(p.name, p.name, p.dir)) },
          { name: 'u_mix', module: 'mix', connections: [conn('x', 'operand'), conn('y', 'offset'), conn('z', 'mixed', 'out')] },
        ],
        deps: [],
      },
      {
        name: 'hub', orig_name: 'hub',
        ports: hubPorts,
        nets: [...hubPorts.map((p) => net(p.name, p.width)), net('acc_q', 8, 'var'), net('cnt_q', 4, 'var')],
        registers: [reg('acc_q', 8), reg('cnt_q', 4)],
        instances: [],
        deps: [
          { target: 'acc_q', sources: ['operand', 'acc_q', 'rst_n'], kind: 'seq' },
          { target: 'cnt_q', sources: ['start', 'cnt_q', 'rst_n'], kind: 'seq' },
          { target: 'result', sources: ['acc_q', 'offset'], kind: 'comb' },
          { target: 'busy', sources: ['cnt_q'], kind: 'comb' },
        ],
      },
      {
        name: 'mix', orig_name: 'mix',
        ports: [port('x', 'in', 8), port('y', 'in', 8), port('z', 'out', 8)],
        nets: [net('x', 8), net('y', 8), net('z', 8)], registers: [], instances: [],
        deps: [{ target: 'z', sources: ['x', 'y'], kind: 'comb' }],
      },
    ],
  };
}

test('N1: a stateful non-controller block gets per-input latency maps (holds_state) instead of unmapped nets', async () => {
  const nl = hubNetlist();
  const { doc, notes } = draftFigure(nl, { preset: 'block', scope: '' });
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const hub = doc.elements.find((e) => e.rtl?.instance === 'u_hub');
  assert.equal(hub.holds_state, true);
  assert.deepEqual(hub.ports.find((p) => p.id === 'result').latency, { operand: 1, offset: 0 });
  assert.ok(notes.some((n) => /holds registers with feedback; declared per input \(holds_state\)/.test(n)));
  assert.ok(!doc.nets.some((n) => n.rtl_unmapped), 'no net is drawn unmapped for its latency');
  assert.deepEqual(codes(checkDatapath(doc).diagnostics, 'latency/controller-only'), []);
  const r = checkLatency(doc, nl, { quality: 'paper' });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.ok(r.report.pairs_checked >= 3, `pairs checked: ${r.report.pairs_checked}`);
  assert.deepEqual((await draftResiduals(doc, nl)).filter((x) => x.source === 'latency'), []);
});

test('N1: holds_state relaxes latency/controller-only and is verified against the netlist (latency/holds-state)', async () => {
  const nl = hubNetlist();
  const { doc } = draftFigure(nl, { preset: 'block', scope: '' });
  const hub = doc.elements.find((e) => e.rtl?.instance === 'u_hub');
  delete hub.holds_state;
  assert.equal(codes(checkDatapath(doc).diagnostics, 'latency/controller-only').length, 1, 'a map needs a stateful kind or holds_state');
  const mix = structuredClone(doc);
  const mixer = mix.elements.find((e) => e.rtl?.instance === 'u_mix');
  mixer.holds_state = true;
  mixer.ports.find((p) => p.id === 'z').latency = { x: 0, y: 0 };
  assert.deepEqual(await validateSchema('datapath', mix), []);
  const bad = codes(checkLatency(mix, nl).diagnostics, 'latency/holds-state');
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /u_mix declares holds_state, but its rtl\.covers and rtl\.instance name no register/);
});

test('N1: registers in scope with no compared latency pair: latency/unverified (error at paper), or an explicit opt-out', async () => {
  const nl = hubNetlist();
  const { doc } = draftFigure(nl, { preset: 'block', scope: '' });
  for (const n of doc.nets) if (n.rtl) { n.rtl_unmapped = { reason: 'drawn for structure only' }; delete n.rtl; }
  const paper = codes(checkLatency(doc, nl, { quality: 'paper' }).diagnostics, 'latency/unverified');
  assert.equal(paper.length, 1);
  assert.equal(paper[0].severity, 'error');
  assert.match(paper[0].message, /holds 2 registers, but no drawn latency pair is compared/);
  assert.equal(codes(checkLatency(doc, nl).diagnostics, 'latency/unverified')[0].severity, 'warning');
  assert.ok((await draftResiduals(doc, nl, { quality: 'paper' })).some((x) => x.code === 'latency/unverified'));

  doc.latency_unverified = { reason: 'structure overview; timing is drawn in the detail figure' };
  assert.deepEqual(await validateSchema('datapath', doc), []);
  const out = codes(checkLatency(doc, nl, { quality: 'paper' }).diagnostics, 'latency/unverified');
  assert.equal(out[0].severity, 'info');
  assert.equal(out[0].evidence.reason, doc.latency_unverified.reason);
  assert.ok((await validateSchema('datapath', { ...doc, latency_unverified: { reason: 'n/a' } })).length, 'a reason is required');
});

test('N11: "state" on an output the netlist reaches with fixed per-input latencies warns latency/state-escape', () => {
  const nl = hubNetlist();
  const { doc } = draftFigure(nl, { preset: 'block', scope: '' });
  doc.elements.find((e) => e.rtl?.instance === 'u_hub').ports.find((p) => p.id === 'result').latency = 'state';
  const r = checkLatency(doc, nl);
  const w = codes(r.diagnostics, 'latency/state-escape');
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, 'warning');
  assert.deepEqual(w[0].evidence.measured, { operand: 1, offset: 0 });
  assert.equal(r.report.state_pairs, 2);
});

// A stream engine behind request/response handshakes: req_* in, rsp_* out.
function engineNetlist() {
  const eng = [port('clk', 'in'), port('rst_n', 'in'), port('req_valid', 'in'), port('req_data', 'in', 8), port('req_ready', 'out'), port('rsp_valid', 'out'), port('rsp_data', 'out', 8), port('rsp_ready', 'in')];
  const top = eng.map((p) => (p.name === 'clk' || p.name === 'rst_n' ? p : port(`${p.name}_${p.dir === 'in' ? 'i' : 'o'}`, p.dir, p.width)));
  return {
    ...header('top', [{ path: 'top', module: 'top' }, { path: 'top.u_eng', module: 'engine' }]),
    modules: [
      {
        name: 'top', orig_name: 'top', ports: top, nets: top.map((p) => net(p.name, p.width)), registers: [],
        instances: [{ name: 'u_eng', module: 'engine', connections: eng.map((p, i) => conn(p.name, top[i].name, p.dir)) }],
        deps: [],
      },
      {
        name: 'engine', orig_name: 'engine', ports: eng,
        nets: [...eng.map((p) => net(p.name, p.width)), net('st_q', 8, 'var'), net('full_q', 1, 'var')],
        registers: [reg('st_q', 8), reg('full_q')], instances: [],
        deps: [
          { target: 'st_q', sources: ['req_valid', 'req_data', 'st_q', 'rst_n'], kind: 'seq' },
          { target: 'full_q', sources: ['req_valid', 'rsp_ready', 'full_q', 'rst_n'], kind: 'seq' },
          { target: 'rsp_data', sources: ['st_q'], kind: 'comb' },
          { target: 'rsp_valid', sources: ['full_q'], kind: 'comb' },
          { target: 'req_ready', sources: ['full_q', 'rsp_ready'], kind: 'comb' },
        ],
      },
    ],
  };
}

test('N6: bundle keys by shared prefix (AXI prefixes kept whole) or handshake stem', () => {
  assert.equal(bundleKey('h2p_start_i', 'prefix').key, 'h2p');
  assert.equal(bundleKey('m_axi_gmem_awaddr', 'prefix').key, 'm_axi');
  assert.equal(bundleKey('start', 'prefix'), null);
  assert.deepEqual(bundleKey('absorb_valid_i', 'handshake'), { key: 'absorb', word: 'valid' });
  assert.deepEqual(bundleKey('s_axis_tdata', 'handshake'), { key: 's_axis', word: 'data' });
  assert.equal(bundleKey('absorb_done_i', 'handshake'), null);
});

test('N6: draft --bundle groups ports, pins and nets; schema-valid, residual-free, latency still checked per member', async () => {
  const nl = engineNetlist();
  const plain = draftFigure(nl, { preset: 'overview', scope: '' }).doc;
  for (const mode of ['prefix', 'handshake']) {
    const { doc, notes } = draftFigure(nl, { preset: 'overview', scope: '', bundle: mode });
    assert.deepEqual(await validateSchema('datapath', doc), [], mode);
    const ports = (d) => d.elements.filter((e) => e.kind === 'port').length;
    assert.equal(ports(plain), 6);
    assert.equal(ports(doc), 4, `${mode}: req valid+data in, rsp valid+data out; the single ready ports stay`);
    const req = doc.nets.find((n) => n.bundle_of?.includes('req_valid_i'));
    assert.deepEqual(req.bundle_of, ['req_valid_i', 'req_data_i']);
    assert.equal(req.width, 9);
    const eng = doc.elements.find((e) => e.rtl?.instance === 'u_eng');
    assert.deepEqual(eng.ports.find((p) => `u_eng.${p.id}` === req.sinks[0]).bundle, ['req_valid', 'req_data']);
    assert.ok(notes.some((n) => new RegExp(`--bundle ${mode}: 2 bundles`).test(n)), notes.join('\n'));
    assert.deepEqual(await draftResiduals(doc, nl), [], mode);
    const r = checkLatency(doc, nl, { quality: 'paper' });
    assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
    assert.ok(r.report.bundled_pairs_checked >= 1);
    assert.ok(r.report.member_pairs_checked > r.report.pairs_checked, `member pairs ${r.report.member_pairs_checked} > drawn pairs ${r.report.pairs_checked}`);
  }
  assert.throws(() => draftFigure(nl, { preset: 'overview', scope: '', bundle: 'width' }), /unknown bundle mode/);
});

test('N2: the draft layout pass renders once in the delivery format, bounded by size and time', async () => {
  const nl = hubNetlist();
  const { doc } = draftFigure(nl, { preset: 'block', scope: '' });
  const paper = await draftLayout(doc);
  assert.equal(paper.variant, '2col');
  assert.ok(paper.height_pt > 0 && paper.width_pt <= 515.5 + 0.01);
  assert.ok(Array.isArray(paper.residual));
  assert.ok(paper.residual.every((x) => x.source === 'layout'));
  const study = await draftLayout(doc, { format: 'study' });
  assert.equal(study.variant, 'study');
  assert.match((await draftLayout(doc, { seconds: 0 })).skipped, /disabled/);
  assert.match((await draftLayout(doc, { limits: { elements: 2, nets: 400 } })).skipped, /exceed the draft layout limit/);
});

test('N2: the draft command reports layout apart ("residual (layout):" / layout note), and the budget error still stops it', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-layout-'));
  const rtl = path.join(dir, 'top.sv');
  fs.writeFileSync(rtl, 'module top; endmodule\n');
  const nl = hubNetlist();
  nl.inputs = { source_root: dir, files: [{ role: 'rtl', path: 'top.sv', sha256: createHash('sha256').update(fs.readFileSync(rtl)).digest('hex') }] };
  const nlFile = path.join(dir, 'netlist.json');
  fs.writeFileSync(nlFile, JSON.stringify(nl));
  const bin = new URL('../bin/fig-gen.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [bin, 'draft', '--netlist', nlFile, ...args], { encoding: 'utf8' });
  const ok = run('--view', 'block', '--scope', '', '--out', path.join(dir, 'a.json'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /^note: layout 2col: [\d.]+ × [\d.]+ pt \(max height 230\.4 pt\); /m);
  const skipped = run('--view', 'block', '--scope', '', '--layout-seconds', '0', '--out', path.join(dir, 'b.json'));
  assert.match(skipped.stderr, /^note: layout not run \(layout pass disabled/m);
  const bundled = run('--view', 'overview', '--scope', '', '--bundle', 'nope');
  assert.equal(bundled.status, 2, 'an unknown bundle mode is a usage error');
  const budget = run('--view', 'block', '--scope', '', '--budget-seconds', '0.000001', '--out', path.join(dir, 'c.json'));
  assert.equal(budget.status, 1);
  assert.match(budget.stderr, /draft\/budget-exceeded/);
  const micro = run('--type', 'microarch', '--out', path.join(dir, 'm.json'));
  assert.equal(micro.status, 0, micro.stderr);
  assert.match(micro.stderr, /^note: microarch draft: /m);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Shaped like an accelerator shell: CSRs behind AXI4-Lite, a core fed by an
// input stream, an output FIFO driving the output stream, a memory mover as
// AXI4 master.
function shellNetlist() {
  const top = [
    port('clk', 'in'), port('rst_n', 'in'),
    port('s_axil_awaddr', 'in', 12), port('s_axil_wdata', 'in', 32), port('s_axil_wvalid', 'in'), port('s_axil_rdata', 'out', 32),
    port('s_axis_tvalid', 'in'), port('s_axis_tready', 'out'), port('s_axis_tdata', 'in', 8),
    port('m_axis_tvalid', 'out'), port('m_axis_tready', 'in'), port('m_axis_tdata', 'out', 8),
    port('m_axi_mem_awaddr', 'out', 32), port('m_axi_mem_wdata', 'out', 32), port('m_axi_mem_rdata', 'in', 32),
  ];
  const mod = (name, ports, extra = {}) => ({ name, orig_name: name, ports, nets: ports.map((p) => net(p.name, p.width)), registers: [], instances: [], deps: [], ...extra });
  const corePorts = [port('din', 'in', 8), port('vin', 'in'), port('start', 'in'), port('rd', 'in', 8), port('rdy', 'out'), port('dout', 'out', 8)];
  const fifoPorts = [port('clk', 'in'), port('d', 'in', 8), port('ready', 'in'), port('q', 'out', 8), port('v', 'out')];
  const moverPorts = [port('len', 'in', 16), port('rdata', 'in', 32), port('wdata_in', 'in', 8), port('awaddr', 'out', 32), port('wdata', 'out', 32), port('rd', 'out', 8)];
  return {
    ...header('shell_top', [{ path: 'shell_top', module: 'shell_top' }, { path: 'shell_top.u_core', module: 'core_m' }, { path: 'shell_top.u_fifo', module: 'out_fifo' }, { path: 'shell_top.u_mover', module: 'mem_mover' }]),
    modules: [
      {
        name: 'shell_top', orig_name: 'shell_top', ports: top,
        nets: [...top.map((p) => net(p.name, p.width)), net('c_start', 1, 'var'), net('c_len', 16, 'var'), net('core_q', 8, 'wire'), net('mover_rd', 8, 'wire')],
        registers: [reg('c_start'), reg('c_len', 16)],
        instances: [
          { name: 'u_core', module: 'core_m', connections: [conn('din', 's_axis_tdata'), conn('vin', 's_axis_tvalid'), conn('start', 'c_start'), conn('rd', 'mover_rd'), conn('rdy', 's_axis_tready', 'out'), conn('dout', 'core_q', 'out')] },
          { name: 'u_fifo', module: 'out_fifo', connections: [conn('clk', 'clk'), conn('d', 'core_q'), conn('ready', 'm_axis_tready'), conn('q', 'm_axis_tdata', 'out'), conn('v', 'm_axis_tvalid', 'out')] },
          { name: 'u_mover', module: 'mem_mover', connections: [conn('len', 'c_len'), conn('rdata', 'm_axi_mem_rdata'), conn('wdata_in', 'core_q'), conn('awaddr', 'm_axi_mem_awaddr', 'out'), conn('wdata', 'm_axi_mem_wdata', 'out'), conn('rd', 'mover_rd', 'out')] },
        ],
        deps: [
          { target: 'c_start', sources: ['s_axil_wdata', 's_axil_wvalid', 'c_start', 'rst_n'], kind: 'seq' },
          { target: 'c_len', sources: ['s_axil_wdata', 's_axil_awaddr', 'c_len', 'rst_n'], kind: 'seq' },
          { target: 's_axil_rdata', sources: ['c_len', 'c_start'], kind: 'comb' },
        ],
      },
      mod('core_m', corePorts, { deps: [{ target: 'dout', sources: ['din', 'rd', 'start'], kind: 'comb' }, { target: 'rdy', sources: ['vin'], kind: 'comb' }] }),
      mod('out_fifo', fifoPorts, { nets: [...fifoPorts.map((p) => net(p.name, p.width)), net('mem_q', 8, 'var')], registers: [reg('mem_q', 8)], deps: [{ target: 'mem_q', sources: ['d', 'mem_q'], kind: 'seq' }, { target: 'q', sources: ['mem_q'], kind: 'comb' }, { target: 'v', sources: ['ready'], kind: 'comb' }] }),
      mod('mem_mover', moverPorts, { deps: [{ target: 'awaddr', sources: ['len'], kind: 'comb' }, { target: 'wdata', sources: ['wdata_in'], kind: 'comb' }, { target: 'rd', sources: ['rdata'], kind: 'comb' }] }),
    ],
  };
}

test('N7: bus and stream prefixes', () => {
  assert.deepEqual(busOfPort('s_axil_awaddr'), { protocol: 'AXI4-Lite', role: 'slave', name: '', prefix: 's_axil_' });
  assert.deepEqual(busOfPort('m_axi_gmem_awaddr'), { protocol: 'AXI4', role: 'master', name: 'gmem', prefix: 'm_axi_gmem_' });
  assert.equal(busOfPort('m_axis_tdata').protocol, 'AXI4-Stream');
  assert.equal(busOfPort('axis_tdata'), null);
});

test('N7: draft --type microarch: blocks per child, registers by prefix, AXI fabrics and streams, off-chip host and memory; passes its checks', async () => {
  const nl = shellNetlist();
  const { doc } = draftMicroarch(nl);
  assert.deepEqual(await validateSchema('microarch', doc), []);
  assert.deepEqual(doc.view, { preset: 'overview', scope: '' });
  const block = (pred) => doc.blocks.find(pred);
  for (const inst of ['u_core', 'u_fifo', 'u_mover']) assert.ok(block((b) => b.rtl?.instance === inst), inst);
  assert.equal(block((b) => b.rtl?.instance === 'u_fifo').kind, 'fifo');
  assert.deepEqual(block((b) => b.rtl?.covers).rtl.covers, ['c_*']);
  assert.deepEqual(doc.blocks.filter((b) => b.kind === 'offchip').map((b) => b.label).sort(), ['External memory', 'Host']);
  const lite = doc.fabrics.find((f) => f.protocol === 'AXI4-Lite');
  const axi = doc.fabrics.find((f) => f.protocol === 'AXI4');
  assert.equal(lite.data_width, 32);
  assert.equal(lite.addr_width, 12);
  const role = (f, r) => doc.attachments.filter((a) => a.fabric === f.id && a.role === r).map((a) => a.block);
  assert.deepEqual(role(lite, 'manager'), ['host']);
  assert.deepEqual(role(lite, 'subordinate'), [block((b) => b.rtl?.covers).id]);
  assert.deepEqual(role(axi, 'manager'), ['u_mover']);
  assert.deepEqual(role(axi, 'subordinate'), ['ext_mem']);
  const streams = doc.interfaces.map((i) => `${i.from}>${i.to}:${i.data_width}`).sort();
  assert.deepEqual(streams, ['host>u_core:8', 'u_fifo>host:8']);
  assert.ok(doc.links.some((l) => l.from === block((b) => b.rtl?.covers).id && l.to === 'u_core' && l.class === 'control'));
  assert.deepEqual(await draftMicroarchResiduals(doc, nl), []);
  const cov = checkMicroarchCoverage(doc, nl).report.totals;
  assert.deepEqual(cov.registers, { covered: 2, total: 2 });
  assert.deepEqual(cov.instances, { covered: 3, total: 3 });
  assert.throws(() => draftMicroarch(nl, { scope: 'nope' }), /not an instance/);
});
