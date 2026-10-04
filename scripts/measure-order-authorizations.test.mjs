import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  gunzipSync,
} from 'node:zlib';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  ConcurrencyGuard,
  parseOptions,
  parseProcStatStartTime,
  parseProcStatus,
  percentile,
  readProcessMemory,
  runBenchmark,
} from './measure-order-authorizations.mjs';

function makeOptions(outputDir, baseUrl, overrides = {}) {
  return {
    baseUrl,
    adapter: 'native',
    runId: `test-${Math.random().toString(16).slice(2, 10)}`,
    serverPid: process.pid,
    concurrency: 2,
    warmupSeconds: 0,
    durationSeconds: 0.1,
    outputDir,
    requestTimeoutMs: 100,
    ...overrides,
  };
}

async function startMockServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function respondJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readSamples(samplesPath) {
  return gunzipSync(readFileSync(samplesPath))
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readRssSamples(samplesPath) {
  return gunzipSync(readFileSync(samplesPath))
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakeMemoryReader() {
  let calls = 0;
  return async () => {
    calls += 1;
    const vmrssBytes = 128 * 1024 + calls * 1024;
    return {
      vmrssBytes,
      vmhwmBytes: vmrssBytes + 16 * 1024,
      processStartTime: '42',
    };
  };
}

test('M429 runner validates every required option and rejects unsafe values before work starts', () => {
  const argv = [
    '--base-url', 'http://127.0.0.1:3000',
    '--adapter', 'native',
    '--run-id', 'pilot-001',
    '--server-pid', '1234',
    '--concurrency', '8',
    '--warmup-seconds', '10',
    '--duration-seconds', '30',
    '--output-dir', 'evidence/benchmark-comparison',
  ];
  const parsed = parseOptions(argv, 'F:/reference');
  assert.equal(parsed.adapter, 'native');
  assert.equal(parsed.concurrency, 8);
  assert.equal(parsed.requestTimeoutMs, 5_000);
  assert.equal(parsed.outputDir, path.resolve('F:/reference/evidence/benchmark-comparison'));

  assert.throws(() => parseOptions(argv.slice(0, -2)), /missing required options/);
  assert.throws(() => parseOptions([...argv, '--concurrency', '9']), /may be specified only once/);
  assert.throws(() => parseOptions(argv.map((value) => value === '8' ? '257' : value)), /--concurrency must be between/);
  assert.throws(() => parseOptions(argv.map((value) => value === 'pilot-001' ? '../outside' : value)), /--run-id/);
  assert.throws(() => parseOptions(argv.map((value) => value === 'http://127.0.0.1:3000' ? 'http://user:secret@127.0.0.1:3000' : value)), /--base-url/);
  assert.throws(() => parseOptions(argv.map((value) => value === 'http://127.0.0.1:3000' ? 'http://127.0.0.1:3000?token=x' : value)), /--base-url/);
  assert.throws(() => parseOptions([...argv, '--unbounded']), /unknown option/);
});

test('RSS parsing requires both Linux memory fields and converts kB to bytes', () => {
  assert.deepEqual(
    parseProcStatus('Name:\tserver\nVmHWM:\t256 kB\nVmRSS:\t128 kB\n'),
    { vmrssBytes: 128 * 1024, vmhwmBytes: 256 * 1024 },
  );
  assert.throws(() => parseProcStatus('VmRSS:\t128 kB\n'), { code: 'rss_sample_invalid' });
  assert.throws(() => parseProcStatus('VmRSS:\t0 kB\nVmHWM:\t0 kB\n'), { code: 'rss_sample_invalid' });
  const statFields = ['S', ...Array(18).fill('0'), '42'];
  assert.equal(parseProcStatStartTime(`123 (mock ) server) ${statFields.join(' ')} 0 0`), '42');
  assert.throws(() => parseProcStatStartTime('123 (truncated) S 0'), { code: 'process_identity_invalid' });
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
  assert.equal(percentile([], 0.95), null);

  const guard = new ConcurrencyGuard(2);
  guard.enter();
  guard.enter();
  assert.throws(() => guard.enter(), { code: 'maximum_concurrency_exceeded' });
  assert.equal(guard.maximumObserved, 2);
  guard.leave();
  guard.leave();
});

test('S1 mock run records unique request IDs, excludes warmup from latency, and respects concurrency', async () => {
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const mock = await startMockServer((request, response) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      const finish = () => {
        active -= 1;
        if (!response.destroyed) respondJson(response, 200, { status: 'ok', result: { outcome: 'approved' } });
      };
      setTimeout(finish, 4);
    });
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-s1-'));
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'happy-s1',
      concurrency: 3,
      warmupSeconds: 0.04,
      durationSeconds: 0.12,
    }), {
      readMemory: fakeMemoryReader(),
      sampleIntervalMs: 10,
    });
    const samples = readSamples(run.samplesPath);
    const rssSamples = readRssSamples(run.rssSamplesPath);
    const warmup = samples.filter((sample) => sample.phase === 'warmup');
    const measured = samples.filter((sample) => sample.phase === 'measurement');
    const allIds = requests.map((request) => request.order_id);

    assert.equal(run.summary.runner_status, 'PASS');
    assert.equal(run.summary.schema_version, '1.1.0');
    assert.equal(run.summary.comparison_eligibility, 'NOT_ASSESSED');
    assert.ok(warmup.length > 0);
    assert.ok(measured.length > 0);
    assert.equal(run.summary.request_counts.measurement.total, measured.length);
    assert.equal(run.summary.request_counts.warmup.total, warmup.length);
    assert.equal(run.summary.request_counts.all_phases.total, samples.length);
    assert.equal(new Set(allIds).size, allIds.length);
    assert.ok(requests.every((request) => request.fixture === 'normal'));
    assert.ok(requests.every((request) => request.order_id === request.idempotency_key));
    assert.ok(run.summary.timing.latency_ms_all_attempts.p50 >= 0);
    assert.equal(run.summary.concurrency.limit_respected, true);
    assert.ok(run.summary.concurrency.maximum_observed_in_flight <= 3);
    assert.ok(maximumActive <= 3);
    assert.ok(run.summary.rss.sample_count >= 2);
    assert.equal(run.summary.rss.final_sample_present, true);
    assert.ok(run.summary.rss.process_vmhwm_increase_since_initial_bytes >= 0);
    assert.equal(rssSamples.length, run.summary.rss.sample_count);
    assert.equal(run.summary.artifacts.raw_rss_samples, 'rss-samples.jsonl.gz');
    assert.equal(rssSamples.filter((sample) => sample.final).length, 1);
    assert.equal(rssSamples.at(-1).final, true);
    assert.ok(rssSamples.every((sample) => sample.vmrss_bytes > 0 && sample.vmhwm_bytes >= sample.vmrss_bytes));
    assert.ok(rssSamples.every((sample) => sample.process_start_time === '42'));
  } finally {
    await mock.close();
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('4xx and 5xx responses remain in raw samples and invalidate the run', async () => {
  let requestCount = 0;
  const mock = await startMockServer((_request, response) => {
    requestCount += 1;
    const status = requestCount % 2 === 0 ? 503 : 422;
    respondJson(response, status, { status: 'fault', fault: { code: 'mock_failure' } });
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-http-error-'));
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'http-errors',
      concurrency: 1,
      durationSeconds: 0.06,
    }), { readMemory: fakeMemoryReader(), sampleIntervalMs: 10 });
    const samples = readSamples(run.samplesPath);
    assert.equal(run.summary.runner_status, 'FAIL');
    assert.ok(run.summary.errors.counts.http_4xx > 0);
    assert.ok(run.summary.errors.counts.http_5xx > 0);
    assert.ok(samples.every((sample) => sample.status === 422 || sample.status === 503));
  } finally {
    await mock.close();
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('malformed 2xx response invalidates the run', async () => {
  const mock = await startMockServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{not-json');
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-malformed-'));
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'malformed',
      concurrency: 1,
      durationSeconds: 0.06,
    }), { readMemory: fakeMemoryReader(), sampleIntervalMs: 10 });
    assert.equal(run.summary.runner_status, 'FAIL');
    assert.ok(run.summary.errors.counts.malformed_response > 0);
    assert.ok(readSamples(run.samplesPath).every((sample) => sample.error === 'malformed_response'));
  } finally {
    await mock.close();
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('oversized responses are bounded and classified as malformed', async () => {
  const mock = await startMockServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('x'.repeat(70 * 1024));
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-oversized-'));
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'oversized',
      concurrency: 1,
      durationSeconds: 0.06,
    }), { readMemory: fakeMemoryReader(), sampleIntervalMs: 10 });
    assert.equal(run.summary.runner_status, 'FAIL');
    assert.ok(run.summary.errors.counts.malformed_response > 0);
  } finally {
    await mock.close();
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('request timeout is recorded as a failure and does not hang the run', async () => {
  const mock = await startMockServer((_request, response) => {
    response.on('close', () => {});
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-timeout-'));
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'timeouts',
      concurrency: 1,
      durationSeconds: 0.07,
      requestTimeoutMs: 20,
    }), { readMemory: fakeMemoryReader(), sampleIntervalMs: 10 });
    assert.equal(run.summary.runner_status, 'FAIL');
    assert.ok(run.summary.errors.counts.timeout > 0);
    assert.ok(run.summary.request_counts.measurement.total > 0);
  } finally {
    await mock.close();
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('missing /proc RSS source invalidates the run before any request is sent', async () => {
  let requests = 0;
  const mock = await startMockServer((_request, response) => {
    requests += 1;
    respondJson(response, 200, { status: 'ok', result: { outcome: 'approved' } });
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-no-rss-'));
  const procRoot = mkdtempSync(path.join(tmpdir(), 'm429-rq2-proc-missing-'));
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'rss-missing',
      serverPid: 987_654_321,
      durationSeconds: 1,
    }), {
      procRoot,
      pidExists: () => true,
      sampleIntervalMs: 10,
    });
    assert.equal(run.summary.runner_status, 'FAIL');
    assert.equal(run.summary.errors.runner_failure, 'rss_source_missing');
    assert.equal(run.summary.rss.sample_count, 0);
    assert.equal(requests, 0);
  } finally {
    await mock.close();
    rmSync(procRoot, { recursive: true, force: false });
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('server process exit during measurement invalidates the run and aborts in-flight requests', async () => {
  const mock = await startMockServer((_request, response) => {
    const timer = setTimeout(() => {
      if (!response.destroyed) respondJson(response, 200, { status: 'ok', result: { outcome: 'approved' } });
    }, 200);
    response.on('close', () => clearTimeout(timer));
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-early-exit-'));
  const procRoot = mkdtempSync(path.join(tmpdir(), 'm429-rq2-proc-exit-'));
  const pid = 987_654_322;
  const pidDirectory = path.join(procRoot, String(pid));
  mkdirSync(pidDirectory);
  const statusPath = path.join(pidDirectory, 'status');
  writeFileSync(statusPath, 'VmRSS:\t128 kB\nVmHWM:\t160 kB\n');
  const statFields = ['S', ...Array(18).fill('0'), '42'];
  writeFileSync(path.join(pidDirectory, 'stat'), `${pid} (mock server) ${statFields.join(' ')} 0 0\n`);
  const removePid = setTimeout(() => rmSync(pidDirectory, { recursive: true, force: true }), 35);
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'early-exit',
      serverPid: pid,
      concurrency: 1,
      durationSeconds: 1,
      requestTimeoutMs: 500,
    }), {
      procRoot,
      pidExists: () => false,
      sampleIntervalMs: 10,
    });
    assert.equal(run.summary.runner_status, 'FAIL');
    assert.equal(run.summary.errors.runner_failure, 'server_process_exited');
  } finally {
    clearTimeout(removePid);
    await mock.close();
    rmSync(procRoot, { recursive: true, force: false });
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('runner refuses to overwrite an existing run directory', async () => {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-collision-'));
  const runId = 'preserve-existing';
  const runDirectory = path.join(outputDir, runId);
  mkdirSync(runDirectory);
  const sentinel = path.join(runDirectory, 'keep.txt');
  writeFileSync(sentinel, 'existing evidence\n');
  try {
    await assert.rejects(
      runBenchmark(makeOptions(outputDir, 'http://127.0.0.1:1', { runId })),
      { code: 'EEXIST' },
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'existing evidence\n');
  } finally {
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('sample-writer backpressure invalidates the capture instead of claiming comparable throughput', async () => {
  const mock = await startMockServer((_request, response) => {
    respondJson(response, 200, { status: 'ok', result: { outcome: 'approved' } });
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-writer-backpressure-'));
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'writer-backpressure',
      concurrency: 1,
      durationSeconds: 0.06,
    }), {
      readMemory: fakeMemoryReader(),
      sampleIntervalMs: 10,
      sampleWriterFactory: () => ({
        async write() {},
        async close() {},
        metrics: () => ({ backpressureCount: 1, backpressureWaitMs: 4 }),
      }),
    });
    assert.equal(run.summary.runner_status, 'FAIL');
    assert.equal(run.summary.sample_writer.measurement_valid, false);
    assert.ok(run.summary.errors.failure_codes.includes('sample_writer_backpressure'));
  } finally {
    await mock.close();
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('RSS sample-writer backpressure invalidates the capture and is reported separately', async () => {
  const mock = await startMockServer((_request, response) => {
    respondJson(response, 200, { status: 'ok', result: { outcome: 'approved' } });
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-rss-writer-backpressure-'));
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'rss-writer-backpressure',
      concurrency: 1,
      durationSeconds: 0.06,
    }), {
      readMemory: fakeMemoryReader(),
      sampleIntervalMs: 10,
      rssSampleWriterFactory: () => ({
        async write() {},
        async close() {},
        metrics: () => ({ backpressureCount: 1, backpressureWaitMs: 3 }),
      }),
    });
    assert.equal(run.summary.runner_status, 'FAIL');
    assert.equal(run.summary.sample_writer.measurement_valid, false);
    assert.equal(run.summary.sample_writer.request_backpressure_count, 0);
    assert.equal(run.summary.sample_writer.rss_backpressure_count, 1);
    assert.equal(run.summary.sample_writer.backpressure_count, 1);
    assert.ok(run.summary.errors.failure_codes.includes('sample_writer_backpressure'));
  } finally {
    await mock.close();
    rmSync(outputDir, { recursive: true, force: false });
  }
});

test('readProcessMemory distinguishes an absent source from an exited process', async () => {
  const procRoot = mkdtempSync(path.join(tmpdir(), 'm429-rq2-proc-reader-'));
  try {
    const pid = 987_654_324;
    const pidDirectory = path.join(procRoot, String(pid));
    mkdirSync(pidDirectory);
    const statFields = ['S', ...Array(18).fill('0'), '42'];
    writeFileSync(path.join(pidDirectory, 'status'), 'VmRSS:\t128 kB\nVmHWM:\t160 kB\n');
    writeFileSync(path.join(pidDirectory, 'stat'), `${pid} (mock server) ${statFields.join(' ')} 0 0\n`);
    assert.deepEqual(await readProcessMemory(pid, { procRoot }), {
      vmrssBytes: 128 * 1024,
      vmhwmBytes: 160 * 1024,
      processStartTime: '42',
    });
    await assert.rejects(readProcessMemory(987_654_323, { procRoot, pidExists: () => true }), {
      code: 'rss_source_missing',
    });
    await assert.rejects(readProcessMemory(987_654_323, { procRoot, pidExists: () => false }), {
      code: 'server_process_exited',
    });
  } finally {
    rmSync(procRoot, { recursive: true, force: false });
  }
});

test('RSS samples fail closed if the process ID is reused for a different process', async () => {
  const mock = await startMockServer((_request, response) => {
    respondJson(response, 200, { status: 'ok', result: { outcome: 'approved' } });
  });
  const outputDir = mkdtempSync(path.join(tmpdir(), 'm429-rq2-pid-reuse-'));
  let readCount = 0;
  try {
    const run = await runBenchmark(makeOptions(outputDir, mock.baseUrl, {
      runId: 'pid-reused',
      durationSeconds: 1,
    }), {
      readMemory: async () => {
        readCount += 1;
        return {
          vmrssBytes: 128 * 1024,
          vmhwmBytes: 160 * 1024,
          processStartTime: readCount === 1 ? '100' : '200',
        };
      },
      sampleIntervalMs: 10,
    });
    assert.equal(run.summary.runner_status, 'FAIL');
    assert.equal(run.summary.errors.runner_failure, 'server_process_identity_changed');
  } finally {
    await mock.close();
    rmSync(outputDir, { recursive: true, force: false });
  }
});
