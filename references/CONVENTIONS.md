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
| Single-bit wire (data or control) | 0.6 | [house] |
| Multi-bit bus | 1.2 | [house] |
| Block outline (logic block, register, memory) | 0.8 | [house] |
| Emphasis outline (the "new" block the paper proposes) | 1.4 | [house] |
| Group / domain / chip boundary | 0.6, dashed 3–2 | [house] |
| Pipeline register bar | 0.8 outline + gray fill | [house] |
| Arrowheads | filled triangle, length about 4× bus stroke, width about 3× | [house] |

- **Why a bus looks different from a wire:** readers expect a bus to be heavier, as in
  Harris & Harris and Patterson & Hennessy datapaths. Using weight for this keeps color
  free for data vs control (§1). It also still reads in grayscale.
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
| Data, 1 bit | 0.6 pt | `ink` | solid | at sink only if direction is unclear | [house] |
| Data bus | 1.2 pt | `ink` | solid | at sink | [house] |
| Control (select, enable, write-enable, valid/ready) | 0.6 pt | `ctrl` | solid (color mode) / dashed 2–1.5 (grayscale mode) | at sink | [house] |
| Clock | 0.6 pt | `ink` | solid | none; use the clock wedge at the sink | [house] |
| Reset | 0.6 pt | `ink` | dotted 0.8–1.2 | none | [house] |
| Configuration / quasi-static (CSR fields) | 0.6 pt | gray `#777` | dashed 1–1.5 | at sink | [house] |

Rules:

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
4. Where a wire splits, draw a **junction dot** (diameter 2.5× stroke). Where two
   wires cross without connecting, draw **no dot and no hop**. *Why:* a dot means
   "connected", as in IEEE-style schematics and Harris & Harris. Hops (bridges) look
   out of date and add clutter.
5. Never allow a **4-way junction** (two wires meeting at one dot from all four
   directions). Offset the tees by at least 4 pt. *Why:* after reduction, a 4-way dot
   looks the same as a crossing.
6. Route orthogonally (horizontal and vertical segments only). Use at least 6 pt
   between parallel wires, and at most 2 bends per net where possible. Diagonal
   wires are allowed only in FSM arcs and in abstract dataflow figures (§11).

```
data bus  ━━━━━━━━━━━▶        control  ───────────▶ (blue, thin)
junction  ━━━━●━━━━━▶           crossing  ━━━━┿━━━━  (no dot = not connected)
              ┃
              ┗━━━━▶
```

---

## 2. Bit width, bit slices, split/merge

### 2.1 Slash-N width notation

- **[house]** Mark a bus width with a short 45° slash across the bus (length 6 pt,
  0.6 pt stroke). Put the number **above** a horizontal bus or **to the right** of a
  vertical bus, at 7 pt.
- Label every bus width **once**, near its source. Label it again after any operation
  that changes the width (extension, truncation, concatenation, split).
- Do not label 1-bit wires (1-bit is the default).
- Symbolic widths are fine: `/W`, `/log₂N`, `/m`. Say what the symbols mean in the
  caption.
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

### 2.3 Split and merge

- **Split [house]:** Draw the parent bus into a tap point. Each child leaves as a
  thinner branch labeled with its slice. Use a **bus ripper**: a short 45° stub off the
  bus, as in EDA schematics (Verdi nSchema / Virtuoso style), when the children leave
  in the same direction. Use a plain tee when they leave in different directions.
- **Merge / concatenation [house]:** Draw a narrow vertical bar (4 pt wide, filled
  `ink`) that the child buses enter from the left and the merged bus leaves on the
  right. Label it `{ }` above, or list the fields MSB first top-to-bottom.
  *Why:* a bar with an explicit order removes the "which field is MSB?" ambiguity that
  a plain junction dot has.
- **Extension:** sign-extend or zero-extend is a small block labeled `SignExt` /
  `ZeroExt` (or `sext`/`zext`), with widths on both sides. Do not draw it as a merge
  bar.

```
             [31:26]
instr  32  ┌────────────▶ opcode       a  8 ━━┓
━━━━━╱━━━━━┤ [25:21]                         ┃█  16
           ├────────────▶ rs          b  8 ━━┫█━━━╱━━▶ {a,b}
           │ [15:0]                          ┃
           └━━━━━━━━━━━▶ imm         (order: top = MSB)
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
- **Disambiguation (required):** the mux bar must never look like another bar.
  Pipeline-register bars are gray (`fill-3`), outlined, carry a clock wedge and span
  lanes (§5.3). Bus join/split bars are thinner (about 2.5 pt), have no select pin,
  and carry a `{ }` label (join) or slice labels (split) (§2.3). A mux bar always
  shows its select pin. The renderer's skin lint enforces that the bar kinds are
  distinct.
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
- Inversion: a bubble (diameter 4 pt) at the pin. Do not draw a separate inverter
  unless the inverter itself matters.

### 4.2 Arithmetic and GF operators

| Operator | Symbol | When | Tag |
|----------|--------|------|-----|
| Integer adder | Circle Ø 12 pt with `+` | inside dense datapaths (DSP, NTT butterflies, accumulators) | [house] |
| Adder / ALU (processor style) | "chevron" trapezoid with notch on the input side, labeled `+` or `ALU` | processor datapaths | [house] (P&H / H&H style) |
| Subtracter | circle with `−`; mark which input is subtracted with a `−` sign at that pin | | [house] |
| Multiplier | circle with `×` | | [house] |
| **GF(2) addition / XOR (ECC, crypto)** | circle with `⊕` | BCH/RS/LDPC, AES, SHA-3, CRC, LFSR figures | [house] follows the math in the paper |
| GF(2^m) multiplier | circle with `⊗` | RS/BCH key-equation solvers, AES MixColumns | [house] |
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

```
 a ━━━▶( + )━━━▶ s        x ━━▶(⊕)━━▶ y        ┌────────┐
         ▲                       ▲             │ S-box  │
 b ━━━━━━┛                c ━━━━━┛        idx ━┥256×8   ┝━ val
                                               └────────┘
