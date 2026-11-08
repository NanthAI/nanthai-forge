// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { capturedNotSaved, notSavedInclude, notSavedLimit } from '../dist/save-not-saved.js';
import { prepareMirror } from '../dist/hosted-github-mirror.js';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';

// Synthetic Go/.NET/Kotlin trees; no real repository content.
function checkout(t, s) {
  const base = mkdtempSync(join(tmpdir(), 'forge-any-ecosystem-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(base, 'checkout');
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: s.projectId,
        laneId: s.laneId,
        intentId: randomUUID(),
        head: s.baseline.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head: s.baseline.sha256, receiptId: 'main-0' },
        authority: { mode: 'server', epoch: 1 },
      },
      state: s.state,
      scope: ['a.txt'],
      materialized: ['a.txt'],
    }),
  );
  writeFileSync(join(root, 'a.txt'), 'original');
  const put = (path, text = 'package synthetic\n') => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  return { base, root, put };
}
// Generated per run, so no key is ever committed.
const privateKey = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const saved = capture => capture.changes.filter(change => change.after).map(change => change.path);

test('a hosted save keeps source in build/coverage folders and credentials code in any language', async t => {
  const s = await saveFixture(),
    { base, root, put } = checkout(t, s);
  const source = [
    'cmd/build/main.go',
    'pkg/coverage/c.go',
    'internal/auth/credentials.go',
    'src/Auth/Credentials.cs',
    'app/secrets.kt',
    'internal/secrets/store.go',
    'dist/index.js',
  ];
  for (const path of source) put(path);
  put('tls/server.pem', privateKey());
  put('internal/secrets/prod.yaml', 'synthetic: true\n');
  put('tls/ca.pem', 'synthetic certificate\n');
  put('.env/lib/site.py', 'x = 1\n');
  put('node_modules/dep/index.js', 'module.exports = 1;\n');
  symlinkSync(join(base, 'missing'), join(root, 'internal/node_modules'));
  put('.gitignore', '.env\n');
  const capture = await captureHostedSave(root, join(base, 'capture'));
  // A credential-looking name is saved when its bytes hold no credential.
  assert.deepEqual(
    saved(capture).sort(),
    [...source, '.gitignore', 'internal/secrets/prod.yaml', 'tls/ca.pem'].sort(),
  );
  // Only paths a repository would otherwise have saved are reported; ignored ones and installs stay quiet.
  assert.deepEqual(capture.notSaved, {
    count: 1,
    paths: [{ path: 'tls/server.pem', reason: 'secret-content' }],
    include: notSavedInclude,
  });
});

test('a Forge-like repository still leaves gitignored build output out, with no notice', async t => {
  const s = await saveFixture(),
    { base, root, put } = checkout(t, s);
  put('.gitignore', 'node_modules/\ndist/\nbuild/\ncoverage/\n.env\n*.pem\n');
  put('src/a.ts', 'export const a = 1;\n');
  for (const path of ['dist/a.js', 'build/x/out.js', 'web/coverage/lcov.info', '.env', 'k.pem']) put(path);
  const capture = await captureHostedSave(root, join(base, 'capture'));
  assert.deepEqual(saved(capture).sort(), ['.gitignore', 'src/a.ts']);
  assert.equal(capture.notSaved, undefined);
});

test('the not-saved notice is bounded and read back from the retained capture', async t => {
  const s = await saveFixture(),
    { root, put } = checkout(t, s);
  const key = privateKey();
  for (let i = 0; i < notSavedLimit + 5; i++) put(`keys/k${String(i).padStart(2, '0')}.pem`, key);
  const operationId = randomUUID();
  const { clientCacheRoot } = await import('../dist/root-paths.js');
  const capture = await captureHostedSave(
    root,
    join(clientCacheRoot(realpathSync(root)), 'saves', operationId),
  );
  assert.equal(capture.notSaved.count, notSavedLimit + 5);
  assert.equal(capture.notSaved.paths.length, notSavedLimit);
  assert.deepEqual(capturedNotSaved(root, operationId), capture.notSaved);
});

test('the mirror plan publishes tracked build files and tracked credential-looking names', async () => {
  const f = mirrorFixture({
    before: { 'build/x.sh': 'echo old\n', '.env': 'A=1\n', 'tls/k.pem': 'old' },
    after: {
      'build/x.sh': 'echo new\n',
      'cmd/build/main.go': 'package main\n',
      '.env': 'A=2\n',
      'tls/k.pem': 'new',
      'internal/auth/credentials.go': 'package auth\n',
    },
  });
  const plan = await prepareMirror(f.seed, f.io);
  assert.deepEqual(plan.pending.map(file => file.path).sort(), [
    '.env',
    'build/x.sh',
    'cmd/build/main.go',
    'internal/auth/credentials.go',
    'tls/k.pem',
  ]);
});
