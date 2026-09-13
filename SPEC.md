# rtl-figures — Specification (Phase 1 draft)

Status: draft for review. Conventions for sizes, fonts, symbols and line
weights are **provisional** until `references/CONVENTIONS.md` (sibling
research task) lands; where the two disagree, CONVENTIONS.md wins and this
file is updated.

## Contents

1. Goals and non-goals
2. Pipeline overview
3. Shared IR concepts (document envelope, widths, endpoints, source pins, diagnostics)
4. `datapath` IR
5. `fsm` IR
6. `timing` IR (native + WaveJSON input)
7. `microarch` IR
8. Semantic checks (catalog)
9. Layout
10. Rendering and print output
11. RTL cross-check (tool-agnostic adapters)
12. Receipts, delivery, visual check
13. Licensing and neutrality rules
14. Phase plan and open questions

---

## 1. Goals and non-goals

Goals

- Author a figure as a small typed JSON document; get a deterministic vector
  SVG (canonical artifact) and a PDF sized to an IEEE/ACM single or double
  column, readable in grayscale print.
- Hardware semantics are first-class: widths, mux selects, clocks, domains,
  pipeline stages, memories. A figure that is electrically nonsense fails
  validation before any layout work.
- Figures can be *grounded*: element and net source pins (file:line at a Git
  revision), a normalized netlist extracted from RTL by a pluggable tool
  adapter, and waveforms derived from real simulation.
- Diagnostics are machine-actionable (`code`, `subject`, `evidence`,
  `supportedFixes`) so an agent can repair a candidate in a bounded loop.

Non-goals (v1)

- Not a schematic editor, synthesis viewer, or gate-level netlist renderer
  (tools like netlistsvg already do that). Figures are *abstractions* chosen
  by an author; the netlist is evidence, not the drawing.
- No interactive viewer. No Figma / GUI step in the pipeline (an optional
  later export for hand polish may exist; it is never the source of truth).
- No embedded EDA tool, license, PDK or vendor-specific knowledge.

## 2. Pipeline overview

```
author JSON ──► schema (ajv, strict) ──► semantic checks ──► [RTL cross-check] ──► layout (ELK / grid)
                                                                                     │
      receipt ◄── deliver (atomic) ◄── print checks ◄── geometry diagnostics ◄── resolved geometry
         │                                                                           │
         └──────────────► visual-check (headless Chrome, optional) ◄── SVG ──► PDF
```

Each stage emits diagnostics in one shape (§3.5). `validate` runs schema +
semantic + (optional) cross-check + layout + geometry + print checks without
writing an artifact. `deliver` runs everything, writes SVG/PDF atomically, and
emits a receipt (§12).

Borrowed patterns (ideas, not code) from Archify (MIT): strict JSON Schema per
type, deterministic renderer, diagnostics with `supportedFixes`, frozen-spec
delivery receipts with SHA-256, Git-pinned repository evidence, and a separate
headless-browser visual check whose claims are kept distinct from the
deterministic checks.

## 3. Shared IR concepts

### 3.1 Envelope

Every document:

```json
{
  "schema_version": 1,
  "figure_type": "datapath | fsm | timing | microarch",
  "meta": {
    "title": "RS(6,4) decoder, PIPELINE=2",
    "print": { "profile": "ieee", "variants": ["1col", "2col"], "max_height_in": { "1col": 3.2, "2col": 2.6 } },
    "style": { "grayscale": true, "font_family": "Tinos", "svg_profile": "figma-safe" },
    "repository": { "root": "../rs-ecc-accelerator", "revision": "<40-hex sha>" }
  },
  "params": { "DATA_W": 32, "ECC_W": 16, "DEPTH": 16 }
}
```

- `additionalProperties: false` everywhere; unknown fields are errors.
- All `id`s match `^[A-Za-z_][A-Za-z0-9_]*$`, unique within their scope; SVG
  element ids are derived from them (stable across renders).
- `meta.print.profile` names a **width profile** defined as data in
  `profiles/print-profiles.json` (built-in: `ieee` 3.5 in / 7.16 in, `acm`
  3.33 in / 7.0 in) or in a user file passed with `--profiles`. A profile
  lists variants (`1col`, `2col`, optionally more) with `width_in`,
  `max_height_in`, `min_font_pt`, `min_stroke_pt`. Code never hard-codes widths.
- `meta.print.variants` defaults to all variants of the profile; **every figure
  is delivered in both `1col` and `2col`** unless the author narrows it.
  Each variant is laid out independently (§9.5) — never a scaled copy.
- Any human-readable string (`label`, state names, signal aliases, data values)
  may have a `short_label` used by a variant when the full label cannot meet
  the minimum font size; `labels: { "1col": "short" }` selects per variant.

### 3.2 Widths and parameters

A width is a positive integer or a width expression over `params`:
integers, identifiers, `+ - * /` (integer division), parentheses,
`clog2(x)` and `max(a,b)`. Expressions are evaluated once at validation;
unresolvable identifiers are `ir/unknown-param`. Rendered bus labels show the
authored form (`DATA_W`) or the value (`32`) per `meta.style.width_labels` ∈
`value | symbolic | both`.

### 3.3 Endpoints

A net endpoint is a string:

```
endpoint := path "." port [ slice ]      element port, e.g.  u_mux.in1, reg_s1.q[7:0]
          | path                         a top-level port element, e.g.  hclk
path     := id ( "/" id )*               hierarchy, e.g.  u_ecc/u_dec.valid_i
slice    := "[" int ":" int "]" | "[" int "]"
```

Bit order is always `[msb:lsb]`, `msb >= lsb`. A slice selects bits of the
*port*; the net width must equal the slice width. Concatenation is modeled
explicitly with a `comb` element of `op: "concat"` (and `op: "split"` for bus
rippers) so every bit on the page is accounted for.

### 3.4 Source pins

Any element, net, state, transition, signal or block may carry:

```json
"source": { "file": "rtl/rs_decode.sv", "line": 131, "end_line": 146, "match": "always_ff" }
```

- `file` is repo-relative POSIX (no `..`, no `.git`), resolved against
  `meta.repository.root` at `meta.repository.revision` via `git show`.
- `line`/`end_line` must be in range at that revision (`source/line-range`).
- `match` (optional literal substring) must occur within the pinned range, which
  detects drift when RTL changes but pins don't (`source/drift`).
- Pins without `meta.repository` are an error (`source/repository-required`);
  pins are optional overall.

### 3.5 Diagnostics

```json
{
  "code": "width/mismatch",
  "severity": "error | warning | info",
  "message": "net n_dec_data: driver u_inj.data_o is 32 bits, sink u_ecc.dec_data_i[15:0] is 16 bits",
  "subject": { "path": "/nets/4", "id": "n_dec_data" },
  "evidence": { "driverWidth": 32, "sinkWidth": 16 },
  "supportedFixes": ["correct the net width", "slice the sink endpoint", "insert a comb split element"]
}
```

`supportedFixes` are the *only* repairs an agent should attempt for that code;
they are part of the contract and tested.

## 4. `datapath` IR

Purpose: RTL block / schematic-level figures — muxes, registers, pipeline bars,
memories, comb blocks, instances, clock domains.

### 4.1 Top-level shape

```json
{
  "schema_version": 1, "figure_type": "datapath",
  "meta": { ... }, "params": { ... },
  "clock_domains": [
    { "id": "sys", "clock": "hclk", "reset": { "net": "hrst_n", "active": "low", "async": true }, "label": "hclk" }
  ],
  "modules": { "<module name>": { "ports": [ ... ], "elements": [ ... ], "nets": [ ... ], "blackbox": false } },
  "elements": [ ... ],
  "nets": [ ... ],
  "annotations": [ ... ]
}
```

