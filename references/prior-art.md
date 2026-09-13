# Prior Art: Hardware Figure Tools

This is background research for the `fig-gen` skill. The skill takes typed JSON and renders paper-quality SVG/PDF figures: RTL datapaths, FSM/control diagrams, timing waveforms, microarchitecture/pipeline diagrams, and SoC block diagrams.

Research date: 2026-09-13. Versions, dates and licenses come from each project's docs, from GitHub
(`api.github.com/repos/...` `pushed_at` / `license`), or from package registries
(`registry.npmjs.org/<pkg>`, `pypi.org/pypi/<pkg>/json`). Anything I could not confirm is marked **(unverified)**.
No code was copied. The ideas below are paraphrased.

---

## 1. CircuiTikZ, TikZ, `automata`, `tikz-timing`

**What it is.** CircuiTikZ is a set of LaTeX/PGF-TikZ macros for drawing electrical and electronic networks, with native PDF output
(https://ctan.org/pkg/circuitikz). Its changelog lists a flip-flop library (1.0.0-pre1, 2019), mux-demux shapes and "multiple wires markers" for buses
(1.0.0-pre2, 2020), IEEE-standard logic ports alongside the American and European styles (1.1.0, 2020), and configurable muxdemux labels with clock wedges and negation bubbles on pins (1.6.5, 2023)
(https://github.com/circuitikz/circuitikz/blob/master/CHANGELOG.md).
- **Input:** TikZ `\draw ... to[...]` path syntax, with nodes placed at explicit coordinates.
- **Layout:** none. The author places everything by hand, using absolute or relative coordinates and anchors.
- **Output:** PDF (pdfLaTeX/LuaLaTeX). SVG goes through `dvisvgm` or pdf2svg **(unverified for current toolchains)**.
- **License / maintenance:** GPL and LPPL. v1.8.7 was released 2026-09-12 and the repo is very active (https://ctan.org/pkg/circuitikz).

**TikZ `automata` library** (https://tikz.dev/library-automata). It provides `state`, `initial` (arrow or diamond; `initial text`, `initial where`), and `accepting` (`by double` or `by arrow`) styles. It also has a `state with output` split circle (Moore outputs in the lower part), `loop above/below`, and `bend left/right` edges. It has **no automatic layout**: states are placed with `positioning` (`right=of`).

**`tikz-timing`** (https://ctan.org/pkg/tikz-timing). The input is a string of timing characters. Each character has an uppercase full-width form and a lowercase half-width form: `H`, `L`, `Z`, `X`, `D{label}`, `U`, `C` (clock). A number prefix repeats a character (`18{c}`). It also supports meta-characters (user macros) and a `tikztimingtable` environment with `extracode` overlays such as `\vertlines`
(https://nathantypanski.com/blog/2014-10-29-tikz-timing.html, manual: http://mirrors.ibiblio.org/CTAN/graphics/pgf/contrib/tikz-timing/tikz-timing.pdf).
The license is LPPL 1.3c. The last CTAN release is v0.7f (2017-12-20), and the repo was last pushed 2022-10-25, so it is effectively frozen.

**Strengths for papers:** the typography matches the paper exactly (same fonts, math via `$...$`), and fonts embed natively in the PDF. Its symbols are close to IEEE conventions (clock wedge, inversion bubble, bus markers) and it is the de-facto "looks like a textbook" standard.

**Weaknesses:** no layout at all. Compile is slow, and LaTeX errors are opaque. Getting SVG for the web is lossy. Style is hard to keep consistent across figures unless it is centralized in `\tikzset`.

**BORROW**
- Named **style tokens** that compose, like `\tikzset{every state/.style=...}`. Our JSON should have a `styles` map plus per-element `style: ["register","highlight"]`.
- Anchor vocabulary (`north`, `east`, `in 1`, `out`, `clk`) as port names on symbols.
- The `state with output` split-circle for Moore FSMs, `initial by arrow`, and `accepting by double`.
- The tikz-timing idea of **uppercase = full cycle, lowercase = half cycle**, plus numeric repeat prefixes, as an optional compact wave syntax.
- A "multiple wires marker" (a slash with a width number) as a first-class edge decoration.
- An optional **TikZ/PGF emitter** as a secondary backend, so LaTeX users get native fonts.

**AVOID**
- Requiring a TeX installation for the default path.
- Coordinate-only placement as the *only* mode. Offer hints and constraints, not mandatory x/y.

---

## 2. WaveDrom (WaveJSON, `reg`, `assign`, CLI)

**What it is.** A JavaScript renderer that turns WaveJSON into SVG for digital timing diagrams. It also draws register/bitfield diagrams and `assign` logic diagrams (https://github.com/wavedrom/wavedrom).
- **License / maintenance:** MIT. The npm package `wavedrom` is at 3.7.0 (2026-08-31), and the repo is active (pushed 2026-08-31). The README's standalone editor is labelled v2.4.2, which differs from the npm version.
- **Output:** SVG natively. The README points to `@resvg/resvg-js-cli` for PNG. The skin mechanism is "WaveDromSkin".
- **CLI:** `wavedrom-cli` 3.2.0 (2024-02-22, MIT) takes `-i` input, `-s` SVG output and `-p` PNG output. It needs Node 14+, and its docs suggest Inkscape for PDF/EPS (https://github.com/wavedrom/cli).

**WaveJSON schema** (https://wavedrom.com/tutorial.html):
- `signal: [ {name, wave, data, node, period, phase}, ... ]`. A nested array `["group name", lane, lane, ...]` makes a labelled group, and groups can nest. An empty `{}` is a spacer lane.
- `wave` chars, one per period:
  - Levels: `0 1 x z`.
  - Clocks: `p n` (with edge arrow `P N`), `h l` (held clock level).
  - Transitions: `u d` (pull up/down).
  - Data: `=` and `2`-`9` (colored data).
  - Continuation: `.` extends the previous state; `|` draws a gap/break.
- `data`: an array (or space-separated string) of labels consumed in order by `=`/`2-9` segments.
- `node`: a string aligned with `wave`. Letters mark named anchor points and `.` is a placeholder.
- `edge`: strings `"a~>b label"`. Spline arrows are `~ -~ <~> ~> -~>` and friends. Sharp arrows are `- -| -|- <-> -> -|> |-> +`.
- `config: {hscale, skin}`. `head` / `foot: {text, tick, tock, every}` add a title and cycle numbering.

**`reg` bitfield:** `{reg: [{bits, name, attr, type}], config: {lanes, bits, ...}}`
(https://wavedrom.com/images/SNUG2016_WaveDrom.pdf). The standalone `bit-field` package (MIT, 1.9.0, 2024-02-22) exposes `vspace`, `hspace`, `lanes`, `bits`, `fontsize`, `fontfamily`, `fontweight`, `compact`, `hflip`, `vflip`, `trim`, `offset` (https://github.com/wavedrom/bitfield). A per-field `rotate` option also exists **(unverified)**.

**`assign`:** `{assign: [["out", ["|", ["&","a","b"], ...]]]}` uses nested prefix-operator arrays. It covers AND, OR and similar operators. The full operator list (`~`, `^`, `=`, and so on) is **(unverified)** (SNUG2016 slides above).

**Strengths:** a compact, widely known, diff-friendly text format. Hardware engineers already write it, and it has a large ecosystem (Sphinx, Markdown, Schemdraw import).

**Weaknesses for papers:**
- The default skin uses web fonts and colored data fills that don't suit greyscale print.
- The SVG relies on `<use>`/`<defs>` symbol references, which some SVG-to-PDF converters mishandle **(unverified per converter)**.
- There is no native PDF output.
- Sub-cycle and asynchronous edges are awkward. `period`/`phase` exist, but arbitrary time placement does not.
- Edge label collision avoidance is minimal.

**BORROW**
- **Accept a WaveJSON-compatible subset verbatim**: `signal`, groups, `wave` chars `01xz=.|pnPNhlud2-9`, `data`, `node`, `edge` with the arrow grammar, `config.hscale`, `head/foot`.
- Node-letter anchors plus an edge mini-language for setup/hold and latency annotations.
- The `reg` schema (`bits`, `name`, `attr`, `lanes`) for CSR/packet/instruction-format figures.
- `hscale`, `period` and `phase` as the only timing knobs in v1.

**AVOID**
- WaveDrom's color-filled data as the default. Use a greyscale/hatching theme for print.
- `<use>`-heavy SVG output. Emit flattened paths and text.
- Silently ignoring unknown wave characters. Validate and report the column.

---

## 3. netlistsvg

**What it is.** It draws an SVG schematic from a Yosys `write_json` netlist, and also accepts JSON5 for hand-written input. Layout is done with elkjs (https://github.com/nturley/netlistsvg).
- **Skin files:** SVG templates per cell type (with aliases). Port positions are declared via `s:x`, `s:y`, `s:pid` attributes. CSS classes such as `.width_*` and `.busLabel_*` style wires by bus width. ELK layout properties are embedded in the skin.
- **License / maintenance:** MIT. The latest npm release is 1.0.2 (2020-12-12), and the repo was last pushed 2024-01-25, so it is **low activity**. The README notes that the skin format is not formally specified.

**Strengths:** proves that "Yosys JSON → elkjs → SVG with symbol skins" gives recognisable gate-level schematics, with real AND/OR/MUX/DFF shapes.

**Weaknesses:**
- Synthesized netlists explode into bit-level cells and `$`-named wires.
- The auto layout is technically correct but not "figure-like": long feedback wires and no alignment of pipeline stages.
- Bus-width slashes are not drawn by default **(unverified)**.
- Fonts come from CSS.

**BORROW**
- A **skin/symbol library as data**: SVG body plus named port pins with coordinates plus a declared side. Our `symbols/*.json` should look like this.
- Width-based CSS classes (`width_1`, `width_N`) so buses get heavier strokes.
- Mapping Yosys cell types (`$dff`, `$mux`, `$add`, ...) to symbols, for an optional import path.

**AVOID**
- Rendering raw post-`proc`/`opt` netlists for papers. Paper figures are *hand-abstracted*.
- Unversioned skin formats. Version our symbol schema.

---

## 4. d3-hwschematic

**What it is.** An interactive browser schematic viewer built on D3 and elkjs. It uses layered layout with orthogonal routing, and hierarchical components expand and collapse on click (https://github.com/Nic30/d3-hwschematic).
- **Input:** ELK JSON extended with an `hwMeta` property (name, class, style, collapse state). Collapsed nodes store `_children`/`_edges`. It supports hyperedges.
- **Ecosystem:** hwtLib, sphinx-hwt, jupyter_widget_hwt, and a VS Code extension. It also works with Yosys and hdlConvertor front-ends.
- **License / maintenance:** the repo says EPL-2.0, while npm metadata for 0.1.6 (2021-02-22) says EPL-1.0. The repo is still pushed (2026-05-13), but npm releases are stale.
- **Limitation (README):** edges may only connect nodes at the same hierarchy level or to direct children.

**BORROW**
- **ELK JSON plus a domain `meta` sidecar** as the internal IR. It keeps layout options separate from semantics.
- Hyperedges (one net, many sinks) as first-class objects, rendered with junction dots.
- Collapsible hierarchy, so one spec can render both an SoC view and a zoomed-in block view.

**AVOID**
- Interactivity-only features (zoom, tooltips) in the core renderer.
- Cross-hierarchy edges without explicit hierarchical ports.

---

## 5. DigitalJS

**What it is.** An educational digital circuit simulator for designs synthesized by Yosys, rendered with JointJS (https://github.com/tilk/digitaljs).
- **Input:** JSON with `devices` (each with a `type`), `connectors` (output to input, widths must match) and `subcircuits`. `yosys2digitaljs` (BSD-2, 0.10.3, 2026-02-24) converts Yosys output.
- **License / maintenance:** BSD-2-Clause. npm 0.14.2 (2026-02-10), active.
- **Layout:** automatic via ELK/dagre **(unverified which)**; the README focuses on simulation.

**BORROW**
- A small closed **device-type vocabulary** (gates, arith, mux, dff, mem, io) with typed parameters (`bits`, `polarity`, `arst`).
- Connector width checking: **validate bit-widths at spec load** and fail on mismatches.

**AVOID**
- Simulation and interaction concerns, and JointJS's DOM-dependent rendering (it needs a browser or jsdom).

---

## 6. ELK / elkjs (Layered)

**What it is.** The Eclipse Layout Kernel, with Java ELK transpiled to JavaScript through GWT. It ships `elk-api.js`, `elk-worker.js` and `elk.bundled.js`, plus a Promise-based `layout(graph)`. Algorithms include layered, stress, mrtree, radial, force and disco (https://github.com/kieler/elkjs).
- **License / maintenance:** npm `elkjs` 0.12.0 (2026-07-17) declares `EPL-2.0 OR GPL-3.0-or-later` (npm registry). The repo was pushed 2026-09-09. Background paper: Domrös et al., "The Eclipse Layout Kernel", 2023 (https://arxiv.org/abs/2311.00533).
- **JSON format** (https://eclipse.dev/elk/documentation/tooldevelopers/graphdatastructure/jsonformat.html):
  - Nodes have `id`, `x/y/width/height`, `children`, `ports`, `labels`, `layoutOptions`.
  - Extended edges use `sources[]`/`targets[]`, which allows hyperedges. Each edge has `sections` with `startPoint`, `endPoint` and `bendPoints`.
  - Coordinates are relative to the parent node.

**Layered pipeline (Sugiyama)** (https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html):
1. Cycle breaking (e.g. `GREEDY`). This reverses feedback edges, such as the register-to-mux loops in a datapath.
2. Layering (`NETWORK_SIMPLEX` default). Layer constraints are `layering.layerConstraint` = `NONE|FIRST|LAST|SAME`.
3. Crossing minimization (`LAYER_SWEEP`).
4. Node placement (`nodePlacement.strategy` = `BRANDES_KOEPF` default, `LINEAR_SEGMENTS`, `NETWORK_SIMPLEX`, `INTERACTIVE`).
5. Edge routing (`edgeRouting` = `ORTHOGONAL` default for layered, plus `POLYLINE`, `SPLINES`).

**Key options for schematics:**
- `org.eclipse.elk.portConstraints`: `UNDEFINED|FREE|FIXED_SIDE|FIXED_ORDER|FIXED_RATIO|FIXED_POS`.
- `org.eclipse.elk.port.side` (`NORTH|EAST|SOUTH|WEST`) must be set when constraints are `FIXED_SIDE` or `FIXED_ORDER` (https://eclipse.dev/elk/reference/options/org-eclipse-elk-port-side.html).
- `hierarchyHandling`: `INHERIT|INCLUDE_CHILDREN|SEPARATE_CHILDREN`. `INCLUDE_CHILDREN` lays out across hierarchy levels so hierarchical ports line up.
- Spacing: `spacing.nodeNode` (20), `spacing.edgeEdge` (10), `spacing.portPort` (10).
- Other options exist, such as `layered.portSortingStrategy` (https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-portSortingStrategy.html).

**Strengths:** the only open engine that natively respects **port sides and orders, hierarchical ports, and orthogonal routing** together, which is exactly what schematics need. It runs headless in Node, and it is used by netlistsvg, d3-hwschematic, HDElk and Mermaid.

**Weaknesses:**
- The results are "correct but generic". There is no notion of pipeline stages aligned in columns, of clock and reset nets being special, or of drawing feedback as clean U-turns.
- The GWT bundle is large (about 1-2 MB, **(unverified)**).
- Some option combinations across hierarchy have bugs (e.g. https://github.com/kieler/elkjs/issues/177).
- Label placement on orthogonal edges is basic.

**BORROW**
- **elkjs layered as the default engine for datapath, microarch and SoC diagrams**, with `FIXED_ORDER` ports and sides coming from symbol definitions.
- `layerConstraint FIRST/LAST` for primary inputs and outputs, plus a spec-level `stage: k` that we turn into partitioning (`org.eclipse.elk.partitioning.*`, **(unverified option names)**) so pipeline stages become columns.
- `NETWORK_SIMPLEX` or `BRANDES_KOEPF` node placement as a style knob (`layout.compact`, `layout.straight`).
- `INCLUDE_CHILDREN` for SoC subsystems with hierarchical ports.
- Hyperedge sections, which give free junction-dot positions.

**AVOID**
- Routing clock, reset and scan nets through ELK. Suppress them and draw stubs, triangles or labels instead.
- Relying on ELK for label and text measurement. Measure text ourselves using the real font metrics that go into the PDF.

---

## 7. Graphviz `dot`

**What it is.** The classic Sugiyama-style layered layout engine. Records and HTML-like labels (`<TABLE>`, `<TD PORT="p">`) give nodes named ports, and edges attach with compass points (`n, ne, e, ...`). The docs say records are "largely superseded" by HTML-like labels (https://graphviz.org/doc/info/shapes.html). `rankdir` rotates the layout, and record `{}` groups flip orientation with it.
- **Critical limitation:** for `splines=ortho`, "the routing does not handle ports or, in dot, edge labels" (https://graphviz.org/docs/attrs/splines/). Orthogonal wires plus pin-accurate ports, which is what schematics need, are therefore **not** available.
- **License / maintenance:** EPL-1.0 **(unverified exact version)**. Actively maintained.

**Strengths:** ubiquitous and fast. Rank control (`rank=same`, `constraint=false`), cluster subgraphs, and good spline edges for FSMs and graphs.

**BORROW**
- **FSM fallback**: `dot` with `splines=true` is still good for moderate state graphs (loops, curved labelled transitions).
- `rank=same` / `constraint=false`-style hints in our spec (`sameRank`, `noLayoutConstraint`).
- HTML-table nodes as a model for "record" blocks, such as a pipeline register with fields.

**AVOID**
- `splines=ortho` for datapaths.
- Relying on `dot`'s fonts in SVG. Text is placed with the font Graphviz resolves at layout time, so mismatches appear later.

---

## 8. Yosys `show` (and `viz`)

**What it is.** A Yosys pass that writes Graphviz DOT for a selection and runs `dot` for SVG/PS. Options include `-format`, `-viewer`, `-prefix`, `-color`, `-label`, `-colors`, `-width` (annotate bus widths), `-signed`, `-stretch` (inputs left, outputs right), `-lib`, `-notitle`, `-long`, `-enum` (https://yosyshq.readthedocs.io/projects/yosys/en/latest/cmd/index_passes_status.html).

**Visual conventions** (https://yosyshq.readthedocs.io/projects/yosys/en/latest/using_yosys/more_scripting/interactive_investigation.html):
- Ports are octagons, and cells are rectangles with inputs left and outputs right.
- Constants are ellipses.
- Single-bit wires are thin arrows and multi-bit wires are thick arrows.
- Slicing and concatenation appear as rounded "break-out boxes" labelled `<MSB>:<LSB>`.

The docs admit that large-module diagrams "are just stupidly big". Amaranth emits RTLIL for Yosys, so Amaranth designs are usually visualized this way (https://github.com/amaranth-lang/amaranth-yosys). `viz` draws data-flow graphs (https://yosyshq.readthedocs.io/projects/yosys/en/0.45/cmd/viz.html). Yosys is ISC-licensed **(unverified)**.

**BORROW**
- **Stroke weight encodes width** (thin = 1 bit, thick = bus), plus explicit `[msb:lsb]` break-out labels at slices and concatenations.
- The `-stretch` convention: inputs left, outputs right.
- Constant nodes as small labelled terminals, not full blocks.

**AVOID**
- Octagon ports and rectangle-for-everything. Papers expect mux trapezoids, adder shapes, and DFF boxes with clock wedges.

---

## 9. Synopsys Verdi nSchema / nState; Cadence SimVision (proprietary)

**What they are.** Verdi includes nTrace (source), nWave (waves), **nSchema** (RTL or gate schematic with net values annotated at the cursor time) and **nState** (FSM extraction and bubble diagrams). Its RTL view is a synthesized-style schematic that distinguishes clock, reset, set, flop/latch outputs and tristate signals (https://ecrionix.org/tools/verdi/, https://www.coursehero.com/file/239389/Introduction-to-Verdi/). Cadence SimVision has a schematic tracer **(unverified details)**. All of these are closed-source and licensed per seat.

**Conventions (from user guides and training material; mostly unverified in public docs):**
- Flops drawn as rectangles with a clock triangle and D/Q pins.
- Muxes as trapezoids with the select on the narrow side.
- Combinational "clouds" or generic logic boxes for collapsed RTL expressions.
- **Bus rippers/breakouts** (the EDIF term is "ripper"; https://static.assets-stash.eet-china.com/album/old-resources/2008/4/23/c2645fca-3a08-44e9-af60-b9509ac57c64.pdf) where bits leave a bus.
- Hierarchical instance boxes that you can push into.
- Net values overlaid on wires.
- nState draws states as circles or ellipses with transition conditions on arcs **(unverified)**.

**BORROW**
- The "RTL-level abstraction" symbol set: register, mux, comparator, arithmetic block, and a generic comb-logic cloud or box. Paper readers expect this, not gates.
- Bus ripper notation (a diagonal stub with a `[7:0]` label) for bit slices.
- Optional **value annotations** on nets (e.g. `=0x3F` in small italics) for "worked example" figures.

**AVOID**
- EDA screenshot aesthetics: dense colored wires on black backgrounds, and auto-generated instance names.

---

## 10. Others worth noting

**Schemdraw** (Python, MIT, 0.23 released 2026-05-29; https://pypi.org/pypi/schemdraw/json, https://schemdraw.readthedocs.io/en/latest/)
- Programmatic placement of schematic elements. It has `logic` gates and `schemdraw.logic.TimingDiagram`.
- `TimingDiagram.from_json()` **accepts WaveJSON pasted verbatim**. It adds `async` (non-period-boundary transitions), `level`, `shade`, extended edge syntax, and diagram params `yheight`, `ygap`, `risetime`, `fontsize`, `grid`, `nodealign` (https://schemdraw.readthedocs.io/en/latest/elements/timing.html).
- Backends are matplotlib and native SVG **(unverified backend list)**.
- **BORROW:** `async` transition times and `risetime` (slanted edges) as WaveJSON extensions, and data-segment `shade`.
- **AVOID:** a dependency on matplotlib.

**Symbolator** (MIT; PyPI 1.0.2 from 2017; https://github.com/kevinpt/symbolator; community fork https://github.com/hdl/symbolator, both last pushed 2023-02)
- Parses VHDL/Verilog entities and modules and draws **component symbols**: a box with grouped ports on each side, rendered through Cairo/Pango to SVG, PNG, PDF, PS and EPS. It ships a Sphinx extension.
- **BORROW:** port **grouping sections** (a labelled divider inside a block, like "AXI-Lite" or "Stream") and bus-port styling. These are ideal for IP-block figures.
- **AVOID:** the Pango/GTK install burden. The project is effectively unmaintained.

**WaveDrom BitField**: see §2. The standalone package is `bit-field` (MIT).

**Mermaid `stateDiagram-v2`** (MIT, npm `mermaid` 12.0.0 released 2026-09-10; https://mermaid.js.org/syntax/stateDiagram.html)
- Syntax: `A --> B: label`, composite `state X { }`, `<<choice>>`, `<<fork>>`/`<<join>>`, notes, `direction LR`.
- The fetched docs summary said the renderer defaults to ELK. Historically it was dagre, and the current default is **(unverified)**.
- **BORROW:** a compact textual transition list as an *import* format.
- **AVOID:** Mermaid's theme CSS and `foreignObject` HTML labels. They break in SVG-to-PDF converters **(unverified per converter)**.

**draw.io / diagrams.net** (Apache-2.0, https://github.com/jgraph/drawio) and **Excalidraw** (MIT, https://github.com/excalidraw/excalidraw)
- Manual editors, and the most common way paper figures are actually made today. They produce pixel-perfect intent but are not reproducible, not diffable, and styles drift between figures.
- **BORROW:** snap-to-grid and consistent port-stub lengths. Consider exporting `.drawio` XML so authors can hand-tweak after auto layout.
- **AVOID:** Excalidraw's hand-drawn look for papers.

**TerosHDL** (GPL-3.0, https://github.com/TerosTechnology/vscode-terosHDL, pushed 2026-08-07)
- A VS Code IDE with a **schematic viewer** that runs Yosys (a native binary, or a bundled WebAssembly Yosys; GHDL for VHDL) with `proc; opt; write_json` (https://terostechnology.github.io/terosHDLdoc/docs/guides/schematic_viewer/usage/). It also has a state-machine viewer.
- The rendering backend is not documented, and netlistsvg is likely **(unverified)**.
- **BORROW:** automatic FSM extraction from `case` statements as a future import path.

**Chisel/FIRRTL `diagrammer`** (Apache-2.0, https://github.com/freechipsproject/diagrammer, last pushed 2023-04-14)
- Converts FIRRTL to Graphviz DOT and SVG, one diagram per module plus a top-level hierarchy diagram with clickable modules.
- **BORROW:** the module-hierarchy overview figure (instance tree) as a separate figure kind.
- **AVOID:** dot's port and ortho problems (§7).
- CIRCT/firtool graph-dump flags are **(unverified)**.

**HDElk** (Apache-2.0, https://github.com/davidthings/hdelk, last pushed 2023-05-01)
- Builds web block diagrams for documentation from a small JS object.
- Nodes have `id`, `label`, `type`, `children`, `ports`, `inPorts`, `outPorts`, `northPorts`, `southPorts`, `eastPorts`, `westPorts`, `parameters` (top-side ports), `color`, `highlight` (1-6, 0 = dim), `constant`, `port`, `width`, `height`.
- Edges are `["a.p","b.q"]` or `{route, bus, highlight, label, reverse}`. It preprocesses into ELK JSON and renders with SVG.js (https://davidthings.github.io/hdelk/tutorial.html).
- **BORROW:** this is *the closest existing analogue to our spec*. Take its terse port-side arrays, the `bus` flag, **numbered highlight schemes** (for "the path taken by a branch mispredict" figures), and `parameters` on the top edge.
- **AVOID:** its untyped JS objects and its browser-only rendering.

**pyhdl-schematic:** no project by that name was found. Related Python projects are `svg-schematic` (1.3, July 2025; https://pypi.org/project/svg-schematic/), py4hw (https://github.com/davidcastells/py4hw) and Hdl21Schematics (https://github.com/Vlsir/Hdl21Schematics). All are **(unverified depth)**.

**Weave** (arXiv 2607.03835, 2026; https://arxiv.org/abs/2607.03835)
- Converts SPICE netlists to LTspice schematics with layered layout, and **round-trip verifies connectivity** (schematic → netlist → net-for-net compare).
- **BORROW:** a `verify` step that re-extracts connectivity from our laid-out IR and checks it against the spec.

**OpenROAD:** not relevant, since it does physical layout rather than schematics.

---

## 11. Synthesis: recommended architecture

### 11.1 Pipeline

```
spec.json ──validate (JSON Schema + width/port checks)──▶ typed IR
   │
   ├─ kind: datapath | microarch | soc ──▶ ELK JSON (fixed port sides/order, stage partitions,
   │                                         INCLUDE_CHILDREN) ─▶ elkjs layered ─▶ post-process
   │                                         (bus slashes, junction dots, clock/reset stubs, labels)
   ├─ kind: fsm ──▶ small graphs: circular/manual-grid placement + curved arcs
   │                larger: elkjs layered (SPLINES) or Graphviz dot fallback
   ├─ kind: timing ──▶ own renderer for WaveJSON-compatible subset (+ async/risetime ext.)
   └─ kind: bitfield ──▶ own renderer for WaveDrom `reg` schema
                                   │
                            SVG writer (flat paths + <text>, no <use>/foreignObject/CSS vars)
                                   │
                  PDF: rsvg-convert -f pdf | cairosvg | inkscape --export-type=pdf
                  optional: TikZ emitter for LaTeX-native output
```

### 11.2 Spec decisions

1. **Symbols are data.** Each symbol defines an SVG body, pins `{name, side, order, offset}`, and anchors, as in netlistsvg skins and CircuiTikZ anchors. Built-in symbols: `reg` (clock wedge, optional enable/reset pins), `mux` (trapezoid, select entering a slanted side, input indices; see CONVENTIONS §3), `adder`/`alu`, `cmp`, `logic` (generic box or cloud), `mem`, `fifo`, `const`, `port`, and `ripper`.
2. **Ports carry `width`.** Edges inherit the width and are validated as in DigitalJS. Rendering encodes width with stroke weight plus a **slash-and-number marker** when width > 1 (Yosys `-width`, CircuiTikZ multiple-wire markers). Slices use ripper notation `[msb:lsb]`.
3. **Pipeline stages:** `stage: n` on nodes turns into ELK partitions or layer constraints. Stage boundaries get drawn as pipeline-register bars that span every crossing net (CONVENTIONS §5.3).
4. **Special nets:** `clk`, `rst` and `en` are marked `global: true`. By default they are not routed and are drawn as pin stubs with a label or clock wedge. Exception: CDC and clock-gating figures route clocks explicitly (CONVENTIONS §7).
5. **Timing:** accept WaveJSON as-is (`signal`, groups, `wave`, `data`, `node`, `edge`, `config.hscale`, `head/foot`). Add optional extensions under an `x-` prefix (`async`, `risetime` from Schemdraw) so the files still open in WaveDrom.
6. **FSM spec:** `{states: [{id, label, encoding, outputs, initial, terminal}], transitions: [{from, to, cond, actions}]}` in TikZ-automata vocabulary (Moore outputs in a split circle, Mealy `cond / out` on arcs). Do not render double circles for `terminal`; see CONVENTIONS §8. Layout: at most 8 states on a circle or grid heuristic; larger machines use elkjs or dot with splines.
7. **Style tokens** (TikZ `\tikzset`-like): `theme` (`paper-bw`, `paper-color`, `slides`), `font` (family, size, which must match the paper, e.g. Times/Libertinus/Helvetica), `stroke.{wire,bus,box}`, and `highlight[1..6]` (HDElk), capped at 3 non-gray hues per figure (CONVENTIONS §0.4). Default to a greyscale-safe, colorblind-safe palette.
8. **Highlight paths:** `highlight: k` on nodes and edges, as in HDElk, plus `dim` for everything else.

### 11.3 SVG → PDF and fonts

- Emit plain `<text>` with an explicit `font-family` from the theme, and **measure text with the same font file** (e.g. fontkit/opentype.js **(unverified choice)**) before layout so ELK node sizes are exact.
- **rsvg-convert** `-f pdf` keeps text as selectable text and embeds subsetted fonts through Cairo. Some fonts fail to subset and get embedded whole (https://man.archlinux.org/man/rsvg-convert.1.en, https://www.itsfullofstars.de/2017/06/convert-svg-to-pdf/). Fonts must be installed or visible to fontconfig (`FONTCONFIG_FILE`).
- **CairoSVG** (LGPL-3.0, 2.9.1): has **no `@font-face` or SVG-font support**, only system fonts, and only 3 filters. It lacks kerning and letter-spacing (https://cairosvg.org/documentation/).
- **Inkscape** CLI: `--export-type=pdf --export-filename=...` (https://wiki.inkscape.org/wiki/Using_the_Command_Line). The text-to-path and LaTeX-text export flags are **(unverified on that page)**, though they are documented in `man inkscape`.
- Recommendation: rsvg-convert is the primary converter. CONVENTIONS §0.2 makes outlined text the default for PDF export, with live text kept in SVG. Offer a `--text-to-path` switch (outline fonts in our own SVG writer) for venues that reject non-embedded fonts. Always run `pdffonts` in CI to assert that every font is embedded.

### 11.4 Comparison table

| Tool | Input | Layout | Output | License | Activity (last seen) | Best for | Main drawback for papers |
|---|---|---|---|---|---|---|---|
| CircuiTikZ/TikZ | LaTeX macros | manual | PDF (SVG via dvisvgm) | GPL/LPPL | 1.8.7, 2026-09 | typographic match | no layout, needs TeX |
| tikz-timing | char string | fixed grid | PDF | LPPL 1.3c | 0.7f, 2017 | LaTeX waveforms | frozen, TeX only |
| TikZ automata | TikZ | manual | PDF | LPPL (PGF) (unverified) | with PGF | FSM styling | no layout |
| WaveDrom | WaveJSON | fixed grid | SVG (PNG) | MIT | 3.7.0, 2026-08 | timing, bitfields | web styling, no PDF |
| bit-field | JSON array | fixed | SVG | MIT | 1.9.0, 2024-02 | register maps | minimal typography |
| netlistsvg | Yosys JSON | elkjs | SVG | MIT | 1.0.2, 2020 (push 2024) | gate schematics | netlist-level clutter |
| d3-hwschematic | ELK JSON + hwMeta | elkjs | SVG (interactive) | EPL-2.0 (npm: EPL-1.0) | push 2026-05 | hierarchical browse | web-only, stale npm |
| DigitalJS | devices/connectors JSON | JointJS (+auto) | DOM/SVG | BSD-2 | 0.14.2, 2026-02 | teaching sims | not a figure tool |
| elkjs | ELK JSON | layered/others | coordinates | EPL-2.0 OR GPL-3.0+ | 0.12.0, 2026-07 | port-aware ortho layout | generic look, big bundle |
| Graphviz dot | DOT | layered | SVG/PDF/PS | EPL (unverified) | active | FSMs, trees | ortho ignores ports |
| Yosys show | RTLIL selection | dot | SVG/PS/DOT | ISC (unverified) | active | quick netlist look | octagons, huge graphs |
| Verdi/SimVision | compiled design | proprietary | GUI | commercial | n/a | debug | screenshots only |
| Schemdraw | Python API / WaveJSON | manual / grid | SVG, matplotlib | MIT | 0.23, 2026-05 | logic + timing in Python | manual placement |
| Symbolator | VHDL/Verilog | fixed box | SVG/PDF/PNG/EPS | MIT | 1.0.2, 2017 | IP-block symbols | unmaintained, GTK deps |
| Mermaid state | text DSL | ELK/dagre (unverified) | SVG | MIT | 12.0.0, 2026-09 | quick FSM sketch | foreignObject labels |
| HDElk | JS object | elkjs | SVG (web) | Apache-2.0 | push 2023-05 | doc block diagrams | untyped, browser-only |
| diagrammer | FIRRTL | dot | DOT/SVG | Apache-2.0 | push 2023-04 | Chisel hierarchy | dot limits |
| TerosHDL | HDL via Yosys | (unverified) | webview | GPL-3.0 | push 2026-08 | IDE viewing | not for publication |
| draw.io / Excalidraw | GUI | manual | SVG/PDF/PNG | Apache-2.0 / MIT | active | hand polish | not reproducible |

### 11.5 Bottom line

Nothing on this list covers *typed spec → print-ready vector figure* across all five figure kinds. The closest matches are HDElk (spec shape), netlistsvg (symbols as data plus elkjs), WaveDrom (timing format) and CircuiTikZ (visual conventions).

Build our own renderer with these pieces:
- **elkjs layered** with `FIXED_ORDER` ports, stage partitions and `INCLUDE_CHILDREN` for structural figures.
- A **custom FSM placer** with an elkjs or dot fallback.
- **WaveJSON- and `reg`-compatible** timing and bitfield renderers.
- **Font-metric-aware** text measurement.
- A flat SVG writer with **rsvg-convert** for PDF, plus an optional TikZ emitter.
