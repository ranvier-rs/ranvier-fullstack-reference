#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const remote = process.env.M420_FULLSTACK_REMOTE ?? 'https://github.com/ranvier-rs/ranvier-fullstack-reference.git';
const cloneParent = mkdtempSync(path.join(tmpdir(), 'ranvier-m420-clone-'));
const clone = path.join(cloneParent, 'consumer');
const evidenceRoot = path.join(repoRoot, 'target', 'm420-clone-evidence');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, cwd) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  invariant(
    result.status === 0,
    `${command} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  return {
    command: [command, ...args].join(' '),
    duration_ms: Date.now() - started,
    stdout: result.stdout.trim(),
  };
}

try {
  const commands = [];
  commands.push(run('git', ['clone', '--depth', '1', remote, clone], cloneParent));
  invariant(!existsSync(path.join(cloneParent, 'ranvier')), 'clone proof unexpectedly has a sibling Ranvier checkout');
  const manifest = readFileSync(path.join(clone, 'backend', 'Cargo.toml'), 'utf8');
  invariant(!/(^|[{,\s])path\s*=/m.test(manifest), 'default backend manifest contains a path dependency');
  invariant(!/(^|[{,\s])git\s*=/m.test(manifest), 'default backend manifest contains a Git dependency');
  invariant(!/^\s*\[patch[.\]]/m.test(manifest), 'default backend manifest contains a patch override');
  commands.push(run('node', [
    'scripts/candidate-cargo.mjs', 'check', '--manifest-path', 'backend/Cargo.toml', '--locked',
  ], clone));
  commands.push(run('node', [
    'scripts/candidate-cargo.mjs', 'test', '--manifest-path', 'backend/Cargo.toml', '--locked',
  ], clone));
  const metadata = run('node', [
    'scripts/candidate-cargo.mjs', 'metadata', '--manifest-path', 'backend/Cargo.toml',
    '--locked', '--format-version', '1',
  ], clone);
  const parsed = JSON.parse(metadata.stdout);
  const packages = parsed.packages
    .filter((pkg) => pkg.name.startsWith('ranvier-') && pkg.source !== null)
    .map((pkg) => ({ name: pkg.name, version: pkg.version, source: pkg.source }))
    .sort((left, right) => left.name.localeCompare(right.name));
  invariant(packages.length >= 5, 'clone metadata has an incomplete Ranvier package closure');
  for (const pkg of packages) {
    invariant(pkg.version === '0.51.0-m420.1', `${pkg.name} resolved ${pkg.version}`);
    invariant(pkg.source.startsWith('sparse+'), `${pkg.name} is not a sparse-registry dependency`);
  }
  const commit = run('git', ['rev-parse', 'HEAD'], clone).stdout;
  const lock = readFileSync(path.join(clone, 'backend', 'Cargo.lock'));
  const evidence = {
    schema_version: '1.0.0',
    claim_level: 'maintainer-independent-clone-build',
    captured_at: new Date().toISOString(),
    remote,
    commit,
    sibling_ranvier_present: false,
    default_source_mode: 'exact-local-sparse-prerelease-registry',
    packages,
    lock_sha256: createHash('sha256').update(lock).digest('hex'),
    commands: commands.map(({ command, duration_ms }) => ({
      command: command.replace(clone, '$TEMP/consumer'),
      duration_ms,
    })),
    exclusions: [
      'This maintainer clone proof is not independently owned adoption.',
      'The local development source override is not used by this gate.',
      'The candidate registry is not crates.io.',
    ],
  };
  mkdirSync(evidenceRoot, { recursive: true });
  const output = path.join(evidenceRoot, `m420-rq3-${commit.slice(0, 7)}.json`);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[independent-clone] passed ${commit}`);
  console.log(`[independent-clone] evidence ${path.relative(repoRoot, output).replaceAll('\\', '/')}`);
} finally {
  rmSync(cloneParent, { recursive: true, force: true });
}
