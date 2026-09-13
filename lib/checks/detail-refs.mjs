// Sub-figure links of datapath elements (SPEC §4.7): when a declared scope is
// too large for one figure, it is split into sub-figures (a)/(b) and the
// collapsed element names the figure that draws it in detail. The link must
// resolve: the file exists next to the figure and, when an id is given, that
// element exists in it.

import fs from 'node:fs';
import path from 'node:path';
import { diagnostic } from '../diagnostics.mjs';

export function checkDetailRefs(doc, { figureDir = '.' } = {}) {
  const diagnostics = [];
  const refs = [];
  for (const e of doc.elements || []) {
    if (!e.detail_ref) continue;
    const file = path.resolve(figureDir, e.detail_ref.figure);
    const fix = ['fix detail_ref.figure (relative to this figure)', 'fix detail_ref.id'];
    if (!fs.existsSync(file)) {
      diagnostics.push(diagnostic({ code: 'detail/ref-unresolved', message: `element ${e.id}: detail figure ${e.detail_ref.figure} not found`, subject: { id: e.id }, evidence: { figure: e.detail_ref.figure }, supportedFixes: fix }));
      continue;
    }
    let detail;
    try {
      detail = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      diagnostics.push(diagnostic({ code: 'detail/ref-unresolved', message: `element ${e.id}: detail figure ${e.detail_ref.figure} is not valid JSON`, subject: { id: e.id }, evidence: {}, supportedFixes: fix }));
      continue;
    }
    const ids = new Set([...(detail.elements || []), ...(detail.blocks || [])].map((x) => x.id));
    if (e.detail_ref.id && !ids.has(e.detail_ref.id)) {
      diagnostics.push(diagnostic({ code: 'detail/ref-unresolved', message: `element ${e.id}: ${e.detail_ref.figure} has no element ${e.detail_ref.id}`, subject: { id: e.id }, evidence: { figure: e.detail_ref.figure, id: e.detail_ref.id }, supportedFixes: fix }));
      continue;
    }
    refs.push({ element: e.id, figure: e.detail_ref.figure, ...(e.detail_ref.id ? { id: e.detail_ref.id } : {}), scope: detail.meta?.scope ?? null });
  }
  return { diagnostics, refs };
}
