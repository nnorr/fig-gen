# ADR 0002 — Waveform (timing) figures

Status: proposed (Phase 1), revised 2026-09-13 after correcting a wrong
assumption about WaveDrom.

## Context

Timing diagrams in papers need a cycle axis, latency/handshake arrows, bus
values with widths, grayscale output, exact column-width sizing, and an SVG
that stays editable. Engineers already keep WaveDrom WaveJSON snippets.
Hand-drawn waveforms are frequently wrong (off-by-one latency, irregular
clocks).

The first draft of this ADR rejected WaveDrom on the belief that its CLI needs
a headless browser. That is wrong: `wavedrom-cli` 3.2.0 and the `wavedrom`
library 3.x render SVG in plain Node (library + `onml`).

## Options considered

1. **Own deterministic waveform renderer** — full control, but reimplements a
   mature, widely known renderer and its grammar. Rejected.
2. **wavedrom-cli** — works in Node, but pulls `svg2img`/`yargs` for PNG and
   argument parsing we don't need, and adds a process boundary to tests.
3. **wavedrom library API** (`renderAny(0, source, waveSkin)` → `onml.s`),
   pinned — chosen.

## Decision

- Timing figures are WaveJSON rendered by the pinned `wavedrom` npm library
  (3.7.0, MIT) through its Node API.
- Annotations use native WaveDrom features: `node`/`edge` arrows with labels
  for latency and handshakes, `head`/`foot` ticks for the cycle axis,
  `config.hscale` for cycle width.
- fig-gen adds only the value around it (SPEC §6):
  1. grounding: `verilator --binary --trace` → VCD → `vcd2wavejson`
     (signal + cycle-window selection) with VCD hash provenance;
  2. consistency checks on WaveJSON: clock periodicity, bus transitions vs
     data, latencies (edge node distance) vs declared cycles vs datapath
     register stages;
  3. column fitting: per-variant hscale and cycle/signal limits, bounded by the
     printed minimum font size;
  4. a figma-safe post-process of WaveDrom's SVG (inline CSS, expand
     `<use>`/`<defs>`, explicit arrowheads instead of markers, start-anchored
     real text, pt units, meaningful group ids), checked by the same lint as
     other figure types;
  5. PDF from that SVG with outlined text.
- fig-gen' own tests use tiny self-written testbenches under
  `tests/fixtures/`; user projects' testbenches are never modified.

## Consequences

- The post-process depends on WaveDrom's SVG structure; pin the exact version
  and keep a golden test on a representative snippet so an upgrade that
  changes structure fails loudly.
- WaveDrom geometry is scaled to fit a column (unlike ELK figures, which are
  re-laid out per variant); the font-size check bounds that scaling.
- The skin's font is swapped for the configured family before text
  measurement so alignment matches the PDF outlines.
