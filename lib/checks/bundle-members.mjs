// RTL signals a drawn net stands for (SPEC §4.5 bundles, §4.7): its
// rtl.signal, or every member of a heterogeneous bundle — the net's bundle_of
// list and the RTL ports listed on a bundled instance pin at either end.
// Latency and structural cross-checks expand bundles through this, so a figure
// drawn with bundles is verified per member instead of being skipped.
// Paths are flattened dotted paths (top.inst.sub.signal).

const relToPath = (flat, rel) => [flat.top, ...(rel ? String(rel).split('/') : [])].join('.');

// n: a model net ({ net, driver, sinks }); base: meta.rtl.instance.
export function netSignalPaths(n, flat, base) {
  const inst = n.net.rtl?.instance ?? base;
  if (n.net.rtl?.signal) return { paths: [`${relToPath(flat, inst)}.${n.net.rtl.signal}`], bundled: false };
  const paths = [];
  for (const m of n.net.bundle_of || []) {
    const parts = String(m).split('.');
    const sig = parts.pop();
    const rel = [...(inst ? String(inst).split('/') : []), ...parts].join('/');
    paths.push(`${relToPath(flat, rel)}.${sig}`);
  }
  for (const end of [n.driver, ...n.sinks]) {
    if (end.error || !(end.pin?.bundle?.length >= 2)) continue;
    if (end.element.kind !== 'instance' || !end.element.rtl?.instance) continue;
    for (const port of end.pin.bundle) paths.push(`${relToPath(flat, end.element.rtl.instance)}.${port}`);
  }
  return { paths: [...new Set(paths)], bundled: paths.length > 0 };
}
