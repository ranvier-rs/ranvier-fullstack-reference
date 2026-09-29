import assert from 'node:assert/strict';
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
import test from 'node:test';
import {
  createFreshConsumerRunRoot,
  freshConsumerEvidencePath,
  finishFreshConsumerRun,
  freshConsumerRunId,
  freshConsumerTempPathLabel,
  removeFreshConsumerRunRoot,
  writeFreshConsumerEvidence,
} from './fresh-consumer-run-files.mjs';

const sourceCommit = '732d0734a3f9e479932935f6022545fbca8a66f1';

test('fresh consumer runs do not reuse legacy temp paths or each other', () => {
  const testRoot = mkdtempSync(path.join(tmpdir(), 'ranvier-m420-consumer-safety-test-'));
  const legacyPath = path.join(testRoot, 'ranvier-m420-consumer-windows');
  mkdirSync(legacyPath);
  const legacySentinel = path.join(legacyPath, 'preserve.txt');
  writeFileSync(legacySentinel, 'pre-existing user data\n');

  try {
    const first = createFreshConsumerRunRoot(testRoot);
    const second = createFreshConsumerRunRoot(testRoot);
    const firstSentinel = path.join(first, 'generated.txt');
    writeFileSync(firstSentinel, 'first run\n');

    assert.notEqual(first, second);
    assert.ok(existsSync(firstSentinel));
    assert.equal(readFileSync(legacySentinel, 'utf8'), 'pre-existing user data\n');
    assert.equal(path.dirname(first), testRoot);
    assert.equal(path.dirname(second), testRoot);
    assert.equal(
      freshConsumerTempPathLabel(first),
      `$TEMP/${path.relative(tmpdir(), first).replaceAll('\\', '/')}`,
    );
    assert.equal(
      freshConsumerRunId(first),
      path.basename(first).slice('ranvier-m420-consumer-run-'.length),
    );

    removeFreshConsumerRunRoot(first, testRoot);
    assert.ok(!existsSync(first));
    assert.ok(existsSync(second));
    assert.equal(readFileSync(legacySentinel, 'utf8'), 'pre-existing user data\n');
    removeFreshConsumerRunRoot(second, testRoot);
  } finally {
    rmSync(testRoot, { recursive: true, force: false });
  }
});

test('fresh consumer evidence is unique and refuses to overwrite an existing file', () => {
  const testRoot = mkdtempSync(path.join(tmpdir(), 'ranvier-m420-consumer-evidence-test-'));
  const evidenceRoot = path.join(testRoot, 'evidence');
  const runRoot = createFreshConsumerRunRoot(testRoot);
  const evidence = { claim_level: 'maintainer-fresh-consumer-candidate-gate' };

  try {
    const output = writeFreshConsumerEvidence(evidenceRoot, sourceCommit, runRoot, evidence);
    const before = readFileSync(output, 'utf8');

    assert.equal(
      path.basename(output),
      `m420-rq2-${sourceCommit.slice(0, 7)}-${path.basename(runRoot).slice('ranvier-m420-consumer-run-'.length)}.json`,
    );
    assert.equal(JSON.parse(before).claim_level, evidence.claim_level);
    assert.throws(
      () => writeFreshConsumerEvidence(evidenceRoot, sourceCommit, runRoot, { claim_level: 'replacement' }),
      { code: 'EEXIST' },
    );
    assert.equal(readFileSync(output, 'utf8'), before);

    const otherRunRoot = createFreshConsumerRunRoot(testRoot);
    assert.notEqual(
      freshConsumerEvidencePath(evidenceRoot, sourceCommit, runRoot),
      freshConsumerEvidencePath(evidenceRoot, sourceCommit, otherRunRoot),
    );
    removeFreshConsumerRunRoot(runRoot, testRoot);
    removeFreshConsumerRunRoot(otherRunRoot, testRoot);
  } finally {
    rmSync(testRoot, { recursive: true, force: false });
  }
});

test('evidence stays outside the temporary run directory that cleanup removes', () => {
  const testRoot = mkdtempSync(path.join(tmpdir(), 'ranvier-m420-consumer-evidence-cleanup-test-'));
  const runRoot = createFreshConsumerRunRoot(testRoot);
  const nestedEvidenceRoot = path.join(runRoot, 'evidence');

  try {
    assert.throws(
      () => writeFreshConsumerEvidence(nestedEvidenceRoot, sourceCommit, runRoot, { claim_level: 'test' }),
      /must remain outside the temporary run root/,
    );
    assert.ok(!existsSync(nestedEvidenceRoot));

    const output = writeFreshConsumerEvidence(testRoot, sourceCommit, runRoot, { claim_level: 'test' });
    assert.equal(
      finishFreshConsumerRun(runRoot, { completed: true, keepFailed: false, tempRoot: testRoot }),
      true,
    );
    assert.ok(existsSync(output));
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).claim_level, 'test');
  } finally {
    rmSync(testRoot, { recursive: true, force: false });
  }
});

test('run cleanup rejects paths without fresh-consumer ownership and containment', () => {
  const testRoot = mkdtempSync(path.join(tmpdir(), 'ranvier-m420-consumer-cleanup-test-'));
  const unrelatedPath = path.join(testRoot, 'keep-this');
  const unownedNamedPath = path.join(testRoot, 'ranvier-m420-consumer-run-unowned');
  mkdirSync(unrelatedPath);
  mkdirSync(unownedNamedPath);

  try {
    assert.throws(
      () => removeFreshConsumerRunRoot(unrelatedPath, testRoot),
      /outside its owned temporary directory/,
    );
    assert.ok(existsSync(unrelatedPath));
    assert.throws(
      () => removeFreshConsumerRunRoot(unownedNamedPath, testRoot),
      /without its ownership marker/,
    );
    assert.ok(existsSync(unownedNamedPath));
    assert.throws(
      () => removeFreshConsumerRunRoot(path.join(tmpdir(), 'ranvier-m420-consumer-run-unowned'), testRoot),
      /outside its owned temporary directory/,
    );
    assert.throws(
      () => freshConsumerTempPathLabel(path.resolve(tmpdir(), '..', 'outside-run')),
      /inside its temporary run root/,
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: false });
  }
});

test('failed runs are cleaned by default and retained only when requested', () => {
  const testRoot = mkdtempSync(path.join(tmpdir(), 'ranvier-m420-consumer-failure-cleanup-test-'));
  const cleanedRun = createFreshConsumerRunRoot(testRoot);
  const retainedRun = createFreshConsumerRunRoot(testRoot);

  try {
    assert.equal(
      finishFreshConsumerRun(cleanedRun, {
        completed: false,
        keepFailed: false,
        tempRoot: testRoot,
      }),
      true,
    );
    assert.ok(!existsSync(cleanedRun));
    assert.equal(
      finishFreshConsumerRun(retainedRun, {
        completed: false,
        keepFailed: true,
        tempRoot: testRoot,
      }),
      false,
    );
    assert.ok(existsSync(retainedRun));
    removeFreshConsumerRunRoot(retainedRun, testRoot);
  } finally {
    rmSync(testRoot, { recursive: true, force: false });
  }
});
