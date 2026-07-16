#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);
const expectedRegistry = JSON.parse(
  readFileSync(path.join(repoRoot, 'candidate-registry', 'MANIFEST.json'), 'utf8'),
);

if (args.length === 0) {
  throw new Error('usage: node scripts/candidate-cargo.mjs <cargo arguments>');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function registryReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:43117/health.json');
      if (response.ok) {
        const health = await response.json();
        if (
          health.source_commit === expectedRegistry.source_commit
          && health.candidate_version === expectedRegistry.candidate_version
          && health.package_count === expectedRegistry.package_count
        ) return true;
      }
    } catch {
      // Retry while the registry initializes.
    }
    await wait(100);
  }
  return false;
}

let registry;
let ownsRegistry = false;
if (!(await registryReady())) {
  registry = spawn(process.execPath, [path.join(scriptDir, 'serve-candidate-registry.mjs')], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
  });
  ownsRegistry = true;
  if (!(await registryReady())) {
    registry.kill('SIGTERM');
    throw new Error('candidate registry did not become ready');
  }
}

try {
  const result = spawnSync('cargo', args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (ownsRegistry) registry.kill('SIGTERM');
}
