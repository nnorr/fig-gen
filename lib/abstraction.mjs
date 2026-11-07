// Declared abstraction of handshake and mux-select nets (SPEC §4.11). A figure
// may leave out control nets between two drawn blocks, never silently:
//   - view.abstract { handshakes: true, reason } omits every 1-bit net between
//     two drawn (non-port) elements whose driver or sinks use it as a handshake
//     (valid/ready: a handshake pin role, or a derived control class);
//   - view.abstract { selects: true, reason } omits every net (any width)
//     between two drawn elements whose sinks are all mux select pins; the
//     muxes keep their bar and the caption says "mux selects omitted";
//   - a net may declare omit { reason } itself.
// Omitted nets stay in the IR: the RTL cross-check, latency and coverage see
// them (the transfer is represented by abstraction and listed in the receipt);
// only the drawing leaves them out. A data net, a multi-bit net or a net
// touching a figure port cannot be abstracted (view/abstract-invalid), and the
// caption must say "handshake signals omitted" (view/abstract-caption).

import { diagnostic } from './diagnostics.mjs';
import { buildModel } from './ir/datapath-model.mjs';
import { deriveNetClasses, sinkRole } from './checks/net-class.mjs';

export const ABSTRACT_CAPTION = 'handshake signals omitted';
export const SELECT_CAPTION = 'mux selects omitted';

const pinRole = (end) => {
  if (!end || end.error) return null;
  const decl = (end.element.ports || []).find((p) => p.id === end.pin.id);
  return decl?.role ?? null;
};

export function abstraction(doc) {
  const diagnostics = [];
  const abstracted = [];
  if (doc?.figure_type !== 'datapath' && !Array.isArray(doc?.nets)) return { abstracted, diagnostics, drawn: doc };
  const model = buildModel(doc);
  const classes = deriveNetClasses(model);
  const all = doc.view?.abstract?.handshakes === true;
  const selects = doc.view?.abstract?.selects === true;
  const reasonAll = doc.view?.abstract?.reason;
  for (const n of model.nets) {
    const declared = n.net.omit;
    const ends = [n.driver, ...n.sinks];
    const betweenBlocks = ends.every((e) => !e.error && e.element.kind !== 'port');
    const oneBit = n.width === 1;
    const cls = classes.get(n.net.id);
    const handshake = n.sinks.some((s) => sinkRole(s) === 'handshake') || ends.some((e) => pinRole(e) === 'handshake');
    const control = cls?.derived === 'control' || handshake;
    if (declared) {
      if (!(oneBit && control && betweenBlocks)) {
        diagnostics.push(diagnostic({ code: 'view/abstract-invalid', severity: 'error', message: `net ${n.net.id} declares omit, but only 1-bit handshake or control nets between two drawn blocks may be abstracted (${!oneBit ? `${n.width} bits` : !control ? 'a data net' : 'it touches a figure port'})`, subject: { id: n.net.id }, evidence: { width: n.width, class: cls?.derived ?? null }, supportedFixes: ['draw the net', 'narrow the scope instead'] }));
        continue;
      }
      abstracted.push({ net: n.net.id, signal: n.net.rtl?.signal ?? null, driver: n.net.driver, sinks: n.net.sinks, reason: declared.reason, kind: 'handshake' });
      continue;
    }
    const selectOnly = n.sinks.length > 0 && n.sinks.every((s) => !s.error && sinkRole(s) === 'select');
    if (selects && selectOnly && betweenBlocks) abstracted.push({ net: n.net.id, signal: n.net.rtl?.signal ?? null, driver: n.net.driver, sinks: n.net.sinks, reason: reasonAll, kind: 'select' });
    else if (all && oneBit && handshake && betweenBlocks) abstracted.push({ net: n.net.id, signal: n.net.rtl?.signal ?? null, driver: n.net.driver, sinks: n.net.sinks, reason: reasonAll, kind: 'handshake' });
  }
  const caption = String(doc.meta?.caption || '').toLowerCase();
  for (const [kind, phrase, what] of [['handshake', ABSTRACT_CAPTION, 'handshake'], ['select', SELECT_CAPTION, 'mux select']]) {
    const nets = abstracted.filter((a) => a.kind === kind).map((a) => a.net);
    if (nets.length && !caption.includes(phrase)) {
      diagnostics.push(diagnostic({ code: 'view/abstract-caption', severity: 'error', message: `${nets.length} ${what} net(s) are omitted from the drawing (${nets.join(', ')}); the caption must say "${phrase}"`, subject: {}, evidence: { omitted: nets }, supportedFixes: [`add "${phrase}" to meta.caption`, 'draw the nets'] }));
    }
  }
  const omit = new Set(abstracted.map((a) => a.net));
  // Muxes whose select net is abstracted keep their bar: the renderer's
  // select checks (symbol/mux-sel-missing, glyph/distinguishable) accept them.
  const hiddenSel = new Set(abstracted.filter((a) => a.kind === 'select').flatMap((a) => a.sinks.map((s) => s.split('.')[0])));
  const drawn = omit.size ? {
    ...doc,
    nets: doc.nets.filter((n) => !omit.has(n.id)),
    elements: hiddenSel.size ? doc.elements.map((e) => (hiddenSel.has(e.id) ? { ...e, select_abstracted: true } : e)) : doc.elements,
  } : doc;
  return { abstracted, diagnostics, drawn };
}
