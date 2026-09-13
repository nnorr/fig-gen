import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostic } from './diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIGURE_TYPES = Object.freeze(['datapath', 'fsm', 'timing', 'microarch']);

let ajvInstance;

async function ajv() {
  if (ajvInstance) return ajvInstance;
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  // strictTuples off: WaveJSON groups are open tuples ["name", lane, lane, ...].
  const instance = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, strictTuples: false });
  for (const name of ['common', ...FIGURE_TYPES, 'rtl-netlist', 'receipt']) {
    instance.addSchema(JSON.parse(fs.readFileSync(path.join(root, 'schemas', `${name}.schema.json`), 'utf8')));
  }
  ajvInstance = instance;
  return instance;
}

export async function schemaValidator(name) {
  const instance = await ajv();
  const validate = instance.getSchema(`https://fig-gen.local/schemas/${name}.schema.json`);
  if (!validate) throw new Error(`no schema named ${name}`);
  return validate;
}

export async function validateSchema(name, document) {
  const validate = await schemaValidator(name);
  if (validate(document)) return [];
  return validate.errors.map((error) => diagnostic({
    code: 'schema/invalid',
    message: `${error.instancePath || '/'} ${error.message}`,
    subject: { path: error.instancePath || '/' },
    evidence: { keyword: error.keyword, params: error.params, schemaPath: error.schemaPath },
    supportedFixes: ['edit the field named in subject.path to satisfy the schema'],
  }));
}

// Semantic checks are registered per figure type. Phase 1 lists the catalog
// (SPEC §8) without implementations so `validate` reports coverage truthfully.
export const SEMANTIC_CHECKS = Object.freeze({
  datapath: ['ir/unknown-param', 'ir/duplicate-id', 'endpoint/unknown', 'endpoint/direction', 'endpoint/multiple-drivers',
    'width/mismatch', 'width/slice-range', 'mux/sel-width', 'mux/input-index', 'register/no-domain',
    'register/unknown-domain', 'memory/addr-width', 'comb/loop', 'cdc/unsynchronized', 'latency/stage-count', 'label/unreadable'],
  fsm: ['fsm/unreachable', 'fsm/encoding-width', 'fsm/encoding-duplicate', 'fsm/guard-parse', 'fsm/guard-unknown-identifier', 'fsm/output-kind', 'fsm/ambiguous-guards', 'fsm/unknown-state', 'fsm/duplicate-transition', 'label/unreadable'],
  timing: ['timing/wave-length', 'timing/clock-irregular', 'timing/bus-data-count', 'timing/bus-width-overflow', 'timing/latency-mismatch', 'timing/handshake-violation', 'timing/wavejson-unsupported', 'label/unreadable'],
  microarch: ['ir/duplicate-id', 'endpoint/unknown', 'label/unreadable'],
});

export async function validateFigure(type, document, { figureDir, quality } = {}) {
  if (!FIGURE_TYPES.includes(type)) {
    return { ok: false, diagnostics: [diagnostic({ code: 'input/figure-type', message: `unknown figure type '${type}'`, supportedFixes: [`use one of ${FIGURE_TYPES.join(', ')}`] })] };
  }
  const diagnostics = await validateSchema(type, document);
  if (!diagnostics.length && document.figure_type !== type) {
    diagnostics.push(diagnostic({ code: 'input/figure-type', message: `document figure_type '${document.figure_type}' does not match '${type}'` }));
  }
  const schemaOk = !diagnostics.length;
  let semantic = { status: 'not-implemented', planned: SEMANTIC_CHECKS[type] };
  if (schemaOk && (type === 'datapath' || type === 'microarch')) {
    const { checkDatapath } = await import('./checks/datapath.mjs');
    const { checkMicroarch } = await import('./checks/microarch.mjs');
    const { checkLabels } = await import('./checks/labels.mjs');
    const found = type === 'datapath' ? checkDatapath(document).diagnostics : checkMicroarch(document, { figureDir }).diagnostics;
    found.push(...checkLabels(document, type, { quality }));
    if (type === 'datapath') {
      const { checkNetClasses } = await import('./checks/net-class.mjs');
      found.push(...checkNetClasses(document).diagnostics);
    }
    diagnostics.push(...found);
    semantic = { status: found.some((d) => d.severity === 'error') ? 'fail' : 'pass', codes: SEMANTIC_CHECKS[type] };
  } else if (schemaOk && type === 'fsm') {
    const { checkFsm } = await import('./checks/fsm.mjs');
    const found = checkFsm(document, { quality }).diagnostics;
    diagnostics.push(...found);
    semantic = { status: found.some((d) => d.severity === 'error') ? 'fail' : 'pass', codes: SEMANTIC_CHECKS[type] };
  } else if (schemaOk && type === 'timing') {
    const { checkTiming } = await import('./checks/timing.mjs');
    const found = checkTiming(document, { figureDir, quality }).diagnostics;
    diagnostics.push(...found);
    semantic = { status: found.some((d) => d.severity === 'error') ? 'fail' : 'pass', codes: SEMANTIC_CHECKS[type] };
  } else if (!schemaOk) {
    semantic = { status: 'skipped (schema failed)', planned: SEMANTIC_CHECKS[type] };
  }
  const ok = !diagnostics.some((d) => d.severity === 'error');
  return {
    ok,
    checks: {
      schema: schemaOk ? 'pass' : 'fail',
      semantic,
      layout: 'run by render/deliver',
      print: 'run by render/deliver',
    },
    diagnostics,
  };
}
