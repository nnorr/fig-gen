// Post-layout geometry checks shared by renderers: label/label overlap,
// labels touching wires or any other drawn line (outlines, frames), labels too
// close to a symbol outline, missing glyphs, and region frames that enclose
// foreign blocks, miss members, or cross each other. Text boxes use the real
// font metrics.

import { walk } from '../svg.mjs';

export function textBoxes(tree, font) {
  const boxes = [];
  walk(tree, (n) => {
    if (n.name !== 'text') return;
    const size = Number(n.attrs['font-size']);
    const x = Number(n.attrs.x);
    const y = Number(n.attrs.y);
    const value = n.children[0];
    boxes.push({ id: n.attrs.id, text: value, x0: x, x1: x + font.measure(value, size), y0: y - font.ascent * size, y1: y + font.descent * size * 0.6 });
  });
  return boxes;
}

const pathSegments = (d) => {
  const out = [];
  let prev = null;
  for (const m of d.matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
    const p = { x: Number(m[2]), y: Number(m[3]) };
    if (m[1] === 'L' && prev) out.push([prev, p]);
    prev = p;
  }
  return out;
};

export function wireSegments(tree) {
  const segs = [];
  walk(tree, (n) => {
    if (n.name !== 'path' || !/-(seg\d+|stub)$/.test(n.attrs.id || '')) return;
    const hw = Number(n.attrs['stroke-width']) / 2;
    for (const [a, b] of pathSegments(n.attrs.d)) segs.push({ id: n.attrs.id, a, b, hw, dashed: Boolean(n.attrs['stroke-dasharray']) });
  });
  return segs;
}

// Every other stroked straight line: symbol outlines, ripper stubs, frames,
// separators. Curves (gate outlines, circles) are covered by symbol spacing.
export function otherLines(tree) {
  const lines = [];
  walk(tree, (n) => {
    const id = n.attrs?.id || '';
    if (/-(seg\d+|stub)$|-hatch|^frame$/.test(id)) return;
    const stroke = n.attrs?.stroke;
    if (!stroke || stroke === 'none') return;
    const hw = Number(n.attrs['stroke-width'] || 0) / 2;
    if (n.name === 'path' && !/[QAC]/.test(n.attrs.d)) for (const [a, b] of pathSegments(n.attrs.d)) lines.push({ id: id || '(path)', a, b, hw });
    if (n.name === 'rect') {
      const x = Number(n.attrs.x); const y = Number(n.attrs.y); const w = Number(n.attrs.width); const h = Number(n.attrs.height);
      const c = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
      c.forEach((p, k) => lines.push({ id: id || '(rect)', a: p, b: c[(k + 1) % 4], hw }));
    }
  });
  return lines;
}

const overlap = (a, b, pad = 0) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
const segBox = (s) => ({ x0: Math.min(s.a.x, s.b.x) - s.hw, x1: Math.max(s.a.x, s.b.x) + s.hw, y0: Math.min(s.a.y, s.b.y) - s.hw, y1: Math.max(s.a.y, s.b.y) + s.hw });

// Does a stroked segment touch a text box? Axis-aligned segments use their
// stroke box; slanted ones (trapezoid sides, ripper stubs) are clipped
// against the box grown by half the stroke width (Liang–Barsky).
function lineTouchesBox(s, box) {
  const axis = Math.abs(s.a.x - s.b.x) < 0.01 || Math.abs(s.a.y - s.b.y) < 0.01;
  if (axis) return overlap(box, segBox(s), -0.05);
  const x0 = box.x0 - s.hw + 0.05;
  const x1 = box.x1 + s.hw - 0.05;
  const y0 = box.y0 - s.hw + 0.05;
  const y1 = box.y1 + s.hw - 0.05;
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, s.a.x - x0], [dx, x1 - s.a.x], [-dy, s.a.y - y0], [dy, y1 - s.a.y]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

// frames: [{id, x0, y0, x1, y1, members: Set(node ids incl. nested)}]; nodes: [{id, x0, y0, x1, y1}]
export function frameChecks(frames, nodes) {
  const diagnostics = [];
  const add = (code, message, subject, evidence) => diagnostics.push({ code, severity: 'error', message, subject, evidence, supportedFixes: ['let the layout group the region (frame: true)', 'set frame: false and name the region in the caption'] });
  for (const f of frames) {
    for (const n of nodes) {
      if (f.members.has(n.id)) {
        if (n.x0 < f.x0 || n.x1 > f.x1 || n.y0 < f.y0 || n.y1 > f.y1) add('region/frame-member-outside', `region frame ${f.id} does not enclose its member ${n.id}`, { region: f.id, member: n.id }, {});
      } else if (overlap(f, n, -0.25)) {
        add('region/frame-foreign-block', `region frame ${f.id} intersects ${n.id}, which is not a member`, { region: f.id, block: n.id }, {});
      }
    }
  }
  for (let i = 0; i < frames.length; i += 1) {
    for (let j = i + 1; j < frames.length; j += 1) {
      const [a, b] = [frames[i], frames[j]];
      const contains = (p, q) => q.x0 >= p.x0 + 1 && q.x1 <= p.x1 - 1 && q.y0 >= p.y0 + 1 && q.y1 <= p.y1 - 1;
      if (contains(a, b) || contains(b, a)) continue;
      if (overlap(a, b, 1)) add('region/frame-edge-crossing', `region frames ${a.id} and ${b.id} cross or share an edge; frames must nest with clearance or stay apart`, { regions: [a.id, b.id] }, {});
    }
  }
  return diagnostics;
}

