// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { moduleUrl } from './convex-module.mjs';
import { exchangeCli, exchangeCommand } from '../dist/exchange-cli.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { CUTOVER_UPGRADE } from '../dist/cutover-version.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { updateHostState } from '../dist/host-binding.js';
const actions = await import(moduleUrl('../convex/projectExchangeActions.ts'));
const metadata = await import(moduleUrl('../convex/projectPublicationStore.ts'));
const upgraded = error => (error.data?.code ?? error.code) === 'CLI_UPGRADE_REQUIRED';

test('installed exchange clients receive an upgrade error without reading dogfood Work or making IO', async t => {
  const fixture = {
    intents: Array.from({ length: 600 }, (_, id) => ({ id })),
    landings: Array.from({ length: 575 }, (_, id) => ({ id })),
    checkpoints: Array.from({ length: 2800 }, (_, id) => ({ id })),
    lanes: Array.from({ length: 560 }, (_, id) => ({ id })),
    objects: Array.from({ length: 32000 }, (_, id) => ({ id })),
  };
  let io = 0;
  const ctx = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'auth') return { getUserIdentity: async () => ({ subject: 'owner' }) };
        io++;
        throw Error(`Retired endpoint accessed ${String(key)} of the synthetic fixture`);
      },
    },
  );
  const input = {
    projectId: 'project',
    operationId: randomUUID(),
    previous: null,
    digest: 'a'.repeat(64),
    size: 1,
  };
  const start = performance.now();
  const heap = process.memoryUsage().heapUsed;
  for (const authorityEpoch of [0, 1, 2]) {
    for (const invoke of [
      () => actions.publish._handler(ctx, { ...input, authorityEpoch }),
      () => actions.published._handler(ctx, { ...input, authorityEpoch }),
      () => actions.completeHistory._handler(ctx, { backupId: 'old' }),
      ...['capabilities', 'publishedDisplay', 'displayBaseline', 'begin', 'append'].map(
        name => () => metadata[name]._handler(ctx, input),
      ),
    ])
      for (let retry = 0; retry < 2; retry++) await assert.rejects(invoke(), upgraded);
  }
  for (const method of [
    'publish',
    'published',
    'publishMetadata',
    'ownerDisplayBaseline',
    'publishedOwnerDerived',
  ])
    assert.equal(ConvexExchange.prototype[method], undefined);
  assert.equal(io, 0);
  assert.equal(fixture.objects.length, 32000);
  const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heap);
  assert(heapGrowth < 8 * 1024 * 1024, `Retired path retained ${heapGrowth} bytes`);
  t.diagnostic(
    JSON.stringify({
      convexCalls: io,
      documentsRead: 0,
      documentsWritten: 0,
      operations: 48,
      heapGrowth,
      elapsedMs: performance.now() - start,
    }),
  );
});

test('bound and explicit retired push requests fail before opening an owner, lock or request file', async () => {
  const root = '/nonexistent/synthetic-owner';
  for (const args of [
    [root, 'push'],
    [root, 'push', '--command-file', '/nonexistent/request.json'],
  ])
    await assert.rejects(exchangeCli(args), upgraded);
  await assert.rejects(
    exchangeCommand(root, 'push', { returnSource: true }),
    error => upgraded(error) && error.message === CUTOVER_UPGRADE,
  );
});

test('native owner startup and save ignore old exchange queues and start no exchange worker', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-retired-exchange-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let launches = 0;
  t.mock.method(childProcess, 'spawn', () => {
    launches++;
    throw Error('Unexpected worker');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  initNative(root);
  const store = new WorkStore(root);
  const data = store.load();
  data.autonomyPolicy.autoExchange = {
    enabled: true,
    debounceMs: 0,
    maxPendingAgeMs: 0,
    pauseOnDailySpend: true,
  };
  store.save(data);
  updateHostState(store, state => {
    state.binding = {
      projectId: 'synthetic',
      deployment: 'https://fixture.invalid',
      projectUrl: 'https://fixture.invalid/project',
      operationId: randomUUID(),
      name: 'Synthetic',
      visibility: 'private',
      backupId: 'old',
      autoSync: false,
    };
  });
  writeFileSync(join(store.directory, 'pending-exchange.json'), 'retired malformed queue');
  const reopened = new WorkStore(root);
  reopened.save(reopened.load());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0);
});
