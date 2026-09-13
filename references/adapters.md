# RTL adapters

fig-gen ships one adapter, `verilator`, and knows nothing about any other
tool. Anything else — another open-source front-end or a site-licensed tool on
your own machine — is a plug-in you register locally. Keep site-specific
paths, hosts and license settings in your own environment or in an untracked
config, never in this repository.

## Selection

`--adapter <id>` → `FIGGEN_ADAPTER` → `default_adapter` in
`fig-gen.config.json` → `verilator`. List what is visible with
`node bin/fig-gen.mjs adapters`.

## Plug-in forms

**Module adapter** (`module` in config, or a path in `FIGGEN_ADAPTER_PATH`):

```js
export default {
  id: 'my-frontend',
  kind: 'extract',
  async detect() { return { available: true, version: '1.2.3', executable: 'my-frontend' }; },
  async extract(request) { /* request: files, top, include_dirs, defines, params, blackbox_stubs, blackboxes, work_dir, source_root */
    return { schema_version: 1, kind: 'rtl-netlist', /* ... */ };
  },
};
```

**Command adapter** (no JS): an argv template; the command prints normalized
netlist JSON on stdout. Placeholders: `{top}`, `{filelist}`, `{work_dir}`.

```json
{
  "adapters": [
    { "id": "my-extractor", "command": ["my-extractor", "--top", "{top}", "-f", "{filelist}"], "version_command": ["my-extractor", "--version"] }
  ]
}
```

Every result is validated against `schemas/rtl-netlist.schema.json`.

## Blackboxes

Modules not in the file list are stubbed automatically from their
instantiation sites (named port connections; widths and directions inferred
from the elaborated connections). To override, pass `--stub <file.v>` (empty
module bodies with exact ports) or `--blackbox-json <file>`:

```json
{ "blackboxes": [ { "module": "my_mem", "ports": [ { "name": "Q", "dir": "out", "width": 32 } ] } ] }
```

Stub-derived modules are marked `blackbox.origin` = `user` or `auto` in the
netlist, and figures should draw them as opaque blocks with generic labels.
