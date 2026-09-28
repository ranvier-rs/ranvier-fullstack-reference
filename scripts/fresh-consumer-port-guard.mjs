import { createServer } from 'node:net';

export async function assertLocalTcpPortsAvailable(bindings) {
  for (const { host, port } of bindings) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid TCP port ${port}`);
    }
    if (typeof host !== 'string' || host.length === 0) {
      throw new Error(`invalid TCP bind host for port ${port}`);
    }
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', (error) => {
        reject(new Error(`refusing fresh-consumer gate: ${host}:${port} is unavailable (${error.code})`));
      });
      server.listen({ host, port, exclusive: true }, () => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
  }
}
