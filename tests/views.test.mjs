// View presets (overview, block, mixed, detail): the draft generator builds a
// starting figure from a netlist for each preset, every check applies to it,
// and the view checks enforce what each preset may draw. Generic hand-built
// netlist: a CSR register, a memory wrapper around a blackbox macro, a
// two-stage pipeline and a zero detector.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCoverage } from '../lib/checks/coverage.mjs';
import { checkDatapath } from '../lib/checks/datapath.mjs';
import { checkRegionEquivalence } from '../lib/checks/equivalence.mjs';
import { checkLatency } from '../lib/checks/latency.mjs';
import { deliver } from '../lib/deliver.mjs';
import { draftFigure, parseGateRegion } from '../lib/draft.mjs';
import { renderDatapath } from '../lib/render/datapath.mjs';
import { validateSchema } from '../lib/validate.mjs';
import { applyViewOverrides, checkView, withViewScope } from '../lib/view.mjs';

const errors = (diags) => diags.filter((d) => d.severity === 'error');
const codes = (diags) => diags.map((d) => d.code);

function netlist() {
  const reg = (name, width) => ({ name, width, clock: { net: 'clk', edge: 'pos' }, reset: { net: 'rst_n', active: 'low', async: true }, clock_root: 'clk' });
  const port = (name, dir, width) => ({ name, dir, width });
  const net = (name, width, kind = 'wire') => ({ name, width, kind });
  const ref = (name, width) => ({ op: 'ref', name, width });
  const konst = (value, width) => ({ op: 'const', value, width });
  const conn = (p, n, dir = 'in') => ({ port: p, dir, expr: { kind: 'net', net: n } });
  return {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'acc_top', diagnostics: [],
    hierarchy: [
      { path: 'acc_top', module: 'acc_top' }, { path: 'acc_top.u_mem', module: 'sram_wrap' },
      { path: 'acc_top.u_mem.u_ram', module: 'ram_macro', blackbox: true }, { path: 'acc_top.u_pipe', module: 'pipe2' }, { path: 'acc_top.u_det', module: 'zero_det' },
    ],
    modules: [
      {
        name: 'acc_top', orig_name: 'acc_top',
        ports: [port('clk', 'in', 1), port('rst_n', 'in', 1), port('bus_sel', 'in', 1), port('bus_wr', 'in', 1), port('bus_addr', 'in', 4), port('bus_wdata', 'in', 8), port('rdata_o', 'out', 8), port('irq_o', 'out', 1)],
        nets: [net('clk', 1, 'port'), net('rst_n', 1, 'port'), net('bus_sel', 1, 'port'), net('bus_wr', 1, 'port'), net('bus_addr', 4, 'port'), net('bus_wdata', 8, 'port'), net('rdata_o', 8, 'port'), net('irq_o', 1, 'port'), net('ctrl_q', 2, 'var'), net('wr_en', 1), net('mem_q', 8), net('pipe_y', 8), net('hit', 1)],
        registers: [reg('ctrl_q', 2)],
        instances: [
          { name: 'u_mem', module: 'sram_wrap', connections: [conn('clk', 'clk'), conn('rst_n', 'rst_n'), conn('we', 'wr_en'), conn('addr', 'bus_addr'), conn('wdata', 'bus_wdata'), conn('rdata', 'mem_q', 'out')] },
          { name: 'u_pipe', module: 'pipe2', connections: [conn('clk', 'clk'), conn('rst_n', 'rst_n'), conn('a', 'mem_q'), conn('y', 'pipe_y', 'out')] },
          { name: 'u_det', module: 'zero_det', connections: [conn('y', 'pipe_y'), conn('hit', 'hit', 'out')] },
        ],
        deps: [
          { target: 'wr_en', sources: ['bus_sel', 'bus_wr'], kind: 'comb' },
          { target: 'ctrl_q', sources: ['bus_sel', 'bus_wdata', 'bus_wr', 'ctrl_q', 'rst_n'], kind: 'seq' },
          { target: 'rdata_o', sources: ['pipe_y'], kind: 'comb' },
          { target: 'irq_o', sources: ['ctrl_q', 'hit'], kind: 'comb' },
        ],
        exprs: [
          { target: 'wr_en', width: 1, expr: { op: 'and', width: 1, args: [ref('bus_sel', 1), ref('bus_wr', 1)] } },
          { target: 'rdata_o', width: 8, expr: ref('pipe_y', 8) },
          { target: 'irq_o', width: 1, expr: { op: 'and', width: 1, args: [ref('hit', 1), { op: 'sel', width: 1, lsb: 0, args: [ref('ctrl_q', 2)] }] } },
        ],
      },
      {
        name: 'sram_wrap', orig_name: 'sram_wrap',
        ports: [port('clk', 'in', 1), port('rst_n', 'in', 1), port('we', 'in', 1), port('addr', 'in', 4), port('wdata', 'in', 8), port('rdata', 'out', 8)],
        nets: [net('clk', 1, 'port'), net('rst_n', 1, 'port'), net('we', 1, 'port'), net('addr', 4, 'port'), net('wdata', 8, 'port'), net('rdata', 8, 'port'), net('fwd_q', 8, 'var'), net('ram_q', 8)],
        registers: [reg('fwd_q', 8)],
        instances: [{ name: 'u_ram', module: 'ram_macro', connections: [conn('CK', 'clk'), conn('WE', 'we'), conn('A', 'addr'), conn('D', 'wdata'), conn('Q', 'ram_q', 'out')] }],
        deps: [{ target: 'fwd_q', sources: ['rst_n', 'wdata'], kind: 'seq' }, { target: 'rdata', sources: ['fwd_q', 'ram_q', 'we'], kind: 'comb' }],
        exprs: [{ target: 'rdata', width: 8, expr: { op: 'cond', width: 8, args: [ref('we', 1), ref('fwd_q', 8), ref('ram_q', 8)] } }],
      },
      {
        name: 'ram_macro', orig_name: 'ram_macro', blackbox: { origin: 'auto', confidence: 'inferred' },
        ports: [port('CK', 'in', 1), port('WE', 'in', 1), port('A', 'in', 4), port('D', 'in', 8), port('Q', 'out', 8)],
        nets: [net('CK', 1, 'port'), net('WE', 1, 'port'), net('A', 4, 'port'), net('D', 8, 'port'), net('Q', 8, 'port')], registers: [], instances: [], deps: [],
      },
      {
        name: 'pipe2', orig_name: 'pipe2',
        ports: [port('clk', 'in', 1), port('rst_n', 'in', 1), port('a', 'in', 8), port('y', 'out', 8)],
        nets: [net('clk', 1, 'port'), net('rst_n', 1, 'port'), net('a', 8, 'port'), net('y', 8, 'port'), net('t1', 8), net('s1_q', 8, 'var'), net('t2', 8), net('s2_q', 8, 'var')],
        registers: [reg('s1_q', 8), reg('s2_q', 8)], instances: [],
        deps: [
          { target: 't1', sources: ['a'], kind: 'comb' }, { target: 's1_q', sources: ['rst_n', 't1'], kind: 'seq' },
          { target: 't2', sources: ['s1_q'], kind: 'comb' }, { target: 's2_q', sources: ['rst_n', 't2'], kind: 'seq' }, { target: 'y', sources: ['s2_q'], kind: 'comb' },
        ],
        exprs: [
          { target: 't1', width: 8, expr: { op: 'xor', width: 8, args: [ref('a', 8), konst("8'h5a", 8)] } },
          { target: 't2', width: 8, expr: { op: 'and', width: 8, args: [ref('s1_q', 8), konst("8'h0f", 8)] } },
          { target: 'y', width: 8, expr: ref('s2_q', 8) },
        ],
      },
      {
        name: 'zero_det', orig_name: 'zero_det',
        ports: [port('y', 'in', 8), port('hit', 'out', 1)],
        nets: [net('y', 8, 'port'), net('hit', 1, 'port')], registers: [], instances: [],
        deps: [{ target: 'hit', sources: ['y'], kind: 'comb' }],
        exprs: [{ target: 'hit', width: 1, expr: { op: 'eq', width: 1, args: [ref('y', 8), konst("8'h0", 8)] } }],
      },
    ],
  };
}

