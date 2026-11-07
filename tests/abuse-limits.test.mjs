// SPDX-License-Identifier: Apache-2.0
// Signed-out read budget per public project and storage quotas per project and account (a91b9b69).
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { modules } from './project-exchange-fixture.mjs';
import { setup, pinOf } from './r2-harness.mjs';

const limits = await import(moduleUrl('../convex/abuseLimits.ts'));
const { ANONYMOUS_READ_BUDGET, STORAGE_QUOTA } = limits;
const objects = modules.projectObjects,
  downloads = modules.projectObjectDownloads;
const code = expected => error => error.data?.code === expected || error.code === expected;
const perShard = (total, shards) => Math.ceil(total / shards);

/** Pins every shard choice to shard 0, so one shard's share is the observable limit. */
function firstShard(t) {
  t.mock.method(Math, 'random', () => 0);
}
function publicProject(s) {
  s.tables.hostedProjects.get('project').visibility = 'public';
}
const sign = (s, digests = []) =>
  s.transaction(() => downloads.signDownloads._handler(s.ctx, { projectId: 'project', digests }));
const budgetRows = s => [...s.tables.projectReadBudgets.values()];

test('signed-out signing on a public project stops at its budget with a clear error and signs nothing', async t => {
  const { s } = await setup(t);
  publicProject(s);
  firstShard(t);
  const at = 10 * ANONYMOUS_READ_BUDGET.windowMs + 5_000;
  t.mock.method(Date, 'now', () => at);
  s.caller(undefined);
  const limit = perShard(ANONYMOUS_READ_BUDGET.calls, ANONYMOUS_READ_BUDGET.shards);
  for (let i = 0; i < limit; i++) assert.deepEqual(await sign(s), []);
  s.caller('owner');
  const [stored] = await objects.prepareBatch._handler(s.ctx, {
    projectId: 'project',
    objects: [pinOf('kept')],
  });
  assert.equal(stored.created, true);
  s.caller(undefined);
  await assert.rejects(sign(s, [pinOf('kept').digest]), error => {
    assert.ok(code('RATE_LIMITED')(error));
    const message = error.data?.message ?? error.message;
    assert.match(message, /Sign in \(nforge login\) or retry after 55 s\./);
    return true;
  });
  // One bounded row per shard, unchanged by the refused call.
  assert.equal(budgetRows(s).length, 1);
  assert.equal(budgetRows(s)[0].count, limit);
  // Signed-in readers of the same public project are never counted or refused.
  s.caller('stranger');
  assert.deepEqual(await sign(s), []);
  assert.equal(budgetRows(s)[0].count, limit);
});

test('the signed-out budget resets when its window ends, in place', async t => {
  const { s } = await setup(t);
  publicProject(s);
  firstShard(t);
  let now = 3 * ANONYMOUS_READ_BUDGET.windowMs;
  t.mock.method(Date, 'now', () => now);
  s.caller(undefined);
  const limit = perShard(ANONYMOUS_READ_BUDGET.calls, ANONYMOUS_READ_BUDGET.shards);
  for (let i = 0; i < limit; i++) await sign(s);
  await assert.rejects(sign(s), code('RATE_LIMITED'));
  now += ANONYMOUS_READ_BUDGET.windowMs;
  assert.deepEqual(await sign(s), []);
  assert.equal(budgetRows(s).length, 1);
  assert.deepEqual(
    { windowStart: budgetRows(s)[0].windowStart, count: budgetRows(s)[0].count },
    { windowStart: now, count: 1 },
  );
});

test('every signed-out read path of a public project shares the budget; private projects write nothing', async t => {
  const { s } = await setup(t);
  firstShard(t);
  s.caller(undefined);
  await assert.rejects(sign(s), code('PROJECT_UNAVAILABLE'));
  assert.equal(budgetRows(s).length, 0);
  publicProject(s);
  await s.transaction(() => downloads.describe._handler(s.ctx, { projectId: 'project', digests: [] }));
  await sign(s);
  assert.equal(budgetRows(s)[0].count, 2);
});

test('a pack-less signed-out checkout of a 29k-file public project fits in one window', async t => {
  const { s } = await setup(t);
  publicProject(s);
  s.caller(undefined);
  // 29,000 files in 100-pin describe pages, with the real random shard choice.
  for (let page = 0; page < 290; page++)
    await s.transaction(() => downloads.describe._handler(s.ctx, { projectId: 'project', digests: [] }));
  const counts = budgetRows(s).map(row => row.count);
  assert.equal(
    counts.reduce((sum, count) => sum + count, 0),
    290,
  );
  assert.ok(counts.length <= ANONYMOUS_READ_BUDGET.shards);
});

const prepare = (s, list, projectId = 'project') =>
  s.transaction(() => objects.prepareBatch._handler(s.ctx, { projectId, objects: list }));
const usage = (s, table) => [...s.tables[table].values()];
const objectCount = s => s.tables.projectObjects.size;

test('one object over the size limit is refused before anything is reserved', async t => {
  const { s } = await setup(t);
  const before = objectCount(s);
  await assert.rejects(
    prepare(s, [{ digest: 'a'.repeat(64), size: STORAGE_QUOTA.objectBytes + 1 }]),
    error => code('QUOTA_EXCEEDED')(error) && /at most 1 GiB/.test(error.data?.message ?? error.message),
  );
  assert.equal(objectCount(s), before);
  assert.equal(usage(s, 'projectStorageUsage').length, 0);
});

