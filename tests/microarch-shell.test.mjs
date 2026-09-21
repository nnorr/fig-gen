// Microarch trial gaps G11–G13: one row per fabric with off-chip blocks
// outside chip boundaries (G11), view / rtl.covers / coverage (G12), and
// point-to-point stream interfaces (G13). Regression fixture: the common
// FPGA accelerator shell (host + AXI4-Lite control + AXI4 master to external
// memory + AXI4-Stream in/out).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMicroarch } from '../lib/checks/microarch.mjs';
import { checkMicroarchCoverage } from '../lib/checks/microarch-coverage.mjs';
import { buildFigure } from '../lib/deliver.mjs';
import { loadSkin } from '../lib/render/datapath.mjs';
import { assignRows, renderMicroarch } from '../lib/render/microarch.mjs';
import { crosscheckSoc } from '../lib/rtl/crosscheck.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'examples', 'microarch-accelerator-shell.json');
const fixture = () => JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const codes = (diags, severity = 'error') => diags.filter((d) => d.severity === severity).map((d) => d.code);

// attributes of the element with this id in a serialized SVG
const attrsOf = (svg, id) => {
  const m = new RegExp(`<[a-z]+ id="${id}"([^>]*)>`).exec(svg);
  if (!m) return null;
  return Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
};
const rectOf = (svg, id) => {
  const a = attrsOf(svg, id);
  return a && { x0: Number(a.x), y0: Number(a.y), x1: Number(a.x) + Number(a.width), y1: Number(a.y) + Number(a.height) };
};

test('assignRows: each fabric has a row of its own; off-chip managers above, off-chip subordinates below', () => {
  const doc = fixture();
  const { fabricRow, blockRow, order } = assignRows(doc);
  assert.deepEqual(order, ['ctl', 'mem'], 'the fabric with an off-chip manager first, the one with off-chip subordinates last');
  assert.notEqual(fabricRow.get('ctl'), fabricRow.get('mem'));
  const barRows = new Set(fabricRow.values());
  for (const [id, r] of blockRow) assert.ok(!barRows.has(r), `block ${id} shares a row with a fabric bar`);
  assert.ok(blockRow.get('host') < fabricRow.get('ctl') && fabricRow.get('ctl') < blockRow.get('csr'));
  assert.ok(blockRow.get('mover') < fabricRow.get('mem') && fabricRow.get('mem') < blockRow.get('ext_mem'));
  assert.equal(blockRow.get('host'), 0);
  assert.equal(blockRow.get('ext_mem'), Math.max(...blockRow.values(), ...fabricRow.values()));

  // a bridge (subordinate upstream, manager downstream) orders its fabrics
  const bridged = {
    blocks: [{ id: 'cpu', kind: 'core' }, { id: 'br', kind: 'bridge' }, { id: 'uart', kind: 'peripheral' }],
    fabrics: [{ id: 'apb', protocol: 'APB' }, { id: 'ahb', protocol: 'AHB-Lite' }],
    attachments: [
      { id: 'a1', fabric: 'ahb', block: 'cpu', role: 'manager' }, { id: 'a2', fabric: 'ahb', block: 'br', role: 'subordinate' },
      { id: 'a3', fabric: 'apb', block: 'br', role: 'manager' }, { id: 'a4', fabric: 'apb', block: 'uart', role: 'subordinate' },
    ],
  };
  assert.deepEqual(assignRows(bridged).order, ['ahb', 'apb']);
});

