# Hardware Figure Conventions (normative)

This guide tells the renderer, and anyone writing a figure spec, **how to draw** RTL
datapaths, control/FSM figures, timing diagrams, and microarchitecture/SoC block
diagrams so they look right in an IEEE/ACM paper.

Every rule has a tag:

- **[ext]**: comes from an outside source (publisher guide, standard, class file).
  The source is listed in §Sources.
- **[house]**: a choice this project makes, based on common practice in the exemplar
  figures (`figures.yaml`) and textbooks. The renderer MUST follow house rules by
  default. A spec may override one explicitly.

Keywords: MUST / SHOULD / MAY, as in RFC 2119.

Contents

0. Global paper style (canvas, fonts, strokes, color, flow, labels, captions)
1. Nets: datapath vs control vs clock/reset
2. Bit width, bit slices, split/merge
3. Multiplexers
4. Combinational logic (gates vs blocks, XOR/adder/comparator/LUT/ROM)
5. Sequential logic (register, clock wedge, enable/reset, pipeline bars, retiming)
6. Memories and SRAM macros
7. Clock domains and CDC
8. FSM figures
9. Timing diagrams
10. Microarchitecture / pipeline figures
11. Accelerator / SoC block figures
12. Renderer style tokens (summary table)
13. Checklist before export
Sources

---

## 0. Global paper style

### 0.1 Canvas size = final printed size

**Rule [house]:** Draw every figure at the exact size it will be printed. Never scale a
figure in LaTeX (`width=\columnwidth` on a canvas drawn much larger or smaller).
- **Why:** Scaling changes font size and line weight together. An 8 pt label on a
  7 in canvas shrunk to 3.5 in prints at 4 pt, which is unreadable. If you set sizes in
  print points, the numbers in this guide stay true.

Width presets (1 in = 72 bp; TeX pt = 1/72.27 in; the difference is below 0.4 %):

| Preset id          | Venue / class                        | Single column | Double column (`figure*`) | Basis |
|--------------------|--------------------------------------|---------------|---------------------------|-------|
| `ieee`             | IEEE Transactions/journals, IEEEtran conference (non-compsoc) | 3.5 in (21 pc, 88.9 mm) | 7.16 in (43 pc, 182 mm) | [ext] IEEE Author Center, Proc. IEEE guide; IEEEtran.cls `\textwidth 43pc`, `\columnsep 1pc` |
| `ieee-compsoc-conf`| IEEEtran `compsoc,conference` (e.g. many IEEE CS conferences) | 3.375 in | 7.0 in | [ext] IEEEtran.cls: text width = 8.5 in − 2×0.75 in, `\columnsep 0.25in` |
| `acm-sigconf`      | ACM `acmart` sigconf (ISCA, MICRO, ASPLOS use ACM or IEEE templates by year — check the CFP) | 241.1 pt ≈ 3.33 in | 506.3 pt ≈ 7.0 in | [ext] acmart.dtx sigconf geometry: inner/outer 54 pt, `columnsep=2pc` on 8.5 in paper |

- Maximum height: IEEE gives the largest graphic as 7.16 × 8.8 in [ext]. Leave room
  for the caption. **[house]** Keep single-column figures at or below 2.6 in tall and
  double-column figures at or below 3.2 in tall. Taller figures push text off the page
  in 8–12 page conference papers.
- IEEE advises not to size figures narrower than one column [ext]. **[house]** If a
  figure is narrow, add whitespace to the canvas instead of shrinking it.
- **[house] Study canvas.** A study figure (`format: study`) is not a print
  figure. Its canvas is the content size, so it may be any width or height, and
  nothing is collapsed to fit. Text, stroke and symbol rules still apply as drawn
  (same skin); only the column/height limits and print legibility thresholds are
  lifted. Study figures are for reading the RTL, never for a paper: deliver the
  paper figure in paper format.

### 0.2 Fonts

| Use | Family | Size (at print) | Tag |
|-----|--------|-----------------|-----|
| Block names, port/signal labels, state names | Sans serif: Helvetica → Arial → TeX Gyre Heros → Liberation Sans → Nimbus Sans | **8 pt** | [ext] IEEE lists Helvetica/Arial/Times; IEEE says type should look about 9–10 pt at full size. Elsevier: 7 pt normal. [house] 8 pt default |
| Secondary annotations: bit widths `/32`, slices `[31:26]`, encodings `2'b01`, mux input indices | same sans | **6.5–7 pt** | [ext] Elsevier minimum 6 pt for sub/superscripts; Science minimum 6 pt |
| Literal RTL identifiers when the paper quotes code (`io_deq_valid`) | Mono: Inconsolata → DejaVu Sans Mono → Courier | 7 pt | [house] |
| Math variables (`x_i`, `σ(x)`, `Λ(x)`) | Serif italic (Times / TeX Gyre Termes / CM via text-to-path) | 8 pt | [house] match the paper body math |
| Subfigure callouts (a), (b) | Times, 8 pt | 8 pt | [ext] IEEE graphics guide: callouts in Times Roman, consistent 8-point size |

Rules:
- **MUST NOT** use text smaller than **6 pt** at print size [ext: Elsevier, Science].
  *Why:* it breaks up in print and cannot be read in a printed proceedings copy.
- **SHOULD** use at most **two** sizes in one figure (8 pt + 7 pt), and at most one
  bold weight (for block titles only) [ext: IEEE "avoid mixing point sizes"; Proc. IEEE
  "use bold and italic sparingly"]. *Why:* the figure looks like one designed object,
  and emphasis still means something.
- **MUST** embed fonts in the PDF or convert text to outlines [ext: IEEE]. **[house]**
  Default to outlining text in the PDF export, and keep live text in the SVG.
  *Why:* IEEE PDF eXpress and ACM TAPS reject files with unembedded fonts. Outlined
  text looks the same on every machine.
- **[house]** Use the same case style everywhere. Block titles in Title Case
  ("Key-Equation Solver"). Signal names exactly as in RTL. Never write text in ALL CAPS
  except established acronyms (FIFO, SRAM, ALU).

### 0.3 Line weights

| Element | Stroke (pt, at print) | Tag |
|---------|-----------------------|-----|
| Absolute minimum anywhere | 0.5 | [ext] SWST: lines under 0.5 pt drop out; Cell Press range 0.5–1.5 pt |
| Every net: data of any bit width, control (dashed 3–2.25), clock, reset (dotted 1.2–1.8) | 0.9 (skin `stroke.wire` = `stroke.control`) | [house] |
| Block and symbol outline (logic block, register, memory, gates, mux) | 1.0 | [house] |
| Emphasis outline (the "new" block the paper proposes) | 1.4 | [house] |
| Group / domain / chip boundary | 0.6, dashed 3–2 | [house] |
| Pipeline register bar | 1.0 outline + gray fill (bar proportions unchanged) | [house] |
| Arrowheads | filled triangle, 5.0 pt long, 3.6 pt wide, one size per figure | [house] |
| Junction dots | diameter 3× the wire stroke, at least 2.4 pt | [house] |

All of these are skin tokens (`stroke`, `dash`, `arrow`, `junction_diam_factor`,
`junction_min_diam`); renderers never hard-code a weight. Wires at 0.6 pt read as
hairlines beside 0.8 pt outlines at print size, so nets are 0.9 pt and outlines
1.0 pt: blocks still read before wires, and dashes, arrowheads and dots scale
with the wire.

- **Why every net has one weight:** at print size a heavier bus beside thin wires
  reads as emphasis, crowds dense datapaths, and makes junction dots and arrowheads
  look mismatched. The bit width is already stated by the slash-N label (§2.1), so a
  second, heavier channel for it adds clutter, not information. Uniform weight reads
  cleaner; control stays distinguishable by its dash (§1), also in grayscale.
- **[house]** Do not use more than **three** distinct stroke weights in one figure.

### 0.4 Color and grayscale safety

- **[ext] IEEE:** do not rely on color alone. Use color *and* shape (solid vs dashed
  lines, fill patterns). Check that the figure reads correctly in a grayscale printout.
  Avoid red/green pairs [Proc. IEEE].
- **[house]** The figure must be fully readable in pure black and white. Color is a
  *redundant* layer on top.
- **[house] Palette:** Okabe–Ito [ext], used for these meanings:

| Token | Hex | Meaning |
|-------|-----|---------|
| `ink` | `#000000` | datapath nets, outlines, text |
| `ctrl` | `#0072B2` (blue) | control nets, FSM outputs |
| `accent` | `#D55E00` (vermilion) | the paper's contribution / highlighted path |
| `clkA` | `#E69F00` (orange) | clock domain A tint (use at 15 % opacity for fills) |
| `clkB` | `#56B4E9` (sky blue) | clock domain B tint |
| `ok` | `#009E73` (bluish green) | handshake-fire markers, "valid" |
| `alt` | `#CC79A7` (reddish purple) | a 4th category, used rarely |
| `fill-1` / `fill-2` / `fill-3` | `#F2F2F2` / `#D9D9D9` / `#BFBFBF` | block fills by role (logic / storage / off-chip) |

- **[house]** Use at most **3 non-gray hues** in one figure. Fills MUST be light
  (luminance ≥ 80 %) so 8 pt black text on them keeps high contrast.
- **[house]** Do not use gradients, drop shadows, or 3-D bevels. *Why:* they print
  muddy, turn into noise in grayscale, and look dated in JSSC/ISSCC-style figures.

### 0.5 Flow direction

- **[house] Data flows left → right. Control comes in from the top. Clock and reset
  come in from the bottom.**
  *Why:* this matches how people read and the textbook datapath figures (inputs at
  left, results at right). It also lets the layered layout (ELK `direction=RIGHT`) put
  control ports on the NORTH side and clock/reset ports on the SOUTH side, so they
  never cross data.
- Feedback paths (next-PC, iteration loops, accumulator feedback) SHOULD run
  **under** the forward path and come back into the left side of the target.
  Feedback arrows MUST have an arrowhead at the sink.
- Memory-hierarchy / SoC figures MAY flow top → bottom (host at top, off-chip memory
  at bottom). Keep one direction per figure.

```
        ctrl (top, blue)
          │
  in ──▶[ block ]──▶ out        data: left → right
          ▲
        clk/rst (bottom)
  feedback: ◀──────────────┘ (routed below)
```

### 0.6 Labeling

- **[house]** Put the label **inside** the block when it fits at 8 pt. Otherwise put
  it directly above the block. Do not use leader lines unless the block is too small
  (for example a 2-flop synchronizer).
- **[house] Generated text is readable too.** Stage notes, connector tags and
  draft names are written in words derived from labels or RTL signals, never
  as ids (`o_u_client_start_ready_o`, `n_u_owner_c_outstanding`). A block
  prints at most two note lines: output latencies grouped by latency when
  short, else their range; the full list belongs in the receipt or, in a study
  figure, in a table below the drawing. Repeated names are qualified by whose
  they are ("Owner controller"), not numbered ("Controller 3"). *Why:* a
  number or an id tells the reader nothing about which block it is.
- **[house] No pin names inside boxes by default.** A block shows its function
  name; the nets outside say what flows. Print pin names only where the reader
  cannot tell the pins apart otherwise (`pin_labels: true` on that element):
  at most 4 per block, readable words, never clock or reset
  (`label/pin-clutter`; error under `--quality paper`). *Why:* rows of
  `din`/`dout`/`en` inside every box crowd the figure and repeat the wiring.
- **[house]** Put net labels next to the wire, near the **source**. Repeat a label at
  the sink only if the wire is longer than about 1/3 of the figure width, or crosses a
  group boundary.
