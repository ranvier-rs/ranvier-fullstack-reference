import path from 'node:path';

export function parseFreshConsumerGateOptions(args, repoRoot) {
  const options = {
    evidenceRoot: path.join(repoRoot, 'target', 'm420-consumer-evidence'),
    runLinux: true,
    runWindows: true,
    keepFailedRun: false,
  };
  let evidenceRootProvided = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--windows-only') {
      options.runLinux = false;
    } else if (argument === '--linux-only') {
      options.runWindows = false;
    } else if (argument === '--keep-failed-run') {
      options.keepFailedRun = true;
    } else if (argument === '--evidence-root') {
      if (evidenceRootProvided) {
        throw new Error('--evidence-root may be specified only once');
      }
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--evidence-root requires a path');
      }
      options.evidenceRoot = path.resolve(repoRoot, value);
      evidenceRootProvided = true;
      index += 1;
    } else {
      throw new Error(`unknown fresh-consumer gate option: ${argument}`);
    }
  }

  if (!options.runWindows && !options.runLinux) {
    throw new Error('choose at most one of --windows-only and --linux-only');
  }

  return options;
}