test('accelerator shell delivers 2col with 0 errors: fabric bars on distinct rows, off-chip blocks outside the chip boundary', async () => {
  const doc = fixture();
  assert.deepEqual(await validateSchema('microarch', doc), []);
  const build = await buildFigure({ type: 'microarch', figurePath: fixturePath });
  assert.deepEqual(codes(build.diagnostics), []);
  assert.ok(build.ok);
  const two = build.artifacts.find((a) => a.id === '2col');
  assert.ok(two, '2col delivered');
  assert.equal(build.evidence.view.preset, 'overview');
  const { svg } = two;
  assert.doesNotMatch(JSON.stringify(build.diagnostics), /render\/row-conflict|label-overlap|marker-overlap|label-proximity/);

  const bars = ['ctl', 'mem'].map((f) => rectOf(svg, `fabric-${f}-body`));
  assert.ok(bars[0].y1 <= bars[1].y0 || bars[1].y1 <= bars[0].y0, 'bars never share a row');
  for (const b of doc.blocks) {
    const r = rectOf(svg, `block-${b.id}-body`);
    for (const bar of bars) assert.ok(r.y1 <= bar.y0 || r.y0 >= bar.y1, `block ${b.id} overlaps a bar row`);
  }
  const chip = rectOf(svg, 'group-kernel-outline0');
  for (const id of ['host', 'ext_mem']) {
    const r = rectOf(svg, `block-${id}-body`);
    const disjoint = r.x1 <= chip.x0 || r.x0 >= chip.x1 || r.y1 <= chip.y0 || r.y0 >= chip.y1;
    assert.ok(disjoint, `off-chip ${id} is outside the chip boundary`);
  }
  for (const id of ['csr', 'in_sel', 'core', 'fifo', 'mover']) {
    const r = rectOf(svg, `block-${id}-body`);
    assert.ok(r.x0 >= chip.x0 && r.x1 <= chip.x1 && r.y0 >= chip.y0 && r.y1 <= chip.y1, `${id} inside the chip boundary`);
  }
});

test('stream interfaces are links with an open head, never bars; widths, dashes and arrowheads come from the skin', async () => {
  const skin = loadSkin();
  const t = skin.tokens;
  const r = await renderMicroarch(fixture(), { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, skin });
  assert.deepEqual(codes(r.diagnostics), []);
  assert.doesNotMatch(r.svg, /id="fabric-s_in/);
  assert.equal(attrsOf(r.svg, 'link-s_in-arrow').fill, 'none', 'open arrowhead on a stream');
  assert.notEqual(attrsOf(r.svg, 'link-l_in-arrow').fill, 'none', 'filled arrowhead on a data link');
  assert.match(r.svg, /id="legend-class-stream-head"/);
  const control = attrsOf(r.svg, 'link-l_start-seg0');
  assert.equal(Number(control['stroke-width']), t.stroke.control);
  assert.equal(control['stroke-dasharray'], t.dash.control.join(' '));
  assert.equal(Number(attrsOf(r.svg, 'link-s_in-seg0')['stroke-width']), t.stroke.wire);
  assert.equal(attrsOf(r.svg, 'group-kernel-outline0')['stroke-dasharray'], t.dash.boundary.join(' '));
  // every arrowhead in the figure has the skin's length (never shortened to fit)
  const heads = [...r.svg.matchAll(/id="((?:link|att)-[^"]+-arrow\d*)" d="M([\d.-]+) ([\d.-]+) L([\d.-]+) ([\d.-]+) L([\d.-]+) ([\d.-]+)/g)];
  assert.ok(heads.length >= 10);
  for (const m of heads) {
    const [bx, by] = [(Number(m[2]) + Number(m[6])) / 2, (Number(m[3]) + Number(m[7])) / 2];
    assert.ok(Math.abs(Math.hypot(Number(m[4]) - bx, Number(m[5]) - by) - t.arrow.length) < 0.02, `${m[1]} has the skin arrow length`);
  }
  // a DMA link takes the emphasis stroke token
  const dma = fixture();
  dma.links.push({ id: 'l_dma', from: 'mover', to: 'core', class: 'dma' });
  const rd = await renderMicroarch(dma, { variant: '2col', widthPt: 1000, skin });
  assert.equal(Number(attrsOf(rd.svg, 'link-l_dma-seg0')['stroke-width']), t.stroke.emphasis);
});

