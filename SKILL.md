---
name: fig-gen
description: Generate paper-quality figures of hardware designs from validated JSON — datapath / RTL block schematics (muxes, registers, pipeline stages, memories, clock domains), FSM / state diagrams (encodings, guards, Moore/Mealy outputs), timing / waveform diagrams (WaveJSON, latency and handshake annotations, simulation-grounded), and micro-architecture / SoC block diagrams (bus fabrics and bridges, address maps, interrupts, power/clock domains, accelerator integration) — delivered as editable figma-safe SVG plus outlined-text PDF in IEEE/ACM single- and double-column sizes. Checks widths, mux selects, clocks, CDC, reachability, latencies and memory maps, and cross-checks figures against real Verilog/SystemVerilog through Verilator. Use this whenever the user wants any figure, diagram, schematic, block diagram, state machine drawing, waveform, timing diagram, SoC/system architecture figure or address-map table of hardware or RTL for a paper, thesis, slides or a design doc — even if they only say "draw the decoder", "show the pipeline", "FSM of this module", "SoC figure", or paste WaveDrom/WaveJSON.
license: MIT
metadata:
  version: "0.1-phase1"
---

# fig-gen

Phase 3. `datapath`, `microarch`, `fsm` and `timing` figures validate, render
and deliver (SVG + outlined PDF + receipt). Structural figures are
cross-checked against RTL (gate-level equivalence for datapath regions);
timing figures are grounded in Verilator simulation.

A figure is a small JSON document of one type. The pipeline validates the
hardware semantics before any layout, lays out each column variant separately,
and delivers editable SVG plus print PDF with a receipt. The JSON is the
source of truth; never hand-edit generated SVG/PDF to fix a problem — change
the JSON and re-run, so the fix survives the next render.

## Fast authoring path

1. **Pick the type** from the request:

   | type | use for |
   |---|---|
   | `datapath` | RTL block/schematic: mux, comb blocks, registers, pipeline bars, memories, synchronizers, instances |
   | `fsm` | state machines: encodings, guards, Moore/Mealy outputs, reset and any-state arcs |
   | `timing` | waveforms over clock cycles, buses, latency/handshake annotations; WaveJSON accepted |
   | `microarch` | SoC / system integration (bus fabrics and bridges, manager/subordinate attachments, address map, interrupts/DMA/sideband, clock/reset/power domains, ×N units, drill-down to datapath figures) and abstract block pipelines |

2. **Read only what you need**: `schemas/<type>.schema.json`,
   `schemas/common.schema.json`, and the matching file in `examples/`. Use the
   example for field shape, not facts. `SPEC.md` §4–7 explain each field;
   read the section for your type only when a field is unclear.

3. **Ground it when RTL exists.** Hardware figures are wrong in small ways
   (a width, a latency) that reviewers catch. When the user's repository has
   RTL, extract a netlist first and author from it:

   ```bash
   node <skill>/bin/fig-gen.mjs check-rtl --top <module> \
     --search-path "<repo>/rtl/**" [--search-path "<repo>/ip/*.sv"] \
     --work-dir <scratch dir outside the RTL repo> --source-root <repo root> \
     --out <scratch>/netlist.json --summary
   ```

   `--search-path` finds the top's module, package and include closure; no file
   list or helper script is needed (`--files`/`--filelist` still work). Quote
   globs. Duplicate module/package definitions are reported
   (`rtl/duplicate-definition`) with every defining file; the real file wins
   over a `*_stub`/`mock`/`tb` file. Override with `--prefer <file>` or
   `--exclude <glob>`, and tell the user which definition was used.
   `--emit-filelist` saves the resolved list. Enum state registers keep their
   item names and encodings, packed structs their member offsets.

   Missing modules (memory macros, IP) are stubbed automatically from their
   instantiation sites; say which ports were inferred. Add `source` pins
   (file + line at a pinned revision) to elements the reader may want to trace.
   Never write tool output into the user's RTL tree.

