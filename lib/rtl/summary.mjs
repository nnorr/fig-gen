// `check-rtl --summary`: one line per module of the elaborated hierarchy,
// then the file resolution (when --search-path was used) and the diagnostics.

export function summaryLines(netlist) {
  const reachable = new Map();
  for (const h of netlist.hierarchy || []) reachable.set(h.module, (reachable.get(h.module) || 0) + 1);
  const unresolved = new Map();
  for (const d of netlist.diagnostics || []) {
    if (d.code === 'rtl/width-unresolved' && d.subject?.module) unresolved.set(d.subject.module, (unresolved.get(d.subject.module) || 0) + 1);
  }
  const lines = [`top ${netlist.top}: ${netlist.modules.length} modules, ${netlist.hierarchy?.length ?? 0} instances in the hierarchy (adapter ${netlist.adapter?.id} ${netlist.adapter?.version})`];
  for (const m of netlist.modules) {
    const name = m.orig_name === m.name ? m.name : `${m.orig_name} [${m.name}]`;
    const file = m.source ? `${m.source.file}:${m.source.line}` : '-';
    const extra = [
      m.blackbox ? `blackbox=${m.blackbox.origin}` : null,
      reachable.has(m.name) ? (reachable.get(m.name) > 1 ? `used=${reachable.get(m.name)}` : null) : 'unreachable',
    ].filter(Boolean).join(' ');
    lines.push(`module ${name} ${file} ports=${m.ports.length} instances=${m.instances.length} registers=${m.registers.length} width-unresolved=${unresolved.get(m.name) || 0}${extra ? ` ${extra}` : ''}`);
  }
  const res = netlist.inputs?.resolution;
  if (res) {
    lines.push(`resolution: ${res.files.length} files from ${res.scanned} scanned; ${res.duplicates.length} duplicate definitions; ${res.unresolved.length} unresolved`);
    for (const d of res.duplicates) lines.push(`  duplicate ${d.kind || ''} ${d.name}: using ${d.chosen} (${d.reason}); also ${d.candidates.filter((c) => c !== d.chosen).join(', ')}`);
  }
  const diags = netlist.diagnostics || [];
  const counts = {};
  for (const d of diags) counts[`${d.severity} ${d.code}`] = (counts[`${d.severity} ${d.code}`] || 0) + 1;
  lines.push(`diagnostics: ${diags.length}${diags.length ? ` (${Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join(', ')})` : ''}`);
  for (const d of diags) lines.push(`  ${d.severity} ${d.code}: ${d.message}`);
  return lines;
}
