// Minimal deterministic SVG tree + serializer shared by all renderers.
// Numbers are rounded to 0.01; attribute order is insertion order.

export const num = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function el(name, attrs = {}, children = []) {
  return { name, attrs, children };
}

export function serialize(node, indent = '') {
  if (typeof node === 'string') return `${indent}${esc(node)}`;
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? num(v) : v)}"`).join('');
  if (!node.children.length) return `${indent}<${node.name}${attrs}/>`;
  if (node.children.length === 1 && typeof node.children[0] === 'string') return `${indent}<${node.name}${attrs}>${esc(node.children[0])}</${node.name}>`;
  return `${indent}<${node.name}${attrs}>\n${node.children.map((c) => serialize(c, `${indent}  `)).join('\n')}\n${indent}</${node.name}>`;
}

export function walk(node, visit) {
  if (typeof node === 'string') return;
  visit(node);
  for (const c of node.children) walk(c, visit);
}

export const pathD = (pts) => pts.map((p, k) => `${k ? 'L' : 'M'}${num(p.x)} ${num(p.y)}`).join(' ');

// Minimum font size and stroke width actually used in a tree (print checks).
export function printMetrics(tree) {
  let minFont = Infinity;
  let minStroke = Infinity;
  walk(tree, (n) => {
    if (n.name === 'text') minFont = Math.min(minFont, Number(n.attrs['font-size']));
    const stroke = n.attrs.stroke;
    if (stroke && stroke !== 'none' && n.attrs['stroke-width'] !== undefined) minStroke = Math.min(minStroke, Number(n.attrs['stroke-width']));
  });
  return { minFont, minStroke };
}