async function allChecks(doc, nl) {
  const schema = await validateSchema('datapath', doc);
  return {
    schema,
    semantic: errors(checkDatapath(doc).diagnostics),
    coverage: checkCoverage(doc, nl),
    latency: checkLatency(doc, nl),
    view: checkView(doc, { netlist: nl }),
  };
}

test('overview preset: the whole scope with children collapsed, pipeline registers visible, coverage complete by containment', async () => {
  const nl = netlist();
  const { doc, expanded } = draftFigure(nl, { preset: 'overview', scope: '' });
  const r = await allChecks(doc, nl);
  assert.deepEqual(r.schema, []);
  assert.deepEqual(r.semantic, []);
  assert.deepEqual(errors(r.coverage.diagnostics), []);
  assert.equal(r.coverage.report.totals.registers.covered, r.coverage.report.totals.registers.total);
  assert.equal(r.coverage.report.totals.transfers.represented, r.coverage.report.totals.transfers.total);
  assert.deepEqual(r.latency.diagnostics, []);
  assert.deepEqual(errors(r.view.diagnostics), []);
  assert.deepEqual(doc.view, { preset: 'overview', scope: '' });
  // the pipelined child is expanded so its bars show; the memory and the detector stay blocks
  assert.ok(expanded.includes('u_pipe'));
  assert.equal(doc.elements.filter((e) => e.kind === 'pipeline_register').length, 2);
  const mem = doc.elements.find((e) => e.rtl?.instance === 'u_mem');
  assert.equal(mem.function.kind, 'memory');
  assert.equal(mem.ports.find((p) => p.id === 'rdata').registered, true);
  assert.equal(doc.elements.find((e) => e.rtl?.instance === 'u_det').kind, 'instance');
  assert.ok(!doc.regions?.some((g) => g.level === 'gate'));
  const rendered = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'overview' });
  assert.deepEqual(rendered.diagnostics.filter((d) => /^(wire|symbol)\//.test(d.code)), []);
});