`elements`/`nets` describe the figure's top scope. `modules` holds definitions
for `instance` elements (optional — an instance may carry its own port list).

### 4.2 Element kinds and their implicit ports

Every element has `id`, `kind`, optional `label`, `source`, `rtl` (mapping,
§11.5), `layout` (hints, §9.3). Ports are implicit per kind so authors don't
repeat boilerplate; each implicit port has a default side and class.

| kind | required fields | implicit ports (side, class) |
|---|---|---|
| `port` | `dir` (`in/out/inout`), `width`, `class` | `p` (referenced as bare id) |
| `const` | `value` (SV literal, e.g. `"8'h00"`) | `out` (E, data) — width from literal |
| `mux` | `inputs` (n ≥ 2), `width` | `in0..in{n-1}` (W, data, fixed order, `in0` on top), `sel` (N, top edge, control), `out` (E, data) |
| `comb` | `op`, `width` | op-dependent, below; `cin` N, `cout` S |
| `register` | `width`, `domain` | `d` (W), `q` (E), `en`? (N, control), `clk` (S, clock wedge, implicit), `rst`? (S, reset) |
| `pipeline_register` | `lanes[]`, `domain` | `d_<lane>` (W), `q_<lane>` (E) per lane, `en`? (N), `clk` (S, one wedge) |
| `memory` | `depth`, `width`, `domain`, `ports[]` | addr/we/re/wdata (W), rdata (E), clock wedge (S) |
| `synchronizer` | `from`, `to`, `style`, `width` | `in` (W), `out` (E), clocks explicit (CDC figures draw clock nets) |
| `instance` | `module` | from `modules[module].ports` or inline `ports[]` |

Side defaults follow CONVENTIONS.md §0.5: data left→right, control enters from
the top (N), clock and reset from the bottom (S). `meta.style.mux_index_order`
(`top-down` default, `bottom-up`) mirrors the mux input order for the whole
figure.

`mux`

- `encoding`: `binary` (default) → `sel` width must be `clog2(n)` (min 1);
  `onehot` → `sel` width must be `n`.
- `input_labels`: `{ "0": "ENC", "3": "RSVD" }` — keys must be valid indices.
- `priority: true` renders a priority-mux glyph; semantics as `onehot`-less
  ordered selection (sel width checked as binary unless `encoding` says otherwise).

`comb` ops

| op | ports | notes |
|---|---|---|
| `and or xor nand nor xnor` | `in0..in{k-1}`, `out` | `inputs` k ≥ 2, default 2; all widths equal |
| `not` / `buf` | `in0`, `out` | |
| `add` `sub` | `in0`, `in1`, `cin`?, `out`, `cout`? | `out_width` may exceed `width` |
| `mul` | `in0`, `in1`, `out` | `out_width` optional |
| `cmp` | `in0`, `in1`, `out` (1 bit) | `cmp`: `eq ne lt le gt ge`, `signed` |
| `shift` | `in0`, `amt`, `out` | `dir`: `left right arith` |
| `reduce` | `in0`, `out` (1 bit) | `reduce`: `and or xor` |
| `concat` | `in0..in{k-1}` (MSB first), `out` | `in_widths[]`; out width = sum |
| `split` | `in0`, `out0..out{k-1}` | `slices: ["31:24","23:16",...]` |
| `lut` / `rom` | `addr`, `data` | `depth`, `width`, `contents` (label or ref) |
| `custom` | `ports[]` explicit | free label, e.g. "GF(2^8) mult" |

Rendering style of gate ops (`meta.style.gates`: `distinctive | rectangular`)
is presentation only.

`register`

```json
{ "id": "s1_reg", "kind": "register", "width": 8, "domain": "sys",
  "enable": true, "reset": "async", "init": "8'h00", "style": "box" }
```

- `clk` is always implicit from `domain`; drawing shows a clock triangle, no
  clock wire unless `meta.style.clock_wiring: "explicit"`.
- `reset`: `none | async | sync` (polarity comes from the domain).
- `style`: `box` (labeled FF) or `bar` (thin register bar).

`pipeline_register` — one tall bar spanning several independent nets
("lanes"), the idiomatic pipeline-stage figure element.

```json
{ "id": "p_mid", "kind": "pipeline_register", "domain": "sys", "stage": 1,
  "lanes": [ { "id": "h1", "width": 8 }, { "id": "h2", "width": 8 },
             { "id": "sym", "width": 48 }, { "id": "valid", "width": 1, "class": "control" } ] }
```

`stage` (integer) places the bar in a layout partition (§9.2) and is used by
latency checks. All lanes share one clock/enable.

`memory`

```json
{ "id": "data_mem", "kind": "memory", "depth": "DEPTH", "width": 32, "domain": "sys",
  "impl": "blackbox",
  "ports": [
    { "id": "w", "type": "write", "we": true },
    { "id": "r", "type": "read", "read_latency": 1, "read_during_write": "write_first" }
  ] }
```

Implicit pins per memory port `p`: `p_addr` (width `clog2(depth)`), `p_wdata`,
`p_we` for write; `p_addr`, `p_rdata`, `p_re`? for read; `rw` has all.
`read_latency` 0 = asynchronous read (a combinational path addr→rdata);
≥ 1 = synchronous (breaks comb loops, counts as stages). `impl` ∈
`ff | inferred | blackbox | unknown` is shown only in the caption/legend if
requested — never a vendor or macro name.

`synchronizer`

```json
{ "id": "sync_irq", "kind": "synchronizer", "from": "dom_a", "to": "sys",
  "style": "ff2", "width": 1 }
```

`style` ∈ `ff2 | ff3 | pulse | handshake | gray | async_fifo`. Only
synchronizer elements may legally connect sequential logic across domains.

`instance`

```json
{ "id": "u_ecc", "kind": "instance", "module": "rs_ecc_core",
  "params": { "PIPELINE": 2 }, "view": "collapsed" }
```

- `view: "collapsed"` draws a box with the module's ports; `expanded` draws the
  module's elements inside a labeled boundary (hierarchical layout).
- Module port definitions: `{ id, dir, width, class, side?, domain?, registered? }`.
  `registered: true` on an output says the output is driven by a register
  inside (used for loop/latency analysis of collapsed or blackbox instances;
  unknown → conservative, see §8).
- `modules[m].blackbox: true` means no internals are known; the figure shows
  it hatched or dashed.

### 4.3 Nets

```json
{ "id": "n_sym", "width": 48, "class": "data",
  "driver": "p_mid.q_sym", "sinks": ["corr.in0", "sym_split.in0"],
  "label": "sym", "source": { "file": "rtl/rs_decode.sv", "line": 99 } }
```

- `class` ∈ `data | control | clock | reset`; default inferred from endpoints,
  explicit wins. Class drives rendering (control dashed/thinner, per
  CONVENTIONS.md) and CDC analysis.
- Exactly one `driver` (multi-driver/tristate is out of scope for v1).
- `domain` is derived (from the driver's sequential source or a port's
  `domain`); authors may assert it and a mismatch is `cdc/domain-assertion`.
- `bundle` (optional string) lets several nets render as one routed bundle.

### 4.4 Annotations

