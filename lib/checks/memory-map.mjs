// Memory-map checks for microarch figures (SPEC §7): format, overlap within
// an address space, alignment, and bridge-window containment. Address spaces
// are per root fabric; a fabric reached through a bridge shares the root's
// space, with an optional `offset` added to its attachments.

import { diagnostic } from '../diagnostics.mjs';

export function parseHex(text) {
  if (!/^0[xX][0-9a-fA-F][0-9a-fA-F_]*$/.test(text || '')) return null;
  return BigInt(`0x${text.slice(2).replace(/_/g, '')}`);
}

export const formatHex = (value) => {
  const hex = value.toString(16).toUpperCase().padStart(8, '0');
  return `0x${hex.replace(/(?=(?:[0-9A-F]{4})+$)(?!^)/g, '_')}`;
};

function rangeOf(att, add) {
  const a = att.address;
  const base = parseHex(a.base);
  const size = a.size !== undefined ? parseHex(a.size) : null;
  const end = a.end !== undefined ? parseHex(a.end) : null;
  if (base === null || (a.size !== undefined && size === null) || (a.end !== undefined && end === null)) {
    add('memmap/format', `attachment ${att.id}: address is not valid hex`, { id: att.id }, { address: a }, ['write addresses as 0x-prefixed hex, underscores allowed']);
    return null;
  }
  const last = size !== null ? base + size - 1n : end;
  if (last < base || (size !== null && size === 0n)) {
    add('memmap/format', `attachment ${att.id}: end is below base or size is zero`, { id: att.id }, { address: a }, ['fix base/size/end']);
    return null;
  }
  return { base, last, size: last - base + 1n };
}

export function checkMemoryMap(doc) {
  const diagnostics = [];
  const add = (code, message, subject, evidence, supportedFixes = [], severity = 'error') => diagnostics.push(diagnostic({ code, severity, message, subject, evidence, supportedFixes }));
  const attachments = doc.attachments || [];
  const alignment = parseHex(doc.address_map?.alignment || '0x1000') ?? 0x1000n;

  // Bridges: subordinate on upstream fabric + manager on downstream fabric.
  const parentFabric = new Map();
  const bridgeWindow = new Map();
  const blocksById = new Map((doc.blocks || []).map((b) => [b.id, b]));
  for (const block of blocksById.values()) {
    if (block.kind !== 'bridge') continue;
    const up = attachments.find((a) => a.block === block.id && a.role === 'subordinate');
    const downs = attachments.filter((a) => a.block === block.id && a.role === 'manager');
    for (const down of downs) {
      if (up) {
        parentFabric.set(down.fabric, up.fabric);
        bridgeWindow.set(down.fabric, { attachment: up, bridge: block.id });
      }
    }
  }
  const rootOf = (fabric) => {
    const seen = new Set();
    let f = fabric;
    while (parentFabric.has(f) && !seen.has(f)) { seen.add(f); f = parentFabric.get(f); }
    return f;
  };

  const entries = [];
  for (const att of attachments) {
    if (att.role !== 'subordinate' || !att.address) continue;
    const r = rangeOf(att, add);
    if (!r) continue;
    const offset = att.address.offset ? parseHex(att.address.offset) ?? 0n : 0n;
    const entry = { att, base: r.base + offset, last: r.last + offset, size: r.size, space: rootOf(att.fabric), isBridgeWindow: blocksById.get(att.block)?.kind === 'bridge' };
    entries.push(entry);
    if (entry.base % alignment !== 0n || entry.size % alignment !== 0n) {
      add('memmap/misaligned', `attachment ${att.id}: ${formatHex(entry.base)}–${formatHex(entry.last)} is not aligned to ${formatHex(alignment)}`, { id: att.id }, { alignment: formatHex(alignment) }, ['align base and size to address_map.alignment', 'set address_map.alignment'], 'warning');
    } else if ((entry.size & (entry.size - 1n)) !== 0n) {
      add('memmap/misaligned', `attachment ${att.id}: size ${formatHex(entry.size)} is not a power of two`, { id: att.id }, {}, ['use a power-of-two window size'], 'warning');
    }
  }

  // Overlaps within one address space. A bridge window legitimately contains
  // the ranges behind it, so window-vs-downstream pairs are containment-checked instead.
  const bySpace = new Map();
  for (const e of entries) {
    if (!bySpace.has(e.space)) bySpace.set(e.space, []);
    bySpace.get(e.space).push(e);
  }
  for (const list of bySpace.values()) {
    list.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length && list[j].base <= list[i].last; j += 1) {
        const [x, y] = [list[i], list[j]];
        const windowPair = (x.isBridgeWindow && y.att.fabric !== x.att.fabric) || (y.isBridgeWindow && x.att.fabric !== y.att.fabric);
        if (windowPair) continue;
        add('memmap/overlap', `${x.att.id} ${formatHex(x.base)}–${formatHex(x.last)} overlaps ${y.att.id} ${formatHex(y.base)}–${formatHex(y.last)}`, { ids: [x.att.id, y.att.id] }, {}, ['move one base address', 'shrink one window']);
      }
    }
  }

  for (const e of entries) {
    const window = bridgeWindow.get(e.att.fabric);
    if (!window) continue;
    const w = entries.find((x) => x.att.id === window.attachment.id);
    if (w && (e.base < w.base || e.last > w.last)) {
      add('memmap/bridge-window', `${e.att.id} ${formatHex(e.base)}–${formatHex(e.last)} lies outside bridge ${window.bridge} window ${formatHex(w.base)}–${formatHex(w.last)}`, { id: e.att.id, bridge: window.bridge }, {}, ['move the range inside the bridge window', 'widen the bridge window', 'add an address offset']);
    }
  }

  const table = entries
    .filter((e) => !e.isBridgeWindow)
    .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0))
    .map((e) => ({ block: e.att.block, fabric: e.att.fabric, base: formatHex(e.base), end: formatHex(e.last), size: formatHex(e.size) }));
  return { diagnostics, table };
}