// A wire running parallel to a region frame closer than frameGap over more
// than 3 pt (dashed control wires: 1.5 × the gap) reads as a second frame.
export function frameHugChecks(frames, segs, frameGap = 6) {
  const out = [];
  for (const f of frames) {
    for (const s of segs) {
      const horizontal = Math.abs(s.a.y - s.b.y) < 0.01;
      const vertical = Math.abs(s.a.x - s.b.x) < 0.01;
      if (!horizontal && !vertical) continue;
      const gap = frameGap * (s.dashed ? 1.5 : 1);
      const overlap = (p0, p1, q0, q1) => Math.min(Math.max(p0, p1), q1) - Math.max(Math.min(p0, p1), q0);
      const cands = horizontal
        ? [f.y0, f.y1].map((y) => ({ d: Math.abs(s.a.y - y), o: overlap(s.a.x, s.b.x, f.x0, f.x1) }))
        : [f.x0, f.x1].map((x) => ({ d: Math.abs(s.a.x - x), o: overlap(s.a.y, s.b.y, f.y0, f.y1) }));
      const hit = cands.find((c0) => c0.d >= 0.75 && c0.d < gap && c0.o > 3);
      if (hit) {
        out.push({ code: 'region/wire-hugs-frame', severity: 'error', message: `wire ${s.id} runs ${Math.round(hit.d * 100) / 100} pt along the frame of region ${f.id}${s.dashed ? ' (a dashed wire beside a dashed frame)' : ''}`, subject: { region: f.id, wire: s.id }, evidence: { gap: hit.d, overlap: hit.o }, supportedFixes: ['route the wire through the region or at least the frame gap away', 'increase the region padding'] });
        break;
      }
    }
  }
  return out;
}

// A net enters a region frame through the side facing its source, clear of
// the frame's corners and of its label band (CONVENTIONS §4.1a,
// region/entry-side): not climbing in over the top-left corner, not cutting
// through the label. entries: [{ net, region, pts }] where pts run from the
// driver (outside) to a sink inside the frame; frames: [{ id, x0, y0, x1, y1,
// labelW?, labelH? }].
export function frameEntryChecks(frames, entries, { frameGap = 6 } = {}) {
  const out = [];
  const corner = 2 * frameGap;
  for (const { net, region, pts } of entries) {
    const f = frames.find((x) => x.id === region);
    if (!f || pts.length < 2) continue;
    const inside = (p) => p.x > f.x0 + 0.01 && p.x < f.x1 - 0.01 && p.y > f.y0 + 0.01 && p.y < f.y1 - 0.01;
    const src = pts[0];
    if (inside(src)) continue;
    // Sides whose outward normal points toward the source.
    const facing = new Set([src.x < f.x0 && 'west', src.x > f.x1 && 'east', src.y < f.y0 && 'north', src.y > f.y1 && 'south'].filter(Boolean));
    for (let k = 1; k < pts.length; k += 1) {
      const [a, b] = [pts[k - 1], pts[k]];
      if (inside(a) || !inside(b)) continue;
      // The crossing point of segment a→b with the frame outline.
      let side;
      let at;
      if (Math.abs(a.y - b.y) < 0.01) { side = b.x > a.x ? 'west' : 'east'; at = { x: side === 'west' ? f.x0 : f.x1, y: a.y }; }
      else { side = b.y > a.y ? 'north' : 'south'; at = { x: a.x, y: side === 'north' ? f.y0 : f.y1 }; }
      const along = side === 'west' || side === 'east' ? [at.y - f.y0, f.y1 - at.y] : [at.x - f.x0, f.x1 - at.x];
      const labelBand = (side === 'west' || side === 'east') ? at.y < f.y0 + (f.labelH ?? 0) : side === 'north' && at.x < f.x0 + (f.labelW ?? 0) + 4;
      const why = !facing.has(side) ? `enters through the ${side} side, which does not face its source (${[...facing].join('/') || 'inside the frame span'})`
        : Math.min(...along) < corner ? `enters ${Math.round(Math.min(...along) * 10) / 10} pt from a corner (keep ${corner} pt)`
          : labelBand ? 'enters through the frame label band' : null;
      if (why) out.push({ code: 'region/entry-side', severity: 'error', message: `net ${net} ${why} of region ${region}`, subject: { id: net, region }, evidence: { side, at: { x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100 }, facing: [...facing] }, supportedFixes: ['route the net to the side of the frame that faces its source', 'move the member pin so the net enters mid-edge'] });
      break;
    }
  }
  return out;
}

