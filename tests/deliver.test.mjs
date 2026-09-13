import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deliver } from '../lib/deliver.mjs';
import { pdfHasFonts } from '../lib/pdf.mjs';
import { lintFigmaSafe } from '../lib/svg/figma-safe-lint.mjs';
import { validateSchema } from '../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figgen-deliver-'));
const errors = (r) => r.diagnostics.filter((d) => d.severity === 'error');

test('datapath delivery writes 1col + 2col SVG/PDF and a valid receipt', async () => {
  const out = tmp();
  try {
    const r = await deliver({ type: 'datapath', figurePath: path.join(root, 'examples', 'datapath-pipelined-xor.json'), outDir: out });
    assert.deepEqual(errors(r), []);
    assert.equal(r.ok, true);
    const names = fs.readdirSync(out).sort();
    assert.deepEqual(names, ['datapath-pipelined-xor.1col.pdf', 'datapath-pipelined-xor.1col.svg', 'datapath-pipelined-xor.2col.pdf', 'datapath-pipelined-xor.2col.svg', 'datapath-pipelined-xor.receipt.json']);
    for (const n of names.filter((x) => x.endsWith('.svg'))) assert.deepEqual(lintFigmaSafe(fs.readFileSync(path.join(out, n), 'utf8')), []);
    for (const n of names.filter((x) => x.endsWith('.pdf'))) assert.equal(pdfHasFonts(fs.readFileSync(path.join(out, n))), false);
    const receipt = JSON.parse(fs.readFileSync(path.join(out, 'datapath-pipelined-xor.receipt.json'), 'utf8'));
    assert.deepEqual(await validateSchema('receipt', receipt), []);
    assert.equal(receipt.verification.level, 'unverified');
    assert.equal(receipt.variants.find((v) => v.id === '1col').svg.width_pt, 252);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('microarch delivery includes the address-map table figures', async () => {
  const out = tmp();
  try {
    const r = await deliver({ type: 'microarch', figurePath: path.join(root, 'examples', 'microarch-soc-accelerator.json'), outDir: out });
    assert.deepEqual(errors(r), []);
    const names = fs.readdirSync(out);
    for (const v of ['1col', '2col']) {
      assert.ok(names.includes(`microarch-soc-accelerator.${v}.svg`));
      assert.ok(names.includes(`microarch-soc-accelerator.addrmap.${v}.pdf`));
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a failing figure writes nothing', async () => {
  const out = tmp();
  const bad = path.join(out, 'bad.datapath.json');
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'datapath-theme-sample.json'), 'utf8'));
  doc.nets.find((n) => n.id === 'n_sel').width = 3;
  fs.writeFileSync(bad, JSON.stringify(doc));
  const target = path.join(out, 'delivered');
  try {
    const r = await deliver({ type: 'datapath', figurePath: bad, outDir: target });
    assert.equal(r.ok, false);
    assert.ok(errors(r).some((d) => d.code === 'mux/sel-width'));
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
