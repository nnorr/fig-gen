// Doc-grounded facts (SPEC §7.4). A figure that takes a fact from documents —
// slot, instance name, base address, address window, IRQ number — is checked
// against EVERY text document of the pinned revision, not just the pinned
// line. Documents that state a different value produce `doc/conflict`
// (an error for delivery) listing every source. A conflict is resolved only by
// an explicit `authority` {file, reason} recorded in the IR; the receipt then
// lists the authority and the overridden sources. When the RTL is available,
// a documented window that cannot be what the RTL decodes is a
// `doc/rtl-mismatch` warning.

import { diagnostic } from './diagnostics.mjs';
import { repoReader } from './repo-files.mjs';

const DOC_FILE = /\.(md|markdown|txt|rst|adoc)$/i;
const HEX_RE = /0x[0-9a-f]+(?:_[0-9a-f]+)*/gi;
const RANGE_RE = /(0x[0-9a-f]+(?:_[0-9a-f]+)*)`?\s*(?:-|–|—|~|\.\.|to)\s*`?(0x[0-9a-f]+(?:_[0-9a-f]+)*)/gi;
const IRQ_RE = /\bIRQ\s*#?\s*(\d{1,3})\b/gi;
const KEY = {
  slot: /\bslot\b/i,
  base: /\bbase\b|@|\baddress\b/i,
  window: /\bwindow\b|\brange\b|\baddress\b|\bdecod/i,
  irq: /\birq\b|\binterrupt\b/i,
  instance: /\binstance\b/i,
};
const EFFECTIVE = /\beffective\b|\bdecod|\bcsr\b/i;

const hex = (s) => parseInt(String(s).replace(/^0x/i, '').replace(/_/g, ''), 16);
export const fmtHex = (v) => `0x${v.toString(16).toUpperCase().padStart(8, '0').replace(/^(.{4})(.{4})$/, '$1_$2')}`;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmtValue = (attr, v) => (attr === 'base' ? fmtHex(v) : attr === 'window' ? `${fmtHex(v.base)}-${fmtHex(v.end)}` : String(v));
const sameValue = (attr, a, b) => (attr === 'window' ? a.base === b.base && a.end === b.end : a === b);

// Doc-grounded facts the figure asserts, per block, with the IR object that
// owns each. A fact is doc-grounded when its owner (or its block) cites a
// document (source pin), names doc_terms, or records an authority; figures
// that do not take the fact from documents are not scanned.
const grounded = (owner, block) => Boolean(owner.source || owner.authority || block.doc_terms || block.authority);

function assertedFacts(doc) {
  const out = [];
  for (const b of doc.blocks || []) {
    const facts = [];
    if (b.slot && grounded(b, b)) facts.push({ attr: 'slot', value: String(b.slot).toUpperCase(), owner: b, where: `/blocks/${b.id}/slot` });
    if (b.instance && grounded(b, b)) facts.push({ attr: 'instance', value: b.instance, owner: b, where: `/blocks/${b.id}/instance` });
    for (const a of (doc.attachments || []).filter((x) => x.block === b.id && x.address && grounded(x, b))) {
      const base = hex(a.address.base);
      const end = a.address.end !== undefined ? hex(a.address.end) : base + hex(a.address.size) - 1;
      facts.push({ attr: 'base', value: base, owner: a, where: `/attachments/${a.id}/address/base` });
      facts.push({ attr: 'window', value: { base, end }, owner: a, where: `/attachments/${a.id}/address` });
    }
    for (const l of (doc.links || []).filter((x) => x.from === b.id && x.irq !== undefined && grounded(x, b))) facts.push({ attr: 'irq', value: l.irq, owner: l, where: `/links/${l.id}/irq` });
    if (facts.length) out.push({ block: b, facts });
  }
  return out;
}

