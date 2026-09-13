// Text measurement from the bundled font file (lib/fonts.mjs), so layout
// sizes match the outlined PDF exactly.

import { loadFont } from '../fonts.mjs';

let defaultFamily = 'Arial, Helvetica, sans-serif';

export function setDefaultFamily(family) {
  if (family) defaultFamily = family;
}

export function textWidth(text, sizePt, family = defaultFamily) {
  return loadFont(family).measure(text, sizePt);
}

// Baseline offset that visually centers cap-height text on a y coordinate.
export function centerBaseline(sizePt, family = defaultFamily) {
  return (loadFont(family).ascent * sizePt) / 2;
}

export function missingGlyphs(text, family = defaultFamily) {
  return loadFont(family).missing(text);
}
