# Third-party notices

rtl-figures is MIT licensed and shared with lab colleagues only (not
published). Dependencies are installed unmodified from npm with versions
pinned in `package-lock.json`; none are vendored or copied into this
repository. Keep this list in sync with the lockfile when dependencies change.

| Package | Version | License | Use |
|---|---|---|---|
| ajv | 8.20.0 | MIT | JSON Schema validation |
| fast-deep-equal | 3.1.3 | MIT | ajv dependency |
| fast-uri | 3.1.7 | BSD-3-Clause | ajv dependency |
| json-schema-traverse | 1.0.0 | MIT | ajv dependency |
| require-from-string | 2.0.2 | MIT | ajv dependency |
| elkjs | 0.12.0 | EPL-2.0 OR GPL-3.0-or-later | graph layout (ELK Layered), optional dependency, used unmodified |
| wavedrom | 3.7.0 | MIT | timing diagram rendering (Node library API) |
| onml | 2.1.0 | MIT | wavedrom dependency (SVG tree ↔ string) |
| sax | 1.6.1 | BlueOak-1.0.0 | onml dependency |
| json5 | 2.2.3 | MIT | wavedrom dependency |
| tspan | 0.4.0 | MIT | wavedrom dependency |
| logidrom | 1.0.0 | MIT | wavedrom dependency |
| bit-field | 1.9.0 | MIT | wavedrom dependency |
| fs-extra, jsonfile, graceful-fs, universalify | 11.4.0, 6.2.1, 4.2.11, 2.0.1 | MIT / MIT / ISC / MIT | wavedrom dependencies |
| yargs, yargs-parser, cliui, y18n, get-caller-file, require-directory, escalade | 17.7.3, 21.1.1, 8.0.1, 5.0.8, 2.0.5, 2.1.1, 3.2.0 | MIT / ISC / ISC / ISC / ISC / MIT / MIT | wavedrom CLI dependencies (installed, unused) |
| string-width, strip-ansi, ansi-regex, ansi-styles, wrap-ansi, emoji-regex, is-fullwidth-code-point, color-convert, color-name | 4.2.3, 6.0.1, 5.0.1, 4.3.0, 7.0.0, 8.0.0, 3.0.0, 2.0.1, 1.1.4 | MIT | yargs dependencies |
| estraverse | 5.3.0 | BSD-2-Clause | wavedrom dependency |

Planned for Phase 2 (not yet installed): opentype.js (MIT, PDF text
outlining), pdfkit (MIT) and svg-to-pdfkit (MIT) for SVG → PDF.

External tools (not distributed; discovered at runtime on the user's machine):
Verilator (open-source HDL front-end/simulator) and a headless Chrome or
Chromium for the optional visual check and PDF fallback.

Design ideas (no code copied) were taken from Archify (MIT): typed JSON IR
with strict schemas, diagnostics with supported fixes, delivery receipts, and a
separate browser visual check.

The default datapath theme follows the look and the skin architecture of
netlistsvg (nturley/netlistsvg, MIT): symbols as data with named, positioned
pins laid out by ELK. No netlistsvg code or skin geometry is copied and the
package is not a dependency; symbol geometry in `skins/` was drawn for this
project from CONVENTIONS.md. If geometry is ever copied from a netlistsvg skin,
add its MIT notice to that skin file and record it here.

Prototype text metrics in `lib/render/text-metrics.mjs` are approximate
Helvetica-compatible advance widths typed for this project, not a copied AFM
file. If code is copied from an MIT project later,
its notice stays on the copied files and the project is listed here.
