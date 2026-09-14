// Skin lint (SPEC §10.2, CONVENTIONS §2.3/§3): no two element kinds may share
// a glyph. Every bar-like glyph carries its identifying feature — the mux bar
// its select pin, the pipeline-register bar a clock wedge, an outline and a
// gray fill — and concatenation/split never render as a filled bar.

import { diagnostic } from '../diagnostics.mjs';

export const MIN_BAR_WIDTH_DELTA_PT = 1.5;

export function barSignatures(skin) {
  const s = skin.symbols;
  const out = [];
  if (s.mux?.bar) out.push({ kind: 'mux(bar)', width: s.mux.bar.width, fill: s.mux.bar.fill, outline: false, marks: ['select-pin'] });
  for (const k of ['join', 'split']) {
    if (s[k]?.parametric === 'bus-bar') out.push({ kind: k, width: s[k].width, fill: s[k].fill, outline: false, marks: [] });
  }
  if (s.pipeline_register) out.push({ kind: 'pipeline_register', width: s.pipeline_register.width, fill: s.pipeline_register.fill, outline: Boolean(s.pipeline_register.outline), marks: s.pipeline_register.wedge ? ['clock-wedge'] : [] });
  return out;
}

export function checkSkin(skin) {
  const diagnostics = [];
  const add = (code, message, evidence, supportedFixes) => diagnostics.push(diagnostic({ code, message, subject: { skin: skin.skin }, evidence, supportedFixes }));
  const s = skin.symbols;
  const mux = s.mux;
  if (!mux || !['bar', 'trapezoid'].includes(mux.style)) add('skin/mux-style', 'symbols.mux.style must be "bar" or "trapezoid"', { style: mux?.style }, ['set symbols.mux.style']);
  if (mux && mux.select_side !== 'NORTH' && mux.select_side !== 'SOUTH') add('skin/mux-sel-missing', 'the mux must define a select pin side (NORTH or SOUTH)', { select_side: mux.select_side }, ['set symbols.mux.select_side']);

  // CONVENTIONS §3.5 D1: a solid filled bar is always a mux, so concatenation
  // is a hollow { } box and a split is ripper taps with no body.
  const expected = { join: 'concat-box', split: 'bus-ripper' };
  for (const [k, want] of Object.entries(expected)) {
    if (s[k] && s[k].parametric !== want) {
      add('glyph/distinguishable', `${k === 'join' ? 'concatenation' : 'split'} must render as ${want === 'concat-box' ? 'a hollow outlined { } box' : '45° ripper taps with [msb:lsb] labels and no body'}, never as a filled bar that reads like the mux bar`, { symbol: k, parametric: s[k].parametric }, [`set symbols.${k}.parametric to "${want}"`]);
    }
  }
  if (s.join && s.join.fill === 'ink') add('glyph/distinguishable', 'the concatenation box must be hollow (white fill with outline)', { fill: s.join.fill }, ['set symbols.join.fill to "logic"']);
  // CONVENTIONS §3.5 D5: the word on a bus-operation box is its identifying feature.
  // Bus-operation boxes show their word only: no destination ranges inside or beside the box.
  if (s.join?.input_range_labels) add('glyph/distinguishable', 'the concatenation box prints the word "concat" only; destination bit ranges are not drawn (the MSB field is on top by convention and each input keeps its width slash)', { input_range_labels: true }, ['remove symbols.join.input_range_labels']);
  if (s.join && s.join.label !== 'concat') add('glyph/distinguishable', `the concatenation box is identified by the word "concat", not "${s.join.label}"`, { label: s.join.label }, ['set symbols.join.label to "concat"']);
  if (s.replicate && !/^repl ×\{N\}$/.test(s.replicate.label ?? 'repl ×{N}')) add('glyph/distinguishable', `the replication box is identified by "repl ×N", not "${s.replicate.label}"`, { label: s.replicate.label }, ['set symbols.replicate.label to "repl ×{N}"']);
  const ext = s.extend?.labels;
  if (ext && (ext.sign !== 'sext' || ext.zero !== 'zext')) add('glyph/distinguishable', 'extension boxes are identified by the words "sext" and "zext"', { labels: ext }, ['set symbols.extend.labels to { sign: "sext", zero: "zext" }']);
  // CONVENTIONS §1: one stroke weight for every net; width lives in the slash label.
  const st = skin.tokens?.stroke ?? {};
  for (const k of ['bus', 'control']) {
    if (typeof st[k] === 'number' && st[k] !== st.wire) add('net/stroke-uniform', `stroke.${k} (${st[k]} pt) differs from stroke.wire (${st.wire} pt); every net uses one stroke weight and width is shown by slash-N labels`, { token: k, value: st[k], wire: st.wire }, [`remove stroke.${k} or set it to ${st.wire}`]);
  }
  const preg = s.pipeline_register;
  if (preg) {
    const missing = [!preg.wedge && 'clock wedge', !preg.outline && 'outline', (preg.fill === 'ink' || preg.fill === mux?.bar?.fill) && 'gray fill distinct from the mux bar'].filter(Boolean);
    if (missing.length) add('glyph/distinguishable', `pipeline-register bars must carry their identifying features; missing: ${missing.join(', ')}`, { missing }, ['restore wedge, outline and fill "bar" on symbols.pipeline_register']);
  }
  if (mux?.bar && mux.bar.fill !== 'ink') add('glyph/distinguishable', 'the mux bar is identified by a solid ink fill plus its select pin; do not change its fill', { fill: mux.bar.fill }, ['set symbols.mux.bar.fill to "ink"']);

  const sigs = barSignatures(skin);
  const key = (g) => `${g.width}|${g.fill}|${g.outline}|${[...g.marks].sort().join(',')}`;
  for (let i = 0; i < sigs.length; i += 1) {
    for (let j = i + 1; j < sigs.length; j += 1) {
      const [a, b] = [sigs[i], sigs[j]];
      const involvesMux = a.kind.startsWith('mux') || b.kind.startsWith('mux');
      const sameFillNoOutline = a.fill === b.fill && a.outline === b.outline;
      if (key(a) === key(b) || (involvesMux && sameFillNoOutline && Math.abs(a.width - b.width) < MIN_BAR_WIDTH_DELTA_PT)) {
        add('skin/bar-kinds-indistinct', `${a.kind} and ${b.kind} render as near-identical bars`, { a, b }, ['change width, fill, outline or decorations of one bar kind']);
      }
    }
  }
  return diagnostics;
}
