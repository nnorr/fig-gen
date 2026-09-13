// Collision-aware label placement: labels are tried at candidate positions
// in order and committed at the first spot that clears every obstacle
// (symbol boxes, wire segments with stroke, already placed labels).

export class LabelPlacer {
  constructor(font, { pad = 0.4 } = {}) {
    this.font = font;
    this.pad = pad;
    this.obstacles = [];
  }

  addRect(r) {
    this.obstacles.push(r);
  }

  addPolyline(pts, strokeWidth = 0.6) {
    const hw = strokeWidth / 2;
    for (let k = 1; k < pts.length; k += 1) {
      const a = pts[k - 1];
      const b = pts[k];
      this.obstacles.push({ x0: Math.min(a.x, b.x) - hw, y0: Math.min(a.y, b.y) - hw, x1: Math.max(a.x, b.x) + hw, y1: Math.max(a.y, b.y) + hw });
    }
  }

  box(value, size, x, baseline) {
    return { x0: x, x1: x + this.font.measure(value, size), y0: baseline - this.font.ascent * size, y1: baseline + this.font.descent * size * 0.6 };
  }

  fits(box, { within } = {}) {
    const p = this.pad;
    if (within && (box.x0 < within.x0 || box.x1 > within.x1 || box.y0 < within.y0 || box.y1 > within.y1)) return false;
    return !this.obstacles.some((o) => box.x0 < o.x1 + p && o.x0 < box.x1 + p && box.y0 < o.y1 + p && o.y0 < box.y1 + p);
  }

  // candidates: [{ x, y }] with y = baseline; returns the chosen candidate or null.
  place(value, size, candidates, options = {}) {
    for (const c of candidates) {
      const box = this.box(value, size, c.x, c.y);
      if (this.fits(box, options)) {
        this.obstacles.push(box);
        return { ...c, box };
      }
    }
    return null;
  }
}
