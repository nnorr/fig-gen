// Declared abstraction of handshake nets (SPEC §4.11). A figure may leave out
// 1-bit handshake / control nets between two drawn blocks, never silently:
//   - view.abstract { handshakes: true, reason } omits every 1-bit net between
//     two drawn (non-port) elements whose driver or sinks use it as a handshake
//     (valid/ready: a handshake pin role, or a derived control class);
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
      abstracted.push({ net: n.net.id, signal: n.net.rtl?.signal ?? null, driver: n.net.driver, sinks: n.net.sinks, reason: declared.reason });
      continue;
    }
    if (all && oneBit && handshake && betweenBlocks) abstracted.push({ net: n.net.id, signal: n.net.rtl?.signal ?? null, driver: n.net.driver, sinks: n.net.sinks, reason: reasonAll });
  }
  if (abstracted.length && !String(doc.meta?.caption || '').toLowerCase().includes(ABSTRACT_CAPTION)) {
    diagnostics.push(diagnostic({ code: 'view/abstract-caption', severity: 'error', message: `${abstracted.length} handshake net(s) are omitted from the drawing (${abstracted.map((a) => a.net).join(', ')}); the caption must say "${ABSTRACT_CAPTION}"`, subject: {}, evidence: { omitted: abstracted.map((a) => a.net) }, supportedFixes: [`add "${ABSTRACT_CAPTION}" to meta.caption`, 'draw the nets'] }));
  }
  const omit = new Set(abstracted.map((a) => a.net));
  const drawn = omit.size ? { ...doc, nets: doc.nets.filter((n) => !omit.has(n.id)) } : doc;
  return { abstracted, diagnostics, drawn };
}
