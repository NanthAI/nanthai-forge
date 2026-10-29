// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { serveRepository } from '../dist/http.js';
import { initNative } from '../dist/native-work.js';

async function local(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-http-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;
  const request = (path, options = {}) =>
    fetch(`${origin}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${server.token}`, ...options.headers },
    });
  return { root, server, origin, request };
}

test('local HTTP requires capability and rejects foreign hosts, origins and cross-site requests', async t => {
  const { origin, request } = await local(t);
  assert.equal((await fetch(`${origin}/api/work`)).status, 401);
  assert.equal((await request('/api/work', { headers: { Authorization: 'Bearer bad' } })).status, 401);
  assert.equal((await request('/api/work', { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await request('/api/work', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      `${origin}/api/work`,
      { headers: { Host: 'attacker.invalid' } },
      response => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
  assert.equal(foreignHost, 403);
  const response = await request('/api/work?compact=true');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('local serve offers Git transport and /api/work but serves no browser UI or UI read routes', async t => {
  const { server, request } = await local(t);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}$/);
  const work = await request('/api/work?compact=true');
  assert.equal(work.status, 200);
  assert.equal(typeof (await work.json()).revision, 'number');
  // The Git router owns /api/git/: it answers with its own endpoint error, not the generic one.
  const git = await request('/api/git/unknown/info/refs?service=git-upload-pack');
  assert.equal(git.status, 404);
  assert.match((await git.json()).error.message, /Git endpoint/);
  for (const path of [
    '/',
    '/index.html',
    '/assets/index.js',
    '/local/demo/intents',
    '/api/status',
    '/api/source?file=a.ts',
    '/api/files',
    '/api/home',
    '/api/readme',
    '/api/changes',
    '/api/change-map',
    '/api/coordination',
    '/api/presence',
    '/api/work-revision',
    '/api/view',
    '/api/brief',
    '/api/run-log',
    '/api/file-link',
  ]) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, 'NOT_FOUND', path);
  }
  assert.equal((await request('/api/reindex', { method: 'POST' })).status, 404);
});

test('owner runtime probe authenticates and exposes only process identity, retaining private discovery until close', async t => {
  const { readFileSync, statSync, existsSync } = await import('node:fs');
  const { root, server, origin, request } = await local(t);
  const path = join(root, '.forge/work/owner-runtime.json');
  const retained = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(retained.token, server.token);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal((await fetch(`${origin}/api/owner`)).status, 401);
  const response = await request('/api/owner');
  assert.equal(response.status, 200);
  const observed = await response.json();
  assert.equal(observed.pid, process.pid);
  assert.equal(observed.startTime, retained.startTime);
  assert.equal(observed.executablePath, retained.executablePath);
  assert.equal(observed.token, undefined);
  await server.close();
  assert.equal(existsSync(path), false);
});

test('unwritable runtime discovery preserves the existing serve APIs', async t => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.default.openSync;
  t.mock.method(fs.default, 'openSync', (path, ...args) => {
    if (String(path).includes('owner-runtime.json.'))
      throw Object.assign(new Error('Synthetic unwritable discovery'), { code: 'EACCES' });
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { request } = await local(t);
  assert.equal((await request('/api/work?compact=true')).status, 200);
  const probe = await request('/api/owner');
  assert.equal((await probe.json()).error.code, 'OWNER_RUNTIME_UNAVAILABLE');
});

test('discovery cleanup failure cannot prevent server shutdown', async t => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { server, origin } = await local(t);
  const original = fs.default.rmSync;
  t.mock.method(fs.default, 'rmSync', (path, ...args) => {
    if (String(path).endsWith('/owner-runtime.json'))
      throw Object.assign(new Error('Synthetic unwritable discovery cleanup'), { code: 'EACCES' });
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await server.close();
  await assert.rejects(fetch(`${origin}/api/work`));
});