test('block preset: the scope is one instance and its ports are the figure ports', async () => {
  const nl = netlist();
  const { doc } = draftFigure(nl, { preset: 'block', scope: 'u_pipe' });
  const r = await allChecks(doc, nl);
  assert.deepEqual(r.schema, []);
  assert.deepEqual(r.semantic, []);
  assert.deepEqual(errors(r.coverage.diagnostics), []);
  assert.deepEqual(r.latency.diagnostics, []);
  assert.deepEqual(errors(r.view.diagnostics), []);
  assert.deepEqual(doc.elements.filter((e) => e.kind === 'port').map((e) => e.rtl.signal).sort(), ['a', 'y']);
  assert.equal(doc.meta.scope.instance, 'u_pipe');
  const rendered = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'block' });
  assert.deepEqual(errors(rendered.diagnostics), []);

  const missing = structuredClone(doc);
  missing.elements = missing.elements.filter((e) => e.rtl?.signal !== 'y');
  missing.nets = missing.nets.filter((n) => !n.sinks.includes('p_y'));
  assert.ok(codes(checkView(missing, { netlist: nl }).diagnostics).includes('view/boundary-port'));
});

test('mixed preset: selected gate regions (equivalence-checked) and blackboxes on top of a block or overview scope', async () => {
  const nl = netlist();
  assert.deepEqual(parseGateRegion('zero=u_det:hit'), { name: 'zero', outputs: ['u_det:hit'], stop: [] });
  const { doc } = draftFigure(nl, { preset: 'mixed', scope: '', gateRegions: ['zero=u_det:hit'], blackbox: ['u_mem'] });
  const r = await allChecks(doc, nl);
  assert.deepEqual(r.schema, []);
  assert.deepEqual(r.semantic, []);
  assert.deepEqual(errors(r.coverage.diagnostics), []);
  assert.deepEqual(errors(r.view.diagnostics), []);
  assert.equal(doc.elements.find((e) => e.rtl?.instance === 'u_mem').level, 'blackbox');
  const region = doc.regions.find((g) => g.id === 'zero');
  assert.equal(region.level, 'gate');
  const eq = checkRegionEquivalence(doc, region, nl);
  assert.deepEqual(eq.diagnostics, []);
  assert.equal(eq.result.method, 'exhaustive');
  assert.equal(eq.result.result, 'pass');

  const unselected = structuredClone(doc);
  unselected.view.gate_regions = [];
  assert.ok(codes(checkView(unselected, { netlist: nl }).diagnostics).includes('view/gate-region-unselected'));
  const asOverview = structuredClone(doc);
  asOverview.view = { preset: 'overview', scope: '' };
  assert.ok(codes(checkView(asOverview).diagnostics).includes('view/preset-violation'));
});

