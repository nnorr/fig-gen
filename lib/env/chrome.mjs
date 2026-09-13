// Headless Chrome/Chromium discovery: RTLFIG_CHROME wins, then PATH names,
// then per-platform default application locations. Returns the first
// executable that answers --version.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

function platformDefaults(platform, env) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return [];
}

function onPath(name, env) {
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function findChrome({ env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (env.RTLFIG_CHROME) candidates.push({ path: env.RTLFIG_CHROME, via: 'RTLFIG_CHROME' });
  for (const name of PATH_NAMES) {
    const found = onPath(name, env);
    if (found) candidates.push({ path: found, via: 'PATH' });
  }
  for (const p of platformDefaults(platform, env)) if (fs.existsSync(p)) candidates.push({ path: p, via: 'default-location' });

  for (const c of candidates) {
    const result = spawnSync(c.path, ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (!result.error && result.status === 0) return { available: true, executable: c.path, via: c.via, version: result.stdout.trim() };
  }
  return {
    available: false,
    reason: env.RTLFIG_CHROME ? `RTLFIG_CHROME=${env.RTLFIG_CHROME} did not run` : 'no Chrome/Chromium found on PATH or default locations',
    fix: 'install Chrome or Chromium, or set RTLFIG_CHROME to its executable',
  };
}
