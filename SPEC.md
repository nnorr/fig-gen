# fig-gen — Specification (Phase 1 draft)

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

- Not a schematic editor or synthesis viewer. Whole-design gate-level netlist
  rendering is out of scope (tools like netlistsvg already do that); figures
  are *abstractions* chosen by an author and the netlist is evidence, not the
  drawing. User-selected regions may be drawn at gate level (mixed abstraction,
  §4.6), expanded from and equivalence-checked against the RTL.
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
    "title": "Two-stage block decoder",
    "print": { "profile": "ieee", "variants": ["1col", "2col"], "max_height_in": { "1col": 3.2, "2col": 2.6 } },
    "style": { "grayscale": true, "font_family": "Tinos", "svg_profile": "figma-safe" },
    "repository": { "root": "../my-accelerator", "revision": "<40-hex sha>" }
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
path     := id ( "/" id )*               hierarchy, e.g.  u_core/u_dec.valid_i
slice    := "[" int ":" int "]" | "[" int "]"
```

Bit order is always `[msb:lsb]`, `msb >= lsb`. A slice selects bits of the
*port*; the net width must equal the slice width. Concatenation is modeled
explicitly with a `comb` element of `op: "concat"` (and `op: "split"` for bus
rippers) so every bit on the page is accounted for.

### 3.4 Source pins

Any element, net, state, transition, signal or block may carry:

```json
"source": { "file": "rtl/decoder.sv", "line": 131, "end_line": 146, "match": "always_ff" }
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
  "message": "net n_dec_data: driver u_inj.data_o is 32 bits, sink u_core.dec_data_i[15:0] is 16 bits",
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
{ "id": "u_core", "kind": "instance", "module": "core_top",
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
  "label": "sym", "source": { "file": "rtl/decoder.sv", "line": 99 } }
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

### 4.5 Functional names, bus operations, lanes and bundles (Phase 2)

- **`function`** (required on `comb` with `op: custom` and on `instance`,
  optional elsewhere): `{kind, qualifier?, detail?, name?, short_name?}`.
  `kind` comes from the controlled vocabulary in
  `schemas/function-vocabulary.json` (gf_add, gf_mul, gf_const_mul, gf_inv,
  gf_div, gf_pow/log/antilog LUT, adder, subtractor, multiplier, divider,
  comparator, zero_detect, shifter, lut, rom, encoder, decoder, syndrome,
  error_locator, chien_search, error_evaluator, corrector, classifier,
  correction_enable, controller, fsm, csr_bank, bus_slave, memory,
  error_injector, custom + `name`). The printed name is the vocabulary
  display name, qualified when `qualifier` is set ("GF(2^8) multiplier");
  `detail` prints as a small secondary line in full-label layouts only; the
  short name is a readable word (the qualified name when ≤ 14 characters).
  An explicit `label` overrides but is linted (`label/unreadable`, §8).
  Operators whose vocabulary entry has a glyph (⊕ ⊗ + − ×) draw as a circle
  with no text; gates in gate regions keep their shapes. Ports print
  `label` (readable) while `rtl.signal` keeps the exact RTL name.
- **Bus operations** (CONVENTIONS §2.3, §3.5): `concat` renders as a hollow
  `concat` box (the word, no braces) with destination bit ranges on its inputs; `split` as 45° ripper
  taps with `[msb:lsb]` labels and no body; a single-slice split whose input
  has no other sink is drawn as a truncation label on the wire (render-only
  merge; checks use the IR as written); `extend` (`extend: zero|sign`,
  `out_width`) as a `zext`/`sext` box; `replicate` (`count`) as a `repl ×N`
  box. The word on the box is its identifying feature (skin `symbols.join.label`,
  `symbols.replicate.label`, `symbols.extend.labels`; `glyph/distinguishable`). `expand-cone` emits `extend` for zero extension.
- **Width labels are single integers or symbols** (CONVENTIONS §2.1). A mux
  with `lanes` sizes its select, but no lane caption or `N×W` label is ever
  printed (`width/product-notation`). Every multi-bit data net shows its width
  (`width/missing`).
- **`function.stage`** (`"k/n"`) declares stages of one function; the printed
  name becomes `<name> (stage k/n)` and `label/duplicate` accepts the shared
  name. **`function.basis`** `{source, structure}` cites the RTL that justifies
  the vocabulary name; each vocabulary entry declares the required evidence
  (`evidence.source_all` regexes, `evidence.cone_all` operation categories) and
  a more general fallback name (`label/function-justification`).
- **`role`** on a port definition, a top-level port or a pipeline lane
  (`value` default, `select`, `enable`, `handshake`) states how that input is
  used. Net line style is derived from these usages (CONVENTIONS §1): control
  only if every sink is a select/enable/handshake input; an authored net
  `class` that contradicts the usage needs `class_reason` (`net/class-style`).
- **`bundle`** on an instance `port_def`: one drawn pin standing for several
  RTL ports (e.g. `["wen", "waddr", "raddr"]`). The boundary check expands it:
  each port must exist with the bundle's direction and the widths must add up.

### 4.6 Mixed abstraction: regions, gate expansion, equivalence (Phase 2)

**Regions.** `regions[]` groups elements into one abstraction level:
`blackbox | block | rtl | gate`, with optional `parent` (levels nest, e.g. a
gate region inside an rtl-level decoder next to blackbox memories), `label`,
`frame`, `max_gates` (default 30), `rtl.instance` and `rtl.stop_at`. Instance
elements may also carry `level: blackbox|block` and `internals:
unknown|stub|known`.

Checks: `region/unknown-member`, `region/unknown-parent`,
`region/non-gate-member` (gate regions contain only gate-level kinds: logic
gates, reduce, split/concat, 2:1 mux, const), `region/non-blackbox-member`,
`gate/too-many`, `gate/invert-index`. Boundary consistency: collapsed or
blackbox instances mapped with `rtl.instance` must expose exactly the RTL
module's ports, directions and widths (`rtl/boundary-mismatch`); nets between
regions obey the normal width rules with explicit slices.

**Gate expansion grounded in RTL.** The Verilator adapter records every
unconditional continuous assignment as an expression tree (`exprs[]`: target,
optional constant index, tree of `ref/const/and/or/xor/not/land/lor/lnot/
red*/eq/neq/lt…/add/sub/mul/shl/shr/cond/concat/sel/index/repl/extend/func`).
`fig-gen expand-cone --netlist n.json --instance a/b --output sig [--index k]
[--stop-at s1,s2]` inlines assignments backwards from the output (through
constant-index bits/elements) until stop signals, registers, ports or
unassigned signals, then maps operators to elements:

| RTL | drawn as |
|---|---|
| `& \| ^ ~` (bitwise, any width) | one gate per operator chain, bus width shown with slash-N |
| `~(a&b)` etc. | NAND/NOR/XNOR (exact folds); `~x` feeding a gate → input bubble |
| `&& \|\| !` | 1-bit gates; multi-bit operands first go through a reduction |
| `&x \|x ^x` | reduce element |
| `c ? a : b` | 2:1 bar mux |
| `x == K` (K constant, ≤ 16 bits) | bit split + one AND/NAND with bubbles on the 0 bits (bit-blast) |
| `== < + - * << >>` otherwise | compare / arithmetic / shift blocks |
| function calls, unknown operators | `gate/not-expandable` (draw that part at block level or stop before it) |