`label` (free text anchored to element/net), `stage_band` (auto labels S0..Sk
from pipeline partitions), `critical_path` (ordered endpoint list, emphasized
stroke; checked to be a real connected path), `latency` (from/to endpoints
with `cycles`; checked against register count on the path), `legend`.

## 5. `fsm` IR

```json
{
  "schema_version": 1, "figure_type": "fsm", "meta": { ... },
  "machine": { "name": "blk_acc_rs_engine.state_q", "state_width": 3, "encoding": "binary",
               "kind": "mixed" },
  "inputs":  [ { "name": "start", "width": 1 }, { "name": "is_last_word", "width": 1 } ],
  "outputs": [ { "name": "busy", "width": 1, "type": "moore" },
               { "name": "flush_load", "width": 1, "type": "mealy" } ],
  "reset": { "state": "IDLE", "condition": "!hrst_n", "async": true },
  "states": [
    { "id": "IDLE", "encoding": "3'b000", "outputs": { "busy": "0" } },
    { "id": "RUN",  "encoding": "3'b001", "outputs": { "busy": "1" } }
  ],
  "transitions": [
    { "id": "t0", "from": "IDLE", "to": "RUN", "guard": "start && mode != 2'b11", "priority": 0 },
    { "id": "t1", "from": "RUN", "to": "RUN", "guard": "!is_last_word" },
    { "id": "t2", "from": "*", "to": "IDLE", "guard": "soft_reset", "priority": -1, "style": "any_state" },
    { "id": "t3", "from": "RUN", "to": "FLUSH", "guard": "is_last_word && dec", "actions": { "flush_load": "1" } }
  ]
}
```

- `encoding` (machine) ∈ `binary | onehot | gray | custom`; per-state
  `encoding` literal is required unless `binary` auto-assignment is requested
  (`"auto"`).
- Self-loops: `from == to`. Implicit hold (`else stay`) is `machine.default:
  "hold"` and not drawn unless `show_implicit_hold: true`.
- Any-state arcs: `from: "*"` (optionally `except: [...]`). Rendered as a
  single arc from a small "any state" marker, never N arcs.
- Reset arc: `reset` block, rendered as an entry arrow into the reset state
  with the condition label; distinct from `from:"*"` synchronous arcs.
- Moore outputs live on `states[].outputs`; Mealy outputs on
  `transitions[].actions`; each output is declared with its `type`, and using
  it in the wrong place is an error.
- Guards: a small SV expression subset (identifiers, literals, `! ~ && || & |
  ^ == != < <= > >= ?:`, parentheses, bit select). Parsed to an AST; every
  identifier must be a declared input, output, parameter, or `state`.
- `priority` (lower = earlier, mirrors if/else order) disambiguates
  overlapping guards; rendered as `1:`, `2:` prefixes when
  `meta.style.show_priority`.
- `rtl` mapping: `{ "module": "...", "state_register": "state_q",
  "encodings_from": "localparam" }` enables encoding cross-checks (§11.5).

## 6. `timing` IR (WaveJSON + paper layer)

Timing figures are **rendered by WaveDrom** (npm `wavedrom`, pinned, called
through its Node library API `renderAny` + `onml.s` — pure Node, no browser).
rtl-figures does not reimplement waveform drawing; it adds grounding,
consistency checks, column fitting, and a figma-safe post-process around it.

### 6.1 Document

The authored input is plain WaveJSON, so snippets paste in unchanged. Paper
metadata that WaveDrom has no field for sits beside it, keyed by WaveJSON
signal `name` and `node` letters.

```json
{
  "schema_version": 1, "figure_type": "timing", "meta": { ... },
  "wavejson": {
    "signal": [
      { "name": "clk", "wave": "p......." },
      { "name": "in_valid", "wave": "01.0....", "node": ".a......" },
      ["out", { "name": "out_valid", "wave": "0..1.0..", "node": "...b...." }]
    ],
    "edge": ["a~>b 2 cycles"],
    "head": { "tick": 0 },
    "config": { "hscale": 1 }
  },
  "clock": { "name": "clk", "edge": "pos" },
  "signals": { "data": { "width": 8, "short_name": "d" } },
  "latencies": [ { "edge": "a~>b", "cycles": 2,
                   "datapath_ref": { "figure": "pipe.datapath.json", "from": "a", "to": "y" } } ],
  "handshakes": [ { "valid": "in_valid", "ready": "in_ready", "protocol": "valid_ready" } ],
  "fit": { "1col": { "hscale": 1, "max_cycles": 12 }, "2col": { "hscale": 2 } },
  "provenance": { "kind": "hand" }
}
```

- Annotations use **native WaveDrom features**: `node` letters + `edge`
  arrows with labels for latency and handshake arrows, `head`/`foot` `tick`
  (or `every`) for the cycle-number axis, `config.hscale` for cycle width,
  groups for signal sections. `latencies[]`/`handshakes[]` do not draw
  anything; they declare what the arrows mean so it can be checked.
- `signals.<name>.width` adds a bus width annotation (appended to the name
  as `data[7:0]` or `/8` per `meta.style.width_labels`, done in the WaveJSON
  before rendering). `short_name` is used by variants that need it.
- Supported WaveJSON subset for v1: `signal` (objects, groups, spacers `{}`),
  `wave` characters `p n P N h l H L 0 1 x z . = 2-9 | u d`, `data`, `node`,
  `period`/`phase` on clock-like signals, `edge`, `head`, `foot`, `config.hscale`.
  `config.skin` other than default and `reg`/`assign` diagrams are rejected
  with `timing/wavejson-unsupported`.

### 6.2 Consistency checks (on the WaveJSON)

- `timing/clock-irregular`: signals named in `clock` (and any `p/n/P/N` wave)
  are strictly periodic over the window (`.` only continues, no level
  characters mixed in).
- `timing/wave-length`: all lanes span the same number of cycles after
  `period` expansion.
- `timing/bus-data-count`: number of value-starting characters (`=`, `2-9`)
  equals `data` entries; `timing/bus-width-overflow` when a hex/decimal data
  value exceeds `signals.<name>.width`.
- `timing/latency-mismatch`: for each `latencies[]` entry, the cycle distance
  between the edge's `node` letters equals `cycles`; with `datapath_ref`,
  `cycles` equals the register-stage count on that datapath path.
- `timing/handshake-violation` (warn): valid/ready rules (valid stays high and
  data stable until the transfer cycle).
- `timing/diverges-from-simulation`: with `provenance.compare_vcd`, each named
  lane matches the VCD sampled window.

### 6.3 Column fitting

Per variant, the fitter picks `config.hscale` (and may split long windows or
drop lanes above `max_signals` only if the author declared `fit.<variant>`
limits), then renders and measures: the WaveDrom SVG width at that hscale
must fit the variant width **at a scale factor that keeps text ≥
`min_font_pt`**. WaveDrom text sizes are known (skin CSS, px); the fitter
computes `scale = variant_width_pt / svg_width` and fails with
`print/min-font` (fixes: shorten names via `short_name`, reduce cycles,
lower hscale, move to `2col`) instead of shrinking below the minimum. Unlike
graph figures, the waveform is scaled (WaveDrom geometry is resolution-free),
but scaling is bounded by the font check.

### 6.4 Figma-safe post-process of WaveDrom SVG

WaveDrom 3.7.0 output (probed) uses a `<style>` block with ~800 `class`
references, `<defs>` brick symbols placed with `<use xlink:href>` +
`translate`, `<marker>` arrowheads via `style="marker-end:url(#…)"`,
`text-anchor="middle|end"`, `xml:space`, and unitless px size. The
post-process (pure Node, operating on the onml tree before stringifying):

