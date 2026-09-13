// Micro-architecture / SoC semantic checks (SPEC §7).

import fs from 'node:fs';
import path from 'node:path';
import { diagnostic } from '../diagnostics.mjs';
import { checkMemoryMap } from './memory-map.mjs';

const NON_MEMORY_MAPPED = new Set(['AXI4-Stream', 'custom']);

export function checkMicroarch(doc, { figureDir } = {}) {
  const diagnostics = [];
  const add = (code, message, subject = {}, evidence = {}, supportedFixes = [], severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  const blocks = new Map((doc.blocks || []).map((b) => [b.id, b]));
  const fabrics = new Map((doc.fabrics || []).map((f) => [f.id, f]));
  const attachments = doc.attachments || [];
  const links = doc.links || [];
  const domains = new Map((doc.domains || []).map((d) => [d.id, d]));

  const seen = new Set();
  for (const item of [...(doc.blocks || []), ...(doc.fabrics || []), ...attachments, ...links, ...(doc.domains || []), ...(doc.groups || []), ...(doc.stages || [])]) {
    if (seen.has(item.id)) add('ir/duplicate-id', `duplicate id '${item.id}'`, { id: item.id }, {}, ['rename one of the duplicates']);
    seen.add(item.id);
  }
  const need = (map, id, where) => {
    if (!map.has(id)) add('soc/unknown-ref', `${where} references unknown '${id}'`, { ref: id, where }, {}, ['fix the id']);
  };
  for (const a of attachments) { need(fabrics, a.fabric, `attachment ${a.id}.fabric`); need(blocks, a.block, `attachment ${a.id}.block`); }
  for (const l of links) { need(blocks, l.from, `link ${l.id}.from`); need(blocks, l.to, `link ${l.id}.to`); }
  for (const d of domains.values()) for (const m of d.members) need(blocks, m, `domain ${d.id}`);
  for (const g of [...(doc.groups || []), ...(doc.stages || [])]) for (const m of g.members) need(blocks, m, `group ${g.id}`);
  for (const an of doc.annotations || []) if (an.block) need(blocks, an.block, `annotation ${an.id || an.kind}`);

  // fabrics and roles
  for (const f of fabrics.values()) {
    const on = attachments.filter((a) => a.fabric === f.id);
    if (!on.some((a) => a.role === 'manager')) add('soc/fabric-roles', `fabric ${f.id} has no manager attachment`, { id: f.id }, {}, ['attach a manager (core, bridge, DMA master)']);
    const memoryMapped = f.memory_mapped ?? !NON_MEMORY_MAPPED.has(f.protocol);
    if (memoryMapped) {
      for (const a of on.filter((x) => x.role === 'subordinate' && !x.address)) {
        if (a.address_unknown) add('soc/address-unknown', `subordinate ${a.id} on ${f.id} has no documented address window`, { id: a.id }, {}, ['add address {base, size} when it is known'], 'warning');
        else add('soc/fabric-roles', `subordinate ${a.id} on memory-mapped fabric ${f.id} has no address`, { id: a.id }, {}, ['add address {base, size}', 'mark address_unknown: true for context blocks', 'set fabric memory_mapped false']);
      }
    }
  }
  for (const b of [...blocks.values()].filter((x) => x.kind === 'bridge')) {
    const mine = attachments.filter((a) => a.block === b.id);
    const up = mine.filter((a) => a.role === 'subordinate');
    const down = mine.filter((a) => a.role === 'manager');
    if (!up.length || !down.length || down.every((d) => up.some((u) => u.fabric === d.fabric))) {
      add('soc/bridge-shape', `bridge ${b.id} needs a subordinate attachment upstream and a manager attachment on a different downstream fabric`, { id: b.id }, {}, ['add the missing attachment']);
    }
  }

  const mm = checkMemoryMap(doc);
  diagnostics.push(...mm.diagnostics);

  // interrupts, DMA
  const irqSeen = new Map();
  for (const l of links.filter((x) => x.class === 'interrupt')) {
    const target = blocks.get(l.to);
    if (target && !['core', 'interrupt_controller'].includes(target.kind)) add('irq/target-kind', `interrupt link ${l.id} ends at ${target.kind} ${target.id}; expected a core or interrupt_controller`, { id: l.id }, {}, ['route the interrupt to the interrupt controller or core']);
    if (l.irq !== undefined) {
      const key = `${l.to}:${l.irq}`;
      if (irqSeen.has(key)) add('irq/duplicate-line', `interrupt links ${irqSeen.get(key)} and ${l.id} both use line ${l.irq} on ${l.to}`, { ids: [irqSeen.get(key), l.id] }, {}, ['assign distinct IRQ lines']);
      irqSeen.set(key, l.id);
    }
  }
  for (const l of links.filter((x) => x.class === 'dma')) {
    if (!attachments.some((a) => a.block === l.from && a.role === 'manager')) add('dma/no-manager', `DMA link ${l.id}: ${l.from} has no manager attachment on any fabric`, { id: l.id }, {}, [`add a manager attachment for ${l.from}`]);
  }

  // domain crossings
  const domainOf = (blockId, kind) => [...domains.values()].find((d) => d.kind === kind && d.members.includes(blockId))?.id;
  const declared = (doc.crossings || []);
  const isDeclared = (ref, a, b) => declared.some((c) => (c.link === ref || c.attachment === ref) && ((c.from === a && c.to === b) || (c.from === b && c.to === a)));
  for (const kind of ['clock', 'reset', 'power']) {
    for (const l of links) {
      const a = domainOf(l.from, kind);
      const b = domainOf(l.to, kind);
      if (a && b && a !== b && !isDeclared(l.id, a, b)) add('domain/crossing-unmarked', `link ${l.id} crosses ${kind} domains ${a} → ${b} without a declared crossing`, { id: l.id }, { kind, from: a, to: b }, ['add a crossings entry with via (sync, isolation, …)']);
    }
    for (const at of attachments.filter((x) => x.role === 'subordinate')) {
      const sub = domainOf(at.block, kind);
      for (const mgr of attachments.filter((x) => x.fabric === at.fabric && x.role === 'manager')) {
        const md = domainOf(mgr.block, kind);
        if (sub && md && sub !== md && !isDeclared(at.id, sub, md)) add('domain/crossing-unmarked', `attachment ${at.id} crosses ${kind} domains ${md} → ${sub} without a declared crossing`, { id: at.id }, { kind, from: md, to: sub }, ['add a crossings entry with via (async_bridge, isolation, …)']);
      }
    }
  }
  for (const c of declared) {
    if (!domains.has(c.from) || !domains.has(c.to)) add('soc/unknown-ref', `crossing ${c.link || c.attachment} references an unknown domain`, { ref: c.link || c.attachment }, {}, ['fix from/to']);
    if (c.link && !links.some((l) => l.id === c.link)) add('soc/unknown-ref', `crossing references unknown link ${c.link}`, { ref: c.link });
    if (c.attachment && !attachments.some((a) => a.id === c.attachment)) add('soc/unknown-ref', `crossing references unknown attachment ${c.attachment}`, { ref: c.attachment });
  }

  // replication, drill-down
  for (const b of blocks.values()) {
    const count = b.replicate?.count;
    if (typeof count === 'string' && !Object.hasOwn(doc.params || {}, count)) add('replicate/count', `block ${b.id}: replicate count '${count}' is not a param`, { id: b.id }, {}, ['define the param', 'use an integer']);
    const refs = [b.detail_ref, ...(doc.annotations || []).filter((an) => an.block === b.id && an.target).map((an) => an.target)].filter(Boolean);
    for (const ref of refs) {
      if (!figureDir) continue;
      const file = path.resolve(figureDir, ref.figure);
      if (!fs.existsSync(file)) { add('detail/ref-unresolved', `block ${b.id}: detail figure ${ref.figure} not found`, { id: b.id }, { file: ref.figure }, ['fix the relative path']); continue; }
      if (ref.id) {
        const target = JSON.parse(fs.readFileSync(file, 'utf8'));
        const ids = new Set([...(target.elements || []), ...(target.blocks || []), ...(target.states || [])].map((x) => x.id));
        if (!ids.has(ref.id)) add('detail/ref-unresolved', `block ${b.id}: id ${ref.id} not found in ${ref.figure}`, { id: b.id }, {}, ['fix the id']);
      }
    }
  }

  return { diagnostics, addressTable: mm.table };
}
