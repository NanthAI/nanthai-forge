// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReuseKey, currentCheckReuseKey, gateCheck } from '../dist/check-reuse-key.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { createRunReceipt } from '../dist/work-run-receipt.js';
import { NativeSource } from '../dist/native-source.js';
import { fixture } from './landing-batch-fixture.mjs';

test('content key survives restart observations, sleep, Node patches and runner labels', async t => {
  const f = await fixture(t, { remote: false, files: { 'package-lock.json': '{}', 'file.txt': 'one' } });
  const input = await f.candidate('change.txt', undefined, false);
  const run = {
    head: input.view.head,
    check: f.check,
    environment: checkEnvironment(),
    backend: { actual: 'local' },
  };
  const key = checkReuseKey(f.store, run);
  assert.match(key, /^[a-f0-9]{64}$/);
  const environment = {
    ...run.environment,
    node: 'v24.22.999',
    os: 'later-os',
    fingerprint: 'a'.repeat(64),
    env: { ...run.environment.env, PATH: '/different/install/bin', npm_config_cache: '/different/cache' },
  };
  assert.equal(checkReuseKey(f.store, { ...run, environment }), key);
  assert.equal(currentCheckReuseKey(f.store, run, environment), key);
  assert.equal(checkReuseKey(new f.store.constructor(f.root), { ...run, environment }), key);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const moduleUrl = new URL('../dist/check-reuse-key.js', import.meta.url).href;
  const script = `import { checkReuseKey } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(checkReuseKey(${JSON.stringify({ root: f.root, native: true })}, ${JSON.stringify({ ...run, environment })}));`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: f.root },
  });
  assert.equal(child.stdout, key, 'a fresh process derives the same key from retained source');

  assert.notEqual(checkReuseKey(f.store, { ...run, environment: { ...environment, node: 'v24.23.0' } }), key);
  assert.notEqual(
    checkReuseKey(f.store, { ...run, check: { ...run.check, definition: 'b'.repeat(64) } }),
    key,
  );
  const source = new NativeSource(f.root);
  const files = source.state(run.head).files;
  const metadataHead = source.writeState(files, [run.head], 'later after sleep', 'later');
  assert.equal(checkReuseKey(f.store, { ...run, head: metadataHead }), key);
  const changed = files.map(file =>
    file.path === 'package-lock.json' ? { ...file, blob: source.put(Buffer.from('{"new":true}')) } : file,
  );
  const lockHead = source.writeState(changed, [run.head], 'new lockfile', 'later');
  assert.notEqual(checkReuseKey(f.store, { ...run, head: lockHead }), key);
  const remote = runtime =>
    checkReuseKey(f.store, { ...run, backend: { actual: 'github-actions', runtime } });
  assert.equal(remote('github-actions;repo:synthetic/repo;node:24.22.1;runs-on:ubuntu-latest'), key);
  assert.equal(remote('github-actions;repo:synthetic/repo;node:24.22.999;runs-on:blacksmith'), key);
  assert.notEqual(remote('github-actions;node:24.23.0'), key);
  assert.equal(remote('unknown runtime'), undefined);
});

test('declared inputs bind bytes and modes without binding tool install locators', async t => {
  const f = await fixture(t, { remote: false });
  const input = await f.candidate('input.txt', undefined, false);
  const declared = { kind: 'tool', executable: 'tool' };
  const run = {
    head: input.view.head,
    check: { ...f.check, declaredInputs: [declared] },
    environment: checkEnvironment(),
    backend: { actual: 'local' },
    inputObservations: [
      {
        input: declared,
        status: 'observed',
        sha256: 'a'.repeat(64),
        size: 1,
        mode: '755',
        locator: '/old/tool',
      },
    ],
  };
  const key = checkReuseKey(f.store, run);
  const observation = { ...run.inputObservations[0], locator: '/new/tool' };
  assert.equal(checkReuseKey(f.store, { ...run, inputObservations: [observation] }), key);
  for (const patch of [{ sha256: 'b'.repeat(64) }, { mode: '644' }, { status: 'unknown' }])
    assert.notEqual(
      checkReuseKey(f.store, { ...run, inputObservations: [{ ...observation, ...patch }] }),
      key,
    );
  const forwarded = { ...run, check: { ...f.check, env: ['TZ'] } };
  assert.notEqual(
    checkReuseKey(f.store, {
      ...forwarded,
      environment: { ...run.environment, env: { ...run.environment.env, TZ: 'new' } },
    }),
    checkReuseKey(f.store, forwarded),
  );
  assert.equal(gateCheck({ checkSelection: { partial: true } }), false);
  assert.equal(gateCheck({ checkSelection: { scope: 'partial' } }), false);
  assert.equal(gateCheck({ checkSelection: { scope: 'full' } }), true);
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
