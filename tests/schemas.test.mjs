import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateFigure, validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examples = path.join(root, 'examples');
const load = (name) => JSON.parse(fs.readFileSync(path.join(examples, name), 'utf8'));

for (const file of fs.readdirSync(examples).filter((f) => f.endsWith('.json')).sort()) {
  test(`example ${file} passes its schema`, async () => {
    const doc = load(file);
    const result = await validateFigure(doc.figure_type, doc);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.ok, true);
  });
}

test('unknown fields are rejected (additionalProperties/unevaluatedProperties)', async () => {
  const doc = load('datapath-pipelined-xor.json');
  doc.elements[4].sel_width_guess = 3;
  const result = await validateFigure('datapath', doc);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.subject.path === '/elements/4'));
});

test('mux requires inputs >= 2', async () => {
  const doc = load('datapath-pipelined-xor.json');
  doc.elements[4].inputs = 1;
  const result = await validateFigure('datapath', doc);
  assert.equal(result.ok, false);
});

test('endpoint grammar is enforced by schema', async () => {
  const doc = load('datapath-pipelined-xor.json');
  doc.nets[0].driver = 'a..out';
  assert.equal((await validateFigure('datapath', doc)).ok, false);
});

test('source pins must be repo-relative without dot segments', async () => {
  const doc = load('datapath-pipelined-xor.json');
  doc.elements[5].source = { file: '../outside.sv', line: 3 };
  assert.equal((await validateFigure('datapath', doc)).ok, false);
  doc.elements[5].source = { file: 'rtl/inside.sv', line: 3 };
  assert.equal((await validateFigure('datapath', doc)).ok, true);
});

test('timing input is WaveJSON; unknown WaveDrom keys and bad wave characters are rejected', async () => {
  const doc = load('timing-valid-ready.json');
  delete doc.wavejson;
  assert.equal((await validateFigure('timing', doc)).ok, false);

  const skin = load('timing-valid-ready.json');
  skin.wavejson.config.skin = 'narrow';
  assert.equal((await validateFigure('timing', skin)).ok, false);

  const wave = load('timing-valid-ready.json');
  wave.wavejson.signal[0].wave = 'p..q....';
  assert.equal((await validateFigure('timing', wave)).ok, false);

  const minimal = { schema_version: 1, figure_type: 'timing', meta: { title: 't', print: { profile: 'acm' } },
    wavejson: { signal: [{ name: 'clk', wave: 'p...' }, {}, ['grp', { name: 'x', wave: '01.0' }]] } };
  assert.deepEqual((await validateFigure('timing', minimal)).diagnostics, []);
});

test('validate reports semantic checks as not implemented (truthful coverage)', async () => {
  const result = await validateFigure('fsm', load('fsm-run-flush.json'));
  assert.equal(result.checks.semantic.status, 'not-implemented');
  assert.ok(result.checks.semantic.planned.includes('fsm/unreachable'));
});

test('rtl-netlist schema rejects a non-conforming adapter result', async () => {
  const diagnostics = await validateSchema('rtl-netlist', { schema_version: 1, kind: 'rtl-netlist' });
  assert.ok(diagnostics.length > 0);
});