// Scan every document line for facts about the subject (terms).
export function scanDocuments(reader, { terms, slotPrefix }) {
  const termRe = new RegExp(terms.map((t) => `(?<![\\w])${escape(t)}(?![\\w])`).join('|'), 'i');
  const slotRe = slotPrefix ? new RegExp(`(?<![\\w])(${escape(slotPrefix)})(\\d+)(?![\\w])`, 'gi') : null;
  const found = [];
  const files = reader.list().filter((f) => DOC_FILE.test(f));
  for (const file of files) {
    const lines = reader.lines(file) || [];
    const headings = [];
    let fileSubject = false;
    lines.forEach((text, i) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(text);
      if (h) {
        const level = h[1].length;
        headings.length = Math.min(headings.length, level - 1);
        headings[level - 1] = h[2];
        if (level === 1 && termRe.test(h[2])) fileSubject = true;
      }
      const direct = termRe.test(text);
      const inherited = !direct && (fileSubject || headings.some((x) => x && termRe.test(x)));
      if (!direct && !inherited) return;
      const ok = (key) => direct || KEY[key].test(text);
      const line = i + 1;
      const push = (attr, value) => found.push({ attr, value, file, line, text: text.trim().slice(0, 160) });
      if (slotRe && ok('slot')) for (const m of text.matchAll(slotRe)) push('slot', `${m[1].toUpperCase()}${m[2]}`);
      if (ok('instance') && KEY.instance.test(text)) for (const m of text.matchAll(/`(\w+)`/g)) push('instance', m[1]);
      const rangeEnds = new Set();
      if (ok('window') || ok('base')) {
        for (const m of text.matchAll(RANGE_RE)) {
          const base = hex(m[1]);
          const end = hex(m[2]);
          if (end > base && base > 0xffff) { push('window', { base, end }); push('base', base); rangeEnds.add(m[2].toLowerCase()); rangeEnds.add(m[1].toLowerCase()); }
        }
      }
      if (ok('base') || ok('slot')) {
        for (const m of text.matchAll(HEX_RE)) {
          if (rangeEnds.has(m[0].toLowerCase())) continue;
          const v = hex(m[0]);
          if (v > 0xffff && v % 0x1000 === 0) push('base', v);
        }
      }
      if (ok('irq')) for (const m of text.matchAll(IRQ_RE)) push('irq', Number(m[1]));
    });
  }
  return { files, found };
}

