// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkReuseKey } from '../dist/check-reuse-key.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { createRunReceipt } from '../dist/work-run-receipt.js';
import { lockfileDigest } from '../dist/project-lockfile.js';

test('lockfileDigest: empty, single root file, and every other shape', () => {
  const empty = createHash('sha256').update('').digest('hex');
  const entry = (path, blob) => ({ path, blob: blob.repeat(64).slice(0, 64) });
  assert.equal(lockfileDigest([]), empty, 'no lockfile is the empty-input digest');
  assert.equal(lockfileDigest([entry('src/a.ts', 'a')]), empty, 'an unrelated file is not an input');
  assert.equal(lockfileDigest([entry('go.sum', 'a')]).length, 64);
  assert.equal(
    lockfileDigest([entry('go.sum', 'a')]),
    entry('go.sum', 'a').blob,
    'one root lockfile: its bytes',
  );
  const nested = lockfileDigest([entry('svc/go.sum', 'a')]);
  assert.notEqual(nested, entry('go.sum', 'a').blob, 'a moved lockfile changes the digest');
  const both = [entry('svc/go.sum', 'b'), entry('go.sum', 'a'), entry('lib/Cargo.lock', 'c')];
  const digest = lockfileDigest(both);
  assert.equal(lockfileDigest([...both].reverse()), digest, 'order of the State does not matter');
  assert.equal(lockfileDigest([...both, entry('README.md', 'd')]), digest, 'unrelated files do not matter');
  assert.notEqual(
    lockfileDigest([entry('svc/go.sum', 'x'), ...both.slice(1)]),
    digest,
    'nested bytes matter',
  );
  for (const name of [
    'gradle.lockfile',
    'packages.lock.json',
    'Podfile.lock',
    'Cargo.lock',
    'pnpm-lock.yaml',
  ])
    assert.notEqual(lockfileDigest([entry(`deep/er/${name}`, 'a')]), empty, `${name} pins at depth`);
});

test('completion receipt retains content key and full runtime fingerprint', () => {
  const environment = checkEnvironment();
  const receipt = createRunReceipt({
    reuseKey: 'a'.repeat(64),
    environment,
    status: 'passed',
    details: 'Synthetic completion',
    endedAt: new Date().toISOString(),
    exitCode: 0,
    backend: {
      actual: 'github-actions',
      requested: 'github-actions',
      runtime: 'node:24.22.1;runs-on:blacksmith',
    },
  });
  assert.equal(receipt.reuseKey, 'a'.repeat(64));
  assert.deepEqual(receipt.environment, environment);
  assert.equal(receipt.backend.runtime, 'node:24.22.1;runs-on:blacksmith');
});

test('Git receipts use exact tree and lockfile bytes in the same key contract', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { WorkService } = await import('../dist/work.js');
  const { selfMetricReuseKey } = await import('../dist/self-metrics-reuse-key.js');
  const { digest } = await import('../dist/hash.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-key-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const git = args =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init']);
  writeFileSync(join(root, 'package-lock.json'), '{"synthetic":true}\n');
  git(['add', 'package-lock.json']);
  git([
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '-m',
    'Synthetic fixture',
  ]);
  const environment = checkEnvironment();
  const store = new WorkService(root).store;
  const run = {
    head: git(['rev-parse', 'HEAD']),
    check: { definition: 'a'.repeat(64) },
    environment,
    backend: { actual: 'local' },
  };
  assert.equal(
    checkReuseKey(store, run),
    selfMetricReuseKey({
      tree: git(['rev-parse', 'HEAD^{tree}']),
      definition: run.check.definition,
      lockfile: digest('{"synthetic":true}\n'),
      node: environment.node,
      declaredInputs: { inputs: [], environment: [] },
    }),
  );
});

test('a pnpm, Yarn or Cargo project pins its own lockfile bytes, not the empty digest', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { WorkService } = await import('../dist/work.js');
  const { selfMetricReuseKey } = await import('../dist/self-metrics-reuse-key.js');
  const { digest } = await import('../dist/hash.js');
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  // The last one sits below the root (Issue 721cd45c): the git store reads it too.
  for (const lockfile of ['pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'svc/api/go.sum']) {
    const root = mkdtempSync(join(tmpdir(), 'forge-key-lock-'));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const git = args =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(['init']);
    mkdirSync(dirname(join(root, lockfile)), { recursive: true });
    writeFileSync(join(root, lockfile), `synthetic ${lockfile}\n`);
    writeFileSync(join(root, 'README.md'), 'synthetic\n');
    git(['add', '.']);
    git([
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      'commit',
      '-m',
      'Synthetic',
    ]);
    const environment = checkEnvironment();
    const run = {
      head: git(['rev-parse', 'HEAD']),
      check: { definition: 'a'.repeat(64) },
      environment,
      backend: { actual: 'local' },
    };
    assert.equal(
      checkReuseKey(new WorkService(root).store, run),
      selfMetricReuseKey({
        tree: git(['rev-parse', 'HEAD^{tree}']),
        definition: run.check.definition,
        lockfile: lockfile.includes('/')
          ? lockfileDigest([{ path: lockfile, blob: digest(`synthetic ${lockfile}\n`) }])
          : digest(`synthetic ${lockfile}\n`),
        node: environment.node,
        declaredInputs: { inputs: [], environment: [] },
      }),
      lockfile,
    );
  }
});
