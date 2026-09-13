// A named heterogeneous bundle may fan out to sink pins that each take a named
// sub-bundle: no width mismatch when the distinct sub-bundles cover the bundle's
// width exactly; width/sub-bundle-cover when they do not; a plain net still
// reports width/mismatch.

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDatapath } from '../lib/checks/datapath.mjs';

const doc = ({ driverBundle = true, sinks = ['mem_a.ctrl', 'mem_b.ctrl', 'inj.ctl'] } = {}) => ({
  schema_version: 1,
  figure_type: 'datapath',
  meta: { title: 'sub-bundles', print: { profile: 'ieee' } },
  elements: [
    { id: 'slave', kind: 'instance', ports: [{ id: 'ctl', dir: 'out', width: 64, ...(driverBundle ? { bundle: ['inj_arm', 'inj_mask', 'mem_wen', 'mem_addr'] } : {}) }] },
    { id: 'inj', kind: 'instance', ports: [{ id: 'ctl', dir: 'in', width: 55, bundle: ['en', 'mask'] }] },
    { id: 'mem_a', kind: 'instance', ports: [{ id: 'ctrl', dir: 'in', width: 9, bundle: ['wen', 'addr'] }] },
    { id: 'mem_b', kind: 'instance', ports: [{ id: 'ctrl', dir: 'in', width: 9, bundle: ['wen', 'addr'] }] },
  ],
  nets: [{ id: 'n_ctl', width: 64, label: 'control', driver: 'slave.ctl', sinks }],
});
const codes = (d) => checkDatapath(d).diagnostics.filter((x) => x.severity === 'error').map((x) => x.code);

test('sub-bundle sinks that cover the bundle pass the width check', () => {
  const found = codes(doc());
  assert.ok(!found.includes('width/mismatch'), found.join(', '));
  assert.ok(!found.includes('width/sub-bundle-cover'), found.join(', '));
});

test('sub-bundle sinks that leave bits uncovered are reported', () => {
  const found = checkDatapath(doc({ sinks: ['mem_a.ctrl', 'mem_b.ctrl'] })).diagnostics.filter((x) => x.code === 'width/sub-bundle-cover');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.match(found[0].message, /9 of 64 bits/);
});

test('without a driver bundle the widths must match', () => {
  assert.ok(codes(doc({ driverBundle: false })).includes('width/mismatch'));
});