- **[house]** Every abbreviation in the figure MUST be defined in the caption or
  body text [ext: Proc. IEEE "include definitions of all symbols, abbreviations, or
  color codes"].
- **[house]** If the figure uses more than one net style or fill meaning, add a
  **legend** in a corner (usually bottom-right) at 7 pt. Leave it out when there is
  only one style.

### 0.7 Captions and figure numbering

- **[ext] IEEE:** the figure file contains only the image, **not the caption**. Mark
  multi-part figures with (a), (b), (c) callouts inside the figure.
- **[house]** The renderer never draws a title or "Fig. N". The caption goes in LaTeX
  (`\caption{}`). IEEE style prints "Fig. 1."; ACM style prints "Figure 1:". The
  class file handles this.
- **[house]** A good caption says **what** is shown and **what to notice**, and
  defines the color and line meanings. Example: *"Pipelined BCH syndrome datapath.
  Blue lines are control; shaded bars are pipeline registers; the dashed box marks
  the retimed region."*

---

## 1. Nets: datapath vs control vs clock/reset

| Net class | Stroke | Color | Dash | Arrowhead | Tag |
|-----------|--------|-------|------|-----------|-----|
| Data, any bit width (buses, computed flags, status outputs, compare / zero-detect / match results, classifier outputs) | 0.9 pt; the width is shown only by the slash-N label (§2.1) | `ink` | solid | at sink | [house] |
| Control (mux select, register/memory enable, write/chip enable, valid/ready handshake, controller strobes such as start/clear) | 0.9 pt | `ctrl` | solid (color mode) / dashed 3–2.25 (grayscale mode) | at sink | [house] |
| Clock (when drawn) | 0.9 pt | `ink` | solid | at sink | [house] |
| Reset (when drawn) | 0.9 pt | `ink` | dotted 1.2–1.8 | at sink | [house] |

**One stroke weight [house].** Every net is drawn at the one wire stroke
(skin `stroke.wire`, 0.9 pt): a 48-bit bus and a 1-bit flag look the same, and
the bus says its width with a slash-N label. Control keeps that weight and is
dashed; clock and reset follow the rows above; symbol outlines (1.0 pt) and the
solid mux bar are unchanged. The final SVG is checked: any net path or symbol
wire stub at another weight, or a skin whose `stroke.bus`/`stroke.control`
differs from `stroke.wire`, is `net/stroke-uniform` (error). *Why:* uniform
weight reads cleaner at print size; the width is in the label.

**One arrowhead size [house].** Every arrowhead in a figure has the skin's
`arrow.length` × `arrow.width`, and none is shortened to fit a short last run.
The layout keeps each run into a pin at least one arrowhead long (plus
`route.arrow_min_shaft_pt`), moving the riser back when that does not make the
wire hug a block or another wire. A run that still cannot hold a full head is
`arrow/no-room` (error), and any head of another size in the final SVG is
`arrow/nonuniform` (error). *Why:* a short head beside a full one reads as a
different kind of connection.

**Arrowheads [house].** Every net that ends at a block input pin or a figure
output port gets an arrowhead, whatever its width or class. One exception: the
inputs of gate symbols inside a gate-level region, where the gate shape already
shows direction. A bus entering a split does not end there; it continues as the
ripper spine and has no head. A skin that leaves a net kind out of `arrow.at`
fails `arrow/missing` (error). *Why:* when some thin wires have heads and
others don't, readers take the difference to mean something.
| Configuration / quasi-static (CSR fields) | 0.9 pt | gray `#777` | dashed 1.5–2.25 | at sink | [house] |

Rules:

0. **The class comes from usage, not from names or width.** A net is
   **control** only if **every sink** uses it as a select, an enable (register or
   memory enable, write/chip enable) or a handshake (valid/ready) input. Clock and
   reset keep their own styles. If **any sink consumes the net as a value**, it is
   **data** and drawn solid. That includes a 1-bit result: "error detected", a
   comparator or zero-detect output, a position-match vector, a classifier output.
   - **Mixed use**: when one signal feeds both a value input and a select, the
     **whole net is drawn solid**. The select pin itself marks the branch; the
     style is not switched after the junction.
   - A generic block whose output drives only select/enable pins (e.g. a
     correction-enable block) produces a control net; its inputs are data when
     they are values.
   - The renderer derives the class from the sinks' roles (`role` on port
     definitions, top-level ports and pipeline lanes; mux select, register and
     memory enables are built in). An authored `class` that contradicts the usage
     is an error (`net/class-style`) unless it carries a `class_reason`.
   - *Why:* dashed means "this steers something". Drawing a computed flag dashed
     tells the reader it is a control input when it is a result they should
     follow as data.

1. **Control MUST differ from data in at least two of: color, weight, dash.**
   [ext rationale: IEEE color + shape redundancy]. By default the renderer uses color
   plus weight. When `grayscale: true` it also switches control to dashed. The same
   blue-for-control choice appears in Harris & Harris datapaths (see
   `figures.yaml`, verification status noted there).
2. **Clock nets SHOULD be omitted** in datapath and pipeline figures. A clock wedge on
   each register already says "this is clocked". Draw clock nets only in CDC figures
   (§7), clock-gating figures, or when one register uses a different clock.
   *Why:* fanning a clock out to 20 registers adds 20 wires and tells the reader
   nothing.
3. **Reset nets SHOULD be omitted.** Say "all registers reset to 0" in the caption.
   Draw reset only when it matters to the idea, for example a reset synchronizer.
4. Where a wire splits, draw a **junction dot** (diameter 3× stroke, at least 2.4 pt). Where two
   wires cross without connecting, draw **no dot and no hop**. *Why:* a dot means
   "connected", as in IEEE-style schematics and Harris & Harris. Hops (bridges) look
   out of date and add clutter.
5. Never allow a **4-way junction** (two wires meeting at one dot from all four
   directions). Offset the tees by at least 4 pt. *Why:* after reduction, a 4-way dot
   looks the same as a crossing.
6. Route orthogonally (horizontal and vertical segments only). Aim for 6 pt
   between parallel wires, and at most 2 bends per net where possible. A wire
   running parallel to a block outline or to another net's wire **closer than
   4 pt** is an error (`route/edge-hugging`): it reads as part of the outline or
   as one wire, and its crossings become ambiguous. Every wire gets its own
   channel. Diagonal
   wires are allowed only in FSM arcs, in abstract dataflow figures (§11), and as
   the 4–6 pt 45° ripper stubs that mark a bus split (§2.3.1).

```
data bus  ━━━━━━━━━━━▶        control  ───────────▶ (blue, thin)
junction  ━━━━●━━━━━▶           crossing  ━━━━┿━━━━  (no dot = not connected)
              ┃
              ┗━━━━▶
```

### 1.4 Straight data trunks [house]

- **Data wires are straight by default**, usually horizontal west→east. A data
  net's trunk from its source to its sink has **no bends** unless one is
  unavoidable. Only these count:
  - a fan-out branch to a block at least one pin pitch away in another row;
  - a single turn into a pin on a block's top or bottom edge (a side input, or a tap);
  - a feedback path;
  - gate-symbol pin pitch;
  - a straight path that no vertical re-ordering or pin re-assignment can clear.
- **Re-order and re-assign before accepting a bend.** A full-row level change
  counts as a bend to remove, not as "cross-row". Try these first:
  - **Vertical re-ordering:** move either end block into line, with the ports
    on its far side.
  - **Pin re-assignment:** when a trunk feeds a block and also continues past
    it (e.g. a codeword feeding one computation stage and travelling on to the
    next pipeline register), the block's input becomes a tap on its bottom
    edge. The trunk then runs straight underneath on its own lane, and the
    neighbouring pipeline registers put that lane below the block's lanes,
    far enough down to clear the block.

  The renderer lays the figure out with and without taps and keeps the better
  straightened route. Each remaining bend is reported with its justification
  (`route/data-bend`, receipt `route.data_bends`). If a bend has none, meaning
  a tried move would have removed it, the result is `route/data-jog` (error).
- A **level change smaller than one pin pitch (12 pt)** on a data trunk is a
  redundant jog and is not allowed (renderer error `route/data-jog`). The same holds
  for control wires: a dashed select, enable or handshake wire with a small step
  between two runs in one direction is straightened like a data wire, and a remaining
  one is `route/control-jog` (error). Typical
  causes are lanes that step up or down right after a pipeline bar, or a block
  whose pins sit off the neighbour's lane grid. The layout fixes them: all
  multi-pin symbols put their pins on one grid (pitch/2 + k·pitch), pipeline
  bars pass lanes through at identical y, and a post-layout pass straightens
  what remains. A detour, when needed, steps at least one full pitch.
- Bends are free for **control, clock and reset** nets.
- Keep wire **crossings** low. The renderer counts them per class (data,
  control, mixed) and warns above a threshold (`route/crossings`).
- *Why:* the reader's eye follows the data path. A jog implies structure (a
  different row, a new stage) that isn't there, and every crossing is a
  decision the reader has to make.

### 1.5 Connected geometry [house]

Drawn geometry is exactly connected. A visible gap reads as "not connected",
and a wire that touches another reads as a junction.

- **Every wire end coincides with its pin anchor within 0.1 pt.** On a gate
  the anchor comes from the actual outline:
  - an input on the flat back of AND/NAND at that pin's y;
  - an input on the curved back of OR/XOR (for XOR, the extra back line), at
    the curve's x for that pin's y;
  - an output at the apex: the arc apex of AND, the shield tip of OR/XOR, the
    NOT triangle tip;
  - an inverted pin at the bubble's outer tangent point (§4.1).

  Anchors on blocks, bars and registers lie on the outline.
- **Arrowheads:** the tip touches the pin, and the shaft ends exactly at the
  arrowhead's base.
- **Polylines** have no gaps between consecutive segments and are drawn with
  miter or round joins, never with butt caps that leave notches at bends.
- **T-junctions:** a branch leaves exactly on the trunk, with a junction dot
  centered on the branch point. Every dot lies on the trunk.
- **Junction dots keep clear of arrowheads and pins:** a dot's center is at least
  8 pt (skin `route.dot_arrow_clearance`) from the base of every arrowhead of its
  net, on the same or a branching segment, and from every pin anchor of the net.
  The renderer moves the branch point along the trunk (upstream, or downstream
  away from a driver pin) to make room; `route/dot-near-arrow` (error) is checked
  on the final SVG. *Why:* a dot pressed against an arrowhead looks cramped and
  reads as one blob at print size.
- **Pipeline-register bars:** a lane is continuous on both sides of the bar at
  identical y and touches the bar outline.
- **Crossings without a dot never touch:** no bend, end or short run of one
  net lies on another net's wire.
- Checked on the final SVG, after straightening and bubble placement:
  `wire/detached` (error; reports the net, the point and the gap) and
  `wire/touching` (error). The renderer collapses sub-2 pt zig-zags and slides
  a run that touches a foreign wire into a free channel before the check; an
  arrowhead's base counts as a vertex of its wire.
- **Different nets never share or crowd a run.** Parallel runs keep
  `route.min_parallel_gap_pt` (4 pt); closer than `route.collinear_gap_pt`
  (1.5 pt) over more than 0.5 pt is `wire/collinear-overlap` (error, every
  format, microarch links too). *Why:* two wires a stroke apart read as one.

### 1.6 Long returns, frames and edges [house]

- **Long feedback uses named off-page connectors.** A return net whose loop
  would span more than half the content width (skin `route.long_feedback_ratio`)
  or run around frames is cut into a pair of pentagon tags: a source tag after
  the driver and a target tag before each sink. Both carry the net's name (its
  `short_label` in tight variants), and connectivity treats the pair as one net.
  All source tags share one column. Length is the **routed** length, not the
  horizontal span: a back edge whose route is longer than the ratio × width,
  or any branch whose route exceeds its direct distance by that much (a wrap
  around the figure), gets connectors. `route/long-feedback` and
  `route/long-loop` fire for such a loop that is still drawn
  (`meta.style.connectors: false`).
- **A net label anchors to its own wire.** It is placed where its own wire is
  closer than any other net's wire; otherwise the reader may attach it to the
  neighbour (`label/ambiguous-anchor`, error). One name per net: two nets with
  the same label, or a net label that repeats its endpoint's port label, is
  `label/duplicate-net-label`; a tie-off constant (`1'b0`, `'0`) is never a
  port label (`label/constant-as-port-label`). Both are errors under
  `--quality paper`.
- **Nets enter a region frame from the side facing their source**, at least
  two frame gaps from a corner and never through the frame's label band
  (`region/entry-side`, error). *Why:* a wire that loops round to enter from
  the far side reads as a path from somewhere else.
- **Wires keep clear of region frames.** No wire runs parallel to a frame edge
  within 6 pt (9 pt for a dashed wire beside the dashed frame); crossing a frame
  is fine. A frame edge never grows over a non-member block to clear a wire
  (`region/wire-hugs-frame`). Route control such as `valid` straight through the
  pipeline bars, not along the frame.
- **Figure outputs** driven from the last stage sit on the right edge in one
  column; an output from an earlier stage stays beside its driver.
