#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { mkdir as mkdirAsync, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';

const ENDPOINT = '/api/order-authorizations';
const ADAPTERS = new Set(['native', 'hybrid', 'plain-axum-control']);
const MAX_CONCURRENCY = 256;
const MAX_RUN_ID_LENGTH = 64;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

export class RunnerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

const USAGE = `Usage: node scripts/measure-order-authorizations.mjs \\
  --base-url http://127.0.0.1:8080 --adapter native --run-id pilot-001 \\
  --server-pid 1234 --concurrency 8 --warmup-seconds 10 \\
  --duration-seconds 30 --output-dir evidence/benchmark-comparison \\
  [--request-timeout-ms 5000]

The runner requires Node 24 on Linux. It sends only the S1 normal fixture and
samples VmRSS/VmHWM from /proc/<server-pid>/status every second. Each run writes
summary.json plus gzip-compressed request and RSS JSONL samples under
<output-dir>/<run-id>/.
`;

function parseInteger(value, flag, minimum, maximum) {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '')) {
    throw new Error(`${flag} must be an integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

export function parseOptions(args, cwd = process.cwd()) {
  if (args.length === 1 && args[0] === '--help') return { help: true };

  const values = new Map();
  const known = new Set([
    '--base-url', '--adapter', '--run-id', '--server-pid', '--concurrency',
    '--warmup-seconds', '--duration-seconds', '--output-dir', '--request-timeout-ms',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!known.has(flag)) throw new Error(`unknown option: ${flag}`);
    if (values.has(flag)) throw new Error(`${flag} may be specified only once`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }

  const required = [
    '--base-url', '--adapter', '--run-id', '--server-pid', '--concurrency',
    '--warmup-seconds', '--duration-seconds', '--output-dir',
  ];
  const missing = required.filter((flag) => !values.has(flag));
  if (missing.length > 0) throw new Error(`missing required options: ${missing.join(', ')}`);

  let baseUrl;
  try {
    const parsed = new URL(values.get('--base-url'));
    if (!['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash) {
      throw new Error();
    }
    baseUrl = parsed.origin;
  } catch {
    throw new Error('--base-url must be an HTTP(S) origin without credentials, path, query, or fragment');
  }

  const adapter = values.get('--adapter');
  if (!ADAPTERS.has(adapter)) throw new Error('--adapter must be native, hybrid, or plain-axum-control');

  const runId = values.get('--run-id');
  if (runId.length > MAX_RUN_ID_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)
    || runId.includes('..')) {
    throw new Error(`--run-id must be 1-${MAX_RUN_ID_LENGTH} safe filename characters and may not contain '..'`);
  }

  return {
    baseUrl,
    adapter,
    runId,
    serverPid: parseInteger(values.get('--server-pid'), '--server-pid', 1, 2_147_483_647),
    concurrency: parseInteger(values.get('--concurrency'), '--concurrency', 1, MAX_CONCURRENCY),
    warmupSeconds: parseInteger(values.get('--warmup-seconds'), '--warmup-seconds', 0, 3_600),
    durationSeconds: parseInteger(values.get('--duration-seconds'), '--duration-seconds', 1, 3_600),
    outputDir: path.resolve(cwd, values.get('--output-dir')),
    requestTimeoutMs: parseInteger(
      values.get('--request-timeout-ms') ?? String(DEFAULT_REQUEST_TIMEOUT_MS),
      '--request-timeout-ms',
      1,
      MAX_REQUEST_TIMEOUT_MS,
    ),
  };
}

export function parseProcStatus(statusText) {
  const fields = new Map();
  for (const line of statusText.split(/\r?\n/)) {
    const match = /^([^:]+):\s*(\d+)\s+(\S+)$/.exec(line);
    if (match) fields.set(match[1], { value: Number(match[2]), unit: match[3] });
  }

  const readKilobytes = (name) => {
    const field = fields.get(name);
    if (!field || field.unit !== 'kB' || !Number.isSafeInteger(field.value)) {
      throw new RunnerError('rss_sample_invalid');
    }
    return field.value * 1024;
  };
  const vmrssBytes = readKilobytes('VmRSS');
  const vmhwmBytes = readKilobytes('VmHWM');
  if (vmrssBytes <= 0 || vmhwmBytes < vmrssBytes) throw new RunnerError('rss_sample_invalid');
  return { vmrssBytes, vmhwmBytes };
}

export function parseProcStatStartTime(statText) {
  const closingParenthesis = statText.lastIndexOf(')');
  if (closingParenthesis < 0) throw new RunnerError('process_identity_invalid');
  const fields = statText.slice(closingParenthesis + 1).trim().split(/\s+/);
  const startTime = fields[19];
  if (!/^\d+$/.test(startTime ?? '')) throw new RunnerError('process_identity_invalid');
  return startTime;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw new RunnerError('process_presence_check_failed');
  }
}

export async function readProcessMemory(pid, { procRoot = '/proc', pidExists = processExists } = {}) {
  let statusText;
  try {
    statusText = await readFile(path.join(procRoot, String(pid), 'status'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (!pidExists(pid)) throw new RunnerError('server_process_exited');
      throw new RunnerError('rss_source_missing');
    }
    if (error?.code === 'EACCES') throw new RunnerError('rss_source_unreadable');
    throw new RunnerError('rss_source_read_failed');
  }
  const memory = parseProcStatus(statusText);
  let statText;
  try {
    statText = await readFile(path.join(procRoot, String(pid), 'stat'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && !pidExists(pid)) throw new RunnerError('server_process_exited');
    if (error?.code === 'ENOENT') throw new RunnerError('process_identity_missing');
    if (error?.code === 'EACCES') throw new RunnerError('rss_source_unreadable');
    throw new RunnerError('rss_source_read_failed');
  }
  return { ...memory, processStartTime: parseProcStatStartTime(statText) };
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!(fraction > 0 && fraction <= 1)) throw new RangeError('fraction must be in (0, 1]');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export class ConcurrencyGuard {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.maximumObserved = 0;
  }

  enter() {
    if (this.active + 1 > this.limit) throw new RunnerError('maximum_concurrency_exceeded');
    this.active += 1;
    this.maximumObserved = Math.max(this.maximumObserved, this.active);
  }

  leave() {
    if (this.active <= 0) throw new RunnerError('concurrency_guard_unbalanced');
    this.active -= 1;
  }
}

function safeErrorKind(error, requestTimedOut, runAborted) {
  if (runAborted) return 'runner_aborted';
  if (requestTimedOut || error?.name === 'TimeoutError') return 'timeout';
  return 'network_error';
}

async function readBoundedResponseText(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RunnerError('response_too_large');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RunnerError('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function createSampleWriter(filePath) {
  const gzip = createGzip({ level: 6 });
  const output = createWriteStream(filePath, { flags: 'wx' });
  let pipelineError;
  let backpressureCount = 0;
  let backpressureWaitMs = 0;
  const pipelineDone = pipeline(gzip, output).catch((error) => {
    pipelineError = error;
  });

  return {
    async write(sample) {
      if (pipelineError) throw pipelineError;
      if (!gzip.write(`${JSON.stringify(sample)}\n`)) {
        backpressureCount += 1;
        const backpressureStarted = performance.now();
        await once(gzip, 'drain');
        backpressureWaitMs += performance.now() - backpressureStarted;
      }
      if (pipelineError) throw pipelineError;
    },
    async close() {
      gzip.end();
      await pipelineDone;
      if (pipelineError) throw pipelineError;
    },
    metrics() {
      return { backpressureCount, backpressureWaitMs };
    },
  };
}

function emptyCounts() {
  return { total: 0, successful: 0, failed: 0 };
}

function incrementStatus(statusCounts, status) {
  if (status === null) return;
  const key = String(status);
  statusCounts[key] = (statusCounts[key] ?? 0) + 1;
}

async function sendS1Request({
  baseUrl,
  runId,
  sequence,
  timeoutMs,
  fetchImpl,
  runSignal,
  now,
}) {
  const requestId = `rq2-${runId}-${sequence}`;
  const started = now();
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  let status = null;
  let outcome = null;
  let errorKind = null;

  try {
    const response = await fetchImpl(`${baseUrl}${ENDPOINT}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        order_id: requestId,
        idempotency_key: requestId,
        customer_id: 'customer-m429-benchmark',
        items: [{ item_id: 'sku-001', quantity: 2 }],
        amount_minor: 12_500,
        currency: 'USD',
        payment_reference: 'payment-token-benchmark',
        fixture: 'normal',
      }),
      signal: AbortSignal.any([runSignal, timeoutController.signal]),
    });
    status = response.status;
    let bodyText;
    try {
      bodyText = await readBoundedResponseText(response);
    } catch (error) {
      if (error?.code === 'response_too_large') errorKind = 'malformed_response';
      else throw error;
    }

    if (errorKind) {
      // Oversized bodies are malformed regardless of their HTTP status.
    } else if (status < 200 || status >= 300) {
      errorKind = status >= 400 && status < 500
        ? 'http_4xx'
        : status >= 500 && status < 600
          ? 'http_5xx'
          : 'http_non_2xx';
    } else {
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        errorKind = 'malformed_response';
      }
      if (!errorKind) {
        outcome = body?.result?.outcome ?? null;
        if (body?.status !== 'ok' || outcome !== 'approved') errorKind = 'malformed_response';
      }
    }
  } catch (error) {
    errorKind = safeErrorKind(error, timedOut, runSignal.aborted);
  } finally {
    clearTimeout(timer);
  }

  return {
    request_id: requestId,
    latency_ms: Math.max(0, now() - started),
    status,
    outcome,
    error: errorKind,
    successful: errorKind === null,
  };
}