The expansion is emitted as a figure fragment (elements, nets with `rtl`
mappings on inputs and output, region) and capped by `max_gates`
(`gate/too-many`, with "narrow the cone / use block level" fixes).

**Equivalence check.** For every gate region with a netlist, deliver evaluates
the drawn network (including bubbles and 2:1 muxes) against the RTL cone of
each RTL-mapped output, with the region's input nets as the cone's stop
signals. ≤ 16 input bits → exhaustive truth table; otherwise seeded random
vectors (default 4096, `equivalence.vectors/seed`) and the receipt says
`sampled`. Errors: `equiv/mismatch` (names the output, the counterexample
inputs, drawn and RTL values), `equiv/input-unmapped`, `equiv/unmapped-input`
(the RTL cone depends on a signal the drawing does not take), `equiv/
no-rtl-expression`, `equiv/not-evaluable`. The receipt records each gate
region as `kind: gate-region` with `equivalence: {method, vectors, seed?,
input_bits, result}`.

### 4.7 Completeness, hidden registers and sub-figures (pre-phase 3)

**Declared scope.** `meta.scope` names what the figure depicts:
- `{instance, hierarchy: all|none}`: an instance relative to the netlist top
  (omitted for the top), with or without its sub-hierarchy;
- `{instance?, cone: {outputs[], inputs[]}}`: the logic from the named inputs
  (exclusive) back from the named outputs, within one instance.

Without `meta.scope`, the scope defaults to `meta.rtl.instance` (or the top)
with its whole hierarchy, and `coverage/scope-undeclared` (warning) says so.

**Coverage** (`lib/checks/coverage.mjs`, with a netlist). The items are:
- instances under the scope;
- registers (register arrays count as memories too);
- live nets: readable from a port, register or instance connection, directly
  or transitively;
- transfers: dependency edges between items.

Clock and reset nets are implicit; dead nets and `_V*` internals are excluded
and counted.

Owners, in priority order:
1. a net's `rtl.signal`;
2. an element's `rtl.signal`;
3. `rtl.covers` signal globs (`glob`, relative to `meta.rtl.instance`, or
   `inst/path:glob`);
4. the signals inside an equivalence-checked gate region's cone;
5. an instance subtree (`rtl.instance` of an instance element, or a `covers`
   entry naming an instance).

Signals joined by a plain port connection share an owner. An instance counts
as covered when its subtree is owned, or when everything inside it is
represented (drawn in detail).

A transfer is represented when:
- both ends have the same owner;
- both ends are nets driven by the same element; or
- a figure path leads from the source's owner to the target's owner and passes
  through no net carrying another RTL mapping.

Anything unrepresented is `coverage/dropped-hardware` (error). Its evidence
lists the missing items by kind (`register`, `instance`, `net`, `transfer`).
The receipt's `coverage` records the scope, the totals, the per-region counts
(members, plus the region's `rtl.instance` subtree), the exclusions and the
uncovered items.

**Hidden registers and latency** (`lib/checks/latency.mjs`). For every drawn
element that is not itself a register, pipeline register, synchronizer or
memory element, and for every mapped input net → mapped output net:
- The RTL path is traced through the netlist without passing through other
  mapped nets. The minimum number of register stages is the RTL latency.
- The drawn latency is the output pin's latency (`port_def.registered` with
  `latency`, default 1).
- A register on the path that the figure does not draw is a **pipeline
  register** when two conditions hold: every non-clock/reset source of it is
  reachable from the input, and it does not feed back to itself. A pipeline
  register hidden this way is `latency/hidden-register` (error), unless the
  element is a memory (`function.kind: memory`).
- Otherwise the register is internal state, which is allowed when the drawn
  latency equals the RTL latency.
- Any latency mismatch is also `latency/hidden-register`.

The receipt's `latency` records the pairs checked, the mismatches and the
hidden registers (both must be 0), plus each path that crosses registers.

**Sub-figures.** An element may carry `detail_ref {figure, id?}`, naming the
figure that draws it in detail. `detail/ref-unresolved` (error) fires when
that file (relative to the figure) or that id does not exist.

**Fit.** When a required variant overflows its width or height,
`deliver/does-not-fit` (error) lists the only allowed fixes, in order:
1. collapse more hardware into covering blocks;
2. raise `meta.print.max_height_in` up to the profile maximum;
3. narrow `meta.scope`, or split into sub-figures linked with `detail_ref`.

### 4.8 View presets and drafts

A figure may carry a `view`: `{preset, scope, depth?, gate_regions?, blackbox?}`. The preset selects the abstraction; `scope` (an instance path, empty for the top) is the declared scope that coverage (§4.7) applies to. When `meta.scope` is absent, the view's scope fills it; when both are present they must agree (`view/scope-mismatch`).

| preset | draws | checked (`lib/view.mjs`) |
|---|---|---|
| `overview` | the whole scope; child instances collapsed to functional blocks; pipeline registers on shown paths still drawn (rule §4.7); buses and control as bundles | no gate regions, and no mux, register or gate elements (`view/preset-violation`) |
| `block` | one instance (`scope` required) at rtl/block level; its ports are the figure ports | every non-clock/reset port of the scope is a port element with `rtl.signal` or `rtl.covers` (`view/boundary-port`); no gate regions |
| `mixed` | a block or overview scope plus the listed gate regions and blackboxes | every listed gate region exists (`view/gate-region-unknown`), every gate region is listed (`view/gate-region-unselected`), every listed blackbox is a blackbox element (`view/blackbox-unknown`) |
| `detail` | the scope expanded `depth` (≥ 1) levels | instances inside the depth that the figure collapses are reported (`view/detail-collapsed`, warning): collapse only where 2col would otherwise fail |

For every preset:
- Elements mapped outside the scope are context, drawn only as blackboxes (`view/context-not-blackbox`).
- The caption states the preset and the scope (`view/caption`: a warning, and an error under `--quality paper`).
- The receipt records `view` (preset, scope, depth, selections, scope module), plus the CLI `overrides` when any were applied.
- CLI: `validate`, `render` and `deliver` take `--view`, `--scope`, `--depth`, `--gate-region <id>` and `--blackbox <element or instance>`. These override the figure's `view` on a copy of the spec.

**Draft.** `fig-gen draft --view <preset> --scope <path> --netlist n.json [--depth n] [--gate-region name=[inst:]out1,out2[;stop…]] [--blackbox <path>] [--repo-root <dir> --revision <sha>] [--out figure.json]` (`lib/draft.mjs`) generates a starting figure from the netlist. The author refines it; every check applies.

What the draft draws:
- **Ports:** the scope's ports become figure ports; clock and reset stay implicit.
- **Instances:**
  - instances within the depth are expanded (depth 0 for overview, block and mixed; `depth` for detail);
  - a collapsed child that holds pipeline registers is expanded anyway;
  - children holding a blackbox stub stay collapsed as memories, with a registered output where a register lies on an input path;
  - collapsed instances keep their RTL ports, so the boundary check applies.
