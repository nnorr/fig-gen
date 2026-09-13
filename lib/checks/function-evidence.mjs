// Function justification (CONVENTIONS §4.3, SPEC §8): a vocabulary name that
// claims an algorithm (syndrome calculator, Chien search, position match, …)
// must be supported by the RTL structure the figure cites in function.basis.
// The vocabulary entry declares the evidence: regexes the cited source text
// must match, and operation categories that must occur in the RTL cone of the
// block's mapped outputs when a netlist is given. Otherwise the lint suggests
// the entry's more general name (warning; error under --quality paper).

import { diagnostic } from '../diagnostics.mjs';
import { repoReader } from '../repo-files.mjs';
import { findModule, resolveCone } from '../rtl/cone.mjs';
import { VOCABULARY } from './labels.mjs';

const isZero = (node) => node?.op === 'const' && /^(?:\d+'[bhdo])?0+$/i.test(String(node.value).replace(/_/g, ''));

// Operation categories present in an expression tree.
export function coneCategories(tree) {
  const cats = new Set();
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    const args = n.args || [];
    const name = String(n.name || '');
    if (n.op === 'eq' || n.op === 'ne' || n.op === 'neq') {
      cats.add('compare-eq');
      if (args.some(isZero)) cats.add('compare-zero');
    }
    if (['lt', 'le', 'gt', 'ge', 'lts', 'gts'].includes(n.op)) cats.add('compare-eq');
    if (n.op === 'redor' || n.op === 'rednor') cats.add('compare-zero');
    if (n.op === 'not' && args[0]?.op === 'redor') cats.add('compare-zero');
    const mul = n.op === 'mul' || n.op === 'muls' || (n.op === 'func' && /mul/i.test(name));
    if (mul) {
      cats.add('multiply');
      if (args.some((a) => a.op === 'const')) cats.add('multiply-by-constant');
    }
    if (n.op === 'xor' || (n.op === 'func' && /add|xor/i.test(name))) cats.add('gf-add');
    // Field evidence: a Galois-field helper. XOR or multiply alone is not a GF operation.
    if (n.op === 'func' && /gf|galois|field/i.test(name)) cats.add('gf-hint');
    if (n.op === 'add' || n.op === 'sub') cats.add('arith-add');
    if (n.op === 'div' || (n.op === 'func' && /inv|div/i.test(name))) { cats.add('division'); cats.add('multiply'); }
    args.forEach(visit);
  };
  visit(tree);
  return cats;
}

export function checkFunctionEvidence(doc, { figureDir, netlist, quality } = {}) {
  const diagnostics = [];
  const severity = quality === 'paper' ? 'error' : 'warning';
  const reader = repoReader(doc, figureDir);
  const nets = doc.nets || [];
  const report = [];
  for (const e of doc.elements || []) {
    const fn = e.function;
    const entry = fn && VOCABULARY.kinds[fn.kind];
    if (!entry?.evidence) continue;
    const general = entry.general ? VOCABULARY.kinds[entry.general]?.display ?? entry.general : 'a more general name';
    const fixes = [`cite the RTL that ${entry.evidence.description} in function.basis {source, structure}`, `use the more general name: function.kind "${entry.general ?? 'custom'}" (${general})`];
    const add = (message, evidence) => diagnostics.push(diagnostic({ code: 'label/function-justification', severity, message: `${e.kind} ${e.id}: "${entry.display}" ${message}`, subject: { id: e.id, kind: fn.kind }, evidence: { required: entry.evidence, ...evidence }, supportedFixes: fixes }));
    if (!fn.basis?.source) { add('is not justified: function.basis cites no RTL source', {}); continue; }
    const text = reader?.valid ? reader.pinText(fn.basis.source) : null;
    if (text === null) { add(`cannot be justified: ${fn.basis.source.file}:${fn.basis.source.line} cannot be read at the pinned revision`, {}); continue; }
    const missing = (entry.evidence.source_all || []).filter((re) => !new RegExp(re, 'i').test(text));
    if (missing.length) { add(`is not supported by the cited source ${fn.basis.source.file}:${fn.basis.source.line} (missing: ${missing.join(', ')})`, { cited: text.slice(0, 300) }); continue; }
    let rtl = 'not checked (no netlist)';
    if (netlist && entry.evidence.cone_all?.length) {
      const outs = nets.filter((n) => String(n.driver).split('.')[0] === e.id && n.rtl?.signal);
      const ins = nets.filter((n) => n.sinks.some((s) => String(s).split('.')[0] === e.id) && n.rtl?.signal).map((n) => n.rtl.signal);
      const cats = new Set();
      const perOutput = [];
      let resolved = 0;
      for (const n of outs) {
        const mod = findModule(netlist, n.rtl.instance ?? doc.meta?.rtl?.instance);
        if (!mod) continue;
        // An array output (one assignment per element) is resolved per index
        // and the categories are united; a cone that is only an input leaf
        // carries no structure and does not count as resolved.
        const entries = (mod.exprs || []).filter((x) => x.target === n.rtl.signal);
        const indices = entries.length ? [...new Set(entries.map((x) => x.index))] : [undefined];
        const own = new Set();
        for (const index of indices) {
          try {
            const cone = resolveCone(mod, { output: n.rtl.signal, ...(index !== undefined && index !== null ? { index } : {}), stopAt: ins });
            if (!cone?.tree || cone.tree.op === 'input') continue;
            coneCategories(cone.tree).forEach((c) => { cats.add(c); own.add(c); });
            resolved += 1;
          } catch {
            // no continuous-assignment tree for this output: fall back to the source evidence
          }
        }
        if (own.size || entries.length) perOutput.push({ net: n.id, cats: own });
      }
      if (resolved) {
        const absent = entry.evidence.cone_all.filter((c) => !cats.has(c));
        if (absent.length) { add(`is contradicted by the RTL cone of its outputs (lacks ${absent.join(', ')}; found ${[...cats].join(', ') || 'none'})`, { found: [...cats] }); continue; }
        // A narrow name must describe the whole block: the cited structure has
        // to be in the cone of every output, not in one of many (a hub whose
        // one output compares against zero is not a zero detector).
        const partial = perOutput.filter((o) => !entry.evidence.cone_all.every((c) => o.cats.has(c)));
        if (partial.length) { add(`describes only part of the block: ${partial.length} of ${perOutput.length} outputs (${partial.slice(0, 4).map((o) => o.net).join(', ')}${partial.length > 4 ? ', …' : ''}) lack ${entry.evidence.cone_all.join(', ')} in their RTL cone; name the block by what all of it computes, or split it by output cone`, { outputs: perOutput.length, partial: partial.map((o) => o.net) }); continue; }
        rtl = `cone has ${entry.evidence.cone_all.join(', ')}`;
      } else {
        rtl = 'cone not resolvable; source evidence only';
      }
    }
    report.push({ id: e.id, kind: fn.kind, basis: `${fn.basis.source.file}:${fn.basis.source.line}`, rtl });
  }
  return { diagnostics, report };
}