1. **Inline CSS**: resolve the skin's rules (element and single-class
   selectors only) into presentation attributes; drop `<style>`, `class`,
   and `style=""` (parsed into attributes). Unknown selectors fail loudly.
2. **Expand `<use>`/`<defs>`**: replace each `<use>` with a deep copy of the
   referenced group, composing its `translate` into child coordinates (only
   translate/scale transforms occur; others fail); remove `<defs>`.
3. **Arrowheads**: remove `<marker>`; for each path that referenced one,
   append an explicit filled `<path>` arrowhead oriented along the path's end
   tangent (cubic/line segments computed from the `d` data).
4. **Text**: keep `<text>`; convert `text-anchor` middle/end to `start` by
   subtracting the measured advance width (same font metrics as other
   figures, after swapping the skin font to `meta.style.font_family`); remove
   `xml:space`; flatten transforms into explicit `x`/`y`.
5. **Units and size**: apply the fitted scale, set `width`/`height` in `pt`
   and `viewBox="0 0 w h"` in pt; drop `overflow`.
6. **Grayscale**: map skin colors (`info` blue edges, etc.) to the grayscale
   tokens; X/Z hatching from WaveDrom's bricks stays explicit geometry after
   expansion.
7. **Layer ids**: `timing/axis`, `timing/signals/sig-<name>/{name,wave,values}`,
   `timing/edges/edge-<from>-<to>`, groups for WaveJSON sections; WaveDrom's
   internal ids (`svgcontent_0`, `gmark_a_b`, brick ids) are replaced.

The result goes through the same `svg/*` lint (§10.1) as every other figure
type, and the PDF is derived from it with outlined text (§10).

### 6.5 Grounding in simulation

```
tiny testbench (user-owned or generated) ─► verilator --binary --trace ─► VCD
      ─► rtl-figures vcd2wave --clock <path> --signals <paths> --from <cycle> --cycles <n>
      ─► timing IR with provenance { kind: "vcd", vcd_sha256, scope, clock, window, sample: "pre_edge" }
```

- Sampling rule: the value shown for cycle *k* is the value held immediately
  before active edge *k+1* (steady state), so combinational glitches never
  appear. Multi-bit X/Z partially → `x` with a warning.
- Signal selection by hierarchical name or glob; aliases rename for print.
- Simulator invocation goes through the same adapter interface as extraction
  (§11, `kind: "simulate"`); Verilator is the default. Testbenches live with
  the user's project or, for rtl-figures' own tests, under `tests/fixtures/`.

### 6.6 Verification levels (recorded in every receipt)

Timing figures must be verifiable against the RTL, not only self-consistent.
Every delivered figure's receipt carries exactly one `verification.level`,
computed by the tool from evidence it produced in that run — never authored,
never upgraded by hand (`receipt/level-overclaim` if a caption or document
field claims more):

| level | meaning | evidence the receipt must contain |
|---|---|---|
| `simulated` | The WaveJSON lanes were **generated** by `vcd2wavejson` from a Verilator VCD of the RTL and not edited afterwards (lane hash matches generator output). | simulator id/version; top module; stimulus kind + file SHA-256s; RTL file SHA-256s; defines/params; VCD SHA-256; clock path + edge; cycle window; lane → RTL hierarchical path list; generator output hash |
| `sim-compared` | A hand-authored or edited WaveJSON was **diffed cycle by cycle** against a VCD of the same scenario with zero mismatches. | all `simulated` evidence for the reference VCD, plus the compare map, counts of compared / don't-care / skipped cells, and the mismatch list (empty) |
| `structural-only` | No simulation. Only latency and register-stage checks against a datapath IR that itself passed the RTL structural cross-check (§11.5). | datapath figure SHA-256, its netlist SHA-256 and cross-check result, latencies checked |
| `unverified` | None of the above (e.g. no RTL available, or a check failed and the author chose `--quality draft`). | reason |

Rules:

- Levels are ordered `simulated`/`sim-compared` > `structural-only` >
  `unverified`; a figure is labeled at the **highest level whose evidence is
  complete in this run**. A failing sim-compare makes the figure
  `unverified` (with the mismatches), not `structural-only`.
- Datapath, FSM and microarch figures use `structural-only` (netlist
  cross-check passed, including FSM encodings for FSMs) or `unverified`.
- Simulation proves behavior **only for the given stimulus** in the recorded
  cycle window; it does not prove the design correct for all inputs, and
  receipts and generated captions must not suggest otherwise.

**sim-compared semantics**

- Lane → RTL mapping: `provenance.rtl_map` maps each WaveJSON `name` to a
  hierarchical RTL path (`tb.dut.u_ecc.dec_valid_o`); unmapped lanes are
  reported (`timing/compare-unmapped`, error unless listed in
  `provenance.compare.ignore`).
- Clock alignment: the named clock (`clock.name` → `rtl_map`) defines cycle
  boundaries; cycle *k* is sampled pre-edge (§6.5); `provenance.first_cycle`
  aligns WaveJSON cycle 0 to a VCD cycle (or `align_on` a signal event).
- WaveDrom `x` in the drawing is **don't-care**; `.` **holds** the previous
  drawn value and is compared as that value; `|` gaps are skipped.
- Bit lanes compare `0/1/l/h/L/H` levels; `z` compares to Z.
- Bus lanes: a data label that is a literal number (`0x1F`, `31`, `8'h1f`) is
  compared numerically; a symbolic label (`D0`, `SYN`) is skipped
  (`skipped_symbolic_values` count) unless `provenance.compare.values` maps it
  (`{"D0": "0xDEADBEEF"}`). A value change drawn where the VCD has none (or
  vice versa) is a mismatch even for symbolic labels.
- Every mismatch is an error `timing/sim-mismatch` naming lane, cycle, drawn
  value and simulated value, e.g. `out_valid @ cycle 4: drawn 1, simulated 0`.

**Stimulus**

- User-provided Verilator-compatible testbench: SystemVerilog built with
  `--binary --timing --trace`, or a C++ harness with `--cc --exe --trace`.
- Built-in bus-functional-model helper (generic, no project names): a small
  SV package + JSON transaction script for AHB-Lite, APB, AXI4-Lite single
  read/write, and valid/ready streams; `rtl-figures sim --bfm <script.json>`
  generates a wrapper testbench in the work directory around the user's top,
  mapping bus ports by a user-supplied port map.
- Optional DPI-C golden models may be linked by the user's harness; their
  file hashes are recorded as stimulus files.
- Generated testbenches, VCDs and build products live in the work directory,
  never in the RTL repository.

## 7. `microarch` IR (SoC / system and pipeline block figures)

First-class use case, Phase 2 together with datapath. Covers accelerator /
SoC integration figures and abstract block pipelines. Same theme
(`netlist-mono`), 1col/2col re-layout and figma-safe output as datapath.

