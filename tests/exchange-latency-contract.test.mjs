// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
import { pushNativeExchange } from '../dist/native-exchange.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
const names = [
  'projectObjects',
  'projectExchange',
  'projectExchangeActions',
  'projectPublicationStore',
  'projectExchangeCache',
  'projectBackups',
  'projectWork',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
function fixture(t, operationId) {
  const s = state([]),
    run = s.ctx.runQuery;
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Isolated test fixture',
    currentBackup: null,
    revision: 0,
  });
  s.ctx.storage.generateUploadUrl = async () => 'https://fixture.invalid/upload';
  const dispatch = (fn, args) => {
    const [module, method] = getFunctionName(fn).split(':');
    return modules[module] ? modules[module][method]._handler(s.ctx, args) : run(fn, args);
  };
  s.ctx.runAction = s.ctx.runQuery = s.ctx.runMutation = dispatch;
  const client = new ConvexExchange('https://fixture.convex.cloud', 'fixture', 'project', operationId, null);
  const calls = [],
    invoke = (fn, args) => {
      calls.push(getFunctionName(fn));
      return dispatch(fn, args);
    };
  client.client = { query: invoke, mutation: invoke, action: invoke };
  let storageReads = 0;
  for (const method of ['get', 'getMetadata']) {
    const original = s.ctx.storage[method];
    s.ctx.storage[method] = (...args) => {
      storageReads++;
      return original(...args);
    };
  }
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'forge-exchange-contract-'));
  writeFileSync(join(root, 'source.txt'), 'Original retained source\n');
  initNative(root);
  const store = new WorkStore(root),
    fetch = globalThis.fetch,
    counts = { posts: 0 };
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://fixture.invalid/upload');
    counts.posts++;
    const storageId = await s.ctx.storage.store(
      new Blob([init.body], { type: init.headers['Content-Type'] }),
    );
    return Response.json({ storageId });
  };
  t.after(() => {
    globalThis.fetch = fetch;
    rmSync(root, { recursive: true, force: true });
  });
  return { s, store, client, counts, dispatch: invoke, calls, storageReads: () => storageReads };
}

test('real client original retry preserves old prepared manifest identity after unknown publication and rejects changed tuple/current access', async t => {
  const operation = randomUUID(),
    f = fixture(t, operation),
    revision = f.store.revision();
  // This operation predates metadata-tree transport, but retains its original bytes.
  f.client.metadataTrees = false;
  let lostReplies = 2,
    originalBackup;
  f.client.client.action = async (fn, args) => {
    const result = await f.dispatch(fn, args);
    if (getFunctionName(fn) === 'projectExchangeActions:publish' && lostReplies > 0) {
      lostReplies--;
      originalBackup = result;
      throw new Error('Unknown original publication reply');
    }
    return result;
  };
  await assert.rejects(
    pushNativeExchange(f.store, revision, operation, f.client),
    error => error.code === 'WORK_PUBLICATION_FAILED',
  );
  const path = join(f.store.directory, `exchange-${operation}`, 'manifest.json'),
    retained = readFileSync(path),
    posts = f.counts.posts;
  f.client.metadataTrees = true;
  f.calls.length = 0;
  const readsBeforeRetry = f.storageReads();
  const retry = await pushNativeExchange(f.store, revision, operation, f.client);
  assert.equal(retry.backupId, originalBackup);
  assert.equal(retry.uploadedBytes, 0);
  assert.equal(f.counts.posts, posts);
  assert.deepEqual(readFileSync(path), retained);
  assert.equal(f.s.tables.projectBackups.size, 1);
  assert.deepEqual(f.calls, [
    'projectPublicationStore:displayBaseline',
    'projectExchangeActions:published',
    'projectPublicationStore:publishedDisplay',
  ]);
  assert.equal(
    f.storageReads(),
    readsBeforeRetry,
    'New-client receipt retry does not reconstruct validated source',
  );
  // Older clients call publish directly: that public endpoint must reconcile the
  // same immutable receipt before storage validation too.
  f.calls.length = 0;
  const direct = await f.client.publish({
    sha256: createHash('sha256').update(retained).digest('hex'),
    size: retained.length,
  });
  assert.equal(direct, originalBackup);
  assert.deepEqual(f.calls, ['projectExchangeActions:publish']);
  assert.equal(
    f.storageReads(),
    readsBeforeRetry,
    'Old-client publication retry does not reconstruct validated source',
  );
  f.client.previous = originalBackup;
  await assert.rejects(
    pushNativeExchange(f.store, revision, operation, f.client),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
  assert.equal(f.s.tables.projectBackups.size, 1);
  f.client.previous = null;
  f.s.tables.projectContributors.set('grant', {
    _id: 'grant',
    projectId: 'project',
    contributor: 'contributor',
  });
  for (const actor of ['contributor', 'stranger', undefined]) {
    f.s.caller(actor);
    await assert.rejects(
      pushNativeExchange(f.store, revision, operation, f.client),
      error => error.code === 'PROJECT_UNAVAILABLE',
    );
  }
  f.s.caller('owner');
  f.s.tables.hostedProjects.get('project').removal = 'trash';
  await assert.rejects(
    pushNativeExchange(f.store, revision, operation, f.client),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
  assert.deepEqual(readFileSync(path), retained);
  assert.equal(f.counts.posts, posts);
});