```

---

## 5. Sequential logic

### 5.1 Register / flip-flop symbol

- **[house]** Draw a register as a **rectangle** (default 10 pt wide × pin-span tall),
  outline 0.8 pt, fill `fill-2`. Mark the clock pin with the **dynamic-input wedge** (a
  small triangle, 4 pt base, on the inside of the bottom or left edge).
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

---

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

- **States [house]:** circles (or rounded rectangles when names are long), 0.8 pt
  outline. Use one size for all states, big enough for the longest name at 8 pt. State
  name inside, centered, in Title or UPPER case as in the RTL enum.
- **Do not use double circles.** *Why:* in automata theory a double circle means an
  accepting state. Hardware readers may read it as "final/halt". Mark a terminal state
  with a label instead.
- **Encoding [house]:** optional. Put it **under the name** inside the bubble at 6.5 pt
  (`2'b01`), or in a small table next to the diagram when using one-hot/gray encoding.
  Show encoding only when the paper discusses it.
- **Reset arc [house]:** a short arrow from a small filled dot (or from the text
  `rst`) into the reset state. It has no source state and no condition label.
  *Why:* this is UML/statechart practice. It avoids a fake "RESET" state.
- **Self-loops [house]:** a small loop on the side facing away from the most other
  edges (default top). Label it with the hold condition (`!done`). A self-loop that
  just means "stay otherwise" MAY be left out if the caption says "unlabeled
  conditions hold state".
- **Transitions:** smooth curves (cubic), 0.6 pt, arrowhead at target. Use straight
  lines when the pair has only one direction. Use gently curved arcs in opposite
  directions for back-and-forth pairs.
- **Condition labels:** next to the arc near its middle, on the outside of the curve,
  never touching the stroke. Use Verilog-ish boolean syntax (`start && !busy`) or math
  (`cnt = N−1`). Pick one per figure.
- **Moore outputs [house]:** inside the bubble under a thin divider, or under the
  name: `BUSY / en=1`. List only outputs that are asserted (non-default).
- **Mealy outputs [house]:** on the arc after a slash: `start / load=1`.
  *Why:* `condition / output` is the standard notation in textbooks.
- **Default-transition rule:** each state's outgoing conditions must be mutually
  exclusive and complete. Use `else` / `otherwise` for the fall-through. The renderer
  SHOULD check this when conditions are given in its boolean expression subset.
- **Layout [house]:** place the main flow left → right or clockwise from the reset
  state (top-left). Error/abort states go at the bottom. Arcs SHOULD NOT cross state
  bubbles, and SHOULD cross each other at most twice in the whole figure.
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
- **Lane order [house]:** `clk` first, then `rst`, then signals grouped by interface
  (request channel, response channel). Groups are labeled with a bracket on the left,
  as in WaveDrom groups. Signal names are right-aligned at 7 pt in the left gutter.
- **Waveform glyphs** [ext meanings from WaveJSON; drawing = house]:
  - `0`/`1`: low/high lines. Transitions slightly slanted (1.5 pt run) so edges are
    visible after reduction.
  - `x`: hatched fill (45°, 1.5 pt pitch, gray). Never solid black.
  - `z`: line at mid level.
  - `=` / `2`–`9`: bus value box (hexagonal ends at transitions). Value text centered
    at 7 pt, clipped with `…` if too long. Use light fills from `fill-1`/tints to tell
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

---

## 11. Accelerator and SoC block figures

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
  wire: 0.6
  bus: 1.2
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
join_split: { bar_width: 2.5, bar_fill: ink, join_label: "{ }", split_labels: slices }
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
3. No stroke below 0.5 pt; at most 3 weights; buses heavier than wires.
4. Figure reads in grayscale (renderer SHOULD produce a `_gray` preview); control
   differs from data in two ways.
5. Every mux shows its select pin; inputs are in fixed order (0 at top); index labels
   only where opted in, never touching wires; mux bars look different from
   pipeline and join/split bars.
6. Every clocked element has a wedge; no latch has one.
7. Every pipeline bar crosses every net at its boundary; cut-sets are complete.
8. Every CDC crossing ends in a synchronizer.
9. Every bus width labeled once at its source and after width changes.
10. FSM: reset arc present, no double circles, outgoing conditions complete.
11. Timing: cycle indices, handshake fires marked, latency given as a dimension line.
12. No caption or "Fig. N" in the image; (a)/(b) callouts in 8 pt Times if multi-part.
13. Every abbreviation and color/line meaning is explained in the caption or legend.

---

## Sources

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