- **Local logic** of each expanded instance is grouped by stage:
  - stage = the longest path in pipeline registers from the instance inputs;
  - a pipeline register has one data source and no feedback (raw self-dependencies count as feedback);
  - one block per stage, one pipeline-register bar per boundary;
  - state registers stay inside their stage block.
- **Signal ownership:**
  - only signals an instance assigns belong to its blocks; connection wires belong to their driver;
  - an output port belongs to the logic that computes it.
- **Gate regions** are expanded from the RTL cone: signals read outside the cone and the other outputs stop the cone, and pure copies of a gate output belong to that gate.
- **Nets:**
  - crossing signals become nets: mapped when single, bundled (unmapped, width = the sum) when several leave one element for another;
  - a block output is marked registered when its latency is uniform from its mapped inputs, and left unmapped when it varies (unless it feeds a pipeline bar; a note then asks the author to regroup).
- **Names:** a vocabulary function inferred from the cone's operation categories (general names only, with `function.basis` when a repository is given); else a readable generic name. Repeated names are numbered. All inferences are reported as notes.

### 4.9 Controller latency, bundles, pin labels and drafts (trial fixes)

- **Output latency forms** (`ports[].latency` on custom blocks and instances):
  an integer (uniform stages from every input), `"state"` (depends on the
  block's state: no fixed stage count; the latency check records the pair in
  `state_pairs` and does not compare it), or a map `{ "<input pin>": k,
  "default"?: k }` (per-input stages, 0 = combinational). `"state"` and maps are
  legal only on stateful kinds (`latency/controller-only`) and only on outputs.
  A map without an entry for an input that reaches the output is reported with
  the RTL latency to add. A port with a map is sequential when any entry ≥ 1.
- **Unmapped nets.** A draft that cannot express a net's latency (a
  non-controller output whose latency varies by input) keeps the wire and
  records `rtl_unmapped: { reason }` instead of `rtl`; the latency receipt
  counts these as `excluded_unmapped`.
- **Bundles are expanded.** For latency and `rtl/no-structural-path`, a net
  with `bundle_of` (dotted child paths allowed) or ending at a pin with a
  `bundle` is checked member by member against the RTL; the drawn pair's
  latency is the minimum over its member pairs. Receipt `latency`:
  `member_pairs_checked`, `bundled_pairs_checked`, `pairs_skipped_bundled`
  (bundles with no resolvable member), `state_pairs`, `excluded_unmapped`.
- **Ownership.** An instance output belongs to the instance even when a figure
  port also maps the same signal; coverage counts a transfer as represented
  when any owner of its source connects to any owner of its sink.
- **Pin labels** are not printed by default. `pin_labels: true` on a custom
  block, memory or instance prints the `label` of its non-clock, non-reset pins
  (`label/pin-clutter` limits them).
- **Duplicate splits** of one net into identical slices are canonicalised
  before rendering (`lib/ir/canonical.mjs`).
- **Drafts.** `draft` names blocks from evidence only: an enumerated state
  register makes a `controller`; FIFO, counter, arbiter, hash, permutation and
  arithmetic structure map to their vocabulary kinds; GF names need GF
  structure (a function named for a field, or GF multiply cones); otherwise the
  module name. Duplicate vocabulary names are numbered through `label`, keeping
  the kind. `--view block --scope ''` drafts the netlist top. Ids never double a
  prefix, and no net sinks into a figure input port. After writing, `draft` runs
  the figure's own checks (schema, semantics, labels, function evidence, view,
  RTL cross-check, coverage, latency) at paper quality (study with `--format
  study`) and prints every error as `residual: <code>: <message>`; the draft is
  still written (exit 0). A short `--revision` is resolved with `git rev-parse`.

- **Study drafts, structure and budget (review round).** With `--format
  study` the draft shows structure: `--view` defaults to `detail` at depth 1,
  and a whole-design (`--scope ''`) `block`/`overview` request is drafted as
  `detail` too (noted). In every format:
  - an expanded instance's controller is its own block: its enumerated state
    register, the logic read only by it (next state) and the signals decoded
    from its state alone; other registers and logic stay in stage blocks;
  - blocks that feed each other combinationally merge only within one
    instance and never absorb a controller; a remaining block-level loop is
    left to `comb/loop`, which follows pins;
  - a controller's inputs and outputs are one net per signal (so each output
    gets its per-input latency); a study draft never bundles nets;
  - block output latencies are decided from the drafted mappings before any
    net is marked unmapped;
  - net, pin and merged-port ids stay unique when a deep hierarchical name
    truncates at 60 characters, and two instances sharing a local name keep
    separate pins;
  - a time and size budget bounds the draft (`draft/budget-exceeded`).
- **Combinational inputs (`comb_from`).** An output port may list the input
  pins that reach it with no register on the way. `comb/loop` then follows
  exactly those pins (without it, every input of a non-registered output counts
  as combinational, which can report a loop no RTL path closes). With a netlist
  the latency check verifies the list (`latency/comb-from`). A net drawn
  unmapped for latency may keep its signal in `rtl_unmapped.rtl`: it then bounds
  traced paths and verifies `comb_from`, but no latency is compared on it.
  Drafts emit `comb_from` for every non-registered block and instance output
  whose combinational inputs are fewer than all inputs; in study drafts each
  stage's other state (registers with their next-state logic) is a block of its
  own, so outputs are either registered or combinational.
