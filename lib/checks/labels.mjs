// Readable functional names (CONVENTIONS §4.3, SPEC §8): printed primary
// labels must name WHAT a block is, not an RTL identifier, a mnemonic or math
// shorthand; two blocks may not share a primary name unless they are declared
// stages of one function; width labels are single integers or symbols, never
// products. Readability issues are warnings by default and errors under
// --quality paper; duplicates and product notation are always errors.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostic } from '../diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VOCABULARY = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'function-vocabulary.json'), 'utf8'));
const WELL_KNOWN = new Set(VOCABULARY.well_known_symbols);

// Printed primary name, 1col short word and detail of a function spec.
export function functionNames(fn) {
  if (!fn) return null;
  const entry = VOCABULARY.kinds[fn.kind];
  if (!entry) return null;
  const stage = fn.stage ? ` (stage ${fn.stage})` : '';
  if (fn.kind === 'custom') return { display: `${fn.name}${stage}`, short: `${fn.short_name ?? fn.name}${fn.stage ? ` ${fn.stage}` : ''}`, glyph: null, detail: fn.detail };
  const qualified = fn.qualifier && entry.qualified ? entry.qualified.replace('{q}', fn.qualifier) : null;
  const base = qualified ?? (fn.stage && entry.stage_display ? entry.stage_display : entry.display);
  // A short qualified name ("Data memory") stays the short word too, so two
  // qualified blocks never collapse to the same label in narrow variants.
  const short = qualified && qualified.length <= 14 ? qualified : (entry.short ?? entry.display);
  return { display: `${base}${stage}`, short: `${short}${fn.stage ? ` ${fn.stage}` : ''}`, glyph: entry.glyph ?? null, detail: fn.detail };
}

// Returns the reason a printed label is unreadable, or null.
export function unreadableReason(label) {
  const text = String(label ?? '').trim();
  if (!text || WELL_KNOWN.has(text)) return null;
  if (/^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/.test(text)) return /_(i|o|q|d|n|r|w|in|out)$/i.test(text) ? 'raw RTL port/register name (trailing _i/_o/_q)' : 'raw snake_case identifier';
  if (/^[A-Za-z]\w*(\^\w+)?\s*\/\s*[A-Za-z]\w*(\^\w+)?$/.test(text)) return 'bare math ratio';
  if (/\w\s*\.\.\s*\w/.test(text)) return 'index range';
  if (/\^/.test(text) || /^[=!<>]=/.test(text) || /^\w{1,2}\s*=\s*\S/.test(text)) return 'math shorthand';
  // Abbreviated words ("Pos.", "Calc.", "Ctrl."): write the word out and let the block wrap.
  const abbrev = text.match(/(?<![\w.])[A-Za-z]{1,6}\.(?=\s|$|\))/);
  if (abbrev && !/^(?:e\.g|i\.e|etc|vs)\.$/i.test(abbrev[0])) return `abbreviated word "${abbrev[0]}"`;
  if (text.replace(/\s/g, '').length <= 3) return 'mnemonic of 3 characters or fewer';
  return null;
}

// A width written as a product (6×8, 6 x 8-bit, 4*16) instead of one number.
export const PRODUCT_NOTATION = /\b\d+\s*[×xX*]\s*\d+(?:\s*-?\s*bits?)?\b/;

const SUGGEST = 'set function.kind from the vocabulary (e.g. syndrome, error_locator, error_evaluator, position_match, classifier, comparator, zero_detect, gf_mul, adder, controller, memory) and drop the label, or write a functional name';

function suggestionFor(fn) {
  const names = functionNames(fn);
  return names?.display ? `use the functional name "${names.display}" (remove label) and put algorithm detail in function.detail` : SUGGEST;
}

// Printed primary (full-layout) name of a datapath element, or null for
// symbols without text.
export function primaryName(e) {
  const names = functionNames(e.function);
  if (e.kind === 'port' || e.kind === 'const' || e.kind === 'mux' || e.kind === 'register' || e.kind === 'pipeline_register') return null;
  if (e.kind === 'comb' && ['concat', 'split', 'extend', 'replicate'].includes(e.op)) return null;
  if (names?.glyph && !e.label) return null;
  return e.label ?? names?.display ?? null;
}

