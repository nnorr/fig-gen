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
  // qualified blocks never collapse to the same label in narrow variants. A
  // long one keeps its distinguishing words: "Nonce client controller" is
  // "Nonce client" when short, never the generic "Controller". A symbolic
  // qualifier (GF(2^8)) is not a name, so the vocabulary short word stays.
  // A one-word qualifier alone ("Main") names nothing, so it keeps the noun.
  const q = String(fn.qualifier ?? '').trim();
  const wordy = qualified && /^[A-Za-z][A-Za-z-]*(?: [A-Za-z-]+)+$/.test(q);
  const oneWord = qualified && /^[A-Za-z][A-Za-z-]*$/.test(q);
  const short = qualified && (qualified.length <= 14 || oneWord) ? qualified : wordy ? q : (entry.short ?? entry.display);
  return { display: `${base}${stage}`, short: `${short}${fn.stage ? ` ${fn.stage}` : ''}`, glyph: entry.glyph ?? null, detail: fn.detail };
}

// Returns the reason a printed label is unreadable, or null.
// RTL abbreviations a reader has to decode, with the word to write instead.
// Words the vocabulary itself prints ("GF mul") and well-known symbols are
// never flagged.
export const ABBREVIATIONS = Object.freeze({
  cmd: 'command', rsp: 'response', resp: 'response', req: 'request', ack: 'acknowledge', vld: 'valid', rdy: 'ready',
  cfg: 'configuration', ctrl: 'control', ctl: 'control', len: 'length', cnt: 'count', addr: 'address', ptr: 'pointer',
  idx: 'index', buf: 'buffer', sel: 'select', en: 'enable', wr: 'write', rd: 'read', stat: 'status', mgr: 'manager', ena: 'enable',
  re: 'real part', im: 'imaginary part', val: 'value', num: 'number', msg: 'message', pkt: 'packet', src: 'source', dst: 'destination',
  cur: 'current', prev: 'previous', nxt: 'next', tmp: 'temporary', clk: 'clock', rst: 'reset', intr: 'interrupt', sts: 'status',
  ovf: 'overflow', udf: 'underflow',
});

// A standalone word: letters and digits not joined to others by a hyphen
// ("re-encode" keeps its "re").
const WORD = /(?<![-A-Za-z0-9])[A-Za-z0-9]+(?![-A-Za-z0-9])/g;

// Replace dictionary abbreviations word by word ("rd ptr" → "read pointer").
export function expandAbbreviations(text) {
  return String(text ?? '').replace(WORD, (w) => (!WELL_KNOWN.has(w) && Object.hasOwn(ABBREVIATIONS, w.toLowerCase()) && !VOCABULARY_WORDS.has(w.toLowerCase()) ? ABBREVIATIONS[w.toLowerCase()] : w));
}

// Acronyms that stay uppercase when fig-gen makes a name readable.
export const ACRONYMS = Object.freeze(['AXI', 'AHB', 'APB', 'SHA', 'CRC', 'FIFO', 'SRAM', 'DRAM', 'ECC', 'IRQ', 'CSR', 'FSM', 'DDR', 'PCIe',
  'UART', 'SPI', 'I2C', 'GPIO', 'USB', 'DSP', 'CPU', 'GPU', 'RAM', 'ROM', 'LUT', 'PLL', 'ADC', 'DAC', 'MMU', 'TLB', 'AES', 'FFT', 'NTT', 'PHY', 'JTAG', 'SoC']);
const ACRONYM_BY_LOWER = new Map(ACRONYMS.map((a) => [a.toLowerCase(), a]));

// Casing of known acronyms (fifo → FIFO, pcie → PCIe) and of short RTL tokens
// with at least two letters and a digit (h2p → H2P, fp64 → FP64), which read as
// acronyms, not words. A single letter with an index (o0, s1, h2) and
// unit-like tokens (8b, 2x, 4k) keep their case.
export function acronymCase(text) {
  return String(text ?? '').replace(/[A-Za-z0-9]+/g, (w) => ACRONYM_BY_LOWER.get(w.toLowerCase())
    ?? (/^(?=.*\d)(?=(?:.*[A-Za-z]){2})[A-Za-z0-9]{3,4}$/.test(w) && !/^\d+[A-Za-z]{1,2}$/.test(w) ? w.toUpperCase() : w));
}