// Owner of a drawn part: "net-x-seg0", "net-x-arrow1", "link-l-label" → "net-x" / "link-l".
export const ownerOf = (id) => String(id || '').replace(/-(?:stub-arrow|arrow\d*|seg\d+|stub|label|name|width|slash|slice|dot\d+|crossing)$/, '');

// Arrowheads must not overlap each other or touch another owner's wire, and
// no foreign text may sit next to an arrow's head or the last stretch of its
// shaft (CONVENTIONS §1, SPEC §9.4).
export function arrowChecks(tree, boxes, segs, lines) {
  const diagnostics = [];
  const heads = [];
  walk(tree, (n) => {
    if (n.name !== 'path' || !/-arrow\d*$/.test(n.attrs?.id || '')) return;
    const pts = [...n.attrs.d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    if (pts.length < 3) return;
    const tip = pts[1];
    heads.push({ id: n.attrs.id, owner: ownerOf(n.attrs.id), tip, box: { x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) } });
  });
  for (let i = 0; i < heads.length; i += 1) {
    for (let j = i + 1; j < heads.length; j += 1) {
      if (heads[i].owner === heads[j].owner) continue;
      if (overlap(heads[i].box, heads[j].box, 0.3)) diagnostics.push({ code: 'arrow/marker-overlap', severity: 'error', message: `arrowheads ${heads[i].id} and ${heads[j].id} overlap`, subject: { ids: [heads[i].id, heads[j].id] }, evidence: {}, supportedFixes: ['give the arrows distinct pins on the target', 'route one of them to another side'] });
    }
    const h = heads[i];
    // Only other connections count (nets, links, attachments); strokes of the
    // symbol the arrow enters (operator lines, gate stubs) belong to its pin.
    const shaft = [...segs, ...lines].filter((s) => ownerOf(s.id) !== h.owner && /^(net|link|att)-/.test(s.id));
    const hit = shaft.find((s) => overlap(h.box, segBox(s), -0.2));
    if (hit) diagnostics.push({ code: 'arrow/marker-overlap', severity: 'error', message: `arrowhead ${h.id} touches ${hit.id}`, subject: { id: h.id, line: hit.id }, evidence: {}, supportedFixes: ['give the arrow its own pin on the target', 'route the other wire away from the arrow'] });
  }
  // Arrow zone: the head plus the last 8 pt of the shaft segment that ends at
  // the head (not earlier bends of the same wire), grown by 1.5 pt.
  const zones = heads.map((h) => {
    const reach = Math.max(h.box.x1 - h.box.x0, h.box.y1 - h.box.y0) + 1;
    // only the wire shaft itself (not the net's own width slash or labels)
    const own = [...segs, ...lines].filter((s) => ownerOf(s.id) === h.owner && /^(net|link|att)-/.test(s.id) && /-(seg\d+|stub)$/.test(s.id) && (Math.hypot(s.a.x - h.tip.x, s.a.y - h.tip.y) <= reach || Math.hypot(s.b.x - h.tip.x, s.b.y - h.tip.y) <= reach));
    const pts = [h.box, ...own.map(segBox)].map((b) => b);
    const box = { x0: Math.min(...pts.map((b) => b.x0)), x1: Math.max(...pts.map((b) => b.x1)), y0: Math.min(...pts.map((b) => b.y0)), y1: Math.max(...pts.map((b) => b.y1)) };
    // clip the zone to 8 pt behind the tip
    const clip = { x0: Math.max(box.x0, h.tip.x - 8), x1: Math.min(box.x1, h.tip.x + 8), y0: Math.max(box.y0, h.tip.y - 8), y1: Math.min(box.y1, h.tip.y + 8) };
    return { h, zone: { x0: clip.x0 - 1.5, x1: clip.x1 + 1.5, y0: clip.y0 - 1.5, y1: clip.y1 + 1.5 } };
  });
  for (const box of boxes) {
    for (const { h, zone } of zones) {
      if (ownerOf(box.id) === h.owner) continue;
      if (overlap(box, zone, -0.05)) {
        diagnostics.push({ code: 'arrow/label-proximity', severity: 'error', message: `text "${box.text}" sits against arrow ${h.id}`, subject: { label: box.id, arrow: h.id }, evidence: {}, supportedFixes: ['move the label away from the arrowhead', 'give the arrow its own pin'] });
        break;
      }
    }
  }
  return diagnostics;
}

