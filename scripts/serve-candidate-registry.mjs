#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const registryRoot = realpathSync(path.resolve(process.env.RANVIER_CANDIDATE_REGISTRY ?? path.join(repoRoot, 'candidate-registry')));
const indexRoot = realpathSync(path.join(registryRoot, 'index'));
const host = process.env.RANVIER_CANDIDATE_REGISTRY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.RANVIER_CANDIDATE_REGISTRY_PORT ?? '43117', 10);

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': bytes.length,
    etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
    'cache-control': 'no-store',
  });
  if (response.req.method !== 'HEAD') response.end(bytes);
  else response.end();
}

function safeFile(root, relative) {
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('RANVIER_CANDIDATE_REGISTRY_PORT must be a valid TCP port');
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'method not allowed\n');
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://registry.invalid').pathname);
  } catch {
    send(response, 400, 'invalid request path\n');
    return;
  }
  if (pathname === '/config.json') {
    const authority = request.headers.host;
    if (!authority || /[\s/\\]/.test(authority)) {
      send(response, 400, 'invalid host header\n');
      return;
    }
    const body = `${JSON.stringify({
      dl: `http://${authority}/crates/{crate}/{version}/download`,
    })}\n`;
    send(response, 200, body, 'application/json');
    return;
  }
  const relative = pathname.replace(/^\/+/, '');
  const file = relative.startsWith('crates/')
    ? safeFile(registryRoot, relative)
    : safeFile(indexRoot, relative);
  if (!file) {
    send(response, 404, 'not found\n');
    return;
  }
  send(
    response,
    200,
    readFileSync(file),
    file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

server.listen(port, host, () => {
  console.log(`[candidate-registry] listening on http://${host}:${port}`);
});
