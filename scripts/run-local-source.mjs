#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const sourceIndex = process.argv.indexOf('--ranvier-source');
const ranvierRoot = path.resolve(
  sourceIndex >= 0 ? process.argv[sourceIndex + 1] : path.join(repoRoot, '..', 'ranvier'),
);
const cargoArgs = process.argv
  .slice(2)
  .filter((argument, index, all) => argument !== '--ranvier-source' && all[index - 1] !== '--ranvier-source');

if (cargoArgs.length === 0) cargoArgs.push('check');
if (!existsSync(path.join(ranvierRoot, 'Cargo.toml'))) {
  throw new Error(`Ranvier source checkout not found: ${ranvierRoot}`);
}

const local = mkdtempSync(path.join(tmpdir(), 'ranvier-fullstack-local-source-'));
try {
  cpSync(path.join(repoRoot, 'backend'), local, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}target`) && !source.endsWith(`${path.sep}Cargo.lock`),
  });
  const manifestPath = path.join(local, 'Cargo.toml');
  let manifest = readFileSync(manifestPath, 'utf8');
  const packages = {
    'ranvier-core': 'core',
    'ranvier-runtime': 'runtime',
    'ranvier-http': 'http',
    'ranvier-macros': 'macros',
    'ranvier-guard': 'guard',
  };
  for (const [name, relative] of Object.entries(packages)) {
    const expression = new RegExp(`^${name}\\s*=.*$`, 'm');
    const source = path.join(ranvierRoot, relative).replaceAll('\\', '/');
    if (!expression.test(manifest)) throw new Error(`dependency line not found: ${name}`);
    manifest = manifest.replace(expression, `${name} = { path = "${source}" }`);
  }
  writeFileSync(manifestPath, manifest, 'utf8');
  console.error('[local-source] maintainer-only temporary override; not consumer evidence');
  const result = spawnSync('cargo', cargoArgs, {
    cwd: local,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(local, { recursive: true, force: true });
}
