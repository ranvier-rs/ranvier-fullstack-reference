import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { assertLocalTcpPortsAvailable } from './fresh-consumer-port-guard.mjs';

test('host port preflight rejects an existing listener without disturbing it', async () => {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');

  try {
    await assert.rejects(
      assertLocalTcpPortsAvailable([{ host: '127.0.0.1', port: address.port }]),
      /is unavailable \(EADDRINUSE\)/,
    );
    assert.equal(listener.listening, true);
  } finally {
    await new Promise((resolve, reject) => {
      listener.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  await assert.doesNotReject(assertLocalTcpPortsAvailable([{ host: '127.0.0.1', port: address.port }]));
});

test('host port preflight rejects invalid port values', async () => {
  await assert.rejects(
    assertLocalTcpPortsAvailable([{ host: '127.0.0.1', port: 0 }]),
    /invalid TCP port/,
  );
  await assert.rejects(
    assertLocalTcpPortsAvailable([{ host: '127.0.0.1', port: 65536 }]),
    /invalid TCP port/,
  );
});