4. **Write the candidate JSON first**, with a clear main data path left→right.
   **Declare the scope** (`meta.scope`: an instance with its hierarchy, or a
   cone between named signals). Abstraction may collapse hardware, never drop
   it: every instance, register, memory and transfer inside the scope must be
   drawn or covered by a collapsed element (`rtl.covers`, or `rtl.instance` on
   an instance). To leave something out, narrow the scope; nothing else does
   (`coverage/dropped-hardware`). Give long labels a `short_label` so the
   single-column variant can stay legible.

   **Pick a view preset** to deliver the same design at another scope or
   abstraction without hand-rebuilding the IR:

   | preset | use for |
   |---|---|
   | `overview` | the whole IP: children as functional blocks, pipeline bars kept, buses bundled |
   | `block` | one instance (`--scope u_x/u_y`); its ports are the figure ports |
   | `mixed` | a block or overview scope plus selected gate regions and blackboxes |
   | `detail` | the scope expanded `--depth n` levels |

   Start from `fig-gen draft --view <preset> --scope <path> --netlist n.json
   [--gate-region name=out1,out2] [--blackbox <path>] [--repo-root <dir>
   --revision <sha>] --out fig.json`. Then refine: rename blocks, regroup, add
   context. Read the draft's notes; they list every name the generator
   inferred and every wire it could not map. The draft runs the figure's own
   checks and prints each remaining error as `residual: <code>: …` (at paper
   quality; study with `--format study`): fix those first, they are what
   `deliver` would reject. `--scope ''` with `--view block` drafts the top
   module itself. A draft that runs past its budget stops with
   `draft/budget-exceeded`, naming the largest children: narrow `--scope`,
   lower `--depth` or `--blackbox` one; raise `--budget-seconds` only if the
   scope really needs it. The figure's `view` records the
   preset and scope. The caption must state both (`view/caption`), and the
   completeness rule applies within that scope. Narrowing the scope is the
   legitimate way to show one block.

5. **Validate after every edit**:

   ```bash
   node <skill>/bin/fig-gen.mjs validate <type> <figure.json> --json
   ```

   Fix only what a diagnostic names, using its `supportedFixes`. If two
   consecutive repair rounds don't reduce the error count, stop and report the
   remaining diagnostics honestly.

6. **Deliver** (Phase 2+): `deliver` renders both `1col` and `2col` variants,
   lints the SVG as figma-safe, derives outlined-text PDFs, and writes a
   receipt. A non-zero exit is never success. Re-delivering moves the
   figure's previous outputs to `<out>/../archive/<date>-<name>-<hash>/` (also
   when the new delivery fails), so only current outputs stay in `<out>`.

## Paper or study

Paper is the default: every figure is a printed column figure. Use
`--format study` (or `meta.print.format: "study"`) only when the user asks to
study, analyse or explore RTL rather than to make a paper figure.

- A study figure is one SVG (optional PDF, `--no-pdf`) sized to its content,
  with full hierarchy and detail; nothing is collapsed or split for size.
- Every correctness check still applies (coverage, latency, cross-check,
  connectivity, arrowheads, glyphs, evidence). Only print checks are relaxed
  (column fit, height, crossing thresholds, font/stroke floors; readable names
  and caption become warnings). The receipt lists them.
- `draft`, `validate`, `render` and `deliver` all accept `--format`.
- A study draft shows structure by default: `fig-gen draft --scope '' --netlist
  n.json --format study` is a detail view one level deep, with each
  controller (enumerated state register) drawn apart from its datapath and
  every signal as its own net. Go deeper one instance at a time
  (`--view detail --scope u_x --depth 2`).
- A study draft frames each expanded instance, splits hub-like lumps by output
  cone, lays frames out along the flow and turns nets that skip a frame into
  connectors. The receipt's `route.readability` (crossings per net, wire length
  ratio) says how readable the result is; a `route/readability` warning means
  narrow the scope rather than read spaghetti.
- Never hand a study figure over as a paper figure: re-deliver in paper
  format for the paper.

## Things that matter for paper figures

- The double-column (2col) variant is the required deliverable. The
  single-column (1col) variant is best effort: fig-gen tries the normal layout
  and one retry with short labels and tighter spacing, then skips 1col with an
  info diagnostic and a receipt entry. Do not spend repair rounds forcing a
  figure into one column; only `--variants 1col` makes 1col mandatory. Never
  scale one variant into the other — that pushes text below the 6 pt floor
  (labels are 8 pt, secondary text 7 pt — `references/CONVENTIONS.md`).
- The canvas is the printed size; the figure contains no title or "Fig. N" —
  the caption lives in LaTeX and should define colors, line styles and
  abbreviations.
- Grayscale print: distinguish classes by dash, weight and hatching, not hue.
- The SVG stays editable (real text, named layers) so authors can polish in a
  vector editor; the PDF has outlined text for printing.
- No vendor tool, license, host or technology-library names in anything you
  generate; describe memories as `impl: blackbox` rather than by macro name.

## Naming blocks (readers must be able to name every box)

