---
name: rtl-figures
description: Draw paper-quality hardware figures — RTL datapath / block schematics (muxes, registers, pipeline stages, memories, clock domains), finite-state machines, timing waveforms, and pipeline / accelerator / SoC micro-architecture diagrams — as validated JSON rendered to editable SVG and print PDF in IEEE/ACM single- and double-column sizes. Checks widths, mux selects, clocks, CDC, FSM reachability and latencies, and can ground the figure in real Verilog/SystemVerilog through Verilator netlist extraction and simulation waveforms. Use this whenever the user wants a figure, diagram, schematic, block diagram, state diagram, waveform or timing diagram of hardware or RTL for a paper, thesis, slide or design doc — even if they only say "draw the decoder", "show the pipeline", "FSM of this module", or paste WaveDrom/WaveJSON.
license: MIT
metadata:
  version: "0.1-phase1"
---

# rtl-figures

Phase 1 draft. `validate` (schema), `lint-svg` and `check-rtl` work;
`render` and `deliver` are not implemented yet — say so plainly if asked for
an actual figure file.

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
   node <skill>/bin/rtl-figures.mjs check-rtl --top <module> --files <rtl files...> \
     --work-dir <scratch dir outside the RTL repo> --source-root <repo root> \
     --out <scratch>/netlist.json --summary
   ```

   Missing modules (memory macros, IP) are stubbed automatically from their
   instantiation sites; say which ports were inferred. Add `source` pins
   (file + line at a pinned revision) to elements the reader may want to trace.
   Never write tool output into the user's RTL tree.

4. **Write the candidate JSON first**, with a clear main data path left→right
   and only the control signals the figure's point needs. Figures are
   abstractions; completeness belongs in the netlist, not the picture. Give
   long labels a `short_label` so the single-column variant can stay legible.

5. **Validate after every edit**:

   ```bash
   node <skill>/bin/rtl-figures.mjs validate <type> <figure.json> --json
   ```

   Fix only what a diagnostic names, using its `supportedFixes`. If two
   consecutive repair rounds don't reduce the error count, stop and report the
   remaining diagnostics honestly.

6. **Deliver** (Phase 2+): `deliver` renders both `1col` and `2col` variants,
   lints the SVG as figma-safe, derives outlined-text PDFs, and writes a
   receipt. A non-zero exit is never success.

## Things that matter for paper figures

- Every figure ships in single- and double-column variants, each laid out for
  its width. Don't scale one into the other; that pushes text below the 6 pt
  floor (labels are 8 pt, secondary text 7 pt — `references/CONVENTIONS.md`).
- The canvas is the printed size; the figure contains no title or "Fig. N" —
  the caption lives in LaTeX and should define colors, line styles and
  abbreviations.
- Grayscale print: distinguish classes by dash, weight and hatching, not hue.
- The SVG stays editable (real text, named layers) so authors can polish in a
  vector editor; the PDF has outlined text for printing.
- No vendor tool, license, host or technology-library names in anything you
  generate; describe memories as `impl: blackbox` rather than by macro name.

## References (read on demand)

- `SPEC.md` — full IR, semantic check catalog (§8), layout (§9), rendering and
  figma-safe SVG rules (§10), RTL cross-check (§11), receipts (§12).
- `references/adapters.md` — plugging in another RTL front-end or simulator.
- `docs/adr/` — why ELK layout, why our own waveform renderer.
- `references/CONVENTIONS.md`, `references/figures.yaml`,
  `references/prior-art.md` — drawing conventions and exemplars (when present).
