// Lint for the `figma-safe` SVG profile (SPEC §10.1). Works on renderer
// output, which is well-formed XML without CDATA/DTD, so a small tag scanner
// is sufficient; it is not a general XML parser.

import { diagnostic } from '../diagnostics.mjs';

const FORBIDDEN = new Set(['pattern', 'lineargradient', 'radialgradient', 'filter', 'mask', 'foreignobject', 'image', 'script', 'style', 'marker', 'use', 'symbol']);
const TEXT_ATTRS_FORBIDDEN = ['dominant-baseline', 'alignment-baseline', 'rotate', 'writing-mode', 'textLength', 'lengthAdjust'];
const PHYSICAL_RE = /^(\d+(?:\.\d+)?)(pt|in)$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

export function scanTags(svg) {
  const tags = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let match;
  while ((match = re.exec(svg))) {
    const [, closing, name, attrText, selfClosing] = match;
    const attrs = {};
    for (const a of attrText.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
    tags.push({ name, lower: name.toLowerCase(), closing: Boolean(closing), selfClosing: Boolean(selfClosing), attrs, offset: match.index });
  }
  return tags;
}

export function lintFigmaSafe(svg) {
  const diagnostics = [];
  const add = (code, message, evidence = {}, supportedFixes = []) => diagnostics.push(diagnostic({ code, message, subject: { surface: 'svg' }, evidence, supportedFixes }));
  const tags = scanTags(svg);
  const open = tags.filter((t) => !t.closing);
  const root = open[0];

  if (!root || root.lower !== 'svg') {
    add('svg/root', 'document does not start with an <svg> element');
    return diagnostics;
  }

  const w = PHYSICAL_RE.exec(root.attrs.width || '');
  const h = PHYSICAL_RE.exec(root.attrs.height || '');
  const vb = (root.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
  if (!w || !h || w[2] !== h[2]) {
    add('svg/physical-units', 'root width/height must both be in pt or both in in', { width: root.attrs.width, height: root.attrs.height }, ['emit width/height in pt']);
  } else if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) {
    add('svg/physical-units', 'root viewBox is missing or malformed', { viewBox: root.attrs.viewBox }, ['emit viewBox="0 0 <width_pt> <height_pt>"']);
  } else {
    const toPt = (v, unit) => (unit === 'in' ? Number(v) * 72 : Number(v));
    const wPt = toPt(w[1], w[2]);
    const hPt = toPt(h[1], h[2]);
    if (Math.abs(vb[2] - wPt) > 0.01 || Math.abs(vb[3] - hPt) > 0.01) {
      add('svg/physical-units', 'viewBox size must equal the physical size in pt (1 user unit = 1 pt)', { viewBox: root.attrs.viewBox, widthPt: wPt, heightPt: hPt }, ['set viewBox width/height to the physical size in pt']);
    }
  }

  let clipPaths = 0;
  let textDepth = 0;
  let tspanDepth = 0;
  const stack = [];
  for (const tag of tags) {
    if (tag.closing) {
      stack.pop();
      if (tag.lower === 'text') textDepth -= 1;
      if (tag.lower === 'tspan') tspanDepth -= 1;
      continue;
    }
    const where = { element: tag.name, id: tag.attrs.id, offset: tag.offset };
    if (FORBIDDEN.has(tag.lower)) {
      const code = tag.lower === 'marker' ? 'svg/no-marker'
        : tag.lower === 'use' || tag.lower === 'symbol' ? 'svg/no-reuse'
          : tag.lower === 'style' ? 'svg/inline-presentation'
            : 'svg/forbidden-feature';
      add(code, `<${tag.name}> is not allowed in the figma-safe profile`, where);
    }
    if (tag.lower === 'textpath') add('svg/text-positioning', '<textPath> is not allowed', where);
    if (tag.lower === 'clippath') clipPaths += 1;
    if ('class' in tag.attrs || 'style' in tag.attrs) add('svg/inline-presentation', 'use inline presentation attributes instead of class/style', where, ['replace class/style with fill/stroke/font-* attributes']);
    if ('href' in tag.attrs || 'xlink:href' in tag.attrs) add('svg/no-reuse', 'href references are not allowed', where);
    if ('filter' in tag.attrs || 'mask' in tag.attrs || 'vector-effect' in tag.attrs) add('svg/forbidden-feature', 'filter/mask/vector-effect attributes are not allowed', where);
    for (const a of ['marker-start', 'marker-mid', 'marker-end']) if (a in tag.attrs) add('svg/no-marker', `${a} is not allowed; draw arrowheads as paths`, where);
    if (/url\(/.test(tag.attrs.fill || '') || /url\(/.test(tag.attrs.stroke || '')) add('svg/forbidden-feature', 'paint servers (url(...)) are not allowed', where);

    if (tag.lower === 'text') {
      if (tspanDepth || textDepth) add('svg/text-real', 'nested <text> is not allowed', where);
      if (!NUMBER_RE.test(tag.attrs.x || '') || !NUMBER_RE.test(tag.attrs.y || '')) add('svg/text-positioning', '<text> needs explicit single numeric x and y', where, ['emit x/y as numbers (y = baseline)']);
      if (tag.attrs['text-anchor'] && tag.attrs['text-anchor'] !== 'start') add('svg/text-positioning', 'only text-anchor="start" is allowed; precompute alignment', where);
      for (const a of [...TEXT_ATTRS_FORBIDDEN, 'dx', 'dy', 'transform']) if (a in tag.attrs) add('svg/text-positioning', `attribute ${a} is not allowed on <text>`, where);
      if (!tag.attrs['font-family'] || !tag.attrs['font-size']) add('svg/font', '<text> needs inline font-family and font-size', where);
      if (!tag.selfClosing) textDepth += 1;
    }
    if (tag.lower === 'tspan') {
      if (tspanDepth) add('svg/text-real', 'nested <tspan> is not allowed', where);
      for (const a of [...TEXT_ATTRS_FORBIDDEN, 'dx', 'dy']) if (a in tag.attrs) add('svg/text-positioning', `attribute ${a} is not allowed on <tspan>`, where);
      if (!tag.selfClosing) tspanDepth += 1;
    }
    if (tag.lower === 'g' && !tag.attrs.id) add('svg/layer-structure', '<g> without an id becomes an unnamed Figma layer', where, ['give every group a stable id derived from the IR']);
    if (['path', 'rect', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'text'].includes(tag.lower) && stack.length && stack[stack.length - 1] === 'svg') {
      add('svg/layer-structure', `<${tag.name}> directly under <svg>; every drawable belongs to a named group`, where);
    }
    if (!tag.selfClosing) stack.push(tag.lower);
  }
  if (clipPaths > 1) add('svg/clip-budget', `${clipPaths} clipPath elements; at most 1 is allowed`, { clipPaths });
  if (/<path[^>]*data-glyph/.test(svg)) add('svg/text-outlined', 'glyph outlines found; text must stay <text>');
  return diagnostics;
}