// A readable name from an RTL module or instance name, for names fig-gen
// generates (draft labels): underscores become spaces, abbreviations expand,
// acronyms keep their case, the first letter is capitalised.
export function readableName(name) {
  const s = acronymCase(expandAbbreviations(String(name ?? '').replace(/__.*$/, '').replace(/_+/g, ' ').trim()));
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
const VOCABULARY_WORDS = new Set(Object.values(VOCABULARY.kinds).flatMap((k) => [k.display, k.short, k.stage_display, k.qualified].filter(Boolean))
  .flatMap((s) => s.split(/[^A-Za-z0-9]+/)).filter(Boolean).map((w) => w.toLowerCase()));

// The first abbreviated word of a label, as { word, expansion }, or null.
export function abbreviationIn(label) {
  for (const word of String(label ?? '').match(WORD) ?? []) {
    if (WELL_KNOWN.has(word)) continue;
    const lower = word.toLowerCase();
    if (!Object.hasOwn(ABBREVIATIONS, lower) || VOCABULARY_WORDS.has(lower)) continue;
    return { word, expansion: ABBREVIATIONS[lower] };
  }
  return null;
}

export function unreadableReason(label) {
  const text = String(label ?? '').trim();
  if (!text || WELL_KNOWN.has(text)) return null;
  // snake_case is judged as a whole identifier below, not word by word.
  const abbreviation = /_/.test(text) ? null : abbreviationIn(text);
  if (/^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/.test(text)) return /_(i|o|q|d|n|r|w|in|out)$/i.test(text) ? 'raw RTL port/register name (trailing _i/_o/_q)' : 'raw snake_case identifier';
  if (/^[A-Za-z]\w*(\^\w+)?\s*\/\s*[A-Za-z]\w*(\^\w+)?$/.test(text)) return 'bare math ratio';
  if (/\w\s*\.\.\s*\w/.test(text)) return 'index range';
  if (/\^/.test(text) || /^[=!<>]=/.test(text) || /^\w{1,2}\s*=\s*\S/.test(text)) return 'math shorthand';
  // Abbreviated words ("Pos.", "Calc.", "Ctrl."): write the word out and let the block wrap.
  const abbrev = text.match(/(?<![\w.])[A-Za-z]{1,6}\.(?=\s|$|\))/);
  if (abbrev && !/^(?:e\.g|i\.e|etc|vs)\.$/i.test(abbrev[0])) return `abbreviated word "${abbrev[0]}"`;
  if (abbreviation) return `RTL abbreviation "${abbreviation.word}" (write "${abbreviation.expansion}")`;
  if (text.replace(/\s/g, '').length <= 3) return 'mnemonic of 3 characters or fewer';
  return null;
}

// A readable phrase from an RTL or IR identifier, for text that fig-gen
// generates (stage notes, connector names, draft labels): no net or pin id
// prefix (n_, i_, o_, p_), no port-direction or register suffix (_i, _o, _q),
// no one-letter scope prefix (c_state → state), words instead of underscores.
export function readableIdentifier(id) {
  let s = String(id ?? '').replace(/^(?:n|net|i|o|p|b)_/, '');
  s = s.replace(/_(?:i|o|q|in|out)$/i, '');
  if (/^[a-z]_[A-Za-z0-9]/.test(s) && s.length > 5) s = s.slice(2);
  return acronymCase(expandAbbreviations(s.replace(/_+/g, ' ').trim()));
}

// A readable name of one instance path segment: u_nonce_client → nonce client,
// u_ctrl → control.
export function readableInstanceSegment(segment) {
  return acronymCase(expandAbbreviations(String(segment ?? '').replace(/\[\d+\]/g, '').replace(/^(?:u|i|inst|g|gen)_/, '').replace(/_+/g, ' ').trim()));
}

// Readable context names for instance paths that must tell blocks apart:
// the path segments shared by all of them are dropped (the scope, a common
// wrapper), so u_nonce_client/u_stream_client and u_sampler_client/u_stream_client
// become "nonce client" and "sampler client". A path that is a prefix of
// another keeps its last segment.
export function instanceContexts(paths) {
  const split = paths.map((p) => String(p ?? '').split('/').filter(Boolean));
  let head = 0;
  while (split.every((s) => s.length > head + 1 && s[head] === split[0][head])) head += 1;
  let tail = 0;
  while (split.every((s) => s.length > head + tail + 1 && s[s.length - 1 - tail] === split[0][split[0].length - 1 - tail])) tail += 1;
  return split.map((s) => {
    const kept = s.slice(head, s.length - tail);
    return (kept.length ? kept : s.slice(-1)).map(readableInstanceSegment).join(' ');
  });
}

