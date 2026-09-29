import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseFreshConsumerGateOptions } from './fresh-consumer-gate-options.mjs';

const repoRoot = path.resolve('reference-workspace');

test('fresh-consumer gate defaults to its repository evidence directory', () => {
  assert.deepEqual(parseFreshConsumerGateOptions([], repoRoot), {
    evidenceRoot: path.join(repoRoot, 'target', 'm420-consumer-evidence'),
    runLinux: true,
    runWindows: true,
    keepFailedRun: false,
  });
});

test('fresh-consumer gate accepts a D-drive evidence root without changing other options', () => {
  const evidenceRoot = path.resolve('D:/ranvier-reference-evidence');
  assert.deepEqual(parseFreshConsumerGateOptions(['--windows-only', '--evidence-root', evidenceRoot], repoRoot), {
    evidenceRoot,
    runLinux: false,
    runWindows: true,
    keepFailedRun: false,
  });
});

test('relative evidence roots resolve from the reference repository', () => {
  assert.equal(
    parseFreshConsumerGateOptions(['--evidence-root', 'evidence/rechecks'], repoRoot).evidenceRoot,
    path.join(repoRoot, 'evidence', 'rechecks'),
  );
});

test('fresh-consumer gate rejects duplicate, missing, or ambiguous path options', () => {
  assert.throws(
    () => parseFreshConsumerGateOptions(['--evidence-root', 'first', '--evidence-root', 'second'], repoRoot),
    /may be specified only once/,
  );
  assert.throws(
    () => parseFreshConsumerGateOptions(['--evidence-root'], repoRoot),
    /requires a path/,
  );
  assert.throws(
    () => parseFreshConsumerGateOptions(['--evidence-root', '--windows-only'], repoRoot),
    /requires a path/,
  );
  assert.throws(
    () => parseFreshConsumerGateOptions(['--windows-only', '--linux-only'], repoRoot),
    /choose at most one/,
  );
  assert.throws(
    () => parseFreshConsumerGateOptions(['--evidence-root=target'], repoRoot),
    /unknown .* option/,
  );
});