- **Names and notes (review round 2, every format).**
  - Draft names say whose block it is: blocks that would print the same name
    are qualified with the shortest distinguishing instance name ("Owner
    controller", "Nonce client controller"), numbered only if that cannot tell
    them apart.
  - A vocabulary name is proposed only if every output's cone carries its
    structure; otherwise a local lump is "<instance> logic".
  - A controller output that no input reaches is a state output
    (`latency: "state"`); `rtl/no-structural-path` does not apply to it.
  - Stage notes use readable output names and at most two lines.
- **Study layout (review round 2).**
  - Each expanded instance is a framed region (level `block`, nested like the
    hierarchy) holding its blocks, pipeline bars and collapsed children.
  - A stage lump with more than four outputs is split into its independent
    output cones, each named after the output it drives.
  - Outermost frames and top-level elements are ranked along the flow
    (feedback found depth-first from the inputs). The ranks are not imposed on
    the layout (ELK's layered flow already orders the frames left to right, and
    forcing them added crossings); they find nets that skip a flow layer.
  - A net between frames that crosses or passes a third frame, or skips a flow
    layer, becomes a named connector pair.
- **Review round 3.**
  - Connector names are unique per figure (see `connector/ambiguous-name`);
    a net that drives a figure output is never cut (`connector/redundant-port`).
  - Round 3b: one target tag feeds every cut sink of a net; a pair whose tags
    end up within 60 pt, or with at most one drawn block column between them,
    is drawn as a wire (the figure is laid out again without that connector);
    a single-word name or a name equal to a port label is qualified with the
    source instance; every tag and port glyph has a wire on the final SVG
    (`connector/orphan-tag`, `connector/duplicate-name`).
  - Dead logic (local signals no output, register or live reader depends
    on) is not drawn in any block; the draft notes it and coverage lists it in
    `excluded.dead_logic`.
  - The study output latency table has one line per block, outputs grouped
    by latency, long lines continued and wrapped into columns of 16.
  - A study figure that warns `route/readability` tries two layout
    alternatives ("frame-flow": nets between blocks of one frame get high
    shortness and straightness priority, pulling the frame's blocks into
    adjacent layers; "thorough": a deeper crossing-minimization search) and keeps
    one only if it lowers crossings per net without adding errors; the tries are
    in `route.layout_alternatives`.
- **Connectors on final routes.** Connectors are chosen on a probe layout; a
  branch that is still long on the final routes gets connectors in one more
  pass, kept when it has fewer errors.

## 5. `fsm` IR

```json
{
  "schema_version": 1, "figure_type": "fsm", "meta": { ... },
  "machine": { "name": "acc_top.state_q", "state_width": 3, "encoding": "binary",
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
fig-gen does not reimplement waveform drawing; it adds grounding,
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
      ─► fig-gen vcd2wave --clock <path> --signals <paths> --from <cycle> --cycles <n>
      ─► timing IR with provenance { kind: "vcd", vcd_sha256, scope, clock, window, sample: "pre_edge" }
```

- Sampling rule: the value shown for cycle *k* is the value held immediately
  before active edge *k+1* (steady state), so combinational glitches never
  appear. Multi-bit X/Z partially → `x` with a warning.
- Signal selection by hierarchical name or glob; aliases rename for print.
- Simulator invocation goes through the same adapter interface as extraction
  (§11, `kind: "simulate"`); Verilator is the default. Testbenches live with
  the user's project or, for fig-gen' own tests, under `tests/fixtures/`.

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
  hierarchical RTL path (`tb.dut.u_core.dec_valid_o`); unmapped lanes are
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
  read/write, and valid/ready streams; `fig-gen sim --bfm <script.json>`
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
      "address": { "base": "0x5A00_0000", "end": "0x5A00_0FFF" },
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

### 7.3.1 Interfaces, covers, view and layout rows

- **Interfaces.** `interfaces[]` are point-to-point connections with valid/ready
  semantics (`protocol` AXI4-Stream, Avalon-ST or custom; `from` = source, `to` =
  sink; optional `data_width`, `label`, `short_label` and `rtl.from/to
  {instance|top, prefix}`). They need no address map and are drawn as stream
  links (solid, open arrowhead), never as a fabric bar. With a netlist each end
  is checked for `<prefix>tvalid/tready/tdata`, direction and width.
- **Covers and view.** `rtl.covers` lists what a block represents inside the
  scope: register/signal globs of the scope module, instance paths or
  `instance:glob`. Several blocks may each cover part of one top; two blocks
  claiming `rtl.top` without covers is `soc/top-claimed`. `view {preset:
  overview|detail, scope, depth}` works as in §4.8. With a netlist, every
  instance within the view depth and every register of the scope module must be
  represented by a block (`coverage/dropped-hardware`); results go to the
  receipt `coverage`.
- **Layout.** One row per fabric, upstream before downstream (a block that is
  subordinate on A and manager on B puts A first), off-chip managers first and
  off-chip subordinates last. Managers sit above their bar, subordinates below.
  Off-chip blocks sit above or below everything, never inside a chip group.
  Link channels keep a full arrowhead plus 3 pt from row edges; a chip boundary
  keeps 1.5 × `route.frame_gap_pt` from wires and runs the region frame checks.

### 7.4 Documented facts: all sources, conflicts and authority

Facts a figure takes from documents are checked against **every** text
document (`.md/.txt/.rst/.adoc`) at the pinned revision, not only the pinned
line (`lib/doc-facts.mjs`).

- **Facts.** A block's `slot` and `instance`, an attachment's base address and
  address window, and a link's `irq`. A fact counts as doc-grounded when its
  owner or its block has a `source` pin, `doc_terms` or an `authority`.
- **Finding the subject.** A line is about the block when it contains one of
  the block's `doc_terms`, `rtl.module` or `instance`. It also counts when it
  sits under a heading (or in a file whose title) names the block **and**
  carries the attribute's keyword (slot, base/address/@, window/range/decode,
  IRQ/interrupt, instance).
- **Values.** Slot tokens follow the figure's slot shape (letters + number).
  Base addresses are page-aligned hex values; windows are hex ranges; IRQ
  numbers follow `IRQ n`.
- **`doc/conflict` (error).** Any document value that differs from the figure
  value. The message lists every conflicting source as file:line → value, plus
  the supporting sources. Windows are compared only where the base agrees; a
  different base is already a base conflict.
- **Resolution.** Only an explicit `authority {file, line?, reason}` on the
  fact's owner or its block resolves a conflict. The authority file must itself
  state the figure value (`doc/authority-mismatch` otherwise). A resolved
  conflict is still reported as a warning. The receipt's `doc_facts` records the
  authority, the supporting sources and the overridden sources.
- **`doc/rtl-mismatch` (warning, RTL given).** A documented window that is
  smaller than the attachment's `rtl.addr_port` decodes, or an "effective /
  decoded / CSR" window of a different size.