- **No step just before a pin.** A small level change in the last 10 pt before a
  gate input, a figure port or a connector moves back to the branch's junction
  or the start of its run.
- **A net that ends at a connector tag** prints no separate net label; the tag
  names it.
- **One name per connector [house].** Two tag pairs never share a name: when
  two nets read the same ("start ready" of three clients), each tag names its
  source ("Nonce client: start ready"). *Why:* a reader pairs tags by name; a
  repeated name pairs the wrong ends.
- **No tag right before a figure output [house].** A net into an output port is
  drawn as a wire; a tag followed by a port would print two names for one
  signal, and a port standing alone as a far tag looks unconnected.
- **Every tag has a wire [house].** A connector pair is one source tag and one
  target tag, both wired; a pair whose tags would sit side by side is a wire.
  Single words ("state", "busy") are qualified with their instance.
- **Connector or wire is decided by block separation [house].** A returning
  net becomes a connector pair only between blocks at least
  `route.connector_min_layers` (2) drawn layers apart; nearer blocks keep the
  wire, routed above or below them. Tag positions never decide.
- **Parallel nets are named [house].** Two or more nets between the same two
  blocks each carry a name (`label/unlabeled-parallel-nets`); the renderer
  names them from their RTL signals and makes room beside the source pin. A
  net name sits at most 12 pt from its wire and nearer to it than to any block
  outline it faces (`label/ambiguous-anchor`).
- **Unused ports and constants [house].** A port nothing reads or drives sits
  at the figure edge with a short stub and an "unused" mark. A constant is a
  small outlined value box at its pin, printing a readable value (0, 1, all
  ones, 0x1F), never Verilog literal syntax.

---

## 2. Bit width, bit slices, split/merge

### 2.1 Slash-N width notation

- **[house]** Mark a bus width with a short 45° slash across the bus (length 6 pt,
  0.6 pt stroke). Put the number **above** a horizontal bus or **to the right** of a
  vertical bus, at 7 pt.
- Label every bus width **once**, near its source. Label it again after any operation
  that changes the width (extension, truncation, concatenation, split).
- Do not label 1-bit wires (1-bit is the default). **A multi-bit data net shows
  its width wherever that width is introduced or changed**: at a port or
  constant, after a truncation, split, concatenation or extension, and on any
  block output whose width none of the block's inputs carries (renderer error
  `width/missing` when no label fits). A width that is only carried through (a
  pipeline-register lane, a register, a mux, a same-width block) is labeled when
  there is room and may be left to the label upstream. A lane's width is labeled
  once: when one side of a pipeline lane shows it, the other side with the same
  width is not missing it.
- **Heterogeneous bundles are named, never summed.** A bundle of different
  signals (`bundle_of`, or a pin `bundle`) carries a protocol or function name
  ("AHB-Lite", "mem ctrl") and no width slash (`width/bundle-sum`).
- **A slash never covers a label**, and a width number keeps 1 pt from outlines
  other than its own slash (bar edges included).
- **A width label is a single integer or a symbolic expression** (`48`, `/W`,
  `/log₂N`, `/m`), **never a product** such as `6×8` or `6 × 8-bit` (renderer and
  lint error `width/product-notation`). Structure such as "N symbols of W bits" goes
  in the caption or a block's `function.detail`, never on a net or a mux.
- Say what symbolic widths mean in the caption.
- **The width lives in the label only.** Buses are drawn at the same stroke weight
  as 1-bit wires (§1), so a multi-bit net without its slash-N label gives the reader
  no way to see its width; that is why `width/missing` is an error.
- *Why:* this notation is common in textbooks and circuit papers. It costs almost no
  space and answers the reader's first question, "how wide is that?".

```
      32               5            W+1
━━━━━━╱━━━━━▶   ━━━━━━━╱━━━━▶   ━━━━━╱━━━━━▶
```

### 2.2 Bit slices

- **[house]** Write slices in **Verilog MSB:LSB order in square brackets**:
  `[31:26]`, `[4:0]`, `[7]`. Put the label next to the branch **just after** the tap
  point. When the parent bus name is not obvious, write `instr[31:26]`.
  *Why:* Verilog order is what hardware readers expect. Harris & Harris writes slices
  as `31:26` (no brackets) on branches off the instruction bus. Brackets make it
  clearer that the label is a slice, not a width.
- Use `[i]` for a single bit, `[N-1:0]` for a full parametric range, and
  `{a, b}` for concatenation (§2.3).

### 2.3 Split, truncation, concatenation, extension, replication

**Why this section changed.** The house mux is a solid filled bar (§3.1). The old
split/merge rule also drew a thin filled bar (the netlistsvg `$_split_`/`$_join_`
look). In earlier fig-gen datapath figures that meant a mux, a `{ }` join and a `[47:16]` split
looked almost the same at 1-column size. Evidence below is from figures opened
and inspected in `figures.yaml`, so the entries carry `verified: true` unless
stated otherwise.

**Evidence: what published figures actually draw**

| Operation | Observed drawing | Where (figures.yaml) |
|-----------|------------------|----------------------|
| Split into several slices | Plain orthogonal branches off the bus, each with its own slash-N width and/or a field name (`C_h`, `C_l`, `x_l`). No symbol body. | F42 Bertels et al. FPL'24 Fig. 2 (redrawn from Ni et al.); F43 RI5CY Fig. 8 (32 → 16/16) |
| Truncation | Only the width label changes (e.g. `24` → `12`). No symbol. | F42, F43 |
| Concatenation | A small outlined box with `{ }` inside, defined in the figure legend as "Concatenation". Inputs 6 and 12 bits, output 18. | F41 Bertels et al. FPL'24 Fig. 3 (redrawn from Nguyen et al.) |
| Concatenation (implicit) | Not drawn. The text says outputs "are concatenated together to the bus". | F36 McEliece Fig. 6 (text p. 13) |
| Grouping parallel signals | Set-brace labels `{S1,…,S3}` with a vertical ellipsis. No merge symbol. | F37 BCH Fig. 2 |
| Sign/zero extension | A labeled block: `align/extend` (load sign/zero extension), `decoder_imm`; a `Dec/Imm` cloud. Or absorbed into operator width: RI5CY's `17x17` and `9x9` multiplier blocks take sign-extended 16b/8b inputs with no extension glyph. | F47 RVCoreP Fig. 1; F46 Wildcat Fig. 1; F43. Textbook "Sign Extend" blocks (Harris & Harris, Patterson & Hennessy) are unverified |
| Fields of one word | A strip of labeled cells with bit indices above, field names like `imm[31:3]`. | F48 Hwacha Figure 7 |
| Bus rippers (45° entries) | **Not seen in any paper figure examined.** This is an EDA schematic convention: Altium bus entries are diagonal and bus labels use `Name[7..0]`. | Tool docs (§Sources) |
| Replication `{N{x}}` | **Not seen in any figure examined.** | — |
| Split/merge drawn as bars | netlistsvg default skin: split/join are 5-unit filled rectangles with `hi:lo` labels (tool). Spatz Fig. 2: unlabeled flat bars fan three 32-bit buses out to four datapaths and merge them back; the silhouette is identical to a trapezoid/bar mux. | Tool; F44 Spatz ICCAD'22 Fig. 2 (cautionary) |

**Takeaway.** Papers never use a filled bar to mean split or concatenation, except
tool output and one ambiguous example. Splits and truncation have no symbol body.
Concatenation, when drawn, is an **outlined labeled box**. Extension is a **labeled
block**. So the encoding below keeps "solid bar" for the mux alone.

#### 2.3.1 Split: ripper taps [house]

- Draw the source bus as one continuous spine (the wire stroke, like every net). Each
  extracted slice leaves through a **45° ripper stub** (4–6 pt long, same stroke) and then
  continues orthogonally. Put the **`[msb:lsb]` label on the stub side**, at 7 pt.
  The spine may continue past the last tap or end in the last stub.
- **No junction dot at a tap. No symbol body.** Taps are spaced by at least the pin
  pitch (12 pt).
- Each child gets its own width slash only if its width isn't obvious from the slice
  (`[31:26]` is 6 bits, so no slash is needed).
- Slices are listed **MSB first**, in order along the flow. Overlapping slices
  (the same bit in two taps) are allowed; label them exactly.
- *Why:* evidence shows splits have no body (F42, F43). A plain tee, however,
  is identical to **fanout** (a junction dot means *all* bits go to both sinks, §1
  rule 4). The 45° stub is the one mark that says "a subset of the bits". It borrows
  the EDA bus-entry convention and adds no filled shape to confuse with a mux.

#### 2.3.2 Truncation: label only [house]

- Keeping one contiguous range of a bus is **not a symbol**. Write `[msb:lsb]` on the
  straight wire, 3–6 pt downstream of the source pin or of the point where the range
  is taken. Then put the new width slash after it: `━━[47:16]━━╱32━━▶`.
- If more than one range is taken from the same bus, it is a split (§2.3.1), not
  several truncations.
- *Why:* this matches the published figures (F42, F43), which only change the
  width label. A label that starts with `[` is never a net name in this guide
  (§3.5 rule D3), so it reads as a slice even in grayscale.

#### 2.3.3 Concatenation: outlined `concat` box [house]

- Draw a **hollow outlined box**: outline 0.8 pt, fill `fill-logic` (white/`fill-1`),
  at least 14 pt wide, height = inputs × pin pitch. Put the word `concat` centered
  inside at 7 pt.
- Inputs enter on the **left**, **MSB field at the top**: the order is the
  convention, so the box prints **the word `concat` only**. No destination bit
  ranges appear inside or beside the box; each input keeps its width slash on its
  wire. The word has its own row between the fields, and the output leaves on the
  right from that row with the summed width slash. The same holds for `repl ×N`,
  `sext` and `zext`: the word only.
- A constant field (`4'b0000`) is an input with a constant source label, not a
  separate glyph. The whole pattern `{K'b0, x}` is zero extension (§2.3.4).
- *Considered and rejected:* a **ripper merge** (45° entries converging into a bus).
  1. It was not seen in any paper figure.
  2. It is the mirror image of a split: at 1-column size in grayscale, only
     arrowhead direction separates the two, which is exactly the confusion being
     fixed.
  3. Entries arriving from different directions can't all be 45° into one spine
     without extra bends.

  An outlined box is the one concatenation glyph found in a published legend (F41,
  which wrote `{ }` inside). fig-gen writes the word `concat` instead: at 7 pt the
  braces are two thin marks that read as stray brackets, while a word is legible
  and names the operation. The box shares no visual channel with the mux bar
  (hollow vs solid, text vs none, no select pin).

#### 2.3.4 Extension: labeled `sext` / `zext` box [house]

- Draw an outlined box, same family as the concat box (0.8 pt outline, white fill),
  containing `sext` or `zext` at 7 pt. It has exactly **one input and one output**,
  with width slashes on both sides (`╱12` → `╱32`).
- The renderer MUST turn the RTL patterns `{{K{x[msb]}}, x}` into `sext` and
  `{K'b0, x}` into `zext`. Don't draw these as a replication box feeding a concat
  box.
- Shift-and-extend helpers keep their own names (`align/extend`, `<<2`). A pure
  constant shift is a wire label (`<<3`, as in F42) or a small `<<k` box. It is
  never drawn as a concatenation with zeros.
- *Why:* extension appears as a named block in the verified processor figures (F46,
  F47) and in the textbook anchors. The label says whether bits are sign or zero;
  a shape can't.

#### 2.3.5 Replication: `repl ×N` box [house]

- Draw the same outlined box with `repl ×N` inside (e.g. `repl ×4`), one input, output
  width = N × input width. Use it only for replication that is **not** sign
  extension (for example broadcasting a 1-bit enable to a W-bit mask).
- *Why:* no published convention was found. Reusing the concat box family with a
  short word is the smallest new glyph, and its text sets it apart from `concat`,
  `sext` and `zext`. Verilog `{N{ }}` braces are not used: at 7 pt they are hard to
  read and look like a label fragment.