test('microarch storage uses the RS house style: hatched memories and gray register banks', async () => {
  const doc = {
    schema_version: 1,
    figure_type: 'microarch',
    meta: { title: 'storage style', print: { profile: 'ieee', variants: ['2col'] } },
    blocks: [
      { id: 'mem', kind: 'memory', label: 'History memory' },
      { id: 'regs', kind: 'register_file', label: 'Pipeline registers' },
    ],
    links: [{ id: 'read', from: 'mem', to: 'regs', class: 'data', width: 8 }],
  };
  const skin = loadSkin();
  const r = await renderMicroarch(doc, { variant: '2col', widthPt: 515.5, maxHeightPt: 230.4, skin });
  assert.equal(attrsOf(r.svg, 'block-mem-body').fill, skin.tokens.fill.logic);
  assert.match(r.svg, /id="block-mem-hatch"/);
  assert.equal(attrsOf(r.svg, 'block-regs-body').fill, skin.tokens.fill.storage);
  assert.match(r.svg, /id="block-regs-body"[^>]*fill="#D9D9D9"/);
});

test('semantic rules: one top claim, off-chip never in a chip group, streams are interfaces, interface endpoints', () => {
  const doc = fixture();
  assert.deepEqual(codes(checkMicroarch(doc).diagnostics), []);

  const claims = fixture();
  for (const id of ['csr', 'in_sel']) claims.blocks.find((b) => b.id === id).rtl = { top: true };
  assert.ok(codes(checkMicroarch(claims).diagnostics).includes('soc/top-claimed'));
  claims.blocks.find((b) => b.id === 'csr').rtl.covers = ['c_*'];
  claims.blocks.find((b) => b.id === 'in_sel').rtl.covers = ['in_*'];
  assert.ok(!codes(checkMicroarch(claims).diagnostics).includes('soc/top-claimed'), 'covers say which part each block draws');

  const inside = fixture();
  inside.groups[0].members.push('host');
  assert.ok(codes(checkMicroarch(inside).diagnostics).includes('group/offchip-member'));

  const asFabric = fixture();
  asFabric.fabrics.push({ id: 'st', protocol: 'AXI4-Stream' });
  asFabric.attachments.push({ id: 'a_st', fabric: 'st', block: 'fifo', role: 'manager' });
  assert.ok(codes(checkMicroarch(asFabric).diagnostics, 'warning').includes('soc/stream-as-fabric'));

  const loop = fixture();
  loop.interfaces[0].to = 'host';
  assert.ok(codes(checkMicroarch(loop).diagnostics).includes('interface/endpoints'));
  const unknown = fixture();
  unknown.interfaces[0].to = 'nobody';
  assert.ok(codes(checkMicroarch(unknown).diagnostics).includes('soc/unknown-ref'));
});

test('view: the caption states the preset and scope (warning; error under --quality paper)', async () => {
  const doc = fixture();
  doc.meta.caption = 'An accelerator shell.';
  assert.ok(codes(checkMicroarch(doc).diagnostics, 'warning').includes('view/caption'));
  assert.ok(codes(checkMicroarch(doc, { quality: 'paper' }).diagnostics).includes('view/caption'));
  const bad = fixture();
  bad.view.preset = 'block';
  assert.ok((await validateSchema('microarch', bad)).length, 'microarch takes overview or detail only');
});