- Give every custom block and instance a `function` from
  `schemas/function-vocabulary.json` (`syndrome`, `error_locator`,
  `chien_search`, `error_evaluator`, `classifier`, `comparator`,
  `zero_detect`, `gf_mul`, `adder`, `controller`, `bus_slave`, `memory`, …;
  `custom` with a `name` otherwise). Leave `label` unset so the functional
  name prints; put algorithm detail (`Horner`, `X = S2/S1`) in
  `function.detail`.
- Decide the function from what the RTL computes, not from instance or
  signal names. For ECC use coding-theory terms (syndrome calculator, error
  locator, Chien search, Forney evaluator, corrector).
- Ports get readable `label`s ("corrected data", "error detected"); keep the
  RTL name in `rtl.signal`. Never print mnemonics like `cls`, `en`, `e_i`,
  `X=a^i`, or abbreviated words like `Pos.`, `Calc.`, `Ctrl.`. Write the word
  out and let the block wrap. `label/unreadable` flags them (an error with
  `--quality paper`).
- XOR/GF add, GF multiply and arithmetic draw as circle glyphs with no text;
  concatenation is a `concat` box, a split is ripper taps, a single slice is a
  `[msb:lsb]` label on the wire, extension is `sext`/`zext`, replication is
  `repl ×N`. Every net has one stroke weight; widths appear only in slash-N
  labels (`net/stroke-uniform`). Junction dots keep 8 pt from arrowheads and
  pins (`route/dot-near-arrow`).
- **Justify every algorithm name.** Put the RTL lines that show the structure in
  `function.basis {source, structure}`. If the RTL does not show the structure
  the vocabulary entry requires (e.g. per-position polynomial evaluation for a
  Chien search, versus a compare against a power table for a position match),
  use the more general name the lint suggests. Never keep a name the RTL does
  not support.
- **No duplicate names.** Split stages of one function get `function.stage`
  ("1/2", "2/2"); otherwise give each block its own name.
- **Generated text is held to the same rule.** Stage notes and connector tags
  print readable names derived from labels or RTL signals, never ids
  (`label/unreadable` with `evidence.generated`, an error in every format).
  Stage notes stay within two lines (`label/stage-note-clutter`); the full
  per-output latency list is in the receipt (`route.stage_notes`). When a
  draft qualifies duplicates ("Owner controller"), keep or improve that
  context; never go back to numbers.
- **Boxes show the name only.** No stage notes, detail lines, sizes or range
  labels inside boxes (a concat box prints "concat"); latency is in the receipt.
  Opt in only when the reader needs it: `meta.style.block_details: true` or a
  block's `show_details: true`. SoC blocks are name-only too: addresses go on
  the address-map table figure, not inside blocks.
- **No pin names inside boxes.** Blocks print their function name only; the
  nets outside say what flows. Set `pin_labels: true` on an element only when
  the reader cannot tell its pins apart otherwise: at most 4 readable pin
  labels, never clock or reset (`label/pin-clutter`). A tie-off constant is
  drawn as a constant, never as a port label (`label/constant-as-port-label`),
  and each net has one name: no two nets with the same label, no net label
  repeating its port's label (`label/duplicate-net-label`).
- **Widths are one number.** Never write `N×W` on a net or a mux; say "6
  symbols of 8 bits" in the caption or `function.detail`.
- **Line style comes from usage.** Do not set `class: control` on computed
  flags or status outputs; mark real control inputs with `role` (`select`,
  `enable`, `handshake`) and let fig-gen derive dashed/solid.

## SoC / microarch figures

- One `fabrics[]` entry per memory-mapped bus (AXI4-Lite control, AXI4 master,
  APB…), with `attachments[]` giving manager/subordinate and the subordinate's
  `address`. Each fabric gets its own row; don't try to share rows.
- Streams (AXI4-Stream) are `interfaces[]` (`from` source, `to` sink,
  `data_width`, `rtl.from/to {top|instance, prefix}`), not fabrics or links.
- Off-chip blocks (`kind: offchip`: host, card memory) are never members of the
  chip group.
- When several blocks come from one RTL top (register bank, input select),
  give each an `rtl.covers` (`["c_*"]`, `["in_*"]`); map child instances with
  `rtl.instance`. Declare `view: {preset: "overview", scope: ""}` and state it
  in the caption. With `--netlist`, every instance and top register must be
  represented (`coverage/dropped-hardware`).

## Facts from documents

- Before using a slot, address, window, IRQ or instance name from a document,
  let `validate` check it against all documents (`doc_terms` on the block helps
  find them). A `doc/conflict` means the documents disagree: **ask the user
  which document is authoritative**, then record it as `authority {file,
  reason}`. Never choose silently, and never edit the user's documents.