export function checkDocFacts(doc, { figureDir, netlist } = {}) {
  const diagnostics = [];
  const report = { scanned_files: 0, facts: [] };
  const subjects = assertedFacts(doc);
  if (!subjects.length) return { diagnostics, report };
  const reader = repoReader(doc, figureDir);
  const add = (code, severity, message, subject, evidence, supportedFixes = []) => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  if (!reader || !reader.valid) {
    add('doc/repository-required', 'error', 'the figure asserts document facts (slot, address, IRQ, instance) but meta.repository is missing or invalid, so they cannot be checked against the documents', { path: '/meta/repository' }, {}, ['add meta.repository {root, revision}']);
    return { diagnostics, report };
  }
  for (const { block, facts } of subjects) {
    const terms = [...new Set([...(block.doc_terms || []), block.rtl?.module, block.instance].filter(Boolean))];
    if (!terms.length) {
      add('doc/terms-missing', 'warning', `block ${block.id} asserts document facts but has no doc_terms or rtl.module to find them in the documents`, { id: block.id }, {}, ['add doc_terms (names the documents use for this block)']);
      continue;
    }
    const slotFact = facts.find((f) => f.attr === 'slot');
    const { files, found } = scanDocuments(reader, { terms, slotPrefix: slotFact ? slotFact.value.replace(/\d+$/, '') : null });
    report.scanned_files = Math.max(report.scanned_files, files.length);
    for (const fact of facts) {
      let docs = found.filter((d) => d.attr === fact.attr);
      // A different window at a different base is already a base conflict;
      // windows are compared only where the documents agree on the base.
      if (fact.attr === 'window') docs = docs.filter((d) => d.value.base === fact.value.base);
      const agree = docs.filter((d) => sameValue(fact.attr, d.value, fact.value));
      const disagree = docs.filter((d) => !sameValue(fact.attr, d.value, fact.value));
      const authority = fact.owner.authority ?? block.authority;
      const entry = { block: block.id, attribute: fact.attr, figure_value: fmtValue(fact.attr, fact.value), supporting: agree.map((d) => ({ file: d.file, line: d.line })), overridden: [] };
      if (!docs.length) {
        add('doc/fact-unsupported', 'warning', `${block.id}: no document at ${reader.revision.slice(0, 12)} states ${fact.attr} ${entry.figure_value}`, { id: block.id, attribute: fact.attr }, {}, ['pin the document that states it', 'add doc_terms so the documents can be found']);
      }
      if (disagree.length) {
        const listing = disagree.map((d) => `${d.file}:${d.line} → ${fmtValue(fact.attr, d.value)}`);
        const evidence = { figure: entry.figure_value, figure_path: fact.where, conflicting: disagree.map((d) => ({ file: d.file, line: d.line, value: fmtValue(fact.attr, d.value), text: d.text })), supporting: agree.map((d) => ({ file: d.file, line: d.line })) };
        if (!authority) {
          add('doc/conflict', 'error', `${block.id}: documents disagree on ${fact.attr}. Figure: ${entry.figure_value} (${agree.map((d) => `${d.file}:${d.line}`).join(', ') || 'no supporting document'}). Different values: ${listing.join('; ')}`, { id: block.id, attribute: fact.attr }, evidence, ['ask the user which document is authoritative and record it as authority {file, reason}', 'correct the figure value']);
        } else if (!agree.some((d) => d.file === authority.file)) {
          add('doc/authority-mismatch', 'error', `${block.id}: authority ${authority.file} does not state ${fact.attr} ${entry.figure_value}`, { id: block.id, attribute: fact.attr }, evidence, ['use the value the authority states', 'fix authority.file']);
        } else {
          entry.authority = { file: authority.file, ...(authority.line ? { line: authority.line } : {}), reason: authority.reason };
          entry.overridden = disagree.map((d) => ({ file: d.file, line: d.line, value: fmtValue(fact.attr, d.value) }));
          add('doc/conflict', 'warning', `${block.id}: documents disagree on ${fact.attr}; resolved by authority ${authority.file} ("${authority.reason}"). Overridden: ${listing.join('; ')}`, { id: block.id, attribute: fact.attr }, { ...evidence, authority }, []);
        }
      }
      report.facts.push(entry);
    }
    // Windows the RTL cannot decode: a documented window smaller than the
    // address port spans, or an "effective/decoded" window of another size.
    const attachment = (doc.attachments || []).find((a) => a.block === block.id && a.rtl?.addr_port);
    const mod = netlist && attachment ? netlist.modules.find((m) => m.orig_name === (block.rtl?.module ?? netlist.top) && m.ports.some((p) => p.name === attachment.rtl.addr_port)) : null;
    if (mod) {
      const width = mod.ports.find((p) => p.name === attachment.rtl.addr_port).width;
      const rtlSize = 2 ** width;
      for (const d of found.filter((x) => x.attr === 'window')) {
        const size = d.value.end - d.value.base + 1;
        if (size < rtlSize || (EFFECTIVE.test(d.text) && size !== rtlSize)) {
          add('doc/rtl-mismatch', 'warning', `${block.id}: ${d.file}:${d.line} documents a ${size}-byte window (${fmtValue('window', d.value)}), but ${attachment.rtl.addr_port}[${width - 1}:0] of ${mod.orig_name} decodes ${rtlSize} bytes`, { id: block.id, attribute: 'window' }, { file: d.file, line: d.line, documented_bytes: size, rtl_bytes: rtlSize, text: d.text }, ['correct the document', 'check which address bits the RTL decodes']);
        }
      }
    }
  }
  return { diagnostics, report };
}
