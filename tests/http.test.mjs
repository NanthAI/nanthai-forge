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
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
