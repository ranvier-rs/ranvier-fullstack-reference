#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const templateRoot = path.join(repoRoot, 'consumer-smoke');
const registryRoot = path.join(repoRoot, 'candidate-registry');
const targetRoot = path.join(repoRoot, 'target', 'm420-consumer');
const evidenceRoot = path.join(repoRoot, 'target', 'm420-consumer-evidence');
const runWindows = !process.argv.includes('--linux-only');
const runLinux = !process.argv.includes('--windows-only');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function structuralSchematicSha256(file) {
  const schematic = JSON.parse(readFileSync(file, 'utf8'));
  const nodeIndexes = new Map(schematic.nodes.map((node, index) => [node.id, index]));
  const canonical = {
    schema_version: schematic.schema_version,
    name: schematic.name,
    nodes: schematic.nodes.map(({ id: _id, source_location: source, ...node }) => ({
      ...node,
      source_location: source
        ? { ...source, file: source.file.replaceAll('\\', '/') }
        : null,
    })),
    edges: schematic.edges.map(({ from, to, ...edge }) => ({
      ...edge,
      from_node: nodeIndexes.get(from),
      to_node: nodeIndexes.get(to),
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function run(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  invariant(
    result.status === 0,
    `${command} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  return {
    command: [command, ...args].join(' '),
    duration_ms: Date.now() - started,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function copyConsumer(platform) {
  const destination = path.join(tmpdir(), `ranvier-m420-consumer-${platform}`);
  rmSync(destination, { recursive: true, force: true });
  cpSync(templateRoot, destination, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}target`) && !source.endsWith(`${path.sep}Cargo.lock`),
  });
  const workspaceRoot = path.resolve(repoRoot, '..');
  const relative = path.relative(workspaceRoot, destination);
  invariant(relative.startsWith('..') || path.isAbsolute(relative), 'fresh consumer must be outside ranvier-workspace');
  return destination;
}

function tomlFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const current = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...tomlFiles(current));
    else if (entry.isFile() && entry.name.endsWith('.toml')) files.push(current);
  }
  return files;
}

function assertPortableManifests(root) {
  const forbidden = [
    { pattern: /(^|[{,\s])path\s*=/m, label: 'path dependency' },
    { pattern: /(^|[{,\s])git\s*=/m, label: 'Git dependency' },
    { pattern: /^\s*\[patch[.\]]/m, label: '[patch] override' },
  ];
  for (const file of tomlFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const rule of forbidden) {
      invariant(!rule.pattern.test(text), `${rule.label} is prohibited in ${file}`);
    }
  }
}

function verifyMetadata(raw) {
  const metadata = JSON.parse(raw);
  const ranvier = metadata.packages
    .filter((pkg) => pkg.name.startsWith('ranvier-') && pkg.source !== null)
    .map((pkg) => ({ name: pkg.name, version: pkg.version, source: pkg.source }))
    .sort((left, right) => left.name.localeCompare(right.name));
  invariant(ranvier.length >= 4, 'consumer metadata did not resolve the expected Ranvier package closure');
  for (const pkg of ranvier) {
    invariant(pkg.version === '0.51.0-m420.1', `${pkg.name} resolved unexpected version ${pkg.version}`);
    invariant(
      pkg.source?.startsWith('registry+') || pkg.source?.startsWith('sparse+'),
      `${pkg.name} did not resolve from a registry`,
    );
  }
  return ranvier;
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForRegistry() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:43117/config.json');
      if (response.ok) return;
    } catch {
      // Retry while the child initializes.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('candidate registry did not become ready');
}

async function waitForPing(url, value) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (response.ok) return { status: response.status, body: await response.json() };
    } catch {
      // Retry while the consumer server initializes.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`consumer did not answer ${url}`);
}