## Layout quality you should expect (and not fight)

- Data wires come out straight. Before accepting any bend, the renderer tries
  vertical re-ordering and pin re-assignment: a trunk that feeds a block and
  continues past it passes underneath and taps the block from below. Each
  remaining bend is reported with its justification (`route/data-bend`,
  receipt `route.data_bends`). An avoidable bend or a redundant jog is an
  error (`route/data-jog`). If one remains, fix the IR (lane order, pin pitch
  between neighbours), not the SVG.
- Every net ending at a block input or output port has an arrowhead
  (`arrow/missing`), and no wire runs within 4 pt of an outline or another
  wire (`route/edge-hugging`). Both are errors; do not work around them.
- Region frames enclose exactly their members; blackbox regions are not
  framed (the hatch marks them). No wire runs along a frame edge within 6 pt
  (`region/wire-hugs-frame`).
- Long feedback (more than half the width) is drawn as a pair of named
  off-page connectors, not a loop around the figure (`route/long-feedback`).
  Name heterogeneous bundles by protocol or function ("AHB-Lite"); they get no
  summed width (`width/bundle-sum`). When a block's registered outputs differ
  in latency, give those ports labels so the note names each path.
- **Pipeline registers stay visible.** A collapsed block may not hide a
  register that sits on a path the figure shows: split the block at the
  register and draw the pipeline bar. Internal state (feedback, CSRs,
  buffers) and memories may stay inside a block whose output ports are marked
  `registered` with their `latency`; the block then gets a clock wedge and a
  "k stages" note. Drawn latency must equal the RTL latency
  (`latency/hidden-register`), member by member for bundles.
- **Controller outputs** whose latency differs by input get a per-input map
  (`"latency": {"start": 1, "rsp_valid": 2}`); outputs that depend on the
  state rather than a fixed path get `"latency": "state"`. Both are only for
  stateful kinds (`controller`, `fsm`, `bus_slave`, `csr_bank`, `arbiter`;
  `latency/controller-only`). Never invent a uniform number to silence the
  check. A non-controller block that holds registers with feedback may do the
  same with `holds_state: true` (the draft sets it). Never set `"state"` where
  the draft's map is available (`latency/state-escape`), and never opt out of
  `latency/unverified` without a concrete reason in `latency_unverified.reason`.
- **Register-transfer drafts.** A paper block draft (`draft --view block`)
  draws the datapath a paper shows: register banks with load enables, operand
  selects, operators, a write-back bus and a Controller with dashed selects and
  enables (`--style lumps` gives functional blocks instead). Refine the
  role names ("temporary 2" → what it holds), the controller's state figure
  (its own FSM figure, `detail_ref`) and any duplicate operator names; allow a
  taller figure with `meta.print.max_height_in` when banks and wide selects need
  it. Never collapse the registers back into a block to save space.
- **Drafting.** Read both residual lists: `residual:` for semantic checks and
  `residual (layout):` for layout, fit and connectors; a "layout not run" note
  means layout failures may still come at delivery. For overviews with many
  ports try `--bundle prefix`, then `--bundle handshake`. For SoC or shell tops
  use `draft --type microarch`, then add the documented address windows.
- **If the figure does not fit 2col**, in this order: collapse more hardware
  into blocks that cover it; allow a taller figure up to the profile's maximum
  height; otherwise the delivery fails (`deliver/does-not-fit`): narrow the
  scope, or split into sub-figures (a)/(b) where the collapsed element links
  its detail figure with `detail_ref`. Never drop hardware to fit. The
  overflow message names what sets the size (widest layers, tallest
  columns); `render --why-size` prints the full size report.
- Connector tags carry one unique name per net (qualified by source instance
  when names collide; `connector/ambiguous-name`), and never sit right before a
  figure output (`connector/redundant-port`): a net into an output keeps its
  wire. Every tag and port has a wire (`connector/orphan-tag`); declare
  `off_page: true` on a port only for a deliberate single-ended reference. Do
  not hand-name tags to work around these checks.
- Long returns and wrap-arounds are measured by routed length and drawn as
  named connectors (`route/long-feedback`, `route/long-loop`). Net labels sit
  nearer their own wire than any other (`label/ambiguous-anchor`), and nets
  enter a region frame through the side facing their source
  (`region/entry-side`).
- Every arrowhead has the one skin size; none is shortened
  (`arrow/nonuniform`, `arrow/no-room`). If one fires, change spacing or pin
  placement in the IR, not the skin.