export function geometryChecks(tree, { font, polygons = [], frames = [], nodes = [], frameGap = 6 }) {
  const diagnostics = [];
  const boxes = textBoxes(tree, font);
  const segs = wireSegments(tree);
  const lines = otherLines(tree);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (overlap(boxes[i], boxes[j])) diagnostics.push({ code: 'geometry/label-overlap', severity: 'error', message: `labels "${boxes[i].text}" and "${boxes[j].text}" overlap`, subject: { ids: [boxes[i].id, boxes[j].id] }, evidence: {}, supportedFixes: ['add short_label', 'increase spacing for this variant'] });
    }
  }
  for (const box of boxes) {
    const wire = segs.find((s) => overlap(box, segBox(s), -0.05));
    if (wire) diagnostics.push({ code: 'geometry/label-on-wire', severity: 'error', message: `label "${box.text}" touches wire ${wire.id}`, subject: { label: box.id, wire: wire.id }, evidence: {}, supportedFixes: ['move the label', 'increase spacing for this variant'] });
    // Width numbers keep 1 pt from outlines (a digit against a bar edge reads as part of it).
    const grown = /-width$/.test(box.id || '') ? { ...box, x0: box.x0 - 1, x1: box.x1 + 1, y0: box.y0 - 1, y1: box.y1 + 1 } : box;
    // (its own slash and wire are part of the label)
    const line = lines.find((s) => (grown === box ? lineTouchesBox(s, box) : ownerOf(s.id) !== ownerOf(box.id) && lineTouchesBox(s, grown)) && !(grown !== box && /^region-/.test(s.id)));
    if (line) diagnostics.push({ code: 'geometry/text-on-line', severity: 'error', message: `text "${box.text}" is struck by line ${line.id}`, subject: { label: box.id, line: line.id }, evidence: { line: { a: line.a, b: line.b } }, supportedFixes: ['move the text', 'increase spacing for this variant'] });
    const missing = font.missing(box.text);
    if (missing.length) diagnostics.push({ code: 'text/glyph-missing', severity: 'error', message: `label "${box.text}" uses characters without a glyph in ${font.family}: ${missing.join(' ')}`, subject: { label: box.id }, evidence: { missing }, supportedFixes: ['use ASCII / Latin-1 characters', 'choose a font with these glyphs'] });
  }
  for (const { id, points, margin, labelIds } of polygons) {
    const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
    const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
    for (const box of boxes.filter((b) => labelIds.includes(b.id))) {
      const corners = [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x0, y: box.y1 }, { x: box.x1, y: box.y1 }];
      const inside = points.every((a, k) => {
        const b = points[(k + 1) % points.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const side = (p) => ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len;
        const inward = Math.sign(side({ x: cx, y: cy }));
        return corners.every((c) => side(c) * inward >= margin);
      });
      if (!inside) diagnostics.push({ code: 'symbol/label-clearance', severity: 'error', message: `label "${box.text}" is closer than ${margin} pt to the outline of ${id}`, subject: { id, label: box.id }, evidence: {}, supportedFixes: ['increase the symbol end padding', 'use mux_style bar'] });
    }
  }
  diagnostics.push(...frameChecks(frames, nodes));
  diagnostics.push(...arrowChecks(tree, boxes, segs, lines));
  // A wire lying on a frame edge reads as part of the frame.
  for (const f of frames) {
    const hit = segs.find((s) => {
      const horizontal = Math.abs(s.a.y - s.b.y) < 0.01;
      const vertical = Math.abs(s.a.x - s.b.x) < 0.01;
      const over = (p0, p1, q0, q1) => Math.min(Math.max(p0, p1), q1) - Math.max(Math.min(p0, p1), q0) > 2;
      return (horizontal && (Math.abs(s.a.y - f.y0) < 0.75 || Math.abs(s.a.y - f.y1) < 0.75) && over(s.a.x, s.b.x, f.x0, f.x1))
        || (vertical && (Math.abs(s.a.x - f.x0) < 0.75 || Math.abs(s.a.x - f.x1) < 0.75) && over(s.a.y, s.b.y, f.y0, f.y1));
    });
    if (hit) diagnostics.push({ code: 'region/wire-on-frame', severity: 'error', message: `wire ${hit.id} runs along the edge of region frame ${f.id}`, subject: { region: f.id, wire: hit.id }, evidence: {}, supportedFixes: ['increase region padding', 'set frame: false for this region'] });
  }
  diagnostics.push(...frameHugChecks(frames, segs, frameGap));
  return diagnostics;
}
