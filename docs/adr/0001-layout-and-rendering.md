# ADR 0001 — Layout engine and rendering path

Status: proposed (Phase 1). Date: 2026-09-13.

## Context

Datapath and micro-architecture figures are directed graphs with *ports on
fixed sides in a fixed order* (mux inputs top→bottom, select on the bottom),
wide buses, pipeline stages that must line up in columns, and optional
hierarchy. Output must be deterministic (golden SVG bytes), run in pure Node,
and be repairable by an agent through bounded hints.

## Options considered

| Option | Ports / sides | Orthogonal routing | Stage columns | Hierarchy | Node-only | License | Verdict |
|---|---|---|---|---|---|---|---|
| **ELK Layered (elkjs)** | yes: side + fixed order | yes | yes: partitioning | yes: compound nodes | yes (pure JS) | EPL-2.0 | **chosen** |
| dagre | no port model | no (polyline) | no | limited clusters | yes | MIT | too weak for schematics |
| Graphviz dot (wasm) | record ports, no side contract | `splines=ortho` ignores ports/labels | rank=same hacks | clusters | yes (wasm) | EPL (Graphviz) | good for FSMs, poor for datapaths |
| netlistsvg | via ELK + skin | yes | no | limited | yes | MIT | tied to yosys gate netlists; prior art, not an IR renderer |
| d3-hwschematic | ELK | yes | no | yes | browser/d3 | Apache-2.0 | browser-centric, interactive viewer |
| libavoid / adaptagrams (wasm) | yes | yes (routing only) | no placement | no | wasm | LGPL | router only; would need our own placement |
| Hand coordinates (Archify-style) | author-controlled | renderer | author | author | yes | — | not scalable for 30+ element datapaths; kept as override |

## Decision

1. Use **ELK Layered via elkjs** (pinned exact version, `elk.randomSeed`
   fixed) for `datapath` and `microarch`: direction RIGHT, `edgeRouting:
   ORTHOGONAL`, `portConstraints: FIXED_ORDER`, per-port `port.side`,
   `partitioning` for pipeline stages, `hierarchyHandling: INCLUDE_CHILDREN`
   for expanded instances. elkjs is consumed as an unmodified dependency
   (EPL-2.0 permits this alongside MIT code); it is loaded lazily so
   validation-only runs don't need it.
2. `fsm`: ELK Layered (DOWN, `SPLINES`) for state placement; our renderer
   draws self-loops, any-state and reset arcs. Revisit Graphviz only if ELK
   spline quality is unacceptable on the eval set.
3. `timing`: renderer-owned grid; no graph layout.
4. Rendering: pure Node string SVG in physical units; the SVG is the
   editable artifact and keeps real `<text>`. The PDF is print-only and
   contains **outlined text, no fonts**: the variant SVG's `<text>` elements
   are converted in memory to glyph paths with opentype.js (MIT) using the
   same font file and metrics as layout, then converted to PDF primarily via
   pdfkit + svg-to-pdfkit (MIT, pure Node, fixed metadata for
   reproducibility); headless Chrome print of the outlined SVG is the
   fallback and the visual-check engine. Outlining sidesteps font embedding
   and font-license review for the PDF entirely. Both PDF paths are validated
   in a Phase 2 spike (dashes, hatch lines, glyph fidelity, byte stability);
   if pdfkit fails the spike, Chrome print becomes primary and PDF hashes are
   recorded but not golden-tested.
5. Figma / Inkscape round-trip is **not** part of the pipeline; the JSON IR is
   the source of truth and a hand-polished file is never read back. What we do
   guarantee is that the delivered SVG is **figma-safe** (SPEC §10.1: real
   `<text>`, inline presentation attributes, no markers/use/patterns/filters,
   named `<g id>` layer hierarchy, physical units) so a user *can* open it for
   last-mile polish. Acceptance test for that property, later and optional:
   upload each variant SVG through the Figma MCP, read back the layer tree,
   and assert text nodes stay text, group names match the SVG ids, and the
   frame size equals the column width. This test is out-of-band (needs an
   account) and never gates `deliver`.
6. Column variants: each variant (`1col`, `2col`, from data profiles) gets its
   own ELK run with variant-specific options (direction, `aspectRatio`,
   wrapping via `elk.layered.wrapping.strategy`, compaction) and label
   choices; variants are never produced by scaling one layout.

## Consequences

- Layout quality depends on ELK options; we must keep a regression eval set
  (golden SVGs + geometry diagnostics) and pin the elkjs version.
- Text must be measured before layout (bundled font metrics), so fonts are a
  build input and part of the receipt hash.
- ELK's Java-to-JS runtime is heavy (~8 MB); acceptable for a CLI.
- The EPL-2.0 dependency must be listed in THIRD_PARTY_NOTICES when bundled.
