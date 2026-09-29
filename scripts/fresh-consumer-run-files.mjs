import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runDirectoryPrefix = 'ranvier-m420-consumer-run-';
const ownerMarkerName = '.ranvier-m420-consumer-run-owner';
const ownerMarkerContents = 'ranvier-m420-consumer-run/v1\n';

export function createFreshConsumerRunRoot(parent = tmpdir()) {
  const runRoot = mkdtempSync(path.join(parent, runDirectoryPrefix));
  writeFileSync(path.join(runRoot, ownerMarkerName), ownerMarkerContents, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return runRoot;
}

export function freshConsumerRunId(runRoot) {
  const runName = path.basename(runRoot);
  if (!runName.startsWith(runDirectoryPrefix) || runName.length === runDirectoryPrefix.length) {
    throw new Error('run root was not created by the fresh-consumer allocator');
  }
  return runName.slice(runDirectoryPrefix.length);
}

export function freshConsumerTempPathLabel(targetPath, tempRoot = tmpdir()) {
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedTargetPath = path.resolve(targetPath);
  const relative = path.relative(resolvedTempRoot, resolvedTargetPath);
  const isContained = relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
  if (!isContained) {
    throw new Error('fresh-consumer evidence path must remain inside its temporary run root');
  }
  return `$TEMP/${relative.replaceAll('\\', '/')}`;
}

export function freshConsumerEvidencePath(evidenceRoot, sourceCommit, runRoot) {
  if (!/^[a-f0-9]{40,64}$/i.test(sourceCommit)) {
    throw new Error('source commit must be a full hexadecimal object ID');
  }
  return path.join(
    evidenceRoot,
    `m420-rq2-${sourceCommit.slice(0, 7)}-${freshConsumerRunId(runRoot)}.json`,
  );
}

export function assertFreshConsumerEvidenceOutsideRunRoot(evidenceRoot, runRoot) {
  const resolvedRunRoot = path.resolve(runRoot);
  const resolvedEvidenceRoot = path.resolve(evidenceRoot);
  const relative = path.relative(resolvedRunRoot, resolvedEvidenceRoot);
  const isInsideRunRoot = relative.length === 0
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
  if (isInsideRunRoot) {
    throw new Error('fresh-consumer evidence root must remain outside the temporary run root');
  }
}

export function writeFreshConsumerEvidence(evidenceRoot, sourceCommit, runRoot, evidence) {
  assertFreshConsumerEvidenceOutsideRunRoot(evidenceRoot, runRoot);
  mkdirSync(evidenceRoot, { recursive: true });
  const output = freshConsumerEvidencePath(evidenceRoot, sourceCommit, runRoot);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return output;
}

export function removeFreshConsumerRunRoot(runRoot, tempRoot = tmpdir()) {
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedRunRoot = path.resolve(runRoot);
  const relative = path.relative(resolvedTempRoot, resolvedRunRoot);
  const isContained = relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
  const runName = path.basename(resolvedRunRoot);
  if (!isContained || !runName.startsWith(runDirectoryPrefix)) {
    throw new Error('refusing to remove a fresh-consumer path outside its owned temporary directory');
  }
  const stat = lstatSync(resolvedRunRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('refusing to remove a fresh-consumer path that is not an owned directory');
  }
  const markerPath = path.join(resolvedRunRoot, ownerMarkerName);
  let markerStat;
  try {
    markerStat = lstatSync(markerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('refusing to remove a fresh-consumer directory without its ownership marker');
    }
    throw error;
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()
    || readFileSync(markerPath, 'utf8') !== ownerMarkerContents) {
    throw new Error('refusing to remove a fresh-consumer directory without its ownership marker');
  }
  rmSync(resolvedRunRoot, { recursive: true, force: false });
}

export function finishFreshConsumerRun(runRoot, { completed, keepFailed, tempRoot = tmpdir() }) {
  if (!completed && keepFailed) return false;
  removeFreshConsumerRunRoot(runRoot, tempRoot);
  return true;
}