/** Run a single S1 measurement. Dependencies are injectable for local mock-server tests only. */
export async function runBenchmark(options, dependencies = {}) {
  const now = dependencies.monotonicNow ?? (() => performance.now());
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sampleIntervalMs = dependencies.sampleIntervalMs ?? 1_000;
  const readMemory = dependencies.readMemory
    ?? ((pid) => readProcessMemory(pid, {
      procRoot: dependencies.procRoot ?? '/proc',
      pidExists: dependencies.pidExists ?? processExists,
    }));
  if (typeof fetchImpl !== 'function') throw new RunnerError('fetch_unavailable');

  const runDirectory = path.join(options.outputDir, options.runId);
  await mkdirAsync(options.outputDir, { recursive: true });
  await mkdirAsync(runDirectory);
  const samplesPath = path.join(runDirectory, 'samples.jsonl.gz');
  const rssSamplesPath = path.join(runDirectory, 'rss-samples.jsonl.gz');
  const summaryPath = path.join(runDirectory, 'summary.json');
  const writer = (dependencies.sampleWriterFactory ?? createSampleWriter)(samplesPath);
  const rssWriter = (dependencies.rssSampleWriterFactory ?? createSampleWriter)(rssSamplesPath);

  const startedAtUtc = new Date().toISOString();
  const runStarted = now();
  const abortController = new AbortController();
  const warmupCounts = emptyCounts();
  const measurementCounts = emptyCounts();
  const errorCounts = {};
  const measuredLatencies = [];
  const measuredStatusCounts = {};
  const rssSamples = [];
  let serverProcessStartTime = null;
  let requestSequence = 0;
  const concurrencyGuard = new ConcurrencyGuard(options.concurrency);
  let fatalError = null;
  let stopSampler = false;
  const samplerAbort = new AbortController();

  const failRun = (error) => {
    if (fatalError) return;
    fatalError = error instanceof RunnerError ? error : new RunnerError('runner_internal_error');
    abortController.abort();
  };

  const captureRss = async (isFinal = false) => {
    const sample = await readMemory(options.serverPid);
    if (!sample || !Number.isSafeInteger(sample.vmrssBytes) || !Number.isSafeInteger(sample.vmhwmBytes)
      || sample.vmrssBytes <= 0 || sample.vmhwmBytes < sample.vmrssBytes) {
      throw new RunnerError('rss_sample_invalid');
    }
    if (sample.processStartTime !== undefined) {
      if (serverProcessStartTime !== null && serverProcessStartTime !== sample.processStartTime) {
        throw new RunnerError('server_process_identity_changed');
      }
      serverProcessStartTime = sample.processStartTime;
    }
    const rssSample = {
      elapsed_ms: Math.max(0, now() - runStarted),
      vmrss_bytes: sample.vmrssBytes,
      vmhwm_bytes: sample.vmhwmBytes,
      process_start_time: sample.processStartTime ?? null,
      final: isFinal,
    };
    rssSamples.push(rssSample);
    await rssWriter.write(rssSample);
  };

  const samplerTask = (async () => {
    try {
      while (!stopSampler) {
        await delay(sampleIntervalMs, undefined, { signal: samplerAbort.signal });
        if (stopSampler) break;
        await captureRss();
      }
    } catch (error) {
      if (error?.name !== 'AbortError') failRun(error);
    }
  })();

  const runPhase = async (phase, durationSeconds, counts) => {
    if (durationSeconds <= 0 || fatalError) return { elapsedSeconds: 0 };
    const phaseStarted = now();
    const deadline = phaseStarted + durationSeconds * 1_000;
    const worker = async () => {
      while (!fatalError && !abortController.signal.aborted && now() < deadline) {
        const sequence = ++requestSequence;
        let entered = false;
        let sample;
        try {
          concurrencyGuard.enter();
          entered = true;
          sample = await sendS1Request({
            baseUrl: options.baseUrl,
            runId: options.runId,
            sequence,
            timeoutMs: options.requestTimeoutMs,
            fetchImpl,
            runSignal: abortController.signal,
            now,
          });
        } catch (error) {
          failRun(error);
          return;
        } finally {
          if (entered) concurrencyGuard.leave();
        }

        counts.total += 1;
        if (sample.successful) counts.successful += 1;
        else {
          counts.failed += 1;
          errorCounts[sample.error] = (errorCounts[sample.error] ?? 0) + 1;
        }
        if (phase === 'measurement') {
          measuredLatencies.push(sample.latency_ms);
          incrementStatus(measuredStatusCounts, sample.status);
        }
        await writer.write({
          phase,
          ...sample,
          elapsed_ms: Math.max(0, now() - runStarted),
        });
      }
    };
    await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
    return { elapsedSeconds: Math.max(0, (now() - phaseStarted) / 1_000) };
  };

  let warmupElapsedSeconds = 0;
  let measurementElapsedSeconds = 0;
  try {
    try {
      await captureRss();
    } catch (error) {
      failRun(error);
    }
    if (!fatalError) {
      const warmup = await runPhase('warmup', options.warmupSeconds, warmupCounts);
      warmupElapsedSeconds = warmup.elapsedSeconds;
      const measurement = await runPhase('measurement', options.durationSeconds, measurementCounts);
      measurementElapsedSeconds = measurement.elapsedSeconds;
    }
  } finally {
    stopSampler = true;
    samplerAbort.abort();
    await samplerTask;
    if (!fatalError) {
      try {
        await captureRss(true);
      } catch (error) {
        failRun(error);
      }
    }
    const writerCloseResults = await Promise.allSettled([
      Promise.resolve().then(() => writer.close()),
      Promise.resolve().then(() => rssWriter.close()),
    ]);
    const writerCloseFailure = writerCloseResults.find((result) => result.status === 'rejected');
    if (writerCloseFailure?.status === 'rejected') throw writerCloseFailure.reason;
  }

  const totalCounts = {
    total: warmupCounts.total + measurementCounts.total,
    successful: warmupCounts.successful + measurementCounts.successful,
    failed: warmupCounts.failed + measurementCounts.failed,
  };
  const sampledPeakVmrssBytes = rssSamples.length > 0
    ? Math.max(...rssSamples.map((sample) => sample.vmrss_bytes))
    : null;
  const initialRss = rssSamples[0] ?? null;
  const lastRss = rssSamples.at(-1) ?? null;
  const requestSampleWriterMetrics = writer.metrics();
  const rssSampleWriterMetrics = rssWriter.metrics();
  const sampleWriterMetrics = {
    backpressureCount: requestSampleWriterMetrics.backpressureCount + rssSampleWriterMetrics.backpressureCount,
    backpressureWaitMs: requestSampleWriterMetrics.backpressureWaitMs + rssSampleWriterMetrics.backpressureWaitMs,
  };
  const allRequestsSucceeded = totalCounts.total > 0 && totalCounts.failed === 0;
  const runnerPassed = allRequestsSucceeded
    && measurementCounts.total > 0
    && rssSamples.length > 0
    && !fatalError
    && concurrencyGuard.maximumObserved <= options.concurrency
    && sampleWriterMetrics.backpressureCount === 0;
  const failureCodes = [...new Set([
    ...Object.keys(errorCounts),
    ...(fatalError ? [fatalError.code] : []),
    ...(concurrencyGuard.maximumObserved > options.concurrency ? ['maximum_concurrency_exceeded'] : []),
    ...(sampleWriterMetrics.backpressureCount > 0 ? ['sample_writer_backpressure'] : []),
  ])].sort();
  const summary = {
    schema_version: '1.1.0',
    run_id: options.runId,
    adapter: options.adapter,
    runner_status: runnerPassed ? 'PASS' : 'FAIL',
    comparison_eligibility: 'NOT_ASSESSED',
    claim_scope: 'single-run request and RSS capture; correctness preflight, isolated database, environment parity, and budget approval are outside this runner',
    started_at_utc: startedAtUtc,
    ended_at_utc: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    workload: {
      scenario: 'S1',
      fixture: 'normal',
      method: 'POST',
      endpoint: ENDPOINT,
      base_url: options.baseUrl,
      server_pid: options.serverPid,
      concurrency_limit: options.concurrency,
      warmup_seconds_requested: options.warmupSeconds,
      duration_seconds_requested: options.durationSeconds,
      request_timeout_ms: options.requestTimeoutMs,
      rss_sample_interval_ms: sampleIntervalMs,
    },
    request_counts: {
      warmup: warmupCounts,
      measurement: measurementCounts,
      all_phases: totalCounts,
      status_counts_measurement: measuredStatusCounts,
    },
    timing: {
      warmup_elapsed_seconds: warmupElapsedSeconds,
      measurement_elapsed_seconds: measurementElapsedSeconds,
      throughput_requests_per_second: measurementElapsedSeconds > 0
        ? measurementCounts.total / measurementElapsedSeconds
        : null,
      successful_requests_per_second: measurementElapsedSeconds > 0
        ? measurementCounts.successful / measurementElapsedSeconds
        : null,
      latency_ms_all_attempts: {
        p50: percentile(measuredLatencies, 0.50),
        p95: percentile(measuredLatencies, 0.95),
        p99: percentile(measuredLatencies, 0.99),
      },
    },
    errors: {
      counts: errorCounts,
      runner_failure: fatalError?.code ?? null,
      failure_codes: failureCodes,
    },
    concurrency: {
      configured_limit: options.concurrency,
      maximum_observed_in_flight: concurrencyGuard.maximumObserved,
      limit_respected: concurrencyGuard.maximumObserved <= options.concurrency,
    },
    sample_writer: {
      backpressure_count: sampleWriterMetrics.backpressureCount,
      backpressure_wait_ms: sampleWriterMetrics.backpressureWaitMs,
      request_backpressure_count: requestSampleWriterMetrics.backpressureCount,
      request_backpressure_wait_ms: requestSampleWriterMetrics.backpressureWaitMs,
      rss_backpressure_count: rssSampleWriterMetrics.backpressureCount,
      rss_backpressure_wait_ms: rssSampleWriterMetrics.backpressureWaitMs,
      measurement_valid: sampleWriterMetrics.backpressureCount === 0,
    },
    rss: {
      sample_count: rssSamples.length,
      sampled_peak_vmrss_bytes: sampledPeakVmrssBytes,
      initial_vmhwm_bytes: initialRss?.vmhwm_bytes ?? null,
      final_vmrss_bytes: lastRss?.vmrss_bytes ?? null,
      final_vmhwm_bytes: lastRss?.vmhwm_bytes ?? null,
      process_vmhwm_increase_since_initial_bytes: initialRss && lastRss
        ? Math.max(0, lastRss.vmhwm_bytes - initialRss.vmhwm_bytes)
        : null,
      final_sample_present: Boolean(lastRss?.final),
    },
    artifacts: {
      raw_samples: 'samples.jsonl.gz',
      raw_rss_samples: 'rss-samples.jsonl.gz',
      summary: 'summary.json',
    },
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  return { summary, runDirectory, summaryPath, samplesPath, rssSamplesPath };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  try {
    const options = parseOptions(args);
    if (options.help) {
      (dependencies.stdout ?? process.stdout).write(USAGE);
      return 0;
    }
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('runner requires Node.js 24');
    if (process.platform !== 'linux') throw new Error('runner requires Linux /proc RSS sampling');
    if (options.serverPid === process.pid) throw new Error('--server-pid must identify the measured server process');

    const { summary } = await runBenchmark(options, dependencies);
    (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.runner_status === 'PASS' ? 0 : 1;
  } catch (error) {
    (dependencies.stderr ?? process.stderr).write(`error: ${error?.message ?? 'runner failed'}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