- Geometry is exactly connected: wires end on their pin anchors (curved gate
  backs, apexes, bubble tangent points) and inversion bubbles are tangent to
  their gates (`wire/detached`, `wire/touching`, `symbol/bubble-detached`,
  checked on the final SVG). These are renderer guarantees; if one fires,
  report it rather than editing the SVG.
- Returns between neighbouring blocks stay wires; only blocks at least two
  drawn layers apart get connector pairs. Different nets never share or crowd
  a run (`wire/collinear-overlap`, every format, microarch links included).
- Several nets between the same two blocks must be named
  (`label/unlabeled-parallel-nets`, an error in paper variants): give them
  labels or RTL signals; if the names still find no room, bundle them into one
  named bus or allow more width. A net name sits within 12 pt of its own wire
  and nearer to it than to any block. Write words, not RTL abbreviations
  (`cmd`, `rsp`, `cfg`: `label/unreadable` suggests the expansion).
- `fig-gen preview <svg|figure.json>` (or `deliver --preview`) writes a PNG to
  look at before handing a figure over.
- **State machines.** Run `check-rtl` first; the netlist then carries the
  extracted machines. Start from `fig-gen draft --type fsm --netlist n.json
  --scope <module or instance> --state <register>`, which passes its own RTL
  cross-check.
  - Refine state labels and add `short_guard` for long guards; never rename
    state ids (they are the RTL names).
  - Leave out RTL states or arcs only through `machine.scope` with a reason.
  - Keep the recovery arc when unused encodings recover to a safe state; it is
    part of the design's safety story.
  - With `--netlist`, a delivered machine is `structural-only`; it is never
    labelled simulated. Blackboxes outside the machine's cone do not lower it
    (`verification.not_in_cone`).
  - Long chains snake in rows automatically. If nothing fits 2col,
    `fsm/split-suggested` lists groups: draw each as its own figure and
    collapse it in the overview (`collapsed` with `detail_ref`). Never drop
    states or arcs.
  - Guards print enum names only when the netlist types the signal; a bare
    number means the RTL gives no name. Do not invent one.
- **Net names without room** may use `label_placement: "leader"` on that net
  (a short leader to free space). If `label/bundle-name-omitted` persists, change
  the layout (spacing, lane order) or report it; never drop the name.
- **Timing figures.** Ground them in simulation:
  1. `fig-gen simulate` with the user's testbench, or with `--bfm portmap.json
     --scenario scenario.json` for AHB-Lite, APB, AXI4-Lite or valid/ready
     ports. Missing memory models stop the run
     (`sim/blackbox-without-model`): ask the user for their model, and never
     write one.
  2. `fig-gen vcd2wave --vcd <work>/wave.vcd --clock <path> --signals …
     [--radix <path>=label --netlist n.json] --sim-evidence
     <work>/simulate.json --out fig.timing.json`.
  3. Edit only `meta` and `fit`; editing lanes drops `simulated`. For
     hand-drawn waves, run `fig-gen sim-compare` against a VCD instead.
  4. Deliver.

  A caption says the waveform shows the given stimulus only. Choose lanes and
  a window so values fit their cycles (`timing/value-overflow`). Otherwise
  raise `meta.print.max_height_in`, show fewer cycles or use the study format.

## Evidence rule (hard, no exceptions)

A figure is only as verified as the user's own design files make it.

- **Never write RTL, stubs, models or testbench stand-ins to make a check
  pass.** If the RTL for a block is not in the user's repository, that block is
  `unverified` (or doc-grounded when a document pins it). Say so; do not fill
  the gap.
- Verify only against the user's actual RTL, netlists extracted from it, and
  VCDs simulated from it. fig-gen rejects evidence located in its own
  installation, in `tests/fixtures`, or in a fig-gen work directory
  (`evidence/self-authored`) — do not try to work around that.
- Auto-generated blackbox stubs exist only so Verilator can elaborate; they
  copy port names/widths from the user's instantiation sites. Anything behind
  a stub is unverified.
- Generated bus-functional wrapper testbenches are stimulus for the user's DUT,
  never a replacement for it.
- Receipts report verification per region. Never describe a figure as verified
  above the level its receipt shows.

## References (read on demand)

- `SPEC.md` — full IR, semantic check catalog (§8), layout (§9), rendering and
  figma-safe SVG rules (§10), RTL cross-check (§11), receipts (§12).
- `references/adapters.md` — plugging in another RTL front-end or simulator.
- `docs/adr/` — why ELK layout, why our own waveform renderer.
- `references/CONVENTIONS.md`, `references/figures.yaml`,
  `references/prior-art.md` — drawing conventions and exemplars (when present).