```
SPLIT (ripper taps, no dots, no body)       TRUNCATION (label only)
instr ━━╱32━━━┳━━━━━━━┳━━━━━━━━━━━┓           prod ━━╱48━━[47:16]━━╱32━━▶ hi
              ╲       ╲           ┃
        [31:26]╲       ╲[25:21]    ┃[15:0]    (the ┳ above is a 45° stub
               ┗━━▶ op  ┗━━▶ rs    ┗━━▶ imm    leaving the spine, not a tee+dot)

CONCAT (outlined concat box, MSB on top)    EXTENSION / REPLICATION
                ┌───────┐                   imm ──╱12──┤ sext ├──╱32──▶
  a ──╱8───────▶│[15:8] │                   d   ──╱8───┤ zext ├──╱16──▶
                │concat ├──╱16──▶ {a,b}     en  ───────┤repl ×4├──╱4──▶ mask
  b ──╱8───────▶│[7:0]  │
                └───────┘                   (one stroke weight for every net)
```

---

## 3. Multiplexers

### 3.1 Shape

- **[house] Default: a bold filled vertical bar.** Draw a mux as one narrow solid
  black rectangle (about 5 pt wide at print size), height = number of inputs × pin
  pitch (12 pt). Data inputs attach to the left edge in fixed order (input 0 at
  the top), the output leaves the right edge at the vertical middle, and the select
  enters the top edge in control style (with a width slash if it is more than
  1 bit). The bar has no outline and no text.
  *Why:* this is the compact netlistsvg-style schematic look chosen for this
  project. It keeps dense datapaths narrow and reads clearly in grayscale.
- **Disambiguation (required):** a **solid filled bar means mux and nothing else**
  (§3.5). Pipeline-register bars are gray, outlined, carry a clock wedge and span
  every net at a stage boundary (§5.3). Splits have **no body** (45° ripper taps with
  `[msb:lsb]` labels). Truncation is a label on the wire. Concatenation, extension
  and replication are **hollow outlined boxes** with the words `concat`, `sext`/`zext`
  or `repl ×N` inside (§2.3). There are no join/split bars. A mux bar always shows its select pin.
- **[house] Alternative (textbook):** an **isosceles trapezoid**, long side facing
  the inputs, short side facing the output, slope ratio short:long about 0.5, as in
  Patterson & Hennessy / Harris & Harris. Select it per theme or per figure with
  `mux_style: "trapezoid"`. Any index labels drawn inside it stay inset at least
  1 pt from the slanted edges.
- Label the mux `MUX` inside only if the figure also has ALU/adder trapezoids that
  could be mistaken for it. Otherwise leave it unlabeled. Put an instance name, if
  any, above.
- A 2:1 mux on a single-bit control path MAY be drawn as a small rectangle
  `sel ? a : b` when space is tight.
- **Bit-sliced replicas** (one 2:1 mux per symbol of a multi-symbol bus) are
  drawn as one bar mux with no caption. Its buses carry their total width and
  its select carries its total width, each as a single number (§2.1). Say
  that it repeats per symbol in the figure caption or a block's
  `function.detail`, never on a net or on the mux.

### 3.2 Select pin side

- **[house]** The select pin enters the **top edge** of the bar (or the slanted top
  side of the trapezoid alternative) when control comes from a controller above
  (default, matches §0.5), or the bottom edge when the select comes from below. Never
  put select on an input or output side. A mux MUST always show its select pin and
  net.
- Draw the select net in control style (§1). Label its width if it is more than 1 bit
  (`/2` for 4:1).
- If a mux tree shares one select signal, draw the select once and branch it with
  junction dots. Do not label each copy.

### 3.3 Input order and index labels

- **[house] Fixed ordering:** inputs are drawn in the order of the spec's input list,
  input 0 at the **top**, always. The order and the select encoding are part of the IR
  and are cross-checked against the RTL even when nothing is printed.
- **[house] Default: no index labels.** The bar mux shows only the bar, the input
  wires, the output wire and the select pin.
  *Why:* in most paper datapaths the input order is clear from the wire labels, and
  digits next to every input clutter a compact figure.
- **Opt-in** (`mux_indices: true` per figure, per theme, or `indices: true` per mux):
  when the reader needs to know which input a select value picks, draw the select
  value just **outside** the bar, above the incoming wire between its end and the bar
  (bar style), or inside the trapezoid inset from the slope (trapezoid style), at
  7 pt: `0`, `1`, `2`, `3`, … For one-hot selects, label inputs by case name
  (`PC+4`, `branch`) instead. Labels MUST NOT overlap wires or width slashes.

```
            sel (ctrl, from top)            with mux_indices: true
               │ /2                                 │ /2
  a ━━━━━━━━━━┫█                          a ━━━━0━━┫█
  b ━━━━━━━━━━┫█━━━━━▶ y                  b ━━━━1━━┫█━━━━━▶ y
  c ━━━━━━━━━━┫█                          c ━━━━2━━┫█
  d ━━━━━━━━━━┫█                          d ━━━━3━━┫█
```

### 3.4 Demux, and one-hot / priority selectors

- A demux is the mirror of a mux (long side at the output). Index labels go on the
  outputs.
- A priority encoder or AND-OR one-hot selector SHOULD be drawn as a **rectangle**
  labeled `PriEnc` / `1-hot sel`, not a trapezoid. *Why:* the trapezoid means binary
  select. Changing the shape shows the select meaning is different.

### 3.5 Distinguishability of bar-like and width-changing glyphs [house]

Every glyph that is a narrow bar, or that changes a bus width, is listed here.
Each pair MUST differ in **at least two independent visual channels** that survive
grayscale printing at 1-column size:
- **body/fill:** solid ink, gray + outline, white + outline, or none
- **mandatory attachment:** select pin, clock wedge, or none
- **text on the glyph:** none, brackets, or a word (on bus-operation boxes the word
  is the identifying feature)
- **arity:** inputs → outputs
- **extent:** own pins only, or spans every net at a boundary

| Glyph | Body / fill | Size at print | Mandatory attachment | Text on glyph | Arity | Extent |
|-------|-------------|---------------|----------------------|---------------|-------|--------|
| **Mux bar** (§3.1) | solid `ink`, no outline | 5 pt × (inputs × 12 pt) | **select pin** on N or S edge, control style, ≥ 4 pt visible | none (opt-in select indices: bare digits, outside the bar) | ≥ 2 → 1 | own pins |
| **Pipeline-register bar** (§5.3) | `fill-3` gray + 0.8 pt outline | 7 pt × full datapath height | **clock wedge** at bottom; stage label above | `IF/ID`-style label above, none inside | n → n (pass-through) | **every net crossing the stage boundary** |
| Single register (§5.1) | `fill-2` + outline | 14 × 24 pt (`register.width_pt`) | clock wedge | none (no name printed) | 1 → 1 | own pins |
| **Split** (§2.3.1) | **none** (45° stubs off a bus spine) | stub 4–6 pt | none, and **no junction dot** | `[msb:lsb]` per stub | 1 → k | own bus |
| **Truncation** (§2.3.2) | none | — | none | one `[msb:lsb]` on the wire | 1 → 1 | own wire |
| **Concatenation** (§2.3.3) | white + 0.8 pt outline | fits the word, ≥ 14 pt wide | none | **the word `concat`** inside on its own row; `[msb:lsb]` destination range inside at each input | k → 1 | own pins |
| **Extension** (§2.3.4) | white + 0.8 pt outline | fits text | none | **the word `sext` or `zext`** inside | 1 → 1 | own pins |
| **Replication** (§2.3.5) | white + 0.8 pt outline | fits text | none | **the words `repl ×N`** inside | 1 → 1 | own pins |
| Fanout (§1 rule 4) | junction dot | 2.5 × stroke | — | none | 1 → k (all bits) | — |

Rules:

- **D1. A solid filled bar is always a mux.** The renderer's lint MUST reject any
  solid-filled rectangle narrower than 8 pt that lacks a select pin or has fewer
  than two data inputs. It MUST NOT emit netlistsvg-style `$_split_`/`$_join_` bars.
  *Why:* this single rule guarantees no bar-shaped glyph is misread as a mux, and no
  mux is misread as a bus operation. The Spatz MACU figure (F44) shows how
  unlabeled bars leave the reader guessing.
- **D2. Mux bar vs pipeline bar:** they differ in fill (solid vs gray + outline),
  attachment (select pin vs clock wedge) and extent (own pins vs whole boundary).
  A pipeline bar never has a select pin, and a mux bar never has a wedge.
- **D3. Reserved label syntax.** `[msb:lsb]` appears only on slices (split stubs,
  truncation, concat destination ranges). `{…}` appears only in an optional field
  list next to a concatenation output (`{a, b}`), never on a box. Bare digits next to a mux input are
  select values. Net names MUST NOT begin with `[` or `{`.
  *Why:* when shapes are tiny, the first character of a label is often the
  distinguishing channel.
- **D4. Split vs fanout:** a junction dot means the same bits go to every sink. A
  45° ripper stub means a subset. A dot is never drawn at a ripper tap.
- **D5. Concat vs extension vs replication** share one box family on purpose (all
  are width-changing bus operations). They differ by arity (k → 1 vs 1 → 1) and by
  their mandatory text. **The word on the box is the identifying feature**:
  `concat`, `sext`, `zext`, `repl ×N`. Replication vs extension differ **only** by
  that word, which is allowed because the words are distinct and legible at 7 pt.
  The skin lint (`glyph/distinguishable`) fixes these words; braces are rejected.
- **D6. Minimum legibility at 1 column:** ripper stub ≥ 4 pt; slice labels and box words
  7 pt (never below 6.5 pt); mux bar ≥ 5 pt wide with the select stub visible ≥ 4 pt;
  box outlines 0.8 pt so a white box can't vanish in grayscale.
- **D7. Trapezoid theme:** with `mux_style: trapezoid` the mux loses the solid fill.
  The trapezoid silhouette itself is then the mux's channel, and it still needs its
  select pin. Concat/extension boxes stay rectangular, so they never taper.

```
mux bar         pipeline bar      split (taps)        concat box    sext box
   sel             IF/ID
    │               ┃▒┃           ━━━━┳━━━━┳━━━      ─┥     │       ┥ sext ┝
 ━━┫█                ┃▒┃               ╲    ╲        │concat┝━     (1 → 1)
 ━━┫█━━▶            ┃▒┃             [a:b]  [c:d]   ─┥      │
 ━━┫█               ▷┃▒┃                             (k → 1)
solid+select    gray+wedge+span   no body, brackets  hollow+word   hollow+word
```

---

## 4. Combinational logic

### 4.1 Gates vs logic blocks

- **[house]** Use **distinctive-shape gates** (ANSI/IEEE Std 91 distinctive shapes:
  AND D-shape, OR shield, XOR shield with double back line, inverter triangle + bubble)
  only when the figure makes a point **about individual gates**: a synchronizer, a
  clock-gating cell, a carry-save cell, a GF(2) linear network with fewer than about 8
  gates.
- Otherwise use a **rectangular logic block** with a function label (`Next-state
  logic`, `Syndrome calc`, `Decode`).
  *Why:* at 3.5 in wide, a figure can hold about 15–25 symbols. Showing gates for
  anything bigger spends that budget on detail nobody reads. Paper figures abstract to
  blocks; gate-level figures are the exception.
- **[ext]** IEEE Std 91 also defines rectangular-outline symbols with qualifying
  symbols (`MUX`, `Σ` adder, `P–Q` subtracter, `π` multiplier, `COMP` comparator, `ALU`)
  [TI SDYZ001A]. **[house]** Borrow the *labels* (`Σ`, `COMP`, `ALU`), not full
  dependency notation. Paper readers don't know it well.
- Inversion: a bubble (diameter 4 pt, from the skin; stroke equal to the body
  outline) at the pin. Do not draw a separate inverter unless the inverter
  itself matters.
  - **Output bubble:** a circle tangent to the body at the output apex; its
    left-most point touches the outline exactly (the AND arc, the OR/XOR
    shield tip, the NOT tip). The output wire starts at its right-most point.
  - **Input bubble:** tangent to the input edge at that pin's y (the flat back
    of AND/NAND, or the curved back of OR/XOR using the curve's actual x). The
    input wire ends at its left-most point.
  - The same applies to DFF clock/reset pins and to any symbol with bubbles.
  - Placement is computed from the symbol geometry (tangency between stroke
    centerlines), never from fixed offsets, so it holds for every gate size,
    input count and stroke width. A gap or overlap above 0.25 pt, or a wire
    that does not meet its bubble, is `symbol/bubble-detached` (error).