export function checkLabels(doc, type, { quality } = {}) {
  const diagnostics = [];
  const severity = quality === 'paper' ? 'error' : 'warning';
  const check = (subject, field, text, fn) => {
    const reason = unreadableReason(text);
    if (!reason) return;
    diagnostics.push(diagnostic({ code: 'label/unreadable', severity, message: `${subject.what} ${subject.id}: ${field} "${text}" is not a readable functional name (${reason})`, subject: { id: subject.id, field }, evidence: { label: text, reason }, supportedFixes: [suggestionFor(fn)] }));
  };
  const product = (what, id, field, text) => {
    if (!PRODUCT_NOTATION.test(String(text ?? ''))) return;
    diagnostics.push(diagnostic({ code: 'width/product-notation', severity: 'error', message: `${what} ${id}: ${field} "${text}" writes a width as a product; width labels are one integer or symbol (e.g. 48, W)`, subject: { id, field }, evidence: { label: text }, supportedFixes: ['write the total width', 'put symbol structure (N symbols of W bits) in the caption or function.detail'] }));
  };
  // CONVENTIONS §3.5 D3: labels starting with [ or { are reserved for slices,
  // concatenation and replication; a net or port name must not use them.
  const reserved = (what, id, field, text) => {
    if (!/^[[{]/.test(String(text ?? '').trim())) return;
    diagnostics.push(diagnostic({ code: 'label/reserved-prefix', severity: 'error', message: `${what} ${id}: ${field} "${text}" starts with a reserved character ([ is for bit slices, { for concatenation/replication)`, subject: { id, field }, evidence: { label: text }, supportedFixes: ['rename the label', 'model the slice/concatenation as a split/concat element'] }));
  };
  if (type === 'datapath') {
    for (const e of doc.elements || []) if (e.kind === 'port') { reserved('port', e.id, 'label', e.label ?? e.id); if (e.short_label) reserved('port', e.id, 'short_label', e.short_label); }
    for (const n of doc.nets || []) {
      for (const field of ['label', 'short_label']) if (n[field]) { reserved('net', n.id, field, n[field]); product('net', n.id, field, n[field]); }
    }
    for (const e of doc.elements || []) {
      const what = e.kind;
      const names = functionNames(e.function);
      if (e.kind === 'mux') {
        for (const field of ['label', 'short_label']) if (e[field]) product('mux', e.id, field, e[field]);
        for (const [k, v] of Object.entries(e.input_labels || {})) product('mux', e.id, `input_labels.${k}`, v);
        continue;
      }
      if (e.kind === 'port') {
        check({ what, id: e.id }, e.label ? 'label' : 'label (defaulted from id)', e.label ?? e.id);
        if (e.short_label) check({ what, id: e.id }, 'short_label', e.short_label);
        continue;
      }
      if (e.kind === 'const' || (e.kind === 'comb' && ['concat', 'split'].includes(e.op))) continue;
      if (names?.glyph && !e.label) continue; // the glyph is the name
      if (e.kind === 'comb' && e.op !== 'custom' && !e.label && !e.function) continue; // operator / gate symbol, no text
      if (e.label) check({ what, id: e.id }, 'label', e.label, e.function);
      if (e.short_label) check({ what, id: e.id }, 'short_label', e.short_label, e.function);
      // Names printed from the vocabulary follow the same rule.
      if (!e.label && names?.display) check({ what, id: e.id }, 'printed name (function)', names.display);
      if (!e.short_label && names?.short && names.short !== names.display) check({ what, id: e.id }, 'short name (function)', names.short);
    }
    // Two blocks with the same primary name are ambiguous unless they are
    // declared stages of one function (function.stage), which the renderer
    // suffixes with "(stage k/n)".
    const byName = new Map();
    for (const e of doc.elements || []) {
      const name = primaryName(e);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(e);
    }
    for (const [name, list] of byName) {
      if (list.length < 2) continue;
      diagnostics.push(diagnostic({ code: 'label/duplicate', severity: 'error', message: `${list.length} blocks share the primary name "${name}" (${list.map((x) => x.id).join(', ')})`, subject: { ids: list.map((x) => x.id) }, evidence: { name }, supportedFixes: ['if they are stages of one function, set function.stage ("1/2", "2/2")', 'give each block its own functional name', 'merge them into one block'] }));
    }
    for (const n of doc.nets || []) for (const field of ['label', 'short_label']) if (n[field]) check({ what: 'net', id: n.id }, field, n[field]);
    for (const r of doc.regions || []) {
      if (r.label) check({ what: 'region', id: r.id }, 'label', r.label);
      if (r.short_label) check({ what: 'region', id: r.id }, 'short_label', r.short_label);
    }
  } else if (type === 'microarch') {
    for (const b of doc.blocks || []) {
      check({ what: 'block', id: b.id }, b.label ? 'label' : 'label (defaulted from id)', b.label ?? b.id);
      if (b.short_label) check({ what: 'block', id: b.id }, 'short_label', b.short_label);
    }
  }
  return diagnostics;
}
