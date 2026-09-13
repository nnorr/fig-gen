// Review round 3: connector names are unique per figure and a connector never
// feeds a figure output directly; dead logic is not drawn but listed; the
// output latency table has one line per block; a study figure that reads badly
// tries layout alternatives and keeps one only if it improves.

import assert from 'node:assert/strict';
import test from 'node:test';
import { STAGE_TABLE_ROWS, connectorNames, loadSkin, renderDatapath, stageTableRows } from '../lib/render/datapath.mjs';

const block = (id, name, ins, outs) => ({ id, kind: 'comb', op: 'custom', width: 1, function: { kind: 'custom', name }, ports: [...ins.map((p) => ({ id: p, dir: 'in', width: 1 })), ...outs.map((p) => ({ id: p, dir: 'out', width: 1 }))] });
const figure = (elements, nets, extra = {}) => ({ schema_version: 1, figure_type: 'datapath', meta: { title: 't', print: { profile: 'ieee' } }, clock_domains: [], elements, nets, ...extra });

test('connector names are unique per figure: colliding names are qualified with the source instance, numbered only as a last resort', () => {
  const net = (id, signal, instance) => ({ id, width: 1, driver: 'a.o', sinks: ['b.i'], rtl: { instance, signal } });
  const doc = { elements: [], nets: [
    net('n1', 'start_ready_o', 'u_nonce_client/u_stream_client'),
    net('n2', 'start_ready_o', 'u_sampler_client/u_stream_client'),
    net('n3', 'start_ready_o', 'u_h2p_client'),
    net('n4', 'busy_o', 'u_engine'),
    net('n5', 'state', 'u_x'),
    net('n6', 'state', 'u_x'),
  ] };
  const names = connectorNames(doc, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  assert.deepEqual([...names.values()], ['Nonce client: start ready', 'Sampler client: start ready', 'H2P client: start ready', 'Engine: busy', 'X: state 1', 'X: state 2']);
});

test('connector/ambiguous-name and connector/redundant-port are errors on the drawn figure', async () => {
  const doc = figure([
    { id: 'in', kind: 'port', dir: 'in', width: 1, label: 'value in' },
    block('p', 'Producer', ['i'], ['o1', 'o2']),
    { id: 'cx_n1', kind: 'port', dir: 'out', width: 1, label: 'ready', connector: 'source' },
    { id: 'cx_n2', kind: 'port', dir: 'out', width: 1, label: 'ready', connector: 'source' },
    { id: 'cx_n2_to0', kind: 'port', dir: 'in', width: 1, label: 'ready', connector: 'target' },
    { id: 'out', kind: 'port', dir: 'out', width: 1, label: 'result' },
  ], [
    { id: 'n_in', width: 1, driver: 'in', sinks: ['p.i'] },
    { id: 'n1', width: 1, driver: 'p.o1', sinks: ['cx_n1'] },
    { id: 'n2', width: 1, driver: 'p.o2', sinks: ['cx_n2'] },
    { id: 'n2__cx0', width: 1, driver: 'cx_n2_to0', sinks: ['out'] },
  ], { meta: { title: 't', print: { profile: 'ieee' }, style: { connectors: false } } });
  const r = await renderDatapath(doc, { variant: '2col', widthPt: 515.5, name: 'tags' });
  const ambiguous = r.diagnostics.filter((d) => d.code === 'connector/ambiguous-name');
  assert.equal(ambiguous.length, 1);
  assert.deepEqual([ambiguous[0].severity, ambiguous[0].evidence.nets], ['error', ['n1', 'n2']]);
  const redundant = r.diagnostics.filter((d) => d.code === 'connector/redundant-port');
  assert.deepEqual(redundant.map((d) => [d.severity, d.subject.id]), [['error', 'out']]);
});

test('the output latency table has one line per block, grouped by latency, wrapped and split into columns', () => {
  const entries = [
    ...['start ready', 'absorb ready', 'done'].map((output, i) => ({ element: 'nc', block: 'Nonce client controller', output, pin: `p${i}`, latency: i === 2 ? 1 : 2 })),
    { element: 'oc', block: 'Owner controller', output: 'client ready', pin: 'q', latency: 1 },
  ];
  assert.deepEqual(stageTableRows(entries), ['Nonce client controller: 1 stage: done; 2 stages: start ready, absorb ready', 'Owner controller: 1 stage: client ready']);
  const long = Array.from({ length: 12 }, (_, i) => ({ element: 'w', block: 'Wide block', output: `output number ${i}`, pin: `w${i}`, latency: 1 + (i % 4) }));
  const rows = stageTableRows(long, { maxChars: 60 });
  assert.ok(rows.length > 1 && rows.slice(1).every((r) => r.startsWith('    ')), 'long lines continue indented');
  assert.equal(STAGE_TABLE_ROWS, 16);
});

test('dead logic is not drawn as a block and coverage lists it as excluded dead logic', async () => {
  const { draftFigure } = await import('../lib/draft.mjs');
  const { draftResiduals } = await import('../lib/draft-check.mjs');
  const { checkCoverage } = await import('../lib/checks/coverage.mjs');
  const port = (name, dir, width = 1) => ({ name, dir, width });
  const net = (name, width = 1, kind = 'port') => ({ name, width, kind });
  const ref = (name) => ({ op: 'ref', name });
  const nl = {
    schema_version: 1, kind: 'rtl-netlist', adapter: { id: 'test', version: '0' }, top: 'top', diagnostics: [], hierarchy: [{ path: 'top', module: 'top' }],
    modules: [{
      name: 'top', orig_name: 'top',
      ports: [port('a', 'in'), port('b', 'in'), port('c', 'in'), port('y', 'out'), port('z', 'out'), port('w', 'out'), port('v', 'out'), port('u', 'out')],
      nets: [net('a'), net('b'), net('c'), net('y'), net('z'), net('w'), net('v'), net('u'), net('unused_outputs', 1, 'wire')],
      registers: [], instances: [],
      deps: [
        { target: 'y', sources: ['a'], kind: 'comb' }, { target: 'z', sources: ['b'], kind: 'comb' }, { target: 'w', sources: ['c'], kind: 'comb' },
        { target: 'v', sources: ['a', 'b'], kind: 'comb' }, { target: 'u', sources: ['b', 'c'], kind: 'comb' },
        { target: 'unused_outputs', sources: ['a', 'b', 'c'], kind: 'comb' },
      ],
      exprs: [
        { target: 'y', expr: { op: 'not', args: [ref('a')] } }, { target: 'z', expr: { op: 'not', args: [ref('b')] } }, { target: 'w', expr: { op: 'not', args: [ref('c')] } },
        { target: 'v', expr: { op: 'and', args: [ref('a'), ref('b')] } }, { target: 'u', expr: { op: 'or', args: [ref('b'), ref('c')] } },
        { target: 'unused_outputs', expr: { op: 'or', args: [ref('a'), ref('b'), ref('c')] } },
      ],
    }],
  };
  for (const format of [undefined, 'study']) {
    const { doc, notes } = draftFigure(nl, { format, preset: 'block', scope: '' });
    assert.ok(!doc.elements.some((e) => (e.rtl?.covers || []).includes('unused_outputs')), `${format ?? 'paper'}: no block covers the dead signal`);
    assert.ok(!doc.elements.some((e) => /unused logic/i.test(e.function?.name ?? '')));
    assert.ok(notes.some((n) => /unused_outputs: drives nothing in scope; dead logic, not drawn/.test(n)));
    assert.deepEqual((await draftResiduals(doc, nl)).filter((r) => r.code.startsWith('coverage/')), []);
    assert.ok(checkCoverage(doc, nl).report.excluded.dead_logic.includes('top:unused_outputs'), 'listed as excluded dead logic');
  }
});

test('a study figure that warns route/readability tries the layout alternatives and keeps one only if crossings per net drop', async () => {
  const skin = structuredClone(loadSkin());
  skin.tokens.route.readability = { max_crossings_per_net: -1, max_wire_length_ratio: 99 };
  const doc = figure([
    { id: 'in', kind: 'port', dir: 'in', width: 1, label: 'request in' },
    block('l', 'Owner logic', ['i', 'fb'], ['o', 'q']), block('s', 'Owner state', ['i'], ['o']), block('c', 'Owner controller', ['i', 'j'], ['o']),
    block('e', 'Engine logic', ['i'], ['o']),
    { id: 'out', kind: 'port', dir: 'out', width: 1, label: 'response out' },
  ], [
    { id: 'n0', width: 1, driver: 'in', sinks: ['l.i'] },
    { id: 'n1', width: 1, driver: 'l.o', sinks: ['s.i', 'c.j'] },
    { id: 'n2', width: 1, driver: 's.o', sinks: ['c.i'] },
    { id: 'n3', width: 1, driver: 'c.o', sinks: ['l.fb', 'e.i'] },
    { id: 'n4', width: 1, driver: 'l.q', sinks: ['out'] },
    { id: 'n5', width: 1, driver: 'e.o', sinks: [] },
  ].filter((n) => n.sinks.length), { regions: [{ id: 'r_owner', label: 'Owner', level: 'block', members: ['l', 's', 'c'] }, { id: 'r_engine', label: 'Engine', level: 'block', members: ['e'] }] });
  const r = await renderDatapath(doc, { variant: 'study', name: 'alts', skin });
  const tried = r.route.layout_alternatives;
  assert.deepEqual(tried.map((x) => x.layout), ['default', 'frame-flow', 'thorough']);
  assert.equal(tried.filter((x) => x.chosen).length, 1);
  const chosen = tried.find((x) => x.chosen);
  const base = tried[0];
  assert.ok(chosen.layout === 'default' || (chosen.crossings_per_net < base.crossings_per_net && chosen.errors <= base.errors), JSON.stringify(tried));
  assert.equal(r.route.readability.crossings_per_net, chosen.crossings_per_net);
});