```json
{
  "schema_version": 1, "figure_type": "microarch", "meta": { ... },
  "blocks": [
    { "id": "cpu", "kind": "core", "label": "CPU", "rtl": { "instance": "u_cpu" } },
    { "id": "sram", "kind": "memory", "label": "SRAM", "sublabel": "64 KiB" },
    { "id": "ahb2apb", "kind": "bridge", "label": "AHB→APB" },
    { "id": "acc", "kind": "accelerator", "label": "Accelerator slot",
      "detail_ref": { "figure": "acc.datapath.json" }, "rtl": { "instance": "u_acc" } },
    { "id": "pe", "kind": "custom", "label": "PE", "replicate": { "count": 16, "style": "stack" } }
  ],
  "fabrics": [
    { "id": "ahb", "protocol": "AHB-Lite", "addr_width": 32, "data_width": 32, "topology": "bus" },
    { "id": "apb", "protocol": "APB", "addr_width": 32, "data_width": 32, "topology": "bus" }
  ],
  "attachments": [
    { "id": "at_cpu", "fabric": "ahb", "block": "cpu", "role": "manager" },
    { "id": "at_sram", "fabric": "ahb", "block": "sram", "role": "subordinate", "address": { "base": "0x0000_0000", "size": "0x1_0000" } },
    { "id": "at_acc", "fabric": "ahb", "block": "acc", "role": "subordinate",
      "address": { "base": "0x6100_0000", "end": "0x6100_0FFF" },
      "rtl": { "instance": "u_acc", "base_param": "BASE_ADDR" } },
    { "id": "at_br_s", "fabric": "ahb", "block": "ahb2apb", "role": "subordinate", "address": { "base": "0x4000_0000", "size": "0x1000_0000" } },
    { "id": "at_br_m", "fabric": "apb", "block": "ahb2apb", "role": "manager" }
  ],
  "links": [
    { "id": "irq_acc", "from": "acc", "to": "cpu", "class": "interrupt", "irq": 5, "label": "irq" },
    { "id": "dma0", "from": "acc", "to": "sram", "class": "dma", "label": "DMA" }
  ],
  "domains": [
    { "id": "clk_sys", "kind": "clock", "label": "sys clk", "members": ["cpu", "sram", "ahb2apb", "acc"] },
    { "id": "pd_acc", "kind": "power", "label": "switchable", "members": ["acc"] }
  ],
  "crossings": [ { "link": "irq_acc", "from": "pd_acc", "to": "clk_sys", "via": "isolation" } ],
  "groups": [ { "id": "soc", "label": "SoC", "members": ["cpu", "sram", "ahb2apb", "acc"], "style": "chip" } ],
  "stages": [],
  "address_map": { "table": true, "alignment": "0x1000" }
}
```

**Blocks.** `kind` ∈ `core | accelerator | memory | bridge | router |
interrupt_controller | peripheral | fifo | cache | stage | io | clock_gen |
reset_gen | power_ctrl | offchip | custom`; kinds map to skin glyphs
(CONVENTIONS §11: chip boundary dashed, off-chip `fill-3` outside it, bus as a
thick bar, stacks for replication) and never carry vendor identity.
`replicate: { count, style: "stack" | "grid" }` draws three offset outlines with
`×N` (or a small grid with `…`), never N copies.

**Fabrics and attachments.** A fabric is an interconnect drawn as a bar
(`topology: "bus"`) or a router grid (`"crossbar"`, `"mesh"` with `grid:
[cols, rows]`). Every block↔fabric connection is an *attachment* with a
role: `manager` or `subordinate`; arrowheads point away from the manager
(CONVENTIONS §11). A bridge is a block with a subordinate attachment on the
upstream fabric and a manager attachment on the downstream fabric, which gives
multi-level interconnects (AXI → APB). Protocol labels are generic
standard-bus names.

**Memory map.** A subordinate attachment may carry `address: { base, size }`
or `{ base, end }` (hex with optional `_` separators). Address spaces are per
root fabric; ranges on fabrics behind a bridge must lie inside the bridge's
upstream window (after optional `offset` translation). `address_map.table:
true` additionally delivers an address-map table figure (`<name>.addrmap.*`)
generated from the same data, sorted by base.

**Link classes.** `data | control | interrupt | dma | sideband | clock |
reset | power`. Interrupt links carry `irq` (line number) and end at a `core`
or `interrupt_controller`; DMA links mark bus-mastering paths (the source must
also have a manager attachment somewhere); sideband covers non-bus signals
(`done`, `err`, test/debug). Rendering keeps classes distinguishable in
grayscale: interrupt = dotted with an open arrowhead, DMA = bold with double
arrowhead, sideband = thin dashed, per skin tokens.

**Domains.** `domains[]` of kind `clock`, `reset` or `power` are drawn as
boundaries (grayscale-safe: dash pattern and hatch angle per kind, tint only
as a redundant layer). Any link or attachment whose endpoints are in different
domains of the same kind is a crossing and must be listed in `crossings[]`
with `via` (`sync`, `async_bridge`, `isolation`, `level_shifter`, `reset_sync`,
or a block id); crossings are marked on the figure.

