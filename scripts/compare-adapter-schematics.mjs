#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const nativePath = valueAfter('--native', 'evidence/native-rq5-order-authorization-schematic.json');
const hybridPath = valueAfter('--hybrid', 'evidence/hybrid-order-authorization-schematic.json');
const output = valueAfter('--output', 'evidence/native-hybrid-schematic-parity.json');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inspect(file) {
  const bytes = readFileSync(file);
  const schematic = JSON.parse(bytes.toString('utf8'));
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
  return {
    raw_sha256: sha256(bytes),
    structural_sha256: sha256(JSON.stringify(canonical)),
    node_labels: canonical.nodes.map((node) => node.label),
    edge_count: canonical.edges.length,
  };
}

const native = inspect(nativePath);
const hybrid = inspect(hybridPath);
invariant(
  native.structural_sha256 === hybrid.structural_sha256,
  'native and hybrid domain Schematics differ structurally',
);
const report = {
  schema_version: '1.0.0',
  native: { path: nativePath, ...native },
  hybrid: { path: hybridPath, ...hybrid },
  result: 'pass',
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
