// Streaming VCD reader (IEEE 1364 value change dump). Reads the file in chunks
// so large dumps never sit in memory whole; only the value changes of the
// selected signals are kept.
//
// readVcd(file, { select }) -> {
//   timescale: { value, unit, fs },       // fs: femtoseconds per time unit
//   signals: [{ path, id, width, msb, lsb, kind }],   // every declared variable
//   changes: Map(path -> [{ t, v }]),     // selected signals only; v is a bit string ('0101', 'x', 'z')
//   end: last timestamp
// }
// select(path) -> boolean chooses which signals keep their changes (default: all).

import fs from 'node:fs';

const UNIT_FS = { s: 1e15, ms: 1e12, us: 1e9, ns: 1e6, ps: 1e3, fs: 1 };

export function parseTimescale(text) {
  const m = /(\d+)\s*(s|ms|us|ns|ps|fs)/.exec(String(text));
  if (!m) return { value: 1, unit: 's', fs: 1e15 };
  return { value: Number(m[1]), unit: m[2], fs: Number(m[1]) * UNIT_FS[m[2]] };
}

// Normalise a VCD value to a bit string of the variable's width: scalars
// '0'/'1'/'x'/'z', vectors 'b0101' (left-extended per IEEE: 0/1 extend with 0,
// x with x, z with z), reals kept as 'r<value>'.
export function normaliseValue(raw, width) {
  if (raw[0] === 'r' || raw[0] === 'R') return raw;
  let bits = raw[0] === 'b' || raw[0] === 'B' ? raw.slice(1) : raw;
  bits = bits.toLowerCase();
  if (bits.length < width) {
    const pad = bits[0] === 'x' ? 'x' : bits[0] === 'z' ? 'z' : '0';
    bits = pad.repeat(width - bits.length) + bits;
  } else if (bits.length > width) bits = bits.slice(bits.length - width);
  return bits;
}

function* lines(file, chunkSize = 1 << 20) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(chunkSize);
  let rest = '';
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkSize, null);
      if (!n) break;
      const text = rest + buf.toString('latin1', 0, n);
      const parts = text.split('\n');
      rest = parts.pop();
      for (const p of parts) yield p;
    }
    if (rest) yield rest;
  } finally {
    fs.closeSync(fd);
  }
}

export function readVcd(file, { select = () => true } = {}) {
  const scope = [];
  const signals = [];
  const byId = new Map();
  let timescale = { value: 1, unit: 's', fs: 1e15 };
  let inHeader = true;
  let pendingTimescale = null;
  let t = 0;
  let end = 0;
  const changes = new Map();
  let tokens = [];
  const record = (id, raw) => {
    const vars = byId.get(id);
    if (!vars) return;
    for (const v of vars) {
      if (!v.keep) continue;
      const value = normaliseValue(raw, v.width);
      const list = changes.get(v.path);
      if (list.length && list[list.length - 1].t === t) list[list.length - 1].v = value;
      else if (!list.length || list[list.length - 1].v !== value) list.push({ t, v: value });
    }
  };
  for (const line of lines(file)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (inHeader) {
      tokens.push(...trimmed.split(/\s+/));
      // Header commands end with $end; process complete commands only.
      while (tokens.length) {
        const endAt = tokens.indexOf('$end');
        if (tokens[0] === '$enddefinitions') { inHeader = false; tokens = []; break; }
        if (tokens[0] === '$dumpvars' || tokens[0] === '#0' || /^#\d+$/.test(tokens[0])) { inHeader = false; break; }
        if (endAt < 0) break;
        const cmd = tokens.slice(0, endAt + 1);
        tokens = tokens.slice(endAt + 1);
        if (cmd[0] === '$scope') scope.push(cmd[2]);
        else if (cmd[0] === '$upscope') scope.pop();
        else if (cmd[0] === '$timescale') { pendingTimescale = cmd.slice(1, -1).join(''); timescale = parseTimescale(pendingTimescale); }
        else if (cmd[0] === '$var') {
          const [, kind, widthText, id, name, maybeRange] = cmd;
          const width = Number(widthText);
          const range = maybeRange && maybeRange !== '$end' ? /\[(\d+)(?::(\d+))?\]/.exec(maybeRange) : null;
          const path = [...scope, name].join('.');
          const entry = { path, id, width, kind, ...(range ? { msb: Number(range[1]), lsb: Number(range[2] ?? range[1]) } : {}) };
          entry.keep = select(path, entry);
          signals.push(entry);
          if (!byId.has(id)) byId.set(id, []);
          byId.get(id).push(entry);
          if (entry.keep) changes.set(path, []);
        }
      }
      if (inHeader) continue;
      // fall through with any tokens left on this line (e.g. "#0")
      if (!tokens.length) continue;
    }
    const parts = tokens.length ? tokens : trimmed.split(/\s+/);
    tokens = [];
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      if (!p) continue;
      if (p[0] === '#') { t = Number(p.slice(1)); if (t > end) end = t; continue; }
      if (p[0] === '$') continue; // $dumpvars, $end, $dumpon ...
      const c = p[0];
      if (c === 'b' || c === 'B' || c === 'r' || c === 'R') { record(parts[i + 1], p); i += 1; continue; }
      if ('01xXzZ'.includes(c)) record(p.slice(1), c.toLowerCase());
    }
  }
  for (const s of signals) delete s.keep;
  return { timescale, signals, changes, end };
}

// Value of a change list at time t, taken strictly before t (the value held
// just before an edge at t), or at/before t when inclusive.
export function valueBefore(list, t, { inclusive = false } = {}) {
  let lo = 0;
  let hi = list.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (inclusive ? list[mid].t <= t : list[mid].t < t) { found = list[mid].v; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// Active edges of a clock: times where its least significant bit changes to 1
// (pos) or 0 (neg). A clock declared wider than one bit (a testbench logic
// vector) still has its edges on bit 0.
export function edgesOf(list, edge = 'pos') {
  const want = edge === 'neg' ? '0' : '1';
  const out = [];
  let prev = null;
  for (const c of list) {
    const bit = c.v.at(-1);
    if (bit === want && prev !== null && prev !== want) out.push(c.t);
    prev = bit;
  }
  return out;
}

// Signal paths matching a hierarchical name or glob (`*` one level segment
// part, `**` any depth).
export function globMatcher(patterns) {
  const res = patterns.map((p) => new RegExp(`^${String(p).split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*')).join('.*')}$`));
  return (path) => res.some((re) => re.test(path));
}
