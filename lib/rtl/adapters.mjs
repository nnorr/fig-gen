// Tool-agnostic adapter discovery (SPEC §11.2–11.3). The only built-in
// adapter is Verilator; everything else is registered by the user at runtime
// through a config file or RTLFIG_ADAPTER_PATH. No tool names, paths, hosts or
// license mechanisms are known to this module.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import verilator from './verilator.mjs';

export const CONFIG_BASENAME = 'rtl-figures.config.json';

export function loadConfig({ configPath, cwd = process.cwd() } = {}) {
  const candidate = configPath ? path.resolve(cwd, configPath) : path.join(cwd, CONFIG_BASENAME);
  if (!fs.existsSync(candidate)) {
    if (configPath) throw new Error(`config not found: ${candidate}`);
    return { path: null, dir: cwd, config: {} };
  }
  return { path: candidate, dir: path.dirname(candidate), config: JSON.parse(fs.readFileSync(candidate, 'utf8')) };
}

function assertAdapterShape(adapter, origin) {
  const ok = adapter && typeof adapter.id === 'string' && typeof adapter.detect === 'function' && typeof adapter.extract === 'function';
  if (!ok) throw new Error(`adapter from ${origin} must export { id, detect(), extract() }`);
  return adapter;
}

// An external-command adapter: argv template with {top}, {filelist},
// {work_dir} placeholders; the command prints normalized netlist JSON.
export function commandAdapter({ id, command, version_command: versionCommand }, baseDir) {
  if (!Array.isArray(command) || !command.length) throw new Error(`adapter ${id}: command must be a non-empty argv array`);
  return {
    id,
    kind: 'extract',
    async detect() {
      if (!versionCommand) return { available: true, version: 'unknown', executable: command[0] };
      const result = spawnSync(versionCommand[0], versionCommand.slice(1), { encoding: 'utf8', cwd: baseDir });
      return result.status === 0
        ? { available: true, version: result.stdout.trim().split('\n')[0], executable: command[0] }
        : { available: false, reason: result.error?.message || result.stderr.trim() };
    },
    async extract(request) {
      fs.mkdirSync(request.work_dir, { recursive: true });
      const filelist = path.join(request.work_dir, 'files.f');
      fs.writeFileSync(filelist, `${request.files.join('\n')}\n`);
      const argv = command.map((arg) => arg
        .replaceAll('{top}', request.top)
        .replaceAll('{filelist}', filelist)
        .replaceAll('{work_dir}', request.work_dir));
      const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', cwd: request.work_dir, maxBuffer: 256 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(`adapter ${id} failed (exit ${result.status}): ${(result.stderr || result.error?.message || '').slice(0, 2000)}`);
      return JSON.parse(result.stdout);
    },
  };
}

export async function discoverAdapters({ config = {}, configDir = process.cwd(), env = process.env } = {}) {
  const adapters = new Map([[verilator.id, verilator]]);
  const entries = [...(config.adapters || [])];
  for (const modulePath of (env.RTLFIG_ADAPTER_PATH || '').split(path.delimiter).filter(Boolean)) {
    entries.push({ module: modulePath });
  }
  for (const entry of entries) {
    if (entry.command) {
      adapters.set(entry.id, commandAdapter(entry, configDir));
      continue;
    }
    const resolved = path.resolve(configDir, entry.module);
    const imported = await import(pathToFileURL(resolved).href);
    const adapter = assertAdapterShape(imported.default, resolved);
    if (entry.id && entry.id !== adapter.id) throw new Error(`adapter at ${resolved} declares id '${adapter.id}', config expects '${entry.id}'`);
    adapters.set(adapter.id, adapter);
  }
  return adapters;
}

export function selectAdapterId({ cliId, config = {}, env = process.env }) {
  return cliId || env.RTLFIG_ADAPTER || config.default_adapter || verilator.id;
}