### 4.1a Mixed abstraction levels in one figure

A figure may combine four levels; each region is drawn in its own style:

- **blackbox** — a plain box with the module or instance name and only its
  ports (port labels inside the edge). Hatch the box lightly (explicit 45°
  lines, `fill-3` gray) when its internals are unknown or come from a stub.
  Its ports and widths must equal the RTL module (or the declared stub).
- **block** and **rtl** — the `netlist-mono` symbols of §3–§6 (bar mux,
  register with wedge, pipeline bars, labeled comb blocks, memories).
- **gate** — IEEE Std 91 distinctive shapes (AND, OR, XOR, NAND, NOR, XNOR,
  NOT/BUF) in the same monochrome stroke family; inversion bubbles on the
  inverted pins (bubbles are folded into NAND/NOR/XNOR where exact).
  Arithmetic and compare operators stay blocks unless bit-blasted on request.
- **Bold bar mux at every level**, including inside gate regions.
- A thin dashed frame (0.5 pt, dash 2–2) with a 7 pt label inside its top
  edge marks an RTL, block or gate region. A frame **encloses exactly its
  members** (including labels that hang off them), never cuts through a
  block that is not a member, and nested frames keep clearance: they never
  share or cross edges. No wire may run along a frame edge. Blackbox regions
  are not framed by default — the hatch already marks them. The layout groups
  framed members together so these rules can hold. Nets crossing between
  regions must agree in width, and bit slices at the boundary are explicit.
- Add a small legend of levels only when more than two levels appear in one
  figure.

### 4.1b Completeness: collapse, never drop [house]

- A figure has a **declared scope**: the top instance and its selected
  hierarchy (`meta.scope.instance`, `hierarchy`), or a cone between named
  signals (`meta.scope.cone`).
- **Everything inside the scope is represented.** That means every RTL
  instance, register (including memories) and live net, and every
  datapath/control transfer between them. Each is either:
  - drawn, or mapped by a net;
  - contained in a collapsed or blackbox element whose RTL mapping covers it
    (`rtl.instance` on an instance, or `rtl.covers` with instances and signal
    globs); or
  - inside the cone of an equivalence-checked gate region.
- A transfer is represented when a wire connects the elements that represent
  its two ends.
- Clock and reset nets are implicit (§1). Dead logic, i.e. nets read by
  nothing live, is excluded and counted in the receipt.
- **The only way to exclude hardware is to narrow the declared scope
  explicitly.** Leaving parts inside the scope out of the drawing is not
  allowed: `coverage/dropped-hardware` (error). The receipt lists coverage per
  region and for the whole scope (covered/total registers, instances, nets,
  transfers).
