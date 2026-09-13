// Phase-1 text measurement: approximate Helvetica/Arial advance widths
// (units per 1000 em). Good enough to size prototype symbols; Phase 2
// replaces this with metrics read from the bundled font file, which is also
// what the PDF outliner uses.

const WIDTHS = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278, '<': 584, '=': 584,
  '>': 584, '?': 556, '@': 1015, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, '{': 334,
  '|': 260, '}': 334, '~': 584,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
  n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
};
for (const d of '0123456789') WIDTHS[d] = 556;

export function textWidth(text, sizePt) {
  let units = 0;
  for (const ch of String(text)) units += WIDTHS[ch] ?? 600;
  return (units / 1000) * sizePt;
}

// Baseline offset that visually centers cap-height text on a y coordinate.
export function centerBaseline(sizePt) {
  return sizePt * 0.36;
}