**Drill-down.** `detail_ref: { figure, id? }` links a block to a datapath,
fsm or another microarch figure by path and optional element id; a `callout`
annotation draws the zoom frame. Figures in one project share ids, so
SoC → IP → datapath stay consistent (the detail figure's top ports must match
the block's attachments and links by name/width).

**Checks** (added to §8): `soc/unknown-ref`, `soc/fabric-roles` (≥ 1 manager
per fabric; subordinates on memory-mapped fabrics need an address),
`soc/bridge-shape`, `memmap/format`, `memmap/overlap`, `memmap/misaligned`
(warn: base or size not a multiple of `alignment`, or size not a power of two),
`memmap/bridge-window`, `irq/duplicate-line`, `irq/target-kind`,
`dma/no-manager`, `domain/crossing-unmarked`, `replicate/count`,
`detail/ref-unresolved`, `detail/interface-mismatch`.

**SoC RTL cross-check (structural-only)** with the same adapter netlist:
`rtl.instance` of blocks resolves to a hierarchy path; attachment `rtl.port`
prefixes are connected; parameter values named by `rtl.base_param` (and other
`rtl.params`) equal the figure's base address / sizes; interrupt links map to
connected nets. Codes: `rtl/instance-missing`, `rtl/param-mismatch`,
`rtl/bus-port-unconnected`, `rtl/irq-unconnected`. This yields
`verification.level: "structural-only"` at most (§6.6).

## 8. Semantic checks (catalog)

All checks run after schema validation and before layout. Errors block
render; warnings are reported and allowed only under `--quality draft`.

| code | type | rule |
|---|---|---|
| `ir/unknown-param` | all | width expression references undefined param |
| `ir/duplicate-id` | all | ids unique per scope |
| `endpoint/unknown` | datapath, microarch | endpoint path/port resolves |
| `endpoint/direction` | datapath | driver is an output-class pin, sinks input-class |
| `endpoint/multiple-drivers` | datapath | a sink pin is driven by more than one net |
| `endpoint/unconnected` (warn) | datapath | required pin (e.g. `mux.sel`, `in*`) left open |
| `width/mismatch` | datapath | driver width (after slice) = net width = every sink width (after slice) |
| `width/slice-range` | datapath | slice within port width, msb ≥ lsb |
| `mux/sel-width` | datapath | binary: sel = `clog2(n)` (≥1); onehot: sel = n |
| `mux/input-index` | datapath | `in<k>`, `input_labels` keys: k < n, no duplicate connection |
| `register/no-domain` | datapath | every register, pipeline_register, sync memory has a declared `domain` |
| `register/unknown-domain` | datapath | domain id exists in `clock_domains` |
| `memory/addr-width` | datapath | addr pin nets = `clog2(depth)` |
| `comb/loop` | datapath | no cycle through combinational elements; registers, `read_latency ≥ 1` memories, and `registered` instance outputs break cycles; unknown instance timing → warning `comb/loop-unknown` |
| `cdc/unsynchronized` | datapath | a path from sequential source in domain A to a sequential sink in domain B ≠ A passes through a `synchronizer` with `from=A,to=B` |
| `cdc/multibit-ff-sync` (warn) | datapath | `ff2/ff3` synchronizer with width > 1 |
| `cdc/domain-assertion` | datapath | authored net `domain` disagrees with derived |
| `path/not-connected` | datapath | `critical_path`/`latency` endpoints form a connected path |
| `latency/stage-count` | datapath, timing | annotated `cycles` = registers on path (pipeline_register counts 1, memory counts `read_latency`) |
| `fsm/unreachable` | fsm | every state reachable from `reset.state` via transitions (guards treated as satisfiable unless literally `0`/`false`) |
| `fsm/dead-end` (warn) | fsm | non-terminal state with no outgoing arc and no implicit hold |
| `fsm/encoding-width` | fsm | every encoding literal fits `state_width`; onehot has exactly one bit set |
| `fsm/encoding-duplicate` | fsm | encodings unique |
| `fsm/guard-parse` / `fsm/guard-unknown-id` | fsm | guard parses; identifiers declared |
| `fsm/output-kind` | fsm | Moore outputs only on states, Mealy only on transitions |
| `fsm/ambiguous-guards` (warn) | fsm | two arcs from the same state, same priority, syntactically identical or both unguarded |
| `timing/wave-length` | timing | wave length = window cycles |
| `timing/clock-irregular` | timing | clock waves are strictly periodic |
| `timing/bus-data-count` | timing | bus value starts = data entries |
| `timing/latency-mismatch` | timing | latency annotation cycles = observed edge distance in waves; and, with `datapath_ref`, = datapath stage count |
| `timing/handshake-violation` (warn) | timing | valid_ready: once valid rises, data stable and valid held until ready |
| `source/*` | all | §3.4 |
| `rtl/*` | all | §11.5 |
| `print/profile-unknown` | all | `meta.print.profile` exists in loaded profiles; every requested variant exists |
| `print/variant-missing` | all | `deliver` produced SVG + PDF for every requested variant (default: `1col` and `2col`) |
| `print/min-font` | all, per variant | smallest rendered font ≥ variant `min_font_pt` (no scaling after layout, so authored pt = printed pt) |
| `print/min-stroke` | all, per variant | every stroke ≥ variant `min_stroke_pt` |
| `print/width-overflow` | all, per variant | figure bounding box ≤ variant `width_in` |
| `print/max-height` | all, per variant | height ≤ `max_height_in` (figure override, else profile) |
| `print/label-fallback` (info) | all, per variant | a `short_label` was used, listing ids |
| `svg/*` | all, per variant | figma-safe profile lint, §10.1 |

## 9. Layout

### 9.1 Decision (see `docs/adr/0001-layout-and-rendering.md`)

- `datapath`, `microarch`: **ELK Layered** via elkjs (pinned exact version),
  left-to-right, orthogonal routing, fixed port sides and order.
- `fsm`: ELK Layered top-to-bottom with spline routing for arcs; renderer-owned
  self-loops, any-state and reset arcs; optional authored grid positions.
- `timing`: rendered by WaveDrom (pinned npm library); rtl-figures only fits
  `config.hscale` per variant and post-processes the SVG (§6.3–6.4).

### 9.2 ELK mapping (datapath/microarch)

- Elements → ELK nodes with measured size (text metrics from the bundled font
  at final point size, so layout happens in print units).
- Pins → ELK ports with `elk.port.side` from the kind defaults (data W→E,
  `sel`/`en`/`rst`/`clk` on S) and `org.eclipse.elk.portConstraints:
  FIXED_ORDER` (mux inputs ordered in0 top → in{n-1} bottom, pipeline lanes in
  declared order).
- Pipeline/stage structure → `elk.partitioning.activate: true`, node
  `elk.partitioning.partition = stage`; pipeline_register bars get their own
  partition between stages so bars align vertically.
- Expanded instances → compound nodes with `elk.hierarchyHandling:
  INCLUDE_CHILDREN`.
- Buses/bundles → one ELK edge per net, rendered with width slash labels;
  bundles share `elk.layered.mergeEdges` groups.
- Determinism: fixed `elk.randomSeed`, deterministic input ordering (declared
  order, never object-key iteration of user maps without sorting), coordinates
  rounded to 0.01 pt after layout.

### 9.3 Author hints (only after a diagnostic asks for them)

`layout.layer` (partition override), `layout.order` (in-layer order via
`elk.layered.crossingMinimization.semiInteractive` positions),
`layout.align_with` (same-row constraint), port `side` override,
`label.side`. Hints are bounded: one hint per repair round, like Archify.

### 9.5 Column variants (per-variant layout, never scaling)

Each requested variant is an independent pass: `measure → layout → geometry
checks → SVG → print checks`. Scaling one layout into another width is
forbidden because it moves fonts and strokes below print minimums; text is
always measured at its final printed point size.

- Variant layout options come from data (profile variant entry, optionally
  overridden by `meta.layout.variants.<id>`): ELK `direction` (e.g. `RIGHT`
  for `2col`, `DOWN` or wrapped `RIGHT` for `1col`), `elk.aspectRatio`,
  `elk.layered.wrapping.strategy` (`MULTI_EDGE` wrapping for long pipelines
  in `1col`), spacing scale, and label policy.
- Label policy per variant: `full` first; if a text item cannot fit its slot at
  `min_font_pt`, use its `short_label` (reported as `print/label-fallback`);
  if still failing, report `print/min-font` with fixes ("add short_label to
  <id>", "collapse instance <id>", "drop variant 1col for this figure").
  The renderer never shrinks text below the minimum to make things fit.
- Timing variants change cycle column width and may split the window across
  rows in `1col`; FSM variants change rank direction.
- An author can restrict variants (`meta.print.variants`) but `deliver`
  reports which standard variants were skipped.

### 9.4 Geometry diagnostics (post-layout, pure Node)

`geometry/label-overlap`, `geometry/label-clearance` (min clear gap between a
label and any stroke), `geometry/edge-through-element`,
`geometry/edge-overlap` (collinear shared segments of different nets),
`geometry/port-crowding`, `geometry/crossings` (warn, budget per figure),
`print/min-font` (font size after scaling to column width, provisional ≥ 7 pt),
`print/min-stroke` (≥ 0.5 pt), `print/aspect` (height exceeds
`max_height_in`). Each carries `supportedFixes` (e.g. "set layout.layer on
<id>", "switch meta.print.column to double", "collapse instance <id>").

## 10. Rendering and print output

- Pure Node: IR + geometry → SVG string. No DOM, no browser, no Figma, no
  manual editing step. Output bytes are a function of (IR bytes, renderer
  version, elkjs version, font file hash).
- Output per figure and variant: `<name>.1col.svg`, `<name>.1col.pdf`,
  `<name>.2col.svg`, `<name>.2col.pdf` (+ one receipt covering all). The PDF of
  a variant is generated **from that variant's SVG**, never re-rendered
  separately.
- Fonts: family is configurable (`meta.style.font_family`); the default
  families are ones available in Figma and freely licensed with
  metric-compatible print shapes (serif default `Tinos`, sans `Arimo`; final
  choice follows CONVENTIONS.md). The font file is a build input used for text
  measurement and for PDF glyph outlining; its hash is in the receipt.
- Two artifacts, two roles: the **SVG is the editable artifact** (real
  `<text>`, figma-safe); the **PDF is print-only**. The PDF is derived from the
  variant SVG by (1) outlining every `<text>` into glyph `<path>`s in memory
  using the same font file and the same baseline/advance metrics that layout
  used (kerning per the font's tables), then (2) converting the outlined SVG to
  PDF. The PDF therefore contains **no fonts at all** (checked:
  `pdf/fonts-present` fails if the PDF has any font resource) and needs no
  font embedding or licensing review.
- PDF conversion: primary path is pure Node (pdfkit + svg-to-pdfkit on the
  outlined SVG, fixed metadata dates) so PDFs are reproducible; headless
  Chrome print of the outlined SVG is the fallback and the visual-check engine.
  Validated by a Phase 2 spike (dashes, hatch lines, byte stability) — see ADR.
- Grayscale: a token palette of ≤ 4 gray levels with a minimum L* separation;
  distinctions are carried by dash, weight and explicit hatch lines, not hue
  (control nets dashed, clock nets thin, blackbox hatched). Check
  `style/color-only-distinction` for authored color overrides.

### 10.1 SVG profile `figma-safe` (default)

The SVG must import into Figma as editable, sensibly named layers and still
be the PDF source. Rules (each has a lint code, run by `validate` on the
rendered SVG and by `deliver` before commit):

| rule | lint code |
|---|---|
| Root has physical `width`/`height` in `pt` or `in` and a `viewBox` whose aspect matches exactly (1 user unit = 1 pt) | `svg/physical-units` |
| Text is real `<text>` (one `<tspan>` level at most), with explicit numeric `x`/`y` (y = baseline computed from font metrics); only `text-anchor="start"` (renderer pre-computes alignment); no `dominant-baseline`, `alignment-baseline`, `textPath`, `dx/dy` lists, `rotate`, or `writing-mode` | `svg/text-real`, `svg/text-positioning` |
| Text is never converted to paths | `svg/text-outlined` |
| `font-family` is the configured family with a generic fallback; `font-size` in user units (pt) | `svg/font` |
| Styling only via inline presentation attributes (`fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `stroke-linecap`, `stroke-linejoin`, `font-*`, `opacity`); no `<style>`, no `class`, no `style=""` | `svg/inline-presentation` |
| No `<marker>`: arrowheads are explicit `<path>` elements next to their net | `svg/no-marker` |
| No `<use>`, `<symbol>`, or `href` references; all geometry inline | `svg/no-reuse` |
| No `<pattern>`, gradients, `<filter>`, `<mask>`, `foreignObject`, `vector-effect`, `<image>` | `svg/forbidden-feature` |
| `<clipPath>` only when unavoidable, max 1 per figure, never on text | `svg/clip-budget` |
| Hatching drawn as explicit `<line>`/`<path>` inside a named group, clipped geometrically (lines computed to the shape boundary), not via clip | `svg/hatch-explicit` |
| Group hierarchy with meaningful ids; every drawable belongs to a named group; nothing is flattened into a single compound path across objects | `svg/layer-structure` |

Group hierarchy (ids are derived from IR ids, `-` separated, unique):

```
<svg id="fig-<name>-1col">
  <g id="frame">                         (background/boundaries, optional)
  <g id="datapath">
    <g id="stage-0"> <g id="mux-sel_a"> <path .../> <text .../> </g> ... </g>
    <g id="stage-1"> <g id="preg-p_mid"> ... </g> </g>
    <g id="inst-u_ecc"> ... (expanded children nested) </g>
  <g id="nets">
    <g id="nets-data"> <g id="net-n_sym"> <path/> <path id="net-n_sym-arrow"/> <text/> </g> </g>
    <g id="nets-control"> ... </g>
  <g id="labels"> <g id="label-..."> </g>
  <g id="annotations"> ...
  <g id="legend">
```

FSM uses `states/state-<id>`, `transitions/tr-<id>`; timing (after the
WaveDrom post-process, §6.4) uses `timing/axis`,
`timing/signals/sig-<name>/{name,wave,values}`, `timing/edges/edge-<from>-<to>`;
microarch uses `blocks/…`, `groups/…`, `links/…`.

A second profile `print-compact` (merged paths, fewer groups) may exist later
for size-sensitive venues; it is never the default and still keeps real text.

### 10.2 Default datapath theme `netlist-mono` and the skin library

The default look for datapath (and microarch) figures is a clean monochrome
schematic in the style of netlistsvg: real symbol shapes (trapezoid mux, DFF
box with clock wedge, distinctive gates, adder chevron), thin orthogonal wires
routed by ELK Layered with fixed pins, buses heavier than 1-bit wires,
junction dots, compact labels, white background, minimal decoration.

Architecture borrowed as an idea (netlistsvg, MIT; no code or geometry copied —
it is stale on elkjs 0.3 and not a dependency):

- A **skin** is versioned data (`skins/<name>/skin.json`): style tokens (from
  CONVENTIONS.md §12), ELK option sets per column variant, and **symbols**.
  A literal symbol has a size, an SVG body (paths/rects with a role that maps
  to outline/line/wedge styling) and named **pins** with coordinates, side and
  class; ELK receives them as `FIXED_POS` ports. Parametric symbols (mux with
  n inputs, pipeline bar with k lanes, labeled port, memory, block) carry
  parameters instead of a fixed body.
- Selection: `meta.style.skin` per figure, or a lab theme file passed with
  `--skin`; unspecified keys inherit from `netlist-mono`. Skins are validated
  and hashed into the receipt.
- Width-dependent styling is resolved by the renderer into inline attributes
  (`stroke-width` 1.2 for buses, 0.6 for wires); there are no CSS classes in
  the output (§10.1).

rtl-figures differences kept on top of the netlistsvg look:

- Hand-abstracted blocks from the IR, not raw bit-level netlists.
- Mux symbol: `mux_style: "bar"` (house default: one bold filled vertical bar,
  inputs on the left in fixed order with input 0 on top, output right middle,
  select on the top edge) or `"trapezoid"` (textbook alternative). Index labels
  are off by default and opt-in with `mux_indices` (figure/theme) or `indices`
  (per mux); when on they sit outside the bar above the incoming wire, or
  inside the trapezoid inset from the slope (checked: `symbol/label-clearance`,
  `geometry/label-on-wire`, `geometry/label-overlap`). A mux always shows its
  select (`symbol/mux-sel-missing`). Bar kinds stay distinct
  (`skin/bar-kinds-indistinct`): mux bar 5 pt black; join/split 2.5 pt black
  with `{ }` / slice labels and no select; pipeline bar gray, outlined, clock
  wedge, spanning lanes.
- Outline weights are per-symbol tokens (`stroke.outline.default` plus
  optional per-kind keys).
- Slash-N width labels once near the source (CONVENTIONS §2).
- Pipeline-stage alignment: stages become ELK partitions so register bars line
  up in one column per boundary.
- Control vs data stays grayscale-safe: control nets are dashed (and thinner),
  never distinguished by color alone; clock/reset nets omitted by default.
- Figma-safe output rules and per-variant re-layout.

Optional draft import (Phase 3+): `rtl-figures import-yosys <design.json>`
maps Yosys cell types to skin symbols through `skin.yosys_cell_map`
(`$mux`/`$pmux` → mux, `$dff`/`$adff`/`$dffe` → register, `$xor`/`$and`/`$or`
→ gates, `$add` → adder) to produce a starting datapath IR that the author
then abstracts.

Phase 1 ships a prototype renderer for a subset of kinds
(`lib/render/datapath-proto.mjs`) and a sample
(`scripts/render-theme-sample.mjs` → `docs/samples/theme-sample.{1col,2col}.svg`)
to judge the look.

## 11. RTL cross-check (tool-agnostic adapters)

### 11.1 Principles

- rtl-figures never embeds, requires or assumes any commercial tool, license
  mechanism, host, install path, or technology library. The only built-in
  adapter is Verilator (open source), located via `PATH` or
  `RTLFIG_VERILATOR`.
- Other front-ends (slang, yosys, commercial tools) are plug-ins the *user*
  registers; rtl-figures ships no knowledge of them.
- All tool work happens in a work directory outside the RTL repository
  (`--work-dir`, default under the OS temp dir); the RTL tree is read-only.

### 11.2 Adapter interface

```js
// An adapter module default-exports:
export default {
  id: 'verilator',
  kind: 'extract',                       // 'extract' | 'simulate'
  async detect(ctx) { return { available, version, executable, reason } },
  async extract(request, ctx) { return normalizedNetlist },   // rtl-netlist.schema.json
};
// request: { files[], top, include_dirs[], defines{}, params{}, blackboxes[], work_dir }
```

External-command plug-ins need no JS: the config gives an argv template and
the command must print normalized netlist JSON on stdout.

### 11.3 Discovery (runtime only)

Order: CLI `--adapter <id>` → env `RTLFIG_ADAPTER` → config `default_adapter`
→ `verilator`. Plug-ins come from `rtl-figures.config.json` (project root or
`--config`) and `RTLFIG_ADAPTER_PATH` (path-list of adapter modules):

```json
{
  "default_adapter": "verilator",
  "adapters": [
    { "id": "my-frontend", "module": "./tools/my-frontend-adapter.mjs" },
    { "id": "my-extractor", "command": ["my-extractor", "--top", "{top}", "--filelist", "{filelist}"] }
  ],
  "rtl": { "files": ["rtl/*.sv", "rtl/*.v"], "top": "top_name", "blackbox_stubs": ["stubs/*.v"] }
}
```

Every adapter result is schema-validated; a non-conforming plug-in fails with
`rtl/adapter-output-invalid`.

### 11.4 Blackbox handling (generic)

Missing modules (IP macros, memories, anything not in the file list) are
handled without any hard-coded names:

1. User-supplied stubs win: stub files (`blackbox_stubs`) or JSON port lists
   (`blackboxes: [{ module, ports: [{name, dir, width}], outputs_registered }]`).
2. Otherwise, auto-stub: run the front-end once; parse its "missing module"
   diagnostics; scan the instantiation sites of those modules for named port
   connections (`.PORT(expr)`); emit an empty-bodied stub with each port as a
   wide `inout`-free placeholder and re-run elaboration.
3. Refine: from the elaborated JSON, take the width of each connected
   expression and infer direction (constant/expression → input; a net with no
   other driver in the parent → output); regenerate stubs with exact widths and
   run the final extraction.
4. Every stub-derived module is marked `blackbox: { origin: "user" | "auto",
   confidence: "declared" | "inferred" }` and its ports carry
   `direction_inferred: true` where applicable. Positional port connections
   and ports left unconnected cannot be inferred → `rtl/blackbox-port-unknown`.

### 11.5 Normalized netlist and cross-checks

Netlist (`schemas/rtl-netlist.schema.json`): modules (specialized by
parameters, with `orig_name` and resolved `params`), ports (dir, width,
msb/lsb), nets/variables (width, unpacked dims), registers (target, width,
clock, edge, reset, async, source), instances (module, connections with
expression kind and referenced nets), per-module dependency edges (`comb` /
`seq` driver → target sets), hierarchy with per-register clock roots traced to
top-level ports.

IR elements/nets carry optional `rtl` mappings:

```json
"rtl": { "instance": "u_ecc/u_dec", "signal": "s1_s2" }
```

Cross-checks: `rtl/unknown-signal`, `rtl/width-mismatch`,
`rtl/not-a-register` (IR register maps to comb-driven signal),
`rtl/domain-mismatch` (clock root differs), `rtl/no-structural-path` (IR net
from A to B has no dependency path between mapped signals),
`rtl/latency-mismatch` (register count along RTL path ≠ IR stages),
`rtl/fsm-encoding` (FSM state encodings ≠ RTL localparams). A coverage report
(info) lists RTL registers not represented — figures are abstractions, so
coverage is informative, never an error.

## 12. Receipts, delivery, visual check

- `deliver` freezes the spec bytes, re-runs every check on the frozen copy,
  lays out and renders **every requested variant**, lints each SVG against the
  figma-safe profile, derives each outlined-text PDF from its SVG, runs
  per-variant print checks, and only then atomically commits
  `<name>.1col.svg`, `<name>.1col.pdf`, `<name>.2col.svg`, `<name>.2col.pdf`.
  Any variant failing means nothing is committed and the previous artifacts
  stay.
- Receipt `<name>.receipt.json`: spec SHA-256/bytes; per variant: SVG and PDF
  SHA-256/bytes, width/height in pt, smallest font pt, thinnest stroke pt,
  labels that used `short_label`, `svg/*` lint result, `pdf/fonts-present`
  result; renderer, elkjs, font file hashes; profile file hash; check codes run
  with counts; source pins with repository revision; RTL netlist SHA-256 +
  adapter id/version when cross-checked; VCD SHA-256 for grounded timing.
- `visual-check` (optional, headless Chrome): loads the delivered SVG at print
  size, measures rendered text boxes for overlap and point size, renders a
  grayscale raster and checks adjacent-fill luminance separation, stores PNGs.
  Exit codes pass/fail/skipped like Archify; its claim ("bounded browser
  evidence") is reported separately from deterministic checks and from any
  human perceptual review.

## 13. Licensing and neutrality rules

- MIT for this repository. Code copied from MIT projects keeps its notice on
  those files only (Phase 1 copies none).
- Runtime dependencies are pinned. `elkjs` is EPL-2.0 (consumed as an unmodified
  npm dependency, not vendored); `ajv` MIT.
- No vendor tool names, license mechanisms, hosts, paths, PDK or
  foundry/macro names anywhere in code, docs, examples or tests. Tests use
  generic fixture names. Proprietary RTL used for local experiments stays out
  of git (`references/local/`).

## 14. Phase plan and open questions

- Phase 1 (this): spec, ADRs, schemas (figure types, rtl-netlist, receipt with
  verification levels), print profiles as data, figma-safe SVG lint, CLI stub
  (`validate` schema-only, `lint-svg`, `check-rtl`, `adapters`, `doctor`),
  Verilator extractor with two-pass auto-blackbox, tests, SKILL.md draft,
  evals plan.
- Phase 2: datapath **and microarch/SoC**: semantic checks (datapath, memory
  map, fabrics/bridges, domains), skin-driven ELK layout + SVG in
  `netlist-mono` with 1col/2col re-layout, address-map table figure,
  outlined-text PDF spike (opentype.js + pdfkit), source-pin verification,
  `deliver` + receipts, SoC-level structural RTL cross-check.
- Phase 3: WaveDrom integration (fitting + figma-safe post-process + golden
  test); `vcd2wavejson`; sim-compare; BFM helper; FSM checks + renderer;
  datapath IR↔netlist cross-checks; FSM extraction from `case(state)`;
  optional Yosys JSON import.
- Phase 4: visual-check; optional Figma MCP import acceptance test; evals loop
  per skill-creator (`evals/evals.json`, trigger queries).

Open questions are tracked in the Phase 1 summary.
