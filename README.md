# rtl-figures

Claude Code skill for paper-quality hardware figures from typed JSON:
datapath (RTL block/schematic), FSM, timing (waveform) and micro-architecture
diagrams, delivered as editable figma-safe SVG plus outlined-text PDF in both
single- and double-column variants, with RTL cross-checks.

Status: **Phase 1** — specification (`SPEC.md`), ADRs (`docs/adr/`), schemas,
CLI stub, Verilator netlist extraction with automatic blackbox stubs. Rendering
is not implemented yet.

## INSTALL

Requirements: Node.js ≥ 20, Git. Optional: Verilator 5.x (RTL extraction and
simulation), a headless Chrome or Chromium (visual check).

Install as a personal skill (all projects):

```bash
git clone <lab-remote>/rtl-figures.git ~/.claude/skills/rtl-figures
cd ~/.claude/skills/rtl-figures
npm ci
node bin/rtl-figures.mjs doctor
```

Or as a project skill (checked into / next to one repository):

```bash
git clone <lab-remote>/rtl-figures.git .claude/skills/rtl-figures
cd .claude/skills/rtl-figures && npm ci && node bin/rtl-figures.mjs doctor
```

Restart Claude Code afterwards so it picks up `SKILL.md`.

`doctor` reports Node, dependencies, Verilator and Chrome/Chromium. Tool
discovery uses `PATH` and well-known install locations; override with:

| Variable | Meaning |
|---|---|
| `RTLFIG_VERILATOR` | Verilator executable |
| `RTLFIG_CHROME` | Chrome/Chromium executable |
| `RTLFIG_ADAPTER` | default RTL adapter id |
| `RTLFIG_ADAPTER_PATH` | path-list of extra adapter modules |

Nothing in this repository refers to a specific machine, user, host, license
server or vendor tool; site-specific tools are plugged in through
`rtl-figures.config.json` (see `references/adapters.md`).

## Commands (Phase 1)

```bash
node bin/rtl-figures.mjs validate datapath examples/datapath-pipelined-xor.json --json
node bin/rtl-figures.mjs lint-svg some-figure.svg --json
node bin/rtl-figures.mjs check-rtl --top my_top --files rtl/*.sv --work-dir /tmp/rtlfig --out netlist.json --summary
node bin/rtl-figures.mjs adapters
npm test
```

## License

MIT. Dependencies and their licenses: `THIRD_PARTY_NOTICES.md`.