test('detail preset: children expanded to the depth; collapsing inside it is reported', async () => {
  const nl = netlist();
  const { doc, expanded } = draftFigure(nl, { preset: 'detail', scope: '', depth: 1 });
  const r = await allChecks(doc, nl);
  assert.deepEqual(r.schema, []);
  assert.deepEqual(r.semantic, []);
  assert.deepEqual(errors(r.coverage.diagnostics), []);
  assert.deepEqual(r.latency.diagnostics, []);
  assert.ok(['u_mem', 'u_pipe', 'u_det'].every((i) => expanded.includes(i)));
  assert.deepEqual(r.view.diagnostics.filter((d) => d.code === 'view/detail-collapsed'), []);
  // the macro inside the memory wrapper is a stub: a blackbox, not a collapse to report
  assert.equal(doc.elements.find((e) => e.rtl?.instance === 'u_mem/u_ram').level, 'blackbox');

  const shallow = draftFigure(nl, { preset: 'overview', scope: '' }).doc;
  shallow.view = { preset: 'detail', scope: '', depth: 1 };
  shallow.meta.caption = 'Detail view of the whole design.';
  assert.ok(codes(checkView(shallow, { netlist: nl }).diagnostics).includes('view/detail-collapsed'));
});

test('view checks: context outside the scope only as blackboxes, the caption states preset and scope, one scope', () => {
  const doc = {
    meta: { title: 't', print: { profile: 'ieee' }, caption: 'A figure.', scope: { instance: 'u_other' } },
    view: { preset: 'block', scope: 'u_pipe' },
    elements: [{ id: 'mem', kind: 'instance', module: 'm', rtl: { instance: 'u_mem' }, function: { kind: 'memory' }, ports: [] }],
    nets: [],
  };
  const found = codes(checkView(doc).diagnostics);
  assert.ok(found.includes('view/context-not-blackbox'));
  assert.ok(found.includes('view/caption'));
  assert.ok(found.includes('view/scope-mismatch'));
  doc.elements[0].level = 'blackbox';
  doc.meta.caption = 'Block view of u_pipe.';
  delete doc.meta.scope;
  assert.deepEqual(codes(checkView(doc).diagnostics), []);
  assert.deepEqual(withViewScope(doc).meta.scope, { instance: 'u_pipe', hierarchy: 'all' });
});

test('CLI view overrides select preset and scope; the receipt records them', async () => {
  const nl = netlist();
  const base = draftFigure(nl, { preset: 'block', scope: 'u_pipe' }).doc;
  const { doc, overrides } = applyViewOverrides(base, { preset: 'detail', depth: 1 });
  assert.deepEqual(overrides, { preset: 'detail', depth: 1 });
  assert.deepEqual(doc.view, { preset: 'detail', scope: 'u_pipe', depth: 1 });
  assert.equal(applyViewOverrides(base, {}).overrides, null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-view-'));
  try {
    const file = path.join(dir, 'pipe.datapath.json');
    base.meta.print.variants = ['2col'];
    fs.writeFileSync(file, JSON.stringify(base));
    const out = await deliver({ type: 'datapath', figurePath: file, outDir: path.join(dir, 'out'), variants: ['2col'], view: { preset: 'block', scope: 'u_pipe' } });
    assert.deepEqual(errors(out.diagnostics), []);
    assert.equal(out.receipt.view.preset, 'block');
    assert.equal(out.receipt.view.scope, 'u_pipe');
    assert.deepEqual(out.receipt.view.overrides, { preset: 'block', scope: 'u_pipe' });
    assert.deepEqual(await validateSchema('receipt', out.receipt), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
