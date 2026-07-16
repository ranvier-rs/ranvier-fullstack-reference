#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  invariant(
    result.status === 0,
    `${command} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  return result.stdout.trim();
}

function tarText(header, start, length) {
  return header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
}

function parseTar(bytes) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = Buffer.from(bytes.subarray(offset, offset + 512));
    if (header.every((value) => value === 0)) break;
    const prefix = tarText(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${tarText(header, 0, 100)}`;
    const size = Number.parseInt(tarText(header, 124, 12).trim() || '0', 8);
    invariant(Number.isSafeInteger(size) && size >= 0, `invalid tar size for ${name}`);
    const bodyStart = offset + 512;
    entries.push({ header, name, data: Buffer.from(bytes.subarray(bodyStart, bodyStart + size)) });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  invariant(entries.length > 0, 'crate archive contains no entries');
  return entries;
}

function writeTarPath(header, name) {
  header.fill(0, 0, 100);
  header.fill(0, 345, 500);
  if (Buffer.byteLength(name) <= 100) {
    header.write(name, 0, 100, 'utf8');
    return;
  }
  const separators = [...name.matchAll(/\//g)].map((match) => match.index);
  const split = separators.reverse().find((index) =>
    Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100,
  );
  invariant(split !== undefined, `tar path is too long: ${name}`);
  header.write(name.slice(split + 1), 0, 100, 'utf8');
  header.write(name.slice(0, split), 345, 155, 'utf8');
}

function writeOctal(header, start, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  invariant(encoded.length < length, `tar numeric field overflow: ${value}`);
  header.fill(0, start, start + length);
  header.write(encoded, start, length - 1, 'ascii');
}

function encodeTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const header = Buffer.from(entry.header);
    writeTarPath(header, entry.name);
    writeOctal(header, 124, 12, entry.data.length);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    const checksumText = checksum.toString(8).padStart(6, '0');
    header.write(checksumText, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function rewriteNormalizedManifest(text, sourceVersion, candidateVersion) {
  const versionLine = new RegExp(`^version = "${sourceVersion.replaceAll('.', '\\.')}"$`, 'gm');
  let packageVersionSeen = false;
  const rewritten = text.replace(versionLine, () => {
    if (!packageVersionSeen) {
      packageVersionSeen = true;
      return `version = "${candidateVersion}"`;
    }
    return `version = "=${candidateVersion}"`;
  });
  invariant(packageVersionSeen, 'normalized Cargo.toml has no package version');
  return rewritten;
}

function rewriteOriginalManifest(text, sourceVersion, candidateVersion) {
  return text.replaceAll(`version = "${sourceVersion}"`, `version = "=${candidateVersion}"`);
}

function extractRegularFiles(entries, destination) {
  for (const entry of entries) {
    invariant(entry.header[156] === 0x30 || entry.header[156] === 0, `unsupported tar entry type for ${entry.name}`);
    const output = path.resolve(destination, entry.name);
    const relative = path.relative(destination, output);
    invariant(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `unsafe tar path: ${entry.name}`);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, entry.data);
  }
}

function indexPrefix(name) {
  const normalized = name.toLowerCase();
  if (normalized.length === 1) return '1';
  if (normalized.length === 2) return '2';
  if (normalized.length === 3) return `3/${normalized[0]}`;
  return `${normalized.slice(0, 2)}/${normalized.slice(2, 4)}`;
}

const provenanceDir = path.resolve(argument(
  '--provenance',
  path.join(repoRoot, '..', 'ranvier', 'target', 'release-provenance', 'm419-rq11-732d073'),
));
const outputDir = path.resolve(argument('--output', path.join(repoRoot, 'candidate-registry')));
const candidateVersion = argument('--version', '0.51.0-m420.1');
const capturedAt = argument('--captured-at', '2026-07-17T03:19:10+09:00');

invariant(/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(candidateVersion), 'candidate version must be an explicit SemVer pre-release');
invariant(existsSync(path.join(provenanceDir, 'provenance.json')), `missing provenance: ${provenanceDir}`);

const provenance = JSON.parse(readFileSync(path.join(provenanceDir, 'provenance.json'), 'utf8'));
const sourceCommit = provenance.source?.commit ?? provenance.git?.commit;
invariant(/^[0-9a-f]{40}$/.test(sourceCommit ?? ''), 'provenance has no exact source commit');
invariant(
  (provenance.source?.tree_clean_before === true && provenance.source?.tree_clean_after === true)
    || provenance.git?.clean === true,
  'candidate source provenance is not clean',
);

const crateArtifacts = provenance.artifacts
  .filter((artifact) => artifact.kind === 'crate' && artifact.file?.endsWith('.crate'))
  .map((artifact) => ({
    name: artifact.crate,
    version: artifact.version,
    file: artifact.file,
    expectedSha256: artifact.sha256,
  }))
  .sort((left, right) => left.name.localeCompare(right.name));
invariant(crateArtifacts.length > 0, 'provenance has no crate artifacts');
invariant(new Set(crateArtifacts.map((artifact) => artifact.name)).size === crateArtifacts.length, 'duplicate package in provenance');
const packageNames = new Set(crateArtifacts.map((artifact) => artifact.name));
const sourceVersions = new Set(crateArtifacts.map((artifact) => artifact.version));
invariant(sourceVersions.size === 1, 'candidate source artifacts do not share one version');
const sourceVersion = [...sourceVersions][0];

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(path.join(outputDir, 'index'), { recursive: true });
mkdirSync(path.join(outputDir, 'crates'), { recursive: true });
const extractionRoot = mkdtempSync(path.join(tmpdir(), 'ranvier-m420-registry-'));
const generated = [];

try {
  for (const artifact of crateArtifacts) {
    const sourcePath = path.join(provenanceDir, artifact.file);
    const sourceBytes = readFileSync(sourcePath);
    invariant(sha256(sourceBytes) === artifact.expectedSha256, `source checksum mismatch: ${artifact.file}`);
    const oldPrefix = `${artifact.name}-${sourceVersion}/`;
    const newPrefix = `${artifact.name}-${candidateVersion}/`;
    const entries = parseTar(gunzipSync(sourceBytes)).map((entry) => {
      invariant(entry.name.startsWith(oldPrefix), `unexpected crate root: ${entry.name}`);
      const rewritten = { ...entry, name: `${newPrefix}${entry.name.slice(oldPrefix.length)}` };
      if (entry.name.endsWith('/Cargo.toml')) {
        rewritten.data = Buffer.from(
          rewriteNormalizedManifest(entry.data.toString('utf8'), sourceVersion, candidateVersion),
          'utf8',
        );
      } else if (entry.name.endsWith('/Cargo.toml.orig')) {
        rewritten.data = Buffer.from(
          rewriteOriginalManifest(entry.data.toString('utf8'), sourceVersion, candidateVersion),
          'utf8',
        );
      }
      return rewritten;
    });
    const candidateBytes = gzipSync(encodeTar(entries), { level: 9, mtime: 0 });
    const checksum = sha256(candidateBytes);
    const crateOutput = path.join(outputDir, 'crates', artifact.name, candidateVersion, 'download');
    mkdirSync(path.dirname(crateOutput), { recursive: true });
    writeFileSync(crateOutput, candidateBytes);

    const extractDir = path.join(extractionRoot, artifact.name);
    mkdirSync(extractDir, { recursive: true });
    extractRegularFiles(entries, extractDir);
    const packageRoot = path.join(extractDir, `${artifact.name}-${candidateVersion}`);
    const metadata = JSON.parse(run('cargo', [
      'metadata', '--no-deps', '--format-version', '1',
      '--manifest-path', path.join(packageRoot, 'Cargo.toml'),
    ], { cwd: packageRoot }));
    invariant(metadata.packages.length === 1, `unexpected metadata package count for ${artifact.name}`);
    const pkg = metadata.packages[0];
    invariant(pkg.name === artifact.name && pkg.version === candidateVersion, `candidate metadata mismatch for ${artifact.name}`);

    const indexRecord = {
      name: pkg.name,
      vers: pkg.version,
      deps: pkg.dependencies.map((dependency) => ({
        name: dependency.rename ?? dependency.name,
        req: dependency.req,
        features: dependency.features,
        optional: dependency.optional,
        default_features: dependency.uses_default_features,
        target: dependency.target,
        kind: dependency.kind ?? 'normal',
        registry: packageNames.has(dependency.name)
          ? null
          : 'https://github.com/rust-lang/crates.io-index',
        package: dependency.rename ? dependency.name : null,
      })),
      cksum: checksum,
      features: pkg.features,
      yanked: false,
      links: pkg.links,
      v: 2,
      rust_version: pkg.rust_version,
    };
    const indexPath = path.join(outputDir, 'index', indexPrefix(pkg.name), pkg.name.toLowerCase());
    mkdirSync(path.dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, `${JSON.stringify(indexRecord)}\n`, 'utf8');
    generated.push({
      package: pkg.name,
      version: pkg.version,
      bytes: candidateBytes.length,
      sha256: checksum,
      source_artifact: artifact.file,
      source_sha256: artifact.expectedSha256,
    });
  }

  writeFileSync(
    path.join(outputDir, 'index', 'config.json'),
    `${JSON.stringify({ dl: 'http://127.0.0.1:43119/{crate}/{version}/download' }, null, 2)}\n`,
    'utf8',
  );
  const manifest = {
    schema_version: '1.0.0',
    claim_level: 'maintainer-local-versioned-prerelease-registry',
    captured_at: capturedAt,
    source_commit: sourceCommit,
    source_version: sourceVersion,
    candidate_version: candidateVersion,
    package_count: generated.length,
    packages: generated,
    exclusions: [
      'This is not crates.io publication evidence.',
      'This is not independently owned adopter evidence.',
      'The registry is a deterministic local candidate channel for path-free consumer validation.',
    ],
  };
  writeFileSync(path.join(outputDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[candidate-registry] wrote ${generated.length} packages at ${candidateVersion}`);
  console.log(`[candidate-registry] source ${sourceCommit}`);
  console.log(`[candidate-registry] output ${path.relative(repoRoot, outputDir).replaceAll('\\', '/')}`);
} finally {
  rmSync(extractionRoot, { recursive: true, force: true });
}
