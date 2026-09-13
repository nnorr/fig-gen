// Skin lint: bar-shaped symbols must stay visually distinct, and the mux bar
// must keep a select pin (SPEC §10.2, CONVENTIONS §3).

import { diagnostic } from '../diagnostics.mjs';

export const MIN_BAR_WIDTH_DELTA_PT = 1.5;

export function barSignatures(skin) {
  const s = skin.symbols;
  const out = [];
  if (s.mux?.bar) out.push({ kind: 'mux(bar)', width: s.mux.bar.width, fill: s.mux.bar.fill, outline: false, marks: ['select-pin'] });
  if (s.join) out.push({ kind: 'join', width: s.join.width, fill: s.join.fill, outline: false, marks: s.join.label ? ['brace-label'] : [] });
  if (s.split) out.push({ kind: 'split', width: s.split.width, fill: s.split.fill, outline: false, marks: s.split.slice_labels ? ['slice-labels'] : [] });
  if (s.pipeline_register) out.push({ kind: 'pipeline_register', width: s.pipeline_register.width, fill: s.pipeline_register.fill, outline: Boolean(s.pipeline_register.outline), marks: s.pipeline_register.wedge ? ['clock-wedge'] : [] });
  return out;
}

export function checkSkin(skin) {
  const diagnostics = [];
  const add = (code, message, evidence, supportedFixes) => diagnostics.push(diagnostic({ code, message, subject: { skin: skin.skin }, evidence, supportedFixes }));
  const mux = skin.symbols.mux;
  if (!mux || !['bar', 'trapezoid'].includes(mux.style)) add('skin/mux-style', 'symbols.mux.style must be "bar" or "trapezoid"', { style: mux?.style }, ['set symbols.mux.style']);
  if (mux && mux.select_side !== 'NORTH' && mux.select_side !== 'SOUTH') add('skin/mux-sel-missing', 'the mux must define a select pin side (NORTH or SOUTH)', { select_side: mux.select_side }, ['set symbols.mux.select_side']);

  const sigs = barSignatures(skin);
  const key = (g) => `${g.width}|${g.fill}|${g.outline}|${[...g.marks].sort().join(',')}`;
  for (let i = 0; i < sigs.length; i += 1) {
    for (let j = i + 1; j < sigs.length; j += 1) {
      const [a, b] = [sigs[i], sigs[j]];
      if (key(a) === key(b)) {
        add('skin/bar-kinds-indistinct', `${a.kind} and ${b.kind} render identically`, { a, b }, ['change width, fill, outline or decorations of one bar kind']);
      }
      const involvesMux = a.kind.startsWith('mux') || b.kind.startsWith('mux');
      const sameFillNoOutline = a.fill === b.fill && a.outline === b.outline;
      if (involvesMux && sameFillNoOutline && Math.abs(a.width - b.width) < MIN_BAR_WIDTH_DELTA_PT) {
        add('skin/bar-kinds-indistinct', `${a.kind} and ${b.kind} differ by less than ${MIN_BAR_WIDTH_DELTA_PT} pt in width with the same fill`, { a, b }, ['make the join/split bar thinner than the mux bar', 'use a different fill']);
      }
    }
  }
  return diagnostics;
}
