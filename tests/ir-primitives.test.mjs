import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEndpoint, formatEndpoint } from '../lib/ir/endpoints.mjs';
import { clog2, evalWidth, muxSelWidth } from '../lib/ir/width.mjs';

test('clog2 and mux select widths', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 16, 17].map(clog2), [0, 1, 2, 2, 3, 4, 5]);
  assert.equal(muxSelWidth(2), 1);
  assert.equal(muxSelWidth(3), 2);
  assert.equal(muxSelWidth(4), 2);
  assert.equal(muxSelWidth(5), 3);
  assert.equal(muxSelWidth(6, 'onehot'), 6);
});

test('width expressions evaluate over params without eval', () => {
  const params = { DATA_W: 32, ECC_W: 16, DEPTH: 16 };
  assert.equal(evalWidth(8), 8);
  assert.equal(evalWidth('DATA_W+ECC_W', params), 48);
  assert.equal(evalWidth('clog2(DEPTH)', params), 4);
  assert.equal(evalWidth('max(DATA_W, ECC_W*3)/2', params), 24);
  assert.throws(() => evalWidth('NOPE+1', params), (e) => e.code === 'ir/unknown-param' && e.param === 'NOPE');
  assert.throws(() => evalWidth('process.exit()', params));
});

test('endpoint parsing round-trips', () => {
  for (const text of ['hclk', 'u_mux.in1', 'reg_s1.q[7:0]', 'u_ecc/u_dec.valid_i', 'p1.q_data[3]']) {
    assert.equal(formatEndpoint(parseEndpoint(text)), text);
  }
  const e = parseEndpoint('u_ecc/u_dec.sym[15:8]');
  assert.deepEqual(e.path, ['u_ecc', 'u_dec']);
  assert.equal(e.port, 'sym');
  assert.deepEqual(e.slice, { msb: 15, lsb: 8, width: 8, valid: true });
  assert.equal(parseEndpoint('bad..port'), null);
  assert.equal(parseEndpoint('x.y[3:7]').slice.valid, false);
});