async function windowsGate() {
  const consumer = copyConsumer('windows');
  assertPortableManifests(consumer);
  const commands = [];
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: path.join(targetRoot, 'windows'),
  };
  commands.push(run('cargo', ['generate-lockfile'], { cwd: consumer, env }));
  commands.push(run('cargo', ['check', '--locked'], { cwd: consumer, env }));
  commands.push(run('cargo', ['test', '--locked'], { cwd: consumer, env }));
  const schematic = path.join(consumer, 'm420-smoke-schematic.json');
  commands.push(run('cargo', [
    'run', '--locked', '--', '--schematic', '--schematic-output', schematic,
  ], { cwd: consumer, env }));
  invariant(existsSync(schematic), 'Windows schematic was not exported');
  const metadataRun = run('cargo', ['metadata', '--locked', '--format-version', '1'], { cwd: consumer, env });
  const packages = verifyMetadata(metadataRun.stdout);
  commands.push({ ...metadataRun, stdout: '[parsed into packages]' });

  const binary = path.join(targetRoot, 'windows', `debug`, `ranvier-m420-consumer-smoke${process.platform === 'win32' ? '.exe' : ''}`);
  const server = spawn(binary, [], {
    cwd: consumer,
    env: { ...env, M420_SMOKE_BIND: '127.0.0.1:43118' },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  let request;
  try {
    request = await waitForPing('http://127.0.0.1:43118/ping', 'windows');
  } finally {
    server.kill('SIGTERM');
    await waitForExit(server);
  }
  invariant(request.body.echoed === 'windows' && request.body.source === 'registry-prerelease', 'unexpected Windows response');
  return {
    platform: 'windows-x64',
    consumer_root: '$TEMP/ranvier-m420-consumer-windows',
    rustc: run('rustc', ['--version']).stdout,
    cargo: run('cargo', ['--version']).stdout,
    registry_source: 'sparse+http://127.0.0.1:43117/',
    packages,
    commands: commands.map(({ command, duration_ms }) => ({
      command: command.replaceAll(consumer, '$TEMP/ranvier-m420-consumer-windows'),
      duration_ms,
    })),
    lock_sha256: sha256File(path.join(consumer, 'Cargo.lock')),
    schematic_file_sha256: sha256File(schematic),
    schematic_structural_sha256: structuralSchematicSha256(schematic),
    request,
  };
}

function linuxGate() {
  const consumer = copyConsumer('linux');
  assertPortableManifests(consumer);
  const mount = `${consumer.replaceAll('\\', '/')}:/consumer:Z`;
  const registryMount = `${registryRoot.replaceAll('\\', '/')}:/registry:ro,Z`;
  const script = [
    'set -euo pipefail',
    'python3 -m http.server 43117 --bind 127.0.0.1 --directory /registry/index >/tmp/m420-index.log 2>&1 &',
    'index_pid=$!',
    'python3 -m http.server 43119 --bind 127.0.0.1 --directory /registry/crates >/tmp/m420-crates.log 2>&1 &',
    'crates_pid=$!',
    "trap 'kill -TERM ${server_pid:-} ${index_pid:-} ${crates_pid:-} 2>/dev/null || true' EXIT",
    'for attempt in $(seq 1 30); do curl --fail --silent http://127.0.0.1:43117/config.json >/dev/null && break; sleep 0.1; done',
    'curl --fail --silent http://127.0.0.1:43117/config.json >/dev/null',
    'cargo generate-lockfile',
    'cargo check --locked',
    'cargo test --locked',
    'cargo run --locked -- --schematic --schematic-output /consumer/m420-smoke-schematic.json',
    'cargo build --locked',
    'M420_SMOKE_BIND=127.0.0.1:43118 target/debug/ranvier-m420-consumer-smoke >/tmp/m420-server.log 2>&1 &',
    'server_pid=$!',
    'response=""',
    'for attempt in $(seq 1 60); do',
    "  if exec 3<>/dev/tcp/127.0.0.1/43118; then printf 'POST /ping HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Type: application/json\\r\\nContent-Length: 17\\r\\nConnection: close\\r\\n\\r\\n{\"value\":\"linux\"}' >&3; response=$(cat <&3); exec 3<&-; exec 3>&-; break; fi",
    '  sleep 0.2',
    'done',
    "printf '%s' \"$response\" | grep -q '200 OK'",
    "printf '%s' \"$response\" | grep -q '\"echoed\":\"linux\"'",
    "printf '%s' \"$response\" | grep -q '\"source\":\"registry-prerelease\"'",
    'kill -TERM "$server_pid"',
    'wait "$server_pid" || true',
    'kill -TERM "$index_pid" "$crates_pid"',
    'wait "$index_pid" "$crates_pid" || true',
    'trap - EXIT',
    "printf '\\nM420_METADATA_BEGIN\\n'",
    'cargo metadata --locked --format-version 1 | base64 -w0',
    "printf '\\nM420_METADATA_END\\n'",
    'rustc --version',
    'cargo --version',
  ].join('\n');
  const result = run('podman', [
    'run', '--rm',
    '-v', mount,
    '-v', registryMount,
    '-w', '/consumer',
    'docker.io/library/rust:1.95.0-bookworm',
    'bash', '-c', script,
  ], { cwd: repoRoot });
  const metadataMatch = /M420_METADATA_BEGIN\r?\n([A-Za-z0-9+/=]+)\r?\nM420_METADATA_END/.exec(result.stdout);
  invariant(metadataMatch, 'Linux metadata marker was not captured');
  const metadata = Buffer.from(metadataMatch[1], 'base64').toString('utf8');
  const packages = verifyMetadata(metadata);
  const rustcMatch = /\nrustc ([^\r\n]+)\r?\n/.exec(result.stdout);
  const cargoMatch = /\ncargo ([^\r\n]+)\r?\n?$/.exec(result.stdout);
  invariant(rustcMatch && cargoMatch, 'Linux toolchain versions were not captured');
  const imageInspect = run('podman', [
    'image', 'inspect', 'docker.io/library/rust:1.95.0-bookworm', '--format', 'json',
  ], { cwd: repoRoot });
  const image = JSON.parse(imageInspect.stdout)[0];
  const schematic = path.join(consumer, 'm420-smoke-schematic.json');
  invariant(existsSync(schematic), 'Linux schematic was not exported');
  return {
    platform: 'linux-x64-container',
    consumer_root: '$TEMP/ranvier-m420-consumer-linux',
    container_image: 'docker.io/library/rust:1.95.0-bookworm',
    container_image_id: image.Id,
    container_repo_digests: image.RepoDigests ?? [],
    rustc: `rustc ${rustcMatch[1]}`,
    cargo: `cargo ${cargoMatch[1]}`,
    registry_source: 'sparse+http://127.0.0.1:43117/',
    packages,
    command: result.command
      .replaceAll(consumer.replaceAll('\\', '/'), '$TEMP/ranvier-m420-consumer-linux')
      .replaceAll(registryRoot.replaceAll('\\', '/'), '$REPO/candidate-registry'),
    duration_ms: result.duration_ms,
    lock_sha256: sha256File(path.join(consumer, 'Cargo.lock')),
    schematic_file_sha256: sha256File(schematic),
    schematic_structural_sha256: structuralSchematicSha256(schematic),
    request: {
      status: 200,
      body: { echoed: 'linux', source: 'registry-prerelease' },
    },
  };
}

invariant(existsSync(path.join(registryRoot, 'MANIFEST.json')), 'candidate registry has not been generated');
mkdirSync(targetRoot, { recursive: true });
mkdirSync(evidenceRoot, { recursive: true });
const registryManifest = JSON.parse(readFileSync(path.join(registryRoot, 'MANIFEST.json'), 'utf8'));
const registryServer = spawn(process.execPath, [path.join(scriptDir, 'serve-candidate-registry.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    RANVIER_CANDIDATE_REGISTRY_HOST: runLinux ? '0.0.0.0' : '127.0.0.1',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
  windowsHide: true,
});

try {
  await waitForRegistry();
  const observations = [];
  if (runWindows) observations.push(await windowsGate());
  if (runLinux) observations.push(linuxGate());
  invariant(
    new Set(observations.map((entry) => entry.schematic_structural_sha256)).size === 1,
    'Windows and Linux Schematic structures differ',
  );
  const evidence = {
    schema_version: '1.0.0',
    claim_level: 'maintainer-fresh-consumer-candidate-gate',
    captured_at: new Date().toISOString(),
    source_commit: registryManifest.source_commit,
    candidate_version: registryManifest.candidate_version,
    package_count: registryManifest.package_count,
    prohibited_sources: ['path', 'git', '[patch]'],
    observations,
    exclusions: [
      'The candidate registry is not crates.io.',
      'The run is maintainer-owned and does not close independent PoC evidence.',
      'Compatibility across two releases and eight weeks is not claimed.',
    ],
  };
  const output = path.join(evidenceRoot, `m420-rq2-${registryManifest.source_commit.slice(0, 7)}.json`);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[fresh-consumer] passed ${observations.map((entry) => entry.platform).join(', ')}`);
  console.log(`[fresh-consumer] evidence ${path.relative(repoRoot, output).replaceAll('\\', '/')}`);
} finally {
  registryServer.kill('SIGTERM');
  await waitForExit(registryServer);
}