test('project quota: a batch that would pass it reserves nothing; one that fits is counted', async t => {
  const { s } = await setup(t);
  firstShard(t);
  const share = perShard(STORAGE_QUOTA.project.objects, STORAGE_QUOTA.shards);
  s.tables.projectStorageUsage.set('u0', {
    _id: 'u0',
    _creationTime: 1,
    projectId: 'project',
    shard: 0,
    objects: share - 1,
    bytes: 0,
    pendingObjects: 0,
    pendingBytes: 0,
  });
  const before = objectCount(s);
  await assert.rejects(prepare(s, [pinOf('one'), pinOf('two')]), error => {
    assert.ok(code('QUOTA_EXCEEDED')(error));
    assert.match(error.data?.message ?? error.message, /This project has reached its storage quota/);
    return true;
  });
  assert.equal(objectCount(s), before);
  assert.equal(s.tables.projectStorageUsage.get('u0').objects, share - 1);
  assert.equal(usage(s, 'accountStorageUsage').length, 0);
  const [prepared] = await prepare(s, [pinOf('one')]);
  assert.equal(prepared.created, true);
  assert.equal(s.tables.projectStorageUsage.get('u0').objects, share);
  assert.equal(s.tables.projectStorageUsage.get('u0').pendingBytes, pinOf('one').size);
  // Preparing content that is already reserved charges nothing.
  await prepare(s, [pinOf('one')]);
  assert.equal(s.tables.projectStorageUsage.get('u0').objects, share);
});

test('project byte quota and the owner account quota across projects are both enforced', async t => {
  const { s } = await setup(t);
  firstShard(t);
  const seed = fields =>
    s.tables.projectStorageUsage.set('u0', {
      _id: 'u0',
      _creationTime: 1,
      projectId: 'project',
      shard: 0,
      objects: 0,
      bytes: 0,
      pendingObjects: 0,
      pendingBytes: 0,
      ...fields,
    });
  seed({ bytes: perShard(STORAGE_QUOTA.project.bytes, STORAGE_QUOTA.shards) });
  await assert.rejects(prepare(s, [pinOf('bytes')]), code('QUOTA_EXCEEDED'));
  // The same owner's other projects already fill the account; this shard's next batch
  // reaches its roll-up, so the account quota is checked and nothing is reserved.
  s.tables.accountStorageUsage.set('a0', {
    _id: 'a0',
    _creationTime: 1,
    account: 'owner',
    objects: STORAGE_QUOTA.account.objects,
    bytes: 0,
  });
  seed({ objects: 999, pendingObjects: STORAGE_QUOTA.rollup.objects - 1 });
  const before = objectCount(s);
  await assert.rejects(prepare(s, [pinOf('account')]), error =>
    /This account has reached its storage quota/.test(error.data?.message ?? error.message),
  );
  assert.equal(objectCount(s), before);
  assert.equal(s.tables.projectStorageUsage.get('u0').objects, 999);
  assert.equal(s.tables.accountStorageUsage.get('a0').objects, STORAGE_QUOTA.account.objects);
  // With room, the roll-up adds the pending part to the account and clears it.
  s.tables.accountStorageUsage.get('a0').objects = 5;
  const single = await s.transaction(() =>
    objects.prepare._handler(s.ctx, { projectId: 'project', ...pinOf('single') }),
  );
  assert.equal(single.created, true);
  assert.deepEqual(
    {
      objects: s.tables.accountStorageUsage.get('a0').objects,
      pending: s.tables.projectStorageUsage.get('u0').pendingObjects,
    },
    { objects: 5 + STORAGE_QUOTA.rollup.objects, pending: 0 },
  );
  assert.equal(s.tables.projectStorageUsage.get('u0').objects, 1_000);
});

test('a dogfood-sized project (115,028 objects, 9.22 GB) stays far below every quota', async t => {
  const { s } = await setup(t);
  const project = s.tables.hostedProjects.get('project');
  const total = { objects: 115_028, bytes: 9_217_586_347 };
  const average = Math.floor(total.bytes / total.objects);
  for (let done = 0; done < total.objects; done += 100) {
    const n = Math.min(100, total.objects - done);
    await s.transaction(() =>
      limits.chargeStorage(
        s.ctx,
        project,
        Array.from({ length: n }, () => average),
      ),
    );
  }
  const rows = usage(s, 'projectStorageUsage');
  assert.ok(rows.length <= STORAGE_QUOTA.shards);
  assert.equal(
    rows.reduce((sum, row) => sum + row.objects, 0),
    total.objects,
  );
  const [account] = usage(s, 'accountStorageUsage');
  assert.equal(account.objects + rows.reduce((sum, row) => sum + row.pendingObjects, 0), total.objects);
  for (const row of rows) {
    assert.ok(row.objects < perShard(STORAGE_QUOTA.project.objects, STORAGE_QUOTA.shards) / 10);
    assert.ok(row.bytes < perShard(STORAGE_QUOTA.project.bytes, STORAGE_QUOTA.shards) / 10);
  }
  // Largest object seen in the dogfood project is about 26 MB.
  assert.ok(total.bytes < STORAGE_QUOTA.project.bytes / 20 && 26 * 1024 ** 2 < STORAGE_QUOTA.objectBytes);
});