- **If the result does not fit 2col**, apply these fixes in order:
  1. collapse more into blocks (e.g. a write path into one "AHB-Lite slave /
     write path" block, a test-only injector into an "Error injector" block);
  2. allow a taller figure, up to the profile's maximum height;
  3. otherwise delivery fails (`deliver/does-not-fit`), with the suggestion to
     narrow the scope or to split into sub-figures (a)/(b), where a collapsed
     element links its detail figure (`detail_ref`, checked by
     `detail/ref-unresolved`).

  Never silently drop hardware.
- *Why:* a figure that omits hardware reads as a claim that the hardware is
  not there. Readers cannot tell an abstraction from an omission unless the
  omission is a declared scope.

### 4.1c View presets [house]

One design is shown at several scopes and abstractions through named views.
Each view declares its scope, and the caption says which view it is and what
the scope covers.

- **Overview:** the whole declared scope (e.g. the top IP).
  - Every child instance is a functional block.
  - Pipeline registers on the shown paths stay visible (§5.5).
  - Buses and control are bundles.
  - Completeness is shown by containment.
- **Block:** the scope is one instance, drawn at rtl/block level. The ports
  of that instance are the figure ports.
- **Mixed:** a block or overview scope plus the gate regions and blackboxes
  the author selects, and only those.
- **Detail:** the scope expanded one or more hierarchy levels. Collapse only
  where the 2col figure would otherwise not fit, and say so.
- **Context** from outside the scope, such as a memory feeding the shown
  block, is drawn only as a blackbox. Context on the path between two shown
  parts is drawn too (e.g. an error injector between a memory and a decoder),
  because skipping it would draw a wire that does not exist.

### 4.2 Arithmetic and GF operators

| Operator | Symbol | When | Tag |
|----------|--------|------|-----|
| Integer adder | Circle Ø 12 pt with `+` | inside dense datapaths (DSP, NTT butterflies, accumulators) | [house] |
| Adder / ALU (processor style) | "chevron" trapezoid with notch on the input side, labeled `+` or `ALU` | processor datapaths | [house] (P&H / H&H style) |
| Subtracter | circle with `−`; mark which input is subtracted with a `−` sign at that pin | | [house] |
| Multiplier | circle with `×` | | [house] |
| **GF(2) addition / XOR (ECC, crypto)** | circle with `⊕` | BCH/Reed–Solomon/LDPC, AES, SHA-3, CRC, LFSR figures | [house] follows the math in the paper |
| GF(2^m) multiplier | circle with `⊗` | Reed–Solomon/BCH key-equation solvers, AES MixColumns | [house] |
| Constant multiplier (by α^i, by 2) | circle `⊗` with constant written outside, or a small box `×α^i` | | [house] |
| Comparator | rectangle `=`, `<`, `≥` or `COMP`; output is 1-bit control style | | [house] + [ext label COMP] |
| Shifter | rectangle `<<` / `>>`, with shift amount entering from the top (control) or as data | | [house] |
| Barrel / modular reduction | rectangle `mod q`, `Barrett`, `Montgomery` | lattice crypto | [house] |
| LUT / S-box / small ROM | rectangle with the index on the left, value on the right, label `S-box` or `LUT` and size `256×8` | | [house] |
| Popcount / leading-zero | rectangle `popcnt`, `LZC` | | [house] |

- **[house]** Use `⊕` for XOR whenever the paper's math uses `⊕`. Use the
  distinctive XOR gate only in gate-level figures. *Why:* the figure then reads like
  the equations next to it. Mixing the two in one figure is not allowed.
- Carry-in / carry-out pins SHOULD enter from the top and leave from the bottom, as
  control-weight wires.
- **The glyph is the name.** A circle operator (`⊕`, `⊗`, `+`, `−`, `×`) carries
  no text label. Gate-level regions keep gate shapes without text.

### 4.3 Block naming: say what the block is [house]

- The printed name of a block is its **function**, taken from a controlled
  vocabulary (`schemas/function-vocabulary.json`): *GF multiplier*, *GF adder
  (XOR)*, *GF inverter*, *Adder*, *Comparator*, *Zero detector*, *Syndrome
  calculator*, *Error locator*, *Chien search*, *Error evaluator*,
  *Corrector*, *Error classifier*, *Correction enable*, *Controller*, *CSR
  bank*, *Bus slave*, *Memory*, *Error injector*, … An open `custom` entry
  takes a functional name for anything else. A qualifier refines it:
  *GF(2^8) multiplier*, *AHB-Lite slave*, *Data memory*.
- **Never print** signal mnemonics, internal RTL names or math shorthand as a
  block's primary name: not `cls`, `en`, `H4..2`, `S2/S1`, `X=a^i`, `e_i`,
  `== 0`.
- **Boxes show the name only.** A datapath block prints its name and nothing
  else inside the box: no stage notes ("2 stages", "outputs: 1–4 stages"), no
  algorithm detail (*Horner*, *X = S2/S1*), no pin labels, no table or memory
  sizes. A registered block keeps its clock wedge. Latency and detail are in the
  receipt and, in the study format, the side table; the caption carries what the
  reader needs. An author may opt in for a figure (`meta.style.block_details:
  true`) or a block (`show_details: true`); the two-line limit
  (`label/stage-note-clutter`) and the pin-label limits apply then.
  Microarch / SoC blocks follow the same rule (§11).
- Short labels for narrow variants are **readable words** (*Locator*, *GF mul*,
  *Classifier*), never cryptic abbreviations. If the readable form does not
  fit one column, the single-column variant is skipped (best effort) rather
  than abbreviated.
- **One name, one block.** Two or more blocks in one figure with the same
  primary name are an error (`label/duplicate`), unless they are declared stages
  of one function (`function.stage: "1/2"`, `"2/2"`). The renderer then prints
  *Syndrome calculator (stage 1/2)* and *(stage 2/2)*. A single block spanning the
  pipeline bar is the alternative when the stages need no separate boxes.
- **The name must be justified by the RTL.** A vocabulary name that claims an
  algorithm requires the structure its entry declares, cited in
  `function.basis` (source pin + a short description):
  - *syndrome calculator*: polynomial evaluation at the code's roots, e.g.
    Horner steps (multiply by a constant root, add the next symbol);
  - *Chien search*: per-position evaluation of the error-locator polynomial,
    iterative or parallel, each result compared with zero;
  - *position match*: equality compares of one value against a constant table of
    field powers, one compare per position (not a Chien search);
  - *error locator*, *error evaluator*: a GF division or multiplication by an
    inverse (or a key-equation solver);
  - *zero detector*, *comparator*, *GF adder*, *GF multiplier*: the compare,
    XOR or multiply itself.

  The lint `label/function-justification` checks the cited source text and,
  with a netlist, the operations in the RTL cone of the block's outputs. When
  the evidence is missing or contradicted, use the entry's more general name
  (e.g. *Comparator* instead of *Chien search*). It is a warning, and an error
  under `--quality paper`.
- For ECC figures (Reed–Solomon, BCH), use coding-theory terms and derive them from what
  the RTL computes, not from instance names: syndrome calculator, error
  locator (Berlekamp–Massey / RiBM, or direct for t = 1), Chien search,
  Forney error evaluator, corrector.
- **Ports** print a readable name (*corrected data*, *error detected*, *valid
  in*); the RTL signal name stays in the IR mapping and source pins, where the
  cross-check uses it exactly.
- Lint: `label/unreadable` flags primary labels that are raw identifiers
  (snake_case, trailing `_i/_o/_q`), mnemonics of three characters or fewer
  (except well-known symbols and acronyms such as `+`, `⊕`, `MUX`, `LUT`,
  `CSR`, `ECC`), bare ratios (`S2/S1`), index ranges (`h1..0`), or
  abbreviated words with a period (`Pos.`, `Calc.`, `Ctrl.`). Write the word
  out and let the block wrap to two lines ("Position match"). The rule also
  covers names printed from the vocabulary, so every `display`, `short` and
  `stage_display` entry is written out. It is a warning, and an error under
  `--quality paper`.
- *Why:* a reader who has not seen the RTL must be able to name every box.
  Mnemonics shift the decoding work to the reader and hide what the figure is
  meant to show.

```
 a ━━━▶( + )━━━▶ s        x ━━▶(⊕)━━▶ y        ┌────────┐
         ▲                       ▲             │ S-box  │
 b ━━━━━━┛                c ━━━━━┛        idx ━┥256×8   ┝━ val
                                               └────────┘
```

---

## 5. Sequential logic

### 5.1 Register / flip-flop symbol

- **[house]** Draw a register as a **narrow rectangle** (the skin's `register.width_pt`,
  14 pt, never sized to its name; pin-span tall), outline 0.8 pt, fill `fill-2`. Mark the
  clock pin with the **dynamic-input wedge** (a small triangle, 4 pt base, on the inside
  of the bottom or left edge).
- **[house] No name on a register:** nothing is printed inside or beside the box. The
  ports and nets on its lanes say what it holds; the element's `label` stays in the IR
  (receipt, caption, review). *Why:* a name printed next to a narrow box cannot be told
  apart from the name of a wire running beside it.
  *Why:* the wedge is the IEEE Std 91 dynamic-input indicator. It means edge-triggered
  [ext: TI SDYZ001A: edge-triggered elements accept data "on the active transition of
  C"]. Readers of any EDA schematic recognize it.
- Pin labels `D`, `Q`, `en`, `rst` are **optional** in datapath figures. Leave them
  out when the flow is obvious (one in, one out). Show them in gate-level and CDC
  figures.
- **Latch:** same rectangle **without** the wedge, labeled `L` or with a `G`/`C` pin.
  *Why:* the wedge is the only visual difference between level-sensitive and
  edge-triggered symbols in Std 91 (static vs dynamic C). It must never be dropped from
  a flop.
- **Negative-edge flop:** wedge plus bubble.
- **Register arrays / bit-vectors:** one rectangle with a slash-N on the input bus.
  Do not stack N flops.

```
      en (ctrl, top)
       │
    ┌──┴──┐
 D ━┥     ┝━ Q
    │▷    │          ▷ = clock wedge (bottom-left or bottom edge)
    └──┬──┘
      rst (bottom, dotted, optional)
```

### 5.2 Enable, reset, clear

- **Enable [house]:** Put the `en` pin on the **top** edge, in control style. Do **not**
  draw the equivalent feedback mux unless the paper discusses clock gating vs mux
  enable.
- **Synchronous reset [house]:** `rst` on the bottom edge, labeled. **Asynchronous
  reset:** label `arst`, or add an `R` next to the pin without the `1` dependency,
  following Std 91 [ext: synchronous inputs carry dependency labels 1D/1R; asynchronous
  S/R do not]. Put a bubble on active-low (`rst_n`).
- **Reset value [house]:** write it inside the register at 6.5 pt (`=0`, `=IDLE`) only
  when it matters.

### 5.3 Pipeline-register bars

- **[house]** A pipeline boundary is **one tall, thin bar** (6–8 pt wide, fill
  `fill-3`, outline 0.8 pt) that runs across **every net crossing that stage
  boundary**, top of the datapath to bottom. Put the stage pair name above the bar:
  `IF/ID`, `ID/EX`, or `S1|S2`. Put one clock wedge at the bottom of the bar.
  *Why:* this is the Patterson & Hennessy pipeline figure style. It shows the
  **cut-set** at a glance: every signal crossing the line is delayed one cycle. If a
  wire crosses the stage line without a bar, a reader sees a combinational path that
  skips a stage. That is a bug in the drawing, or a deliberate multi-cycle path that
  MUST be labeled.
- Every net crossing a bar MUST visibly pass *through* it, so the bar is not hiding
  junctions.
- Control that is pipelined alongside data (`EX.ctrl`, `MEM.ctrl`) SHOULD be drawn
  as a small separate section at the top of the same bar, in control color.
  (P&H shows pipelined control this way.)
- Stage names go at the top of each stage column, at 8 pt bold: `Fetch`, `Decode`, …
- **Skid buffers / elastic stages:** a bar with a small `2` inside, or label
  `skid`, and valid/ready shown as a control pair.

```
          IF/ID          ID/EX
   Fetch    ┃   Decode     ┃   Execute
 ━━━━━━━━━━━╋━━━━━━━━━━━━━━╋━━━━━━━━▶
 ─ ─ ─ ─ ─ ─╂─ ─ ─ ─ ─ ─ ─ ╂─ ─ ─ ─▶ (ctrl)
 ━━━━━━━━━━━╋━━━━━━━━━━━━━━╋━━━━━━━━▶
           ▷┃             ▷┃
```

### 5.4 Retiming and cut-set annotations

- **[house]** Show a *proposed* or *possible* cut as a **dashed line** (0.6 pt,
  `accent`, dash 3–2) crossing the datapath. Label it with a circled number or `cut 1`.
  Show a *retimed* register as a normal register with an `accent` outline. Where you
  want to show where it came from, add a faint dashed ghost at its original place and
  a curved arrow.
- A dashed cut-set line **must cross every forward path exactly once**. The renderer
  SHOULD check this (graph cut test) and warn.
  *Why:* a cut that misses a path is a retiming error. Checking the drawing catches
  mistakes in the spec.
- Delay elements in DSP-style signal-flow graphs (FIR, IIR, LFSR, NTT loops) MAY use
  `D` / `z⁻¹` boxes instead of register rectangles. Pick one per figure.

### 5.5 Registers inside collapsed blocks [house]

- A collapsed or blackbox block that contains registers on a path shown in
  the figure must make them visible, in one of two ways:
  - **(a) Default, required for pipeline registers on a shown path:** keep the
    register outside the block. Split the block at the register boundary into
    stage blocks, and draw the pipeline-register bar (§5.3) or register
    between them.
  - **(b) Only for internal state not on a shown path, and for memories:**
    mark the block registered. Its output ports carry `registered` and
    `latency`, and the block shows a clock wedge on its bottom edge and a
    "k stages" note ("registered read" for a memory).
- A register counts as a **pipeline register** of a shown path when it feeds
  no loop back to itself and every one of its sources, other than its clock
  and reset, comes from that path. Registers that are also loaded from
  elsewhere (CSRs, sticky flags, shared buffers) or that feed back to
  themselves are internal state.
- **Drawn latency equals RTL latency.** Along every shown path through a drawn
  element, the register stages the figure draws must equal the minimum
  register count between the mapped signals in the netlist.
  `latency/hidden-register` (error) fires for a hidden pipeline register or
  for any latency mismatch.
- *Why:* a pipeline register absorbed into a block hides the latency. The
  reader counts the bars and gets the wrong cycle count.

---

### 5.6 Register banks [house]

- **What:** registers that share a role and load pattern in an iterative or
  micro-sequenced datapath (operands loaded on accept, temporaries, outputs) are
  drawn as one **register bank**: a narrow storage-filled box (the register width, §5.1)
  with a clock wedge, one lane per register on the pin pitch (d west, q east; height =
  lanes × pitch plus margins) and the load enable entering the top. No role name is
  printed (§5.1): the lane nets and ports name what the bank holds; the role ("input
  registers") stays the element's `label` in the IR.
- **Hold is implicit:** a register that keeps its value unless loaded is drawn as a
  register with an enable; the hold feedback is never drawn as a loop.
- **Enables:** one dashed load net per bank from the controller, one bit per
  independently loaded register (4 bits for four temporaries), or one bit when the
  whole bank loads together.
- **Not a pipeline bar:** a pipeline bar (§5.3) holds registers loaded every cycle
  from one source; a bank holds state under a load condition. Every register is still
  checked one by one (register-to-register transfers, coverage).

## 6. Memories and SRAM macros

- **[house] Shape:** a rectangle with a **double left edge** (a second vertical line
  2 pt inside) or a small "stack" offset (two outlines offset 2 pt up-right) to mark
  storage arrays. Fill `fill-2`. Label with the name and **depth × width**:
  `Weight SRAM 64k×8`, `Syndrome RAM 1024×12`.
  *Why:* on-chip memory is often most of the area and energy, so it must stand out
  from logic blocks. The size tells the reader the cost.
- **Ports [house]:** control and address on the **left** (`addr`, `we`, `re`,
  `wdata`). Read data on the **right** (`rdata`). Clock wedge on the bottom edge if
  synchronous. Label ports only when there are several memories with different port
  sets.
- **Synchronous-read latency [house]:** a synchronous SRAM (1-cycle read) MUST have
  its read-data path treated as registered. Put it after (not before) the pipeline bar,
  or add `(1-cycle rd)`.
  *Why:* timing bugs in figures often come from drawing an SRAM read as
  combinational.
- **Multi-port:** repeat port groups on the left (`A:` / `B:` prefixes). A register
  file is a memory with `2R1W` in the label.
- **FIFO:** rectangle with vertical stripes on the right half (slots). Enqueue on the
  left, dequeue on the right. Label depth (`depth 16`) and show `valid/ready` or
  `full/empty` in control style.
- **Off-chip memory (DRAM, flash):** same shape, fill `fill-3`, placed *outside* the
  dashed chip boundary (§11).

```
   addr ━┥║ Weight SRAM  ┝━ rdata
     we ─┥║   64k × 8    │
  wdata ━┥║▷             │
         └──────────────┘
```

---

## 7. Clock domains and CDC

- **[house] Domain regions:** each clock domain is a rounded rectangle with a
  **light tint fill** (`clkA`/`clkB` at 15 %). In grayscale mode, use different hatch
  angles. Label the domain in the corner (`clk_a (100 MHz)`). Domain boundaries are
  dashed 0.6 pt.
- **[house] Crossing rule:** every net crossing a domain boundary MUST end at a
  recognizable synchronizer (2-flop, pulse sync, handshake sync, async FIFO, or
  gray-coded pointer). Draw the synchronizer **straddling** the boundary: the first
  flop sits inside the receiving domain at the boundary edge.
  *Why:* the figure shows the design is CDC-clean. A bare wire across a boundary looks
  like a metastability bug.
- **[house] 2-flop synchronizer:** two registers in series, pin labels shown, clock
  nets drawn and colored by domain. Label the group `sync`. You MAY add an `MTBF`
  note. Follow Cummings (SNUG) figure style: source flop in domain A, two receive flops
  in domain B.
- **[house] Async FIFO:** memory block straddling the boundary. Write pointer logic
  and `wclk` in A; read pointer logic and `rclk` in B. Gray-coded pointers (`wptr_gray`)
  cross through 2-flop synchronizers on both sides. Full/empty comparators are drawn
  in their own domain. This is the canonical structure of Cummings' async FIFO paper
  (see `figures.yaml`).
- **Clock generation / gating:** PLL as a rectangle labeled `PLL`. A clock-gating cell
  is drawn with a latch + AND gate, or as a block `ICG`. In clock-network figures,
  clock nets are colored by domain and solid.

```
   ┌ clk_a ─ ─ ─ ─ ─ ─ ─ ┐┌ clk_b ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
     ┌───┐                ┆ ┌───┐     ┌───┐
   │ │   ┝━━━━━━━━━━━━━━━━┿━┥   ┝━━━━━┥   ┝━━━▶ d_sync│
     │▷  │                ┆ │▷  │     │▷  │
   │ └───┘                │ └───┘     └───┘          │
    clk_a                 ┆  clk_b ────┘   (sync)
   └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘
```

---

## 8. FSM figures

- **States [house]:** rounded rectangles (corner radius 3 pt) with the skin
  outline (1 pt), sized to their text. The readable state name is centred inside
  at 8 pt, never the raw RTL id: a prefix shared by all states is dropped
  (`OwnerMetaCounter0` → "Meta counter 0", `S_IDLE` → "Idle").
- **Do not use double circles.** *Why:* in automata theory a double circle means an
  accepting state. Hardware readers may read it as "final/halt". Mark a terminal state
  with a label instead.
- **Encoding [house]:** under the name at 7 pt as digits (binary up to 8 bits,
  `010`; else hex, `0x1A`). Hide it with `meta.style.show_encodings: false` when
  the paper does not discuss encodings.
- **Reset arc [house]:** a short arrow from a small filled dot into the reset
  state, labelled "reset" (or the readable condition when it is not simply the
  reset net). It has no source state. *Why:* this is UML/statechart practice. It
  avoids a fake "RESET" state.
- **Any-state and recovery arcs [house]:** an arc taken from every state
  (a synchronous override such as a soft reset) is drawn **once**, from a hollow
  dot captioned "any state" ("except Idle"), never as one arc per state. The RTL
  `default:` branch over unused encodings is one **dashed** arc from a hollow dot
  captioned "other codes", drawn only when the figure asks for it. It must never
  look like an unconditional jump.
- **Self-loops [house]:** a small loop on the side facing away from the most other
  edges (default top). Label it with the hold condition (`!done`). A self-loop that
  just means "stay otherwise" MAY be left out if the caption says "unlabeled
  conditions hold state".
- **Transitions [house]:** orthogonal routes in the one wire stroke (0.9 pt), the
  one skin arrowhead at the target outline. No arc crosses a state box, and every
  arc ends exactly on its target's outline.
- **Condition labels [house]:** beside their own arc (within 12 pt, nearer to it
  than to any other arc), never on a stroke. Write guards in readable words:
  - identifiers become names through the label dictionary ("command valid");
  - `&&`, `||`, `!` print as "and", "or", "not"; `==` as "=" and `!=` as "is
    not";
  - literals print as numbers.

  Lines wrap between words but never inside a name. A comparison ("mode is not
  MODE RSVD") stays on one line when it fits a column line (40 characters); an
  operand word is never left alone on a line apart from its operator, and "and"
  / "or" end the line they continue.
- **Moore outputs [house]:** inside the bubble under a thin divider, or under the
  name: `BUSY / en=1`. List only outputs that are asserted (non-default).
- **Mealy outputs [house]:** on the arc after a slash: `start / load=1`.
  *Why:* `condition / output` is the standard notation in textbooks.
- **Default-transition rule:** each state's outgoing conditions must be mutually
  exclusive and complete. Use `else` / `otherwise` for the fall-through. The renderer
  SHOULD check this when conditions are given in its boolean expression subset.
- **Layout [house]:** place the main flow left → right from the reset state. A
  machine too wide for the column snakes: its dominant chain (the longest path
  from reset) is laid in rows that alternate direction, and arcs that skip
  along the chain run orthogonally in their own channels between the rows.
  Then ELK row wrapping, then top to bottom. A layout that loses or misroutes a
  transition, or runs two arcs on one track, is rejected (`fsm/edge-unrouted`,
  `fsm/edge-detached`, `fsm/arc-overlap`); a transition is never dropped. A
  long machine that fits no plan is delivered in the study format or split into
  linked sub-figures (`fsm/split-suggested`: a `collapsed` state stands for a
  run of states and names its detail figure with `detail_ref`), not squeezed.
- **Guard names [house]:** a module-local prefix shared by the signals
  (`sk_`, `dec_`) is dropped when the rest stays unambiguous in the module. A
  literal compared against a signal of a declared enum type prints the item's
  name ("state = Absorb"), never a number; an untyped signal keeps the number.
- **Controller + datapath figures:** draw the FSM as one rectangle `Control FSM` above
  the datapath, with outputs as control nets (§1) going down. Draw the state diagram
  as a separate subfigure (a)/(b), not inline.

```
        !start                   done / irq=1
         ╭─╮          start         ╭──────────╮
   ●──▶ ( IDLE )──────────────▶( BUSY / en=1 )  │
          ▲                           │          │
          ╰───────────────────────────╯◀─────────╯
                      done                 (Mealy on arc, Moore in bubble)
```

---

## 9. Timing diagrams

Default target: **WaveDrom-compatible** visual style and semantics, so specs can take
WaveJSON input [ext: WaveDrom tutorial].

- **Grid [house]:** each cycle is one column of fixed width (default 18 pt at print).
  Rising edges at column boundaries. Faint vertical gridlines (`#DDDDDD`, 0.4 pt) at
  every rising edge. Put **cycle indices** above the top lane at 6.5 pt (`0 1 2 3 …`),
  following WaveDrom `head.tick`.
- **Names and vectors [house]:** a lane of named values (enum states) prints no
  width suffix. Show one bit of a one-hot or per-client vector as its own 1-bit
  lane ("client 0 valid"), not as a hex bus.
- **Lane order [house]:** `clk` first, then `rst`, then signals grouped by interface
  (request channel, response channel). Groups are labeled with a bracket on the left,
  as in WaveDrom groups. Signal names are right-aligned at 7 pt in the left gutter.
- **Waveform glyphs** [ext meanings from WaveJSON; drawing = house]:
  - `0`/`1`: low/high lines. Transitions slightly slanted (1.5 pt run) so edges are
    visible after reduction.
  - `x`: hatched fill (45°, 1.5 pt pitch, gray). Never solid black.
  - `z`: line at mid level.
  - `=` / `2`–`9`: bus value box (hexagonal ends at transitions). Value text centered
    at 7 pt between the end of its opening transition and the start of the next.
    A value wider than that prints its lossless short form (leading zeros dropped:
    `0x0000` → `0x0`; the lane name keeps the width). A value still too wide is an
    error (`timing/value-overflow`), never clipped or overprinted: widen the cycles,
    show fewer, or use the study format. Use light fills from `fill-1`/tints to tell
    distinct values apart only if the values are named in the caption.
  - `.`: extend. `|`: gap (drawn as a pair of slanted breaks across all lanes).
  - `p`/`n`: clock with rising/falling active edge. `P`/`N`: same with arrow markers.
- **Handshakes [house]:**
  - valid/ready: mark every cycle where both are high at the rising edge (a "fire" or
    transfer) with a small `ok`-colored **dot or up-arrow** on the clock edge in the
    `valid` lane. Stalls (valid high, ready low) keep the data box and add no marker.
    *Why:* it shows the exact AXI/Decoupled transfer semantics instead of leaving it
    to the reader.
  - req/ack four-phase: numbered edge arrows ①→② between `req` and `ack` edges, using
    WaveDrom edge syntax (`a~>b`).
- **Latency annotation [house]:** a horizontal dimension line with arrowheads at both
  ends (`<->` in WaveDrom edge syntax), placed in a spare lane or above the relevant
  lanes, labeled `3 cycles` or `t_lat`. The anchors are nodes on the stimulus edge and
  the response edge. *Why:* latency is often the main claim of a timing figure. A
  dimension line makes the number exact.
- **Setup/hold or propagation delays:** only in circuit-level figures; use shaded
  windows around the edge labeled `t_su` / `t_h`.
- **Width:** a timing diagram SHOULD be at most about 24 cycles wide at single column
  (3.5 in − 0.9 in gutter ≈ 2.6 in ÷ 18 pt ≈ 10 cycles at default hscale). Use `|`
  gaps to compress idle stretches instead of shrinking cycles below 12 pt.

```
cycle     0   1   2   3   4   5
clk      ┌┐┌─┐┌─┐┌─┐┌─┐┌─┐
          └┘ └┘ └┘ └┘ └┘ └┘
valid  ___/‾‾‾‾‾‾‾‾‾‾‾\______
ready  _______/‾‾‾‾‾‾‾\______
data   XXX< A     >< B >XXXXX       ● fire at 2, 3
out    XXXXXXXXXXXXXXXX< A' >X
               |<-- 3 cycles -->|
```

---

## 10. Microarchitecture / pipeline figures

- **Stage columns [house]:** name each stage at the top (8 pt bold). Separate stages
  with pipeline bars (§5.3) in detailed datapaths, or with **vertical dotted lines**
  (0.5 pt gray) in abstract block pipelines.
- **Level of abstraction [house]:** one figure uses **one** level: either
  (a) block pipeline (boxes per stage, few nets, no widths), or (b) datapath (muxes,
  registers, widths). Don't mix them. Use a zoom-in subfigure with a dashed "callout"
  frame instead. *Why:* mixed levels make the reader guess which details matter.
- **Forwarding / bypass paths:** control-style or accent-colored, routed **above**
  (forwarding) or **below** (feedback) the main flow. Label with the source stage
  (`from MEM`).
- **Stall/flush signals:** control style, entering bars from the top, labeled
  `stall`/`flush`.
- **Branch prediction / speculation loops:** the feedback path goes to the leftmost
  stage and is labeled (`redirect`).
- **Superscalar / OoO blocks** (ROB, rename table, issue queues, LSQ): memory-like
  shapes (§6) for tables and queues; logic blocks for select/wakeup. Show queue depth
  and entry fields in a small field strip (a rectangle split into labeled cells, as in
  WaveDrom `reg`-style bitfield rendering) when the fields matter.
- **Iteration / folded architectures** (ECC decoders, iterative crypto rounds): one
  round datapath with a feedback register and a round counter (`round < Nr`) on the
  control side. Annotate `×Nr` in the caption or at the loop.

### 10.1 Iterative (multicycle) datapaths [house]

The textbook multicycle / microprogrammed datapath layout (Patterson & Hennessy):

- **Register banks left** (§5.6), then the **operand selects** (muxes with inputs in
  select order), then the **shared operator** (an arithmetic unit or service block),
  then output registers and figure outputs on the right.
- **Write-back:** the operator result returns to the banks it loads as one result bus
  with taps (or a named connector pair when the return is long, §1.6), each register
  loaded through its enable; never one loop per register.
- **Controller on top** of the operator side, in the column just before the operator
  and above the selects: its selects and load enables are dashed control nets
  running down to the muxes and banks; its handshake and status wires meet the
  operator. The output registers sit in the column after the operator, beside its
  result. The state machine itself is its own FSM figure (detail_ref).
- **Fan-in order:** bank lanes, the bank order and the mux stacking follow the order
  the muxes read them, so lane outputs cross the mux inputs as little as possible;
  a mux's inputs stay in select order. When whole banks still cross, the author may
  split a bank into groups (x / y / s pairs, one intermediate register) placed
  between the groups its selects read; the load of a split bank fans out or is
  split per group.
- **Valid lanes are control:** a valid or ready bit carried through pipeline bars is
  dashed on both sides of every bar, like any handshake.
- **The loop is cut at the banks:** the layout treats an edge into a register bank
  from anything the bank reaches as feedback, so the flow reads left to right.
- **Long control returns are connectors:** a load, select or enable that would loop
  back more than half the width is drawn as a named connector pair.
- **Tall figures are allowed:** banks, wide selects and a controller row may need
  about 6 in of height at 2col (`meta.print.max_height_in`); 1col is skipped.
- **Handshakes may be abstracted:** the valid/ready wires between the controller and a
  shared operator can be left out by declaration (`view.abstract`), never
  silently; the caption says "handshake signals omitted" and the receipt lists
  the omitted nets.

---

## 11. Accelerator and SoC block figures

- **Blocks show the name only [house]:** no address window, size or feature line
  ("2048 bytes", "burst read and write") inside a block by default. Addresses
  appear on the address-map table figure (`addrmap`), which is drawn next to the
  block figure. The same opt-in as datapath blocks applies
  (`meta.style.block_details`, block `show_details`).

- **Boundaries [house]:** the chip / FPGA / accelerator boundary is a dashed rounded
  rectangle, labeled in the top-left (`Accelerator`, `SoC`, `FPGA`). Everything off
  chip (host CPU, DRAM, flash, sensors) goes **outside** with fill `fill-3`.
  *Why:* on-chip vs off-chip is the energy/data-movement story of most accelerator
  papers (DianNao-family and Eyeriss figures lean on it heavily).
- **Interconnect [house]:** draw a shared bus or fabric as a **long thick bar**
  (4–6 pt tall, fill `fill-3`) labeled with the protocol (`AXI4`, `TileLink`, `AHB`,
  `APB`). Masters and slaves attach with short stubs. Mark the manager vs subordinate
  side with arrowheads pointing *away from the manager*. A crossbar or mesh fabric MAY
  be drawn as a grid of small router squares.
- **Tiles / cores / PEs [house]:** repeated identical units are drawn as **three
  stacked offset outlines** labeled `×N`, or as a visible 2×2 / 3×3 grid with `…`. Never
  draw 16 copies. Draw one unit's internals in a zoom callout.
- **Memory hierarchy [house]:** use the three fill levels as storage tiers:
  `fill-1` logic/compute, `fill-2` on-chip memory (SRAM, scratchpad), `fill-3`
  off-chip memory. Add a legend if more than two tiers appear.
- **Dataflow arrows [house]:** in abstract dataflow figures (tensor movement,
  DNN layer mapping), arrows MAY be diagonal. Arrow **weight** scales with data volume
  in at most 3 steps, and the steps are explained in the legend.
- **Block-level content [house]:** in each box: name (8 pt) and optionally one line of
  key parameter (7 pt), e.g. `PE ×168`, `GLB 1.5 MB`. Do not use full sentences.
- **Micrographs and layout plots:** the renderer does not generate these. Papers
  (ISSCC/VLSI/JSSC) often overlay block outlines on a die photo. Our figures should
  show block *relationships*, and never trace or copy a published micrograph.
- **Host–device software/hardware split:** put the boundary as a horizontal dashed
  line labeled `HW` below / `SW` above, when the figure spans both.

---

### 11.1 Facts taken from documents [house]

- A slot, base address, address window, IRQ number or instance name shown in an
  SoC figure is a **documented fact**. Gather it from **every** document of the
  repository revision, not the first hit. Integration guides, READMEs, design
  reviews and test plans often disagree after a reassignment.
- When documents disagree, the figure **does not pick one silently**. The
  conflict is an error until the user chooses the authoritative document. That
  choice is recorded in the figure (`authority {file, reason}`), and the receipt
  lists the overridden sources.
- A documented window that the RTL cannot decode (e.g. an "effective" window
  smaller than the address port spans) is flagged against the RTL, whichever
  document is authoritative.
- *Why:* a figure is often read as the integration reference. One stale
  address in it propagates into firmware and test benches.

---

## 12. Renderer style tokens (summary)

```yaml
units: pt                 # print points, canvas = final size
canvas:
  ieee:            { single: 252,   double: 515.5 }   # 3.5 in / 7.16 in
  ieee-compsoc-conf: { single: 243, double: 504 }     # 3.375 in / 7.0 in
  acm-sigconf:     { single: 241.1, double: 506.3 }
font:
  sans: ["Helvetica", "Arial", "TeX Gyre Heros", "Liberation Sans", "Nimbus Sans", "sans-serif"]
  mono: ["Inconsolata", "DejaVu Sans Mono", "Courier New", "monospace"]
  serif_math: ["TeX Gyre Termes", "Times New Roman", "serif"]
  size: { label: 8, secondary: 7, min: 6, callout: 8 }
stroke:
  wire: 0.6               # every net, any bit width; control dashed at the same weight
  outline: 0.8
  emphasis: 1.4
  boundary: { width: 0.6, dash: [3, 2] }
  grid: { width: 0.4, color: "#DDDDDD" }
  min: 0.5
color:
  ink: "#000000"
  ctrl: "#0072B2"
  accent: "#D55E00"
  clkA: "#E69F00"
  clkB: "#56B4E9"
  ok: "#009E73"
  alt: "#CC79A7"
  fill: ["#F2F2F2", "#D9D9D9", "#BFBFBF"]
spacing:
  pin_pitch: 12
  wire_gap_min: 6
  block_gap_min: 14
  junction_dot_diam: 2.5x_stroke
mux: { style: bar, bar_width: 5, bar_fill: ink, indices: false, index_font: 7, index_order: top-down, select_side: north, trapezoid: { taper_ratio: 0.5, end_pad: 8, index_inset: 1 } }
split: { style: ripper, stub_len: 5, stub_angle: 45, label: slice, dot_at_tap: false }
truncate: { style: label, offset: [3, 6] }
concat: { style: box, min_width: 14, fill: logic, outline: 0.8, label: "concat", input_range_labels: true, msb: top }
extend: { style: box, fill: logic, outline: 0.8, labels: [sext, zext], recognize: ["{{K{x[msb]}},x}", "{K'b0,x}"] }
replicate: { style: box, fill: logic, outline: 0.8, label: "repl ×{N}" }
glyph_lint: { solid_bar_is_mux: true, solid_bar_max_width: 8, mux_requires_select: true, forbid_split_join_bars: true, reserved_label_prefixes: ["[", "{"] }
route: { jog_min_offset_pt: 12, max_crossings: { data: 2, control: 8, mixed: 6 }, pin_grid: "pitch/2 + k*pitch", detour_min_step: pitch, dot_arrow_clearance: 8 }
naming: { vocabulary: schemas/function-vocabulary.json, primary: function name, secondary: algorithm detail, short: readable word, lint: label/unreadable }
region_frame: { stroke: 0.5, dash: [2, 2], pad: 5, label: inside top edge, encloses: exactly members, blackbox_framed: false }
register: { width: 10, wedge_base: 4, fill: fill-2 }
pipeline_bar: { width: 7, fill: fill-3 }
timing: { cycle_width: 18, min_cycle_width: 12, x_hatch_pitch: 1.5, edge_slant: 1.5 }
grayscale_mode: { ctrl_dash: [2, 1.5], domain_fill: hatch }
max_hues: 3
max_stroke_weights: 3
max_font_sizes: 2
```

---

## 13. Checklist before export

1. Canvas width equals a preset (§0.1); nothing scaled afterwards.
2. No text below 6 pt; at most 2 font sizes; fonts embedded or outlined.
3. No stroke below 0.5 pt; at most 3 weights; every net at the one wire weight, bit
   widths only in slash-N labels (§1).
4. Figure reads in grayscale (renderer SHOULD produce a `_gray` preview); control
   differs from data in two ways.
5. Every mux shows its select pin; inputs are in fixed order (0 at top); index labels
   only where opted in, never touching wires; the only solid filled bars are muxes
   (§3.5 D1).
6. Every clocked element has a wedge; no latch has one.
7. Every pipeline bar crosses every net at its boundary; cut-sets are complete.
8. Every CDC crossing ends in a synchronizer.
9. Every bus width labeled once at its source and after width changes. Splits are
   45° ripper taps with `[msb:lsb]` (no dots, no body), truncation is a wire label,
   and concat/extension/replication are hollow labeled boxes (§2.3).
10. FSM: reset arc present, no double circles, outgoing conditions complete.
11. Timing: cycle indices, handshake fires marked, latency given as a dimension line.
12. No caption or "Fig. N" in the image; (a)/(b) callouts in 8 pt Times if multi-part.
13. Every abbreviation and color/line meaning is explained in the caption or legend.
14. Every block prints a functional name (§4.3); no mnemonics, RTL names or math
    shorthand as primary labels; circle operators and gates carry no text.
15. Data trunks are straight: no level change under one pitch. Bends are
    allowed only for control, fan-out to another row, a turn into a top or
    bottom pin, feedback, or a path that lane re-ordering and pin
    re-assignment cannot clear; each is justified (§1.4). Crossings are few.
    No wire runs closer than 4 pt along an outline or another wire (§1 rule 6).
    Every net ending at a block input or output port has an arrowhead, except
    gate inputs in gate-level regions (§1).
16. Region frames enclose exactly their members, don't cut foreign blocks,
    don't touch each other, and no wire or text lies on a frame edge (§4.1a).
17. No two blocks share a primary name unless they are declared stages; every
    algorithm name (syndrome calculator, Chien search, position match, …) is
    justified by the cited RTL structure, otherwise the general name is used
    (§4.3).
18. Line style follows usage: solid for all data including 1-bit results; dashed
    only when every sink is a select, enable or handshake input (§1 rule 0).
    Every multi-bit data net shows one integer width, never a product (§2.1).
19. Arrowheads have their own pins: no two arrowheads overlap, and no label sits
    against another connection's arrow.
20. Facts taken from documents (slot, base, window, IRQ, instance) agree across
    all documents of the pinned revision, or the user's chosen authority is
    recorded and the overridden sources are listed in the receipt (§11.1).
21. The figure declares its scope, and every instance, register, memory, net
    and transfer inside it is drawn or covered by a collapsed element. Nothing
    is dropped to fit; the figure is split or its scope narrowed (§4.1b).
22. No pipeline register on a shown path is hidden inside a block. Blocks that
    keep internal state show a clock wedge and their latency, and drawn latency
    equals RTL latency (§5.5).
23. Wires meet their pins exactly, junctions have dots on the trunk, lanes pass
    bars level, crossings never touch, and bubbles are tangent to their gates
    (§1.5, §4.1).
24. Long returns are named connector pairs, no wire hugs a frame, bundles are
    named without a summed width, a stage note names each path when latencies
    differ ("IRQ: 2 stages, read: 1"), and no wire steps just before a pin
    (§1.6, §2.1, §5.5).
25. Every net has one stroke weight (`net/stroke-uniform`); junction dots stay 8 pt
    from arrowheads and pins (`route/dot-near-arrow`); bus-operation boxes carry
    words (`concat`, `sext`, `zext`, `repl ×N`), never braces (§1, §1.5, §2.3, §3.5).

---

## Sources

Added for §2.3 / §3.5 (bus operations and glyph distinguishability):

- Figure evidence F36, F37, F41–F48 in `figures.yaml` (opened and inspected; see each entry).
- netlistsvg default skin, `lib/default.svg`: `split`/`join` cells are 5-unit filled `rect`s with `hi:lo` pin labels; `mux` is a trapezoid path. <https://github.com/nturley/netlistsvg/blob/master/lib/default.svg> [tool]
- Altium Designer, "Bundling Multiple Nets into Buses": a Bus Entry connects a wire to a bus line; bus net labels use `<Name>[<start>..<end>]`, e.g. `Address[7..0]`. <https://www.altium.com/documentation/altium-designer/schematic-bus> [tool]
- DigitalJS README: separate device types `BusGroup`, `BusUngroup`, `BusSlice`, `ZeroExtend`, `SignExtend` (semantics only; no drawing convention stated). <https://github.com/tilk/digitaljs> [tool]

External facts used above (tag **[ext]**):

- IEEE Author Center, "Improve Your Graphics" (conference): column widths 3.5 in / 7.16 in; max 7.16 × 8.8 in; fonts Helvetica/Times/Arial/Cambria/Symbol; type about 9–10 pt at full size; embed fonts or outline; color and shape for CVD; grayscale check. <https://conferences.ieeeauthorcenter.ieee.org/write-your-paper/improve-your-graphics/>
- Proceedings of the IEEE, "Guidelines for figures and tables": 3.5 in (88.9 mm, 21 pc) / 7.16 in (182 mm, 43 pc); bold/italic sparingly; >600 dpi line art; avoid red–green; define all symbols/abbreviations/color codes. <https://proceedingsoftheieee.ieee.org/resources/guidelines-for-figures-and-tables/>
- IEEE, "Transactions, Journals, and Letters: Guidelines for Author-Supplied Electronic Text and Graphics": figures contain only the image, not the caption; (a)(b)(c) callouts in Times Roman 8 pt; avoid mixing point sizes; one column 3½ in / two column 7 1/16 in; embed fonts. (copy at <http://staffweb.ncnu.edu.tw/will/studentarea/eic-guide.pdf>)
- IEEEtran.cls (CTAN): `\columnsep 1pc`, `\textwidth 43pc % 2 x 21pc + 1pc`; compsoc: `\textwidth 7in` + columnsep; compsoc conference: `\columnsep 0.25in`, 0.75 in side margins. <https://ctan.org/pkg/ieeetran>
- acmart.dtx (CTAN): sigconf geometry `paperwidth=8.5in`, `inner=54pt, outer=54pt`, `columnsep=2pc`. <https://ctan.org/pkg/acmart>
- Texas Instruments SDYZ001A, "Overview of IEEE Std 91-1984, Explanation of Logic Symbols": qualifying symbols MUX, Σ, P–Q, π, COMP, ALU; dynamic input indicator; edge-triggered vs transparent latch; synchronous inputs carry dependency labels (1D, 1R), asynchronous S/R do not. <https://www.ti.com/lit/ml/sdyz001a/sdyz001a.pdf>
- Elsevier artwork guidelines: lettering 7 pt normal, min 6 pt sub/superscripts; line width guidance. <https://www.elsevier.com/about/policies-and-standards/author/artwork-and-media-instructions/artwork-sizing>
- Cell Press figure guidelines: strokes 0.5–1.5 pt; text 6–8 pt. <https://www.cell.com/information-for-authors/figure-guidelines>
- Society of Wood Science & Technology, "Preparing Figures for Publication": lines < 0.5 pt drop out after reduction; no hairlines. <https://www.swst.org/wp/publications/wood-fiber-science/journal-submissions/preparing-figures-publication/>
- Science family of journals figure guide: 8 pt type, 6 pt minimum. <https://www.science.org/cms/asset/76887697-528f-4a22-afea-cee904504e76/sciadv_guide_to_preparing_figures_2026.pdf>
- Okabe & Ito, Color Universal Design palette (hex values as listed, e.g. via easystats `okabeito_colors`). <https://easystats.github.io/see/reference/okabeito_colors.html>
- WaveDrom tutorial (WaveJSON wave characters, data labels, node/edge syntax, groups, `hscale`, head/foot ticks). <https://wavedrom.com/tutorial.html>

Textbook/paper style anchors cited by name are catalogued with verification status in
`figures.yaml`. Statements about their visual style in this file are **[house]**
observations. Rely on them only as strongly as the verification in `figures.yaml`
supports:

- **Unverified (textbooks):** Patterson & Hennessy pipeline-register bars, Harris &
  Harris blue control lines and `31:26` slice labels. These describe widely known
  textbook styles, but figure numbers and visuals were not checked against a primary
  copy.
- **Confirmed from caption and in-figure text** (verified PDFs; images not
  inspected):
  - Cummings 2-flop synchronizer and async-FIFO figures split by clock domain (§7).
  - Eyeriss v2 memory labels giving size and type ("96×24b SRAM") (§6).
  - Snitch per-block area annotations "(188 kGE)" (§11).
  - Chisel conditional-update figure drawn as a mux chain feeding a register with an
    enable.
  - Captions that define signal letters ("d, e, r and m are data, enable, ready…")
    (§0.6).
  - McEliece FPGA caption stating a bus width once for all wires ("Each wire … is of
    width s") (§2.1: acceptable when every bus in the figure shares one width).
  - Eyeriss JSSC die-micrograph overlay (§11: don't imitate).
