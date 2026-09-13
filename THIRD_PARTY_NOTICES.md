# Third-party notices

fig-gen is MIT licensed and shared with lab colleagues only (not published).
Dependencies are installed unmodified from npm with exact versions pinned in
`package-lock.json`; none are vendored or copied into this repository. Keep this
list in sync with the lockfile when dependencies change.

## Direct dependencies

| Package | Version | License | Use |
|---|---|---|---|
| ajv | 8.20.0 | MIT | JSON Schema validation |
| elkjs | 0.12.0 | EPL-2.0 OR GPL-3.0-or-later | graph layout (ELK Layered), optional dependency, used unmodified |
| opentype.js | 2.0.0 | MIT | text measurement and PDF text outlining |
| pdfkit | 0.20.2 | MIT | PDF writer |
| svg-to-pdfkit | 0.1.8 | MIT | SVG → PDF conversion (outlined-text SVG only) |
| wavedrom | 3.7.0 | MIT | timing diagram rendering (Node library API; Phase 3) |
| @fontsource/arimo | 5.3.0 | OFL-1.1 | bundled sans font (metric-compatible with Arial) |
| @fontsource/tinos | 5.3.0 | OFL-1.1 | bundled serif font (metric-compatible with Times) |
| @fontsource/libertinus-serif | 5.3.0 | OFL-1.1 | bundled serif font (ACM-style body) |

Fonts are used for measurement and are outlined into PDFs; they are not
embedded in PDFs and the SVGs only name the family.

## Transitive dependencies

| Package | Version | License |
|---|---|---|
| @noble/ciphers | 1.3.0 | MIT |
| @noble/hashes | 1.8.0 | MIT |
| @swc/helpers | 0.5.23 | Apache-2.0 |
| ansi-regex | 5.0.1 | MIT |
| ansi-styles | 4.3.0 | MIT |
| base64-js | 1.5.1, 0.0.8 | MIT |
| bit-field | 1.9.0 | MIT |
| brotli | 1.3.3 | MIT |
| cliui | 8.0.1 | ISC |
| clone | 2.1.2 | MIT |
| color-convert | 2.0.1 | MIT |
| color-name | 1.1.4 | MIT |
| dfa | 1.2.0 | MIT |
| emoji-regex | 8.0.0 | MIT |
| escalade | 3.2.0 | MIT |
| estraverse | 5.3.0 | BSD-2-Clause |
| fast-deep-equal | 3.1.3 | MIT |
| fast-uri | 3.1.7 | BSD-3-Clause |
| fflate | 0.8.3 | MIT |
| fontkit | 2.0.4 | MIT |
| fs-extra | 11.4.0 | MIT |
| get-caller-file | 2.0.5 | ISC |
| graceful-fs | 4.2.11 | ISC |
| is-fullwidth-code-point | 3.0.0 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| json5 | 2.2.3 | MIT |
| jsonfile | 6.2.1 | MIT |
| linebreak | 1.1.0 | MIT |
| logidrom | 1.0.0 | MIT |
| onml | 2.1.0 | MIT |
| pako | 0.2.9 | MIT |
| png-js | 2.0.0 | MIT (license file; no package.json field) |
| require-directory | 2.1.1 | MIT |
| require-from-string | 2.0.2 | MIT |
| restructure | 3.0.2 | MIT |
| sax | 1.6.1 | BlueOak-1.0.0 |
| string-width | 4.2.3 | MIT |
| strip-ansi | 6.0.1 | MIT |
| tiny-inflate | 1.0.3 | MIT |
| tslib | 2.8.1 | 0BSD |
| tspan | 0.4.0 | MIT |
| unicode-properties | 1.4.1 | MIT |
| unicode-trie | 2.0.0 | MIT |
| universalify | 2.0.1 | MIT |
| wrap-ansi | 7.0.0 | MIT |
| y18n | 5.0.8 | ISC |
| yargs | 17.7.3 | MIT |
| yargs-parser | 21.1.1 | ISC |

## External tools (not distributed)

Discovered at runtime on the user's machine: Verilator (open-source HDL
front-end/simulator) and, optionally, a headless Chrome or Chromium for
previews and the visual check.

## Design ideas (no code copied)

- Archify (MIT): typed JSON IR with strict schemas, diagnostics with supported
  fixes, delivery receipts, a separate browser visual check.
- netlistsvg (nturley/netlistsvg, MIT): the monochrome schematic look and the
  "symbols as data with named, positioned pins laid out by ELK" skin
  architecture. No netlistsvg code or skin geometry is copied and the package
  is not a dependency; symbol geometry in `skins/` and `lib/render/gates.mjs`
  was drawn for this project from CONVENTIONS.md. If geometry is ever copied
  from a netlistsvg skin, add its MIT notice to that file and record it here.
