# fig-gen

Claude Code skill for paper-quality hardware figures from typed JSON:
datapath (RTL block/schematic), FSM, timing (waveform) and micro-architecture
diagrams, delivered as editable figma-safe SVG plus outlined-text PDF in both
single- and double-column variants, with RTL cross-checks.

Status: **Phase 2** — datapath and microarch/SoC figures are rendered and
delivered (SVG + outlined PDF + receipt) with semantic checks, source-pin
verification, the evidence guard, structural RTL cross-checks and gate-level
equivalence for mixed-abstraction regions. FSM and timing rendering are Phase 3
(schemas and specs exist). See `docs/PHASE2_SUMMARY.md`.

## INSTALL

Requirements: Node.js ≥ 20, Git. Optional: Verilator 5.x (RTL extraction and
simulation), a headless Chrome or Chromium (visual check).

Install as a personal skill (all projects):

```bash
git clone <lab-remote>/fig-gen.git ~/.claude/skills/fig-gen
cd ~/.claude/skills/fig-gen
npm ci
node bin/fig-gen.mjs doctor
```

Or as a project skill (checked into / next to one repository):

```bash
git clone <lab-remote>/fig-gen.git .claude/skills/fig-gen
cd .claude/skills/fig-gen && npm ci && node bin/fig-gen.mjs doctor
```

Restart Claude Code afterwards so it picks up `SKILL.md`.

`doctor` reports Node, dependencies, Verilator and Chrome/Chromium. Tool
discovery uses `PATH` and well-known install locations; override with:

| Variable | Meaning |
|---|---|
| `FIGGEN_VERILATOR` | Verilator executable |
| `FIGGEN_CHROME` | Chrome/Chromium executable |
| `FIGGEN_ADAPTER` | default RTL adapter id |
| `FIGGEN_ADAPTER_PATH` | path-list of extra adapter modules |

Nothing in this repository refers to a specific machine, user, host, license
server or vendor tool; site-specific tools are plugged in through
`fig-gen.config.json` (see `references/adapters.md`).

## Commands (Phase 2)

```bash
# figures without RTL
node bin/fig-gen.mjs validate datapath examples/datapath-pipelined-xor.json --json
node bin/fig-gen.mjs deliver  datapath examples/datapath-pipelined-xor.json out/xor
node bin/fig-gen.mjs deliver  microarch examples/microarch-soc-accelerator.json out/soc

# figures checked against your own RTL
node bin/fig-gen.mjs check-rtl --top my_top --files rtl/*.sv --source-root . --work-dir /tmp/figgen --out netlist.json --summary
node bin/fig-gen.mjs crosscheck datapath my_block.datapath.json --netlist netlist.json
node bin/fig-gen.mjs expand-cone --netlist netlist.json --instance u_core/u_dec --output err_flag --out gates.json
node bin/fig-gen.mjs deliver datapath my_block.datapath.json out/my_block --netlist netlist.json

# utilities
node bin/fig-gen.mjs lint-svg out/xor/datapath-pipelined-xor.2col.svg
node scripts/preview.mjs --out preview.png out/xor/*.svg
node bin/fig-gen.mjs doctor
npm test
```

`deliver` writes `<name>.2col.svg/.pdf` (required), `<name>.1col.svg/.pdf`
(best effort; skipped with an info diagnostic if one column cannot be made
legible), address-map tables for SoC figures, and `<name>.receipt.json` with
per-region verification, evidence origins and per-variant route metrics
(straight data nets, redundant jogs, crossings per class).

`--quality paper` (validate/render/deliver) turns readability warnings such as
`label/unreadable` (mnemonics or RTL names printed as block names) into errors.
Blocks are named by `function` from `schemas/function-vocabulary.json`; see
`references/CONVENTIONS.md` §4.3.

## License

MIT. Dependencies and their licenses: `THIRD_PARTY_NOTICES.md`.