- **Other warnings.** `doc/fact-unsupported` (no document states the value),
  `doc/terms-missing`.

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
| `comb/loop` | datapath | no cycle through combinational paths, followed on pins: a net joins its driver pin to its sink pins, and inside an element an input pin reaches an output pin unless the output is sequential; registers, `read_latency ≥ 1` memories, and `registered` outputs break cycles, and a per-input latency map opens the path only from inputs with 0 stages (evidence lists the pins); unknown instance timing → warning `comb/loop-unknown` |
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
| `label/unreadable` | datapath, microarch | a printed primary label is a raw identifier (snake_case, `_i/_o/_q`), a ≤ 3-character mnemonic (well-known symbols/acronyms excepted), a bare ratio (`S2/S1`), an index range (`h1..0`), math shorthand (`X=a^i`, `== 0`) or an abbreviated word with a period (`Pos.`, `Calc.`, `Ctrl.`; also checked on names printed from the vocabulary); warning, **error with `--quality paper`**; suggests the vocabulary name |
| `label/reserved-prefix` | datapath | a net or port label starts with `[` or `{` (reserved for slices and concatenation, CONVENTIONS §3.5 D3) |
| `glyph/distinguishable` | skin + render | no two element kinds render with the same text-less glyph; a solid bar narrower than 8 pt must be a mux with a connected select and ≥ 2 inputs (D1); pipeline bars keep wedge + outline + gray fill; join/split are never filled bars |
| `route/data-jog` | datapath, per variant | a data-net level change shorter than one pin pitch (12 pt) between same-direction runs, or a bend that moving an end block (with its far-side ports) would remove (error) |
| `route/data-bend` (warning) | datapath, per variant | a remaining data bend with its justification: fan-out branch to another row (≥ one pitch), turn into a top/bottom pin, feedback, gate pin pitch, or "blocked" listing each attempted move and why it failed; also in receipt `route.data_bends` |
| `route/edge-hugging` | datapath, per variant | a wire parallel to a block outline or to another net's wire closer than `route.min_parallel_gap_pt` (4 pt) over more than 3 pt (error) |
| `arrow/missing` | datapath, per variant | a net ends at a block input pin or figure output port without an arrowhead (skin `arrow.at` omits its kind); gate inputs in gate-level regions and a bus entering a split are exempt (error) |
| `route/crossings` (warning) | datapath, per variant | wire crossings per class (data / control / mixed) above the skin thresholds |
| `geometry/text-on-line` | datapath, per variant | any text box touched by a drawn line other than a wire (outlines, frames, ripper stubs; slanted lines are clipped exactly) |
| `region/frame-foreign-block`, `region/frame-member-outside`, `region/frame-edge-crossing`, `region/wire-on-frame` | datapath, per variant | a region frame intersects a non-member, misses a member (incl. its overhanging labels), crosses or touches another frame, or has a wire lying on its edge |
| `print/slice-label-omitted` | datapath, per variant | a truncation label found no free spot on its wire (the slice would be invisible) |
| `label/duplicate` | datapath | two or more blocks share a primary name without being declared stages of one function (`function.stage`) |
| `label/function-justification` | datapath | a vocabulary name whose entry declares required evidence lacks `function.basis`, the cited source text does not show the required structure, or (netlist given) the RTL cone of the block's outputs lacks the required operations; suggests the entry's general name (warning, error with `--quality paper`) |
| `width/missing` | datapath, per variant | a multi-bit data net has no width label (error) |
| `width/product-notation` | datapath (lint + render) | a net/mux label or rendered width label is a product such as `6×8` (error) |
| `net/class-style` | datapath | an authored net class contradicts the class derived from its sinks' roles, without `class_reason` (error) |
| `arrow/marker-overlap` | all renderers, per variant | two arrowheads of different connections overlap, or an arrowhead touches another connection's wire |
| `arrow/label-proximity` | all renderers, per variant | foreign text within 1.5 pt of an arrowhead or of the last stretch of its shaft |
| `doc/conflict`, `doc/authority-mismatch`, `doc/rtl-mismatch`, `doc/fact-unsupported` | microarch | documented facts across all documents (§7.4) |
| `coverage/dropped-hardware` | datapath (netlist) | an instance, register, memory, live net or transfer inside the declared scope is neither drawn nor covered by a collapsed element (§4.7) |
| `coverage/scope-undeclared` (warning), `coverage/scope-unknown` | datapath (netlist) | no `meta.scope` (the default scope is used); the declared scope instance does not exist |
| `latency/hidden-register` | datapath (netlist) | a pipeline register on a shown path is hidden inside a collapsed element, or the latency drawn through an element differs from the RTL latency (§4.7) |
| `detail/ref-unresolved` | datapath | an element's `detail_ref` figure or id does not exist |
| `deliver/does-not-fit` | datapath, microarch | a required variant overflows width or height; fixes: collapse, taller up to the profile maximum, narrow the scope or split into sub-figures |
| `wire/detached` | datapath, per variant (final SVG) | a wire end more than 0.1 pt from its pin anchor, an anchor off the symbol outline, an arrow shaft not meeting its base, a divergence without a junction dot, a dot off the trunk, a lane changing level through a bar, or notched joins |
| `wire/touching` | datapath, per variant (final SVG) | a vertex of one net lies on another net's wire |
| `symbol/bubble-detached` | datapath, per variant (final SVG) | an inversion bubble is not tangent to its body (gap or overlap > 0.25 pt) or its wire does not meet it |
| `net/stroke-uniform` | skin + datapath, per variant (final SVG) | a net path or symbol wire stub (concat input, split spine/tap, truncation) is drawn at a stroke weight other than `stroke.wire`, or the skin's `stroke.bus`/`stroke.control` differs from `stroke.wire`; bit width is shown only by slash-N labels (error) |
| `route/dot-near-arrow` | datapath, per variant (final SVG) | a junction dot center is closer than `route.dot_arrow_clearance` (skin, default 8 pt) to the base of an arrowhead of its net or to a pin anchor of its net; the renderer first moves the branch point along the trunk (error) |
| `route/long-feedback` | datapath, per variant | a back edge whose **routed** length exceeds `route.long_feedback_ratio` (skin, default 0.5) × the content width is drawn as a loop; the renderer draws such nets as a pair of named off-page connectors unless `meta.style.connectors: false` (error) |
| `route/long-loop` | datapath, per variant | a forward branch whose route is longer than its direct distance by more than the ratio × width (a wrap around the figure) is drawn as a loop; connectors by default (error) |
| `label/ambiguous-anchor` | datapath, per variant | a net label lies no closer to its own wire than to another net's wire (0.5 pt margin); the placer only uses spots anchored to the own wire (error) |
| `region/entry-side` | datapath, per variant | a net from outside a region frame enters through a side that does not face its source, within 2 × `route.frame_gap_pt` of a corner, or through the frame's label band (error) |
| `arrow/nonuniform` | datapath, microarch, per variant (final SVG) | an arrowhead's length or width differs from the skin's `arrow.length` × `arrow.width` by more than 0.05 pt; receipt `connectivity.arrows_checked` / `arrow_nonuniform` (error) |
| `arrow/no-room` | datapath, per variant | a sink's last run is shorter than the arrowhead plus `route.arrow_min_shaft_pt` after the layout tried to move the riser back; heads are never shortened (error) |
| `label/pin-clutter` | datapath | an element with `pin_labels: true` prints more than 4 pin names, an unreadable one, a clock or reset pin name, or none at all; pin names are off by default (warning, error with `--quality paper`) |
| `label/constant-as-port-label` | datapath | a port or pin label is a tie-off literal (`1'b0`, `'0`, `0`); draw a constant, not a named port (warning, error with `--quality paper`) |
| `label/duplicate-net-label` | datapath | two nets print the same label, or a net label repeats the port label of its driver or sink (warning, error with `--quality paper`) |
| `latency/controller-only` | datapath | a per-input (`{pin: k}`) or `"state"` latency on a block whose `function.kind` is not stateful (controller, fsm, bus_slave, csr_bank, arbiter), or any latency on an input pin (error) |
| `latency/unknown-input` | datapath | a latency map names a pin that is not an input of the block (error) |
| `print/width-overflow`, `print/max-height` (size drivers) | per variant | messages say how far over and what sets the size (widest layers, tallest columns, layer spacing); `--why-size` adds `size_report` to render/deliver output |
| `rtl/duplicate-definition` (warning), `rtl/top-not-found`, `rtl/include-unresolved` (warning) | check-rtl `--search-path` | a module/interface/package defined in several files (every file listed, deterministic choice: `--prefer` > not a stub/mock/tb path > first by path); no file defines the top; an `` `include `` not found |
| `evidence/output-in-rtl-tree` | check-rtl | `--out`, `--work-dir` or `--emit-filelist` inside a search-path base (error) |
| `soc/top-claimed` | microarch | two or more blocks claim `rtl.top` without `rtl.covers` (error) |
| `soc/stream-as-fabric` (warning) | microarch | a fabric uses AXI4-Stream; model it in `interfaces` |
| `interface/endpoints` | microarch | an interface starts and ends at the same block (error) |
| `group/offchip-member` | microarch | an off-chip block is a member of a chip group (error) |
| `view/context-outside-scope`, `view/scope-unknown` | microarch | a block maps an instance outside `view.scope`; the scope does not exist in the netlist (error) |
| `coverage/dropped-hardware` (microarch), `coverage/covers-unmatched` (warning) | microarch, netlist | an instance within the view depth or a register of the scope module is represented by no block; an `rtl.covers` entry matches nothing |
| `rtl/stream-port-missing`, `rtl/stream-direction`, `rtl/stream-width` | microarch, netlist | an interface end lacks `<prefix>tvalid/tready/tdata`, has them in the wrong direction, or tdata ≠ `data_width` (error) |
| `format/unknown` (error), `format/variants-ignored` (info), `format/pdf-required` (info) | all | unknown `--format` / `meta.print.format`; study ignores `--variants`; `--no-pdf` ignored for paper |
| `comb/unknown-input` | datapath | a `comb_from` entry is not an input pin of its element, or `comb_from` sits on an input pin (error) |
| `latency/comb-from` | datapath (netlist) | an output's `comb_from` omits an input that the RTL reaches the output from with no register on the way (error); checked also on nets drawn unmapped for latency when they keep `rtl_unmapped.rtl` |
| `label/unreadable` (generated text) | datapath, per variant, every format | a string the renderer generates (a stage-note output name, a connector tag) is not a readable name; generated names come from the pin label, the net label or the RTL signal made readable, never an id; never relaxed by the study format (error, `evidence.generated: true`) |
| `label/stage-note-clutter` | datapath, per variant | a block prints more than 2 note lines inside its box (function detail plus stage notes); the renderer groups output latencies ("2 stages: ready, done") or gives the range ("outputs: 1–4 stages") and lists every output in `route.stage_notes` and, in a study figure, in an output latency table below the drawing (error) |
| `label/function-justification` (whole block) | datapath, netlist | a vocabulary name whose required structure is in the RTL cone of only some of the block's outputs (a hub where one output compares against zero is not a zero detector) (warning, error with `--quality paper`) |
| `route/readability` (warning) | datapath, study format | the final SVG has more crossings per drawn net than skin `route.readability.max_crossings_per_net` (1) or routed wire length above `max_wire_length_ratio` (1.6) × the direct distance; both numbers are in every receipt as `route.readability` |
| `connector/ambiguous-name` | datapath, per variant, every format | two different nets carry connector tags with the same name; the renderer names connectors uniquely (net label or readable RTL signal, qualified with the readable source instance when names collide, "Nonce client: start ready", numbered only as a last resort) (error) |
| `connector/redundant-port` | datapath, per variant, every format | a connector target tag feeds a figure output port directly (one signal, two names); the renderer never cuts a net that drives a figure output (error) |
| `connector/orphan-tag` | datapath, per variant (final SVG), every format | a connector tag or port glyph has no wire end within its box (grown by an arrowhead's length); exempt: a port declared `off_page: true` in the IR (error) |
| `port/no-sink` (warning) | datapath, per variant (final SVG) | a figure input drives nothing in the figure |
| `connector/duplicate-name` | datapath, per variant, every format | a name is on more than two connector tags (one net gets one source and one target tag, which feeds every cut sink), or names both a connector tag and a figure port (error) |
| `route/straighten-budget` (info) | datapath, per variant | the straightening search scored `route.straighten_max_evaluations` (skin, default 50 000) candidate layouts and stopped; the best route found is kept and every route check still runs; the counts are in `route.layout_plans[].evaluations` |
| `draft/budget-exceeded` | draft | the draft did not finish within its time budget (`--budget-seconds`, default 120 s) or its scope holds more signals than the size budget (50 000); names the phase it stopped in, the expanded instances and the largest children, and suggests a narrower `--scope`, a lower `--depth` or a `--blackbox` (error, exit 1, no draft written) |
| `region/wire-hugs-frame` | datapath, per variant | a wire runs parallel to a region frame edge closer than `route.frame_gap_pt` (default 6 pt; 1.5 × for a dashed wire beside the dashed frame) over more than 3 pt (error). The renderer first moves the edge past the wire: outward if the frame then covers no foreign block, else inward if it still holds its members |
| `width/bundle-sum` | datapath | a heterogeneous bundle (`bundle_of`, or a pin `bundle`) has neither a net label nor a port label; bundles are named by protocol or function and never get a summed width slash (error) |
| `svg/*` | all, per variant | figma-safe profile lint, §10.1 |

## 9. Layout

### 9.1 Decision (see `docs/adr/0001-layout-and-rendering.md`)

- `datapath`, `microarch`: **ELK Layered** via elkjs (pinned exact version),
  left-to-right, orthogonal routing, fixed port sides and order.
- `fsm`: ELK Layered top-to-bottom with spline routing for arcs; renderer-owned
  self-loops, any-state and reset arcs; optional authored grid positions.
- `timing`: rendered by WaveDrom (pinned npm library); fig-gen only fits
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

**Variant policy (decision, Phase 2).** `2col` is the required deliverable
and must pass every check; its failure is a delivery failure. `1col` is best
effort: the renderer runs the normal layout and exactly one retry (short
labels + tighter layer spacing, ×0.7). If 1col still fails a print/geometry/
lint check (min font, min stroke, width overflow, max height, label overlap),
it is skipped — not an error: an info diagnostic `variant/1col-skipped` carries
the reason and measured values, no 1col files are written, and the receipt
records `variant_status["1col"] = { status: "skipped", reason, measured }`.
`--variants 1col` (or any explicit variant list) makes the listed variants
mandatory. No repair loops beyond the single retry.

**Wide-column use (decision).** Datapath figures *spread* in 2col: when the
content is under ~85 % of the column, layer spacing is scaled (≤ 3×) so the
figure uses ~90 % of the width; the remainder is centered. SoC/microarch
figures are *centered* at natural size (spreading a bus diagram only adds
empty bar length). ELK wrapping is not used for delivery (it produced long
return loops that read worse than a skipped 1col).

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

Implemented (Phase 2): `geometry/label-overlap`, `geometry/label-on-wire`,
`geometry/text-on-line`, `symbol/label-clearance`, `text/glyph-missing`,
region frame checks (`region/frame-*`, `region/wire-on-frame`),
`route/data-jog`, `route/data-bend`, `route/crossings`, and the print checks
(`print/min-font`, `print/min-stroke`, `print/max-height`,
`print/width-overflow`). Each carries `supportedFixes`.

Layout pipeline for straight data trunks (CONVENTIONS §1.4):

1. Every multi-pin symbol puts its pins on one grid (pitch/2 + k·pitch, pitch
   12 pt); pipeline bars pass lanes through at identical y; the stage label is
   placed above the bar after routing (it may overhang the bar).
2. ELK layered with NETWORK_SIMPLEX node placement and `favorStraightEdges`.
   Framed regions are compound nodes (`hierarchyHandling: INCLUDE_CHILDREN`,
   ROOT coordinates), so a frame encloses exactly its members.
3. Straightening pass (`lib/render/straighten.mjs`): snap nodes back onto the
   pin grid, then shift nodes vertically (x fixed) and replace detours between
   aligned pins with straight wires, re-routing only the terminal segments of
   moved nodes. Wires a moved block would cover are detoured by at least one
   pitch. Moves are greedy with a two-step lookahead and must lower the score
   (redundant jogs 1000, hugging wires 400, crossings `route.crossing_weight`,
   bends 1, vertical data travel 5/pt) while keeping hard constraints (no
   overlap, no wire through a block, no collinear wires of different nets, no
   region growing over a foreign block). Candidates include:
   - full-row moves (up to four pitches) of either end of a single-sink data wire;
   - a block moved together with the figure ports on its far side;
   - channel moves: an interior segment that hugs an outline or another wire
     slides sideways, together with the same net's coincident branch segments.
3a. Pin re-assignment (`tapPlan`). A block data input whose net also reaches a
   later layer becomes a tap on the block's bottom edge. Adjacent pipeline
   registers move the passing lane below the lanes attached to the block and
   add whole pitches until it clears the block's bottom edge by an arrowhead
   plus 6 pt. The figure is laid out and straightened with and without taps;
   the lower score wins, with avoidable bends weighted like redundant jogs.
   Receipt `route.layout_plans` records both plans and the chosen one.
3b. Bend justification (`justifyBends`) classifies every remaining data bend
   (see `route/data-bend`); an avoidable one is `route/data-jog`.
4. Frames are recomputed from member boxes (plus overhanging labels) and
   pushed off any wire lying on an edge; then the geometry and route checks
   run. Route metrics are recorded per variant in the receipt
   (`variants[].route`).

5. **Exact geometry** (pre-phase 3).
   - Stage partitions follow forward edges only: back edges come from a DFS
     from undriven elements. Figures with feedback nets use ELK depth-first
     cycle breaking, so a result returning to an upstream block is the
     reversed edge.
   - After straightening:
     - zig-zags shorter than 2 pt are collapsed;
     - wire ends are extended to exact pin anchors (ELK keeps ports on the
       node border; gate anchors sit on curved backs and bubble tangent
       points);
     - interior runs that touch a foreign wire slide into a free channel
       (`detouchWires`), avoiding block outlines.
   - `lib/render/connectivity.mjs` then parses the final SVG and runs
     `wire/detached`, `wire/touching` and `symbol/bubble-detached`.
   - The counts are recorded in `variants[].route.connectivity`.

Still planned: `geometry/port-crowding`, `print/aspect` hints.

### 9.6 Output formats: paper and study

- `meta.print.format` is `paper` (default) or `study`; CLI `--format` on
  `validate`, `render`, `deliver` and `draft` overrides it. With `study`,
  `meta.print.profile` may be omitted.
- Study uses `profiles/study-profile.json`: one variant `study`, no width or
  height limit (`sized_to_content`). The renderer gets no column, so the canvas
  is the content size, with no short-label retry and no spread; ELK spacing is
  the skin's `elk.variants.study`. The PDF is optional (`--no-pdf`) and its
  page is the content size.
- The paper-only checks and their study treatment are listed centrally in
  `lib/format.mjs` (`PAPER_ONLY_CHECKS`): skipped — `print/width-overflow`,
  `print/max-height`, `deliver/does-not-fit`, `print/label-fallback`,
  `print/variant-not-requested`, `variant/1col-skipped`, `print/small-font`,
  `view/detail-collapsed`, `route/crossings`; downgraded to warnings —
  `print/min-font`, `print/min-stroke`, `label/unreadable`, `view/caption`.
  Every other check is enforced unchanged; the receipt lists what was relaxed.
- **Size report.** Every render returns `size_report {content_width_pt,
  content_height_pt, layers, spacing_pt, widest_layers, tallest_columns}`;
  overflow messages quote it and `--why-size` prints it.

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
    <g id="inst-u_core"> ... (expanded children nested) </g>
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
routed by ELK Layered with fixed pins, one stroke weight for every net,
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
- Net styling is resolved by the renderer into inline attributes (one
  `stroke-width`, `stroke.wire`, for every net of any bit width; control is
  dashed at the same weight; `net/stroke-uniform`); there are no CSS classes in
  the output (§10.1).

fig-gen differences kept on top of the netlistsvg look:

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
  with slice labels and no select (concatenation is a hollow `concat` box); pipeline bar gray, outlined, clock
  wedge, spanning lanes.
- Outline weights are per-symbol tokens (`stroke.outline.default` plus
  optional per-kind keys).
- Slash-N width labels once near the source (CONVENTIONS §2).
- Pipeline-stage alignment: stages become ELK partitions so register bars line
  up in one column per boundary.
- Control vs data stays grayscale-safe: control nets are dashed (and thinner),
  never distinguished by color alone; clock/reset nets omitted by default.
- Figma-safe output rules and per-variant re-layout.

Optional draft import (Phase 3+): `fig-gen import-yosys <design.json>`
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

- fig-gen never embeds, requires or assumes any commercial tool, license
  mechanism, host, install path, or technology library. The only built-in
  adapter is Verilator (open source), located via `PATH` or
  `FIGGEN_VERILATOR`.
- Other front-ends (slang, yosys, commercial tools) are plug-ins the *user*
  registers; fig-gen ships no knowledge of them.
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

Order: CLI `--adapter <id>` → env `FIGGEN_ADAPTER` → config `default_adapter`
→ `verilator`. Plug-ins come from `fig-gen.config.json` (project root or
`--config`) and `FIGGEN_ADAPTER_PATH` (path-list of adapter modules):

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
"rtl": { "instance": "u_core/u_dec", "signal": "s1_s2" }
```

Cross-checks: `rtl/unknown-signal`, `rtl/width-mismatch`,
`rtl/not-a-register` (IR register maps to comb-driven signal),
`rtl/domain-mismatch` (clock root differs), `rtl/no-structural-path` (IR net
from A to B has no dependency path between mapped signals),
`rtl/latency-mismatch` (register count along RTL path ≠ IR stages),
`rtl/fsm-encoding` (FSM state encodings ≠ RTL localparams). Coverage is not
informative-only. Everything inside the declared scope must be represented,
and missing hardware is `coverage/dropped-hardware` (error, §4.7). Abstraction
collapses hardware into covering elements; only an explicitly narrowed scope
leaves it out.

### 11.6 Dependency resolution and netlist type fields

- `check-rtl` accepts `--search-path <file|dir|glob>` (repeatable; a directory
  means its files, a glob such as `rtl/**` recurses), `--exclude <glob>`,
  `--prefer <file>` and `--emit-filelist <file.f>`; `--filelist` understands
  `+incdir+`, `-I dir` and `-Idir`. From `--top` it follows instantiated
  modules/interfaces, referenced packages and `` `include `` files; package
  files compile first. Duplicate definitions are reported with every candidate
  and the choice. The netlist records `inputs.include_dirs` and
  `inputs.resolution {top, search_paths, excludes, prefer, scanned,
  files[{path, defines}], duplicates[{name, kind, candidates, chosen, reason}],
  unresolved[{kind, name, referenced_by}]}`. `--summary` prints one line per
  module plus a resolution line and the diagnostics.
- Ports, nets and registers may carry `type`, `enum {type, width,
  items[{name, value, literal}]}`, `struct {type, kind: struct|union, width,
  members[{name, width, msb, lsb, type?, enum?}]}` (MSB first) and
  `packed_array {dims[], element_width, element_type?}`; top-level `types[]`
  lists each named type once. Widths resolve through typedefs, enums, packed
  structs/unions and packed arrays.
- Dependencies include signals read inside called functions and tasks (inlined
  semantics), so a value routed through a function is not `rtl/input-unused`.

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
  Datapath receipts with a netlist also carry `coverage` (scope, totals,
  per-region counts, exclusions, uncovered items) and `latency` (pairs
  checked, mismatches 0, hidden registers 0). Every datapath variant carries
  `route.connectivity`, whose `wire_detached`, `wire_touching` and
  `bubble_detached` counts must all be 0.
- `connectivity` also carries `arrows_checked` / `arrow_nonuniform`,
  `dots_checked` / `dot_near_arrow` and `strokes_checked` /
  `stroke_nonuniform`. The latency block carries `member_pairs_checked`,
  `bundled_pairs_checked`, `pairs_skipped_bundled`, `state_pairs` and
  `excluded_unmapped` (§4.9).
- Every receipt has `format {name, profile, skipped_checks,
  downgraded_checks, relaxed[{code, treatment, count}]}`; `checks.quality` is
  `study` for study figures, and only a study receipt may omit a variant's
  `pdf`.
- **Superseded outputs are archived.** `deliver` never leaves old outputs
  beside current ones: every existing SVG, PDF, PNG preview and receipt of the
  same figure name moves to `<out>/../archive/<YYYY-MM-DD>-<name>-<sha8>/` with a
  `README.md`, just before writing — and also when the delivery fails, so a
  stale file never looks current. The receipt records `archived`. `render`
  (preview) does not archive.

### 12.2 Evidence rule and per-region verification (hard rule, Phase 2)

- A figure may only be verified against the **user's own** RTL, netlists
  extracted from it, VCDs simulated from it, and the user's documents.
  fig-gen never synthesizes RTL, stubs, models or stand-in DUTs to fill a gap;
  a region without RTL is `unverified` (grounding `doc` when a source pin
  points into the user's documents, else `none`).
- **Evidence guard** (`lib/evidence.mjs`), enforced by `check-rtl`,
  `validate --netlist`, `crosscheck`, `expand-cone`, `render` and `deliver`:
  any RTL input, netlist input or source-pin repository located inside the
  fig-gen installation (skill files, `tests/fixtures`) or inside a fig-gen work
  directory (marked with `.figgen-work`; all tool-generated stubs and trees
  live there) is rejected with `evidence/self-authored`. Missing or changed
  inputs are `evidence/missing` / `evidence/stale`; files outside git are
  `evidence/untracked` (warning), dirty files `evidence/uncommitted` (warning).
- Test fixtures (e.g. the tiny generic SoC under `tests/fixtures/soc`) exist
  only to unit-test fig-gen's own code and are never used, copied or
  referenced during real figure generation.
- **Stubs are not evidence.** Auto-generated blackbox stubs only copy port
  names and widths from the user's instantiation sites so Verilator can
  elaborate; every stubbed module is reported as a region with grounding
  `stub` and level `unverified`. Generated BFM wrapper testbenches (Phase 3)
  are recorded as `stimulus` and never instantiate a stand-in DUT.
- **Receipt evidence list:** every file relied on is recorded with role
  (`rtl`, `netlist`, `doc`, `vcd`, `stimulus`, `stub-*`), path, SHA-256 and
  repository origin (root, revision, dirty); stubs and stimulus carry
  `counts_as_evidence: false`.
- **Verification is reported per region**, never as one blanket level:
  `verification.regions[]` has one entry per figure scope, SoC block, stub
  module and gate region (`level`, `grounding: rtl|vcd|doc|stub|none`,
  `reason`, and `equivalence` for gate regions). The top-level `level` is the
  common level when all regions agree, otherwise `mixed`. Schema rules make
  `structural-only` require grounding `rtl` and `doc`/`stub`/`none` require
  `unverified` with a reason.
- **SoC context without SoC RTL** (typical for IP deliveries): SoC-level blocks
  are doc-grounded; only the IP boundary is RTL-checked — the accelerator
  block's `ports` against the IP top module (`rtl.top: true`,
  `rtl/boundary-mismatch`) and the address window size against the local
  address port width (`rtl.addr_port`, `rtl/addr-window-mismatch`). Context
  subordinates without a documented window use `address_unknown: true`
  (warning `soc/address-unknown`).

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
- Phase 2 (implemented; see docs/PHASE2_SUMMARY.md): datapath **and
  microarch/SoC** semantic checks (datapath, memory map, fabrics/bridges,
  domains), skin-driven ELK datapath renderer in `netlist-mono` (bar mux,
  parametric IEEE gates, blackbox hatch), deterministic row/bus SoC renderer,
  2col required / 1col best effort, address-map table figure, outlined-text PDF
  (opentype.js + pdfkit + svg-to-pdfkit), source-pin verification, `deliver` +
  receipts with evidence origins and per-region verification, evidence guard,
  structural RTL cross-checks (datapath transfers, registers, domains, mux
  order, latency; SoC instances, params, bus ports, IRQ, IP boundary, address
  window), mixed-abstraction regions with RTL-grounded gate expansion
  (`expand-cone`) and equivalence checks.
  Revised acceptance: (a) a decoder datapath from the user's real RTL; (b1) the user's IP in
  its documented SoC context (doc-grounded blocks, IP boundary RTL-checked);
  (b2) the SoC cross-check itself is proven on a tiny generic unit-test fixture
  only (never evidence).
  Later Phase 2 addenda, also implemented: (Q) functional block names from a
  controlled vocabulary with `label/unreadable` lint and `--quality paper`
  (§4.5, CONVENTIONS §4.3); (R) exact region frames via ELK compound nodes,
  frame/wire/text collision checks and crossing counts (§8, §9.4); (S)
  straight data trunks: shared pin grid, straightening pass and
  `route/data-jog` (§9.4, CONVENTIONS §1.4); (T) distinguishable bus-operation
  glyphs (`concat` box, ripper taps, truncation label, `sext`/`zext`, `repl ×N`)
  and `glyph/distinguishable` (§4.5, CONVENTIONS §2.3, §3.5).
- Phase 3: WaveDrom integration (fitting + figma-safe post-process + golden
  test); `vcd2wavejson`; sim-compare; BFM helper; FSM checks + renderer;
  datapath IR↔netlist cross-checks; FSM extraction from `case(state)`;
  optional Yosys JSON import.
- Phase 4: visual-check; optional Figma MCP import acceptance test; evals loop
  per skill-creator (`evals/evals.json`, trigger queries).

Open questions are tracked in the Phase 1 summary.