// Hand-built netlist: a top with two control registers, an input mux net,
// two child instances and an AXI4-Stream sink port set.
const shellNetlist = () => ({
  hierarchy: [{ path: 'shell_top', module: 'shell_top' }, { path: 'shell_top.u_fifo', module: 'fifo_m' }, { path: 'shell_top.u_core', module: 'core_m' }],
  modules: [
    {
      name: 'shell_top', orig_name: 'shell_top',
      ports: [{ name: 'clk', dir: 'in', width: 1 }, { name: 's_axis_tvalid', dir: 'in', width: 1 }, { name: 's_axis_tready', dir: 'out', width: 1 }, { name: 's_axis_tdata', dir: 'in', width: 8 }],
      nets: ['clk', 'c_start', 'c_len', 'in_data', 's_axis_tvalid', 's_axis_tready', 's_axis_tdata'].map((name) => ({ name, width: name === 'c_len' ? 16 : 1 })),
      registers: [{ name: 'c_start', clock: { net: 'clk' } }, { name: 'c_len', clock: { net: 'clk' } }],
      instances: [{ name: 'u_fifo', module: 'fifo_m', connections: [] }, { name: 'u_core', module: 'core_m', connections: [] }],
      deps: [],
    },
    { name: 'fifo_m', orig_name: 'fifo_m', ports: [], nets: [{ name: 'q', width: 8 }], registers: [{ name: 'q', clock: { net: 'clk' } }], instances: [], deps: [] },
    { name: 'core_m', orig_name: 'core_m', ports: [], nets: [], registers: [], instances: [], deps: [] },
  ],
});

test('microarch coverage: every instance and top register is represented by a block (rtl.instance or rtl.covers)', () => {
  const doc = fixture();
  doc.blocks.find((b) => b.id === 'csr').rtl = { top: true, covers: ['c_*'] };
  doc.blocks.find((b) => b.id === 'in_sel').rtl = { top: true, covers: ['in_*'] };
  doc.blocks.find((b) => b.id === 'fifo').rtl = { instance: 'u_fifo' };
  const partial = checkMicroarchCoverage(doc, shellNetlist());
  const dropped = partial.diagnostics.filter((d) => d.code === 'coverage/dropped-hardware');
  assert.equal(dropped.length, 1);
  assert.deepEqual(dropped[0].evidence.missing, ['u_core']);
  assert.deepEqual(partial.report.totals.registers, { covered: 2, total: 2 });
  assert.deepEqual(partial.report.totals.instances, { covered: 1, total: 2 });

  doc.blocks.find((b) => b.id === 'core').rtl = { instance: 'u_core' };
  const full = checkMicroarchCoverage(doc, shellNetlist());
  assert.deepEqual(codes(full.diagnostics), []);
  doc.blocks.find((b) => b.id === 'mover').rtl = { top: true, covers: ['nothing_here*'] };
  assert.ok(codes(checkMicroarchCoverage(doc, shellNetlist()).diagnostics, 'warning').includes('coverage/covers-unmatched'));

  const uncovered = fixture();
  uncovered.blocks.find((b) => b.id === 'fifo').rtl = { instance: 'u_fifo' };
  uncovered.blocks.find((b) => b.id === 'core').rtl = { instance: 'u_core' };
  const regs = checkMicroarchCoverage(uncovered, shellNetlist()).diagnostics.find((d) => d.evidence.kind === 'register');
  assert.deepEqual(regs.evidence.missing, ['shell_top:c_start', 'shell_top:c_len']);
});

test('stream interface cross-check: tvalid/tready/tdata exist with the direction of each end and the drawn width', () => {
  const base = () => {
    const doc = fixture();
    doc.interfaces[0].rtl = { to: { top: true, prefix: 's_axis_' } };
    return doc;
  };
  const ok = crosscheckSoc(base(), shellNetlist());
  assert.deepEqual(codes(ok.diagnostics), []);
  assert.equal(ok.stats.streamEndsChecked, 1);

  const wide = base();
  wide.interfaces[0].data_width = 16;
  assert.ok(codes(crosscheckSoc(wide, shellNetlist()).diagnostics).includes('rtl/stream-width'));
  const flipped = base();
  flipped.interfaces[0].rtl = { from: { top: true, prefix: 's_axis_' } };
  assert.ok(codes(crosscheckSoc(flipped, shellNetlist()).diagnostics).includes('rtl/stream-direction'));
  const missing = base();
  missing.interfaces[0].rtl.to.prefix = 'm_axis_';
  assert.ok(codes(crosscheckSoc(missing, shellNetlist()).diagnostics).includes('rtl/stream-port-missing'));
});