// The shortest readable instance names that tell paths apart: the last
// segment ("owner", "engine adapter"), widened with instanceContexts only
// where last segments repeat (two u_stream_client → "nonce client", "sampler client").
export function distinctInstanceNames(paths) {
  const last = paths.map((p) => readableInstanceSegment(String(p ?? '').split('/').filter(Boolean).at(-1) ?? ''));
  return last.map((name, i) => {
    const same = last.flatMap((n, j) => (n === name ? [j] : []));
    if (!name || same.length < 2) return name;
    return instanceContexts(same.map((j) => paths[j]))[same.indexOf(i)];
  });
}

// Pin labels printed inside one block (label/pin-clutter).
export const MAX_PIN_LABELS = 4;
// A raw Verilog literal (1'b0, 8'hFF, 'h3, '0) printed as a label.
export const RAW_LITERAL = /^(\d+)?'[sS]?[bBdDhHoO][0-9a-fA-FxXzZ_]+$|^'[01xXzZ]$/;

// A tie-off literal: 1 bit wide, all zeros, or all ones ('0, '1, 1'b0, 4'hF).
export function isTieOff(literal) {
  if (/^'[01]$/.test(literal)) return true;
  const m = /^(\d+)?'[sS]?([bBdDhHoO])([0-9a-fA-F_]+)$/.exec(literal);
  if (!m) return false;
  const base = { b: 2, o: 8, d: 10, h: 16 }[m[2].toLowerCase()];
  const value = BigInt(parseInt(m[3].replace(/_/g, ''), base));
  const width = m[1] ? Number(m[1]) : null;
  return width === 1 || value === 0n || (width !== null && value === (1n << BigInt(width)) - 1n);
}

// The text a constant's value box prints (CONVENTIONS §2): its label, else its
// value in readable form: a tie-off as 0 / 1 / "all ones", a sized literal in
// hex (0xFF) or decimal; never Verilog literal syntax.
export function constantText(element) {
  if (element.label !== undefined) return String(element.label);
  const raw = String(element.value ?? '').trim();
  if (/^'[01]$/.test(raw)) return raw.slice(1);
  const m = /^(\d+)?'[sS]?([bBdDhHoO])([0-9a-fA-F_]+)$/.exec(raw);
  if (!m) return raw;
  const base = { b: 2, o: 8, d: 10, h: 16 }[m[2].toLowerCase()];
  const value = BigInt(parseInt(m[3].replace(/_/g, ''), base));
  const width = m[1] ? Number(m[1]) : null;
  if (width !== null && width > 1 && value === (1n << BigInt(width)) - 1n) return 'all ones';
  if (value < 2n) return String(value);
  return m[2].toLowerCase() === 'd' ? String(value) : `0x${value.toString(16).toUpperCase()}`;
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

// The name a variant actually prints for an element, in label mode 'full' or
// 'short' (the renderer's choice, artifact.layout.labels), honouring a
// per-variant labels override exactly as the renderers do. null when the
// element prints no name (a glyph, a port, a mux symbol).
export function printedName(e, mode = 'full', { variant, type = 'datapath' } = {}) {
  const pref = e.labels?.[variant] ?? mode;
  if (type === 'microarch') return pref === 'short' ? (e.short_label ?? e.label ?? e.id) : (e.label ?? e.id);
  if (primaryName(e) === null) return null;
  const names = functionNames(e.function);
  if (pref === 'short') return e.short_label ?? names?.short ?? e.label ?? names?.display ?? null;
  return e.label ?? names?.display ?? null;
}

// Groups of datapath elements that print the same name in one variant.
export function printedDuplicates(doc, mode, { variant } = {}) {
  const byName = new Map();
  for (const e of doc.elements || []) {
    const name = printedName(e, mode, { variant });
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(e.id);
  }
  return [...byName].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({ name, ids }));
}

// function.name prints only for kind custom; elsewhere it is ignored, so the
// schema rejects it and this companion diagnostic says what to write instead.
export function nameIgnored(doc) {
  const out = [];
  for (const e of doc?.elements || []) {
    const fn = e?.function;
    if (!fn || typeof fn !== 'object' || fn.kind === 'custom' || fn.name === undefined) continue;
    const printed = functionNames({ ...fn, name: undefined })?.display ?? fn.kind;
    // "Nonce client controller" on kind controller suggests qualifier "Nonce client".
    const noun = String(VOCABULARY.kinds[fn.kind]?.short ?? '').toLowerCase();
    const words = String(fn.name).trim().split(/\s+/);
    const qualifier = words.length > 1 && words.at(-1).toLowerCase() === noun ? words.slice(0, -1).join(' ') : String(fn.name);
    out.push(diagnostic({ code: 'label/name-ignored', severity: 'error', message: `${e.kind} ${e.id}: function.name "${fn.name}" is ignored for kind ${fn.kind}; the block would print "${printed}"`, subject: { id: e.id, field: 'function.name' }, evidence: { kind: fn.kind, name: fn.name, printed }, supportedFixes: [`write function.qualifier "${qualifier}" instead of name, and a short_label on the element for narrow variants`, 'or use kind custom with name and short_name'] }));
  }
  return out;
}

// Staged blocks of one function print one naming scheme (label/stage-naming):
// when a block declares function.stage, every other block of the same
// function declares it too — a block of the same vocabulary kind, or a custom
// block whose name repeats a word of the staged block's printed names and
// numbers a stage itself ("Syndrome stage 1" beside Syndromes 2/2).
export function stageNamingProblems(doc) {
  const out = [];
  const blocks = (doc.elements || []).filter((e) => e.function);
  const words = (s) => String(s ?? '').toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const stem = (w) => w.replace(/(?:es|s)$/, '');
  const staged = blocks.filter((e) => e.function.stage);
  const reported = new Set();
  for (const s of staged) {
    const names = functionNames(s.function);
    const entry = VOCABULARY.kinds[s.function.kind];
    const printed = new Set([names?.display, names?.short, entry?.display, entry?.short, entry?.stage_display, s.label, s.short_label].flatMap(words).map(stem));
    for (const e of blocks) {
      if (e === s || e.function.stage || reported.has(e.id)) continue;
      const sameKind = e.function.kind === s.function.kind && e.function.kind !== 'custom';
      const ownName = [e.label, e.short_label, e.function.name, e.function.short_name].filter(Boolean).join(' ');
      const numbersStage = /\bstage\s*\d+\b|\b\d+\s*\/\s*\d+\b/i.test(ownName);
      const repeats = e.function.kind === 'custom' && numbersStage && words(ownName).map(stem).some((w) => w !== 'stage' && printed.has(w));
      if (!sameKind && !repeats) continue;
      reported.add(e.id);
      out.push(diagnostic({
        code: 'label/stage-naming', severity: 'error',
        message: `${e.kind} ${e.id} ("${ownName || functionNames(e.function)?.display}") is a stage of the same function as ${s.id} (function.stage "${s.function.stage}") but does not declare function.stage, so the stages print two naming schemes`,
        subject: { id: e.id, staged: s.id }, evidence: { kind: s.function.kind, stage: s.function.stage },
        supportedFixes: [`set function.kind "${s.function.kind}" with function.stage ("1/${String(s.function.stage).split('/')[1] ?? 'n'}") on ${e.id}`, `or drop function.stage on ${s.id} and name both blocks without stages`],
      }));
    }
  }
  return out;
}

export function checkLabels(doc, type, { quality } = {}) {
  const diagnostics = [];
  const severity = quality === 'paper' ? 'error' : 'warning';
  const check = (subject, field, text, fn) => {
    const reason = unreadableReason(text);
    if (!reason) return;
    const abbreviation = /_/.test(String(text)) ? null : abbreviationIn(text);
    const fixes = [...(abbreviation ? [`write "${abbreviation.expansion}" for "${abbreviation.word}" ("${String(text).replace(abbreviation.word, abbreviation.expansion)}")`] : []), suggestionFor(fn)];
    diagnostics.push(diagnostic({ code: 'label/unreadable', severity, message: `${subject.what} ${subject.id}: ${field} "${text}" is not a readable functional name (${reason})`, subject: { id: subject.id, field }, evidence: { label: text, reason, ...(abbreviation ? { abbreviation: abbreviation.word, expansion: abbreviation.expansion } : {}) }, supportedFixes: fixes }));
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
    for (const d of stageNamingProblems(doc)) diagnostics.push(d);
    for (const n of doc.nets || []) for (const field of ['label', 'short_label']) if (n[field]) check({ what: 'net', id: n.id }, field, n[field]);

    // No pin names inside boxes (CONVENTIONS §4.3): pin labels are opt-in
    // (pin_labels: true) where pin identity is essential, as readable words,
    // at most MAX_PIN_LABELS per block, never on clock or reset pins.
    for (const e of doc.elements || []) {
      if (e.pin_labels !== true) continue;
      const pins = e.ports || [];
      const printed = pins.filter((p) => p.label && p.class !== 'clock' && p.class !== 'reset');
      const clutter = (why, evidence, fixes) => diagnostics.push(diagnostic({ code: 'label/pin-clutter', severity, message: `${e.kind} ${e.id}: ${why}`, subject: { id: e.id }, evidence, supportedFixes: fixes }));
      if (printed.length > MAX_PIN_LABELS) clutter(`prints ${printed.length} pin labels inside the box (at most ${MAX_PIN_LABELS}); pin names are for pins whose identity the reader needs (minuend/subtrahend, A/B of a non-commutative op, mux data order)`, { printed: printed.map((p) => p.label) }, ['set pin_labels false and name the nets instead', `keep labels on at most ${MAX_PIN_LABELS} essential pins`]);
      for (const p of pins.filter((q) => q.label && (q.class === 'clock' || q.class === 'reset'))) clutter(`${p.class} pin ${p.id} has a label; clock and reset pins are never labeled inside a box`, { pin: p.id }, [`remove the label from ${p.id}`]);
      for (const p of printed) {
        const reason = unreadableReason(p.label);
        if (reason) clutter(`pin ${p.id} label "${p.label}" is not a readable word (${reason})`, { pin: p.id, label: p.label, reason }, ['write the pin role as a word ("minuend", "select")', 'set pin_labels false']);
      }
      if (!printed.length) clutter('pin_labels is on but no pin has a readable label, so nothing prints; RTL pin ids are never printed', { pins: pins.map((p) => p.id) }, ['remove pin_labels', 'add port labels to the essential pins']);
    }

    // A tie-off is not an input port: a raw 1-bit / all-zeros / all-ones
    // literal such as 1'b0 printed as text (CONVENTIONS §0.6). The renderer
    // draws a constant as a value box printing constantText (1'b0 → 0), so
    // only an authored label in literal syntax still prints one.
    for (const e of (doc.elements || []).filter((x) => x.kind === 'const')) {
      const text = constantText(e);
      if (!RAW_LITERAL.test(text.trim()) || !isTieOff(text.trim())) continue;
      diagnostics.push(diagnostic({ code: 'label/constant-as-port-label', severity, message: `const ${e.id} prints the raw literal "${text}" like an input port label`, subject: { id: e.id }, evidence: { label: text }, supportedFixes: ['fold the tie-off into the block it feeds (rtl.covers) and state it in function.detail or the caption', 'give the constant a readable label ("tied low", "zero")'] }));
    }

    // The same printed label on two different nets is ambiguous, and a net
    // label repeating the port it ends at prints the name twice.
    const netLabels = new Map();
    for (const n of doc.nets || []) {
      if (!n.label) continue;
      if (!netLabels.has(n.label)) netLabels.set(n.label, []);
      netLabels.get(n.label).push(n.id);
    }
    for (const [label, ids] of netLabels) {
      if (ids.length < 2) continue;
      diagnostics.push(diagnostic({ code: 'label/duplicate-net-label', severity, message: `${ids.length} nets share the label "${label}" (${ids.join(', ')}); a reader cannot tell them apart`, subject: { ids }, evidence: { label }, supportedFixes: ['qualify each label ("hash-to-point command", "nonce command")', 'drop the net labels where the endpoints already name the nets'] }));
    }
    const portLabel = new Map((doc.elements || []).filter((x) => x.kind === 'port').map((x) => [x.id, x.label ?? null]));
    for (const n of doc.nets || []) {
      if (!n.label) continue;
      const ends = [n.driver, ...(n.sinks || [])].map((s) => String(s).split('.')[0]);
      const same = ends.find((id) => portLabel.get(id) && portLabel.get(id).trim().toLowerCase() === n.label.trim().toLowerCase());
      if (same) diagnostics.push(diagnostic({ code: 'label/duplicate-net-label', severity, message: `net ${n.id} label "${n.label}" repeats the label of port ${same} it connects to; the name would print twice`, subject: { id: n.id, port: same }, evidence: { label: n.label }, supportedFixes: ['remove the net label (the port names the net)'] }));
    }
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
