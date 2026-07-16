#!/usr/bin/env node

import { createReadStream, statSync } from 'node:fs';
import { createServer, request as proxyRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const host = valueAfter('--host', '127.0.0.1');
const port = Number(valueAfter('--port', '8080'));
const api = new URL(valueAfter('--api', 'http://127.0.0.1:3000'));
const indexPath = path.join(repositoryRoot, 'frontend', 'index.html');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('port must be an integer from 1 through 65535');
}
statSync(indexPath);

const server = createServer((incoming, response) => {
  const requestUrl = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? host}`);
  if (requestUrl.pathname.startsWith('/api/')) {
    const upstream = proxyRequest(
      {
        protocol: api.protocol,
        hostname: api.hostname,
        port: api.port,
        method: incoming.method,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        headers: { ...incoming.headers, host: api.host },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":"upstream unavailable"}');
    });
    incoming.pipe(upstream);
    return;
  }

  if (requestUrl.pathname !== '/' && requestUrl.pathname !== '/index.html') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(indexPath).pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(`reference UI listening on http://${host}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
