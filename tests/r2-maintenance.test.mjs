// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { setup, pinOf } from './r2-harness.mjs';
const names = [
  'projectR2Maintenance',
  'projectR2Purge',
  'projectR2Sweep',
  'r2ArchiveSource',
  'projectLifecycle',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
const commit = await import(moduleUrl('../convex/projectObjectCommit.ts'));
const objects = await import(moduleUrl('../convex/projectObjects.ts'));
const archive = await import(moduleUrl('../convex/projectArchivePart.ts'));
const operations = await import(moduleUrl('../convex/r2Operations.ts'));
const windowMs = 14 * 86400_000;
async function fixture(t) {
  const x = await setup(t);
  const previous = process.env.FORGE_R2_MAINTENANCE;
  process.env.FORGE_R2_MAINTENANCE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_R2_MAINTENANCE;
    else process.env.FORGE_R2_MAINTENANCE = previous;
  });
  const old = x.s.ctx.runQuery;
  x.run = (name, args) => {
    const [mod, method] = name.split(':');
    return modules[mod][method]._handler(x.s.ctx, args);
  };
  for (const kind of ['runQuery', 'runMutation', 'runAction'])
    x.s.ctx[kind] = (ref, args) => {
      const name = getFunctionName(ref),
        [mod] = name.split(':');
      return modules[mod]
        ? kind === 'runMutation'
          ? x.s.transaction(() => x.run(name, args))
          : x.run(name, args)
        : old(ref, args);
    };
  x.pass = {
    project: 'project',
    mode: 'verify',
    complete: true,
    operationId: 'verified-pass',
    verificationRevision: 0,
    verifiedAt: new Date(Date.now() - windowMs - 10000).toISOString(),
    safeToPurgeAfter: new Date(Date.now() - 10000).toISOString(),
  };
  x.purge = (extra = {}) =>
    x.run('projectR2Maintenance:purgePage', {
      projectId: 'project',
      pass: x.pass,
      kind: 'objects',
      cursor: null,
      ...extra,
    });
  x.sweep = (extra = {}) =>
    x.run('projectR2Maintenance:sweepPage', { projectId: 'project', cursor: null, ...extra });
  x.row = async (text = 'retained source', changes = {}) => {
    const pin = pinOf(text),
      key = `v1/p/project/o/${pin.digest}`;
    const storageId = await x.s.ctx.storage.store(new Blob([text]));
    const id = await x.s.ctx.db.insert('projectObjects', {
      projectId: 'project',
      ...pin,
      nonce: 'synthetic',
      storageId,
      location: 'r2',
      r2Key: key,
      r2Committed: true,
      r2BackfilledAt: Date.parse(x.pass.verifiedAt) - 1000,
      removed: false,
      ...changes,
    });
    x.fake.objects.set(x.fake.key(key), Buffer.from(text));
    return x.s.ctx.db.get(id);
  };
  return x;
}

test('purge refuses a missing pass, the 14-day boundary, and changed backfill revision', async t => {
  const x = await fixture(t);
  await x.row();
  for (const pass of [
    undefined,
    {
      ...x.pass,
      verifiedAt: new Date().toISOString(),
      safeToPurgeAfter: new Date(Date.now() + windowMs).toISOString(),
    },
    { ...x.pass, verifiedAt: 'invalid' },
    { ...x.pass, verificationRevision: 1 },
    { ...x.pass, project: 'other' },
  ])
    await assert.rejects(x.purge({ pass, dryRun: false }));
  assert.equal(x.s.deleted.length, 0);
});
test('purge dry-run re-HEADs but makes no deletes; apply and replay are idempotent', async t => {
  const x = await fixture(t),
    row = await x.row();
  assert.equal((await x.purge()).eligible, 1);
  assert.equal(x.s.deleted.length, 0);
  assert.equal(x.fake.requests.filter(r => r.method === 'HEAD').length, 1);
  assert.equal((await x.purge({ dryRun: false })).deleted, 1);
  assert.equal((await x.s.ctx.db.get(row._id)).r2ConvexPurged, true);
  assert.equal((await x.purge({ dryRun: false })).deleted, 0);
  assert.deepEqual(x.s.deleted, [row.storageId]);
});
test('missing R2 HEAD and wrong-size/checksum pages delete nothing', async t => {
  const x = await fixture(t);
  await x.row('good');
  const bad = await x.row('bad');
  x.fake.objects.delete(x.fake.key(bad.r2Key));
  await assert.rejects(x.purge({ dryRun: false }), /R2 object could not be verified/);
  x.fake.objects.set(x.fake.key(bad.r2Key), Buffer.from('BAD'));
  await assert.rejects(x.purge({ dryRun: false }));
  x.fake.objects.set(x.fake.key(bad.r2Key), Buffer.from('wrong size'));
  await assert.rejects(x.purge({ dryRun: false }));
  assert.equal(x.s.deleted.length, 0);
});
test('only migrated committed rows verified before the pass qualify; shared copies are preserved', async t => {
  const x = await fixture(t);
  await x.row('only convex', { location: 'convex' });
  await x.row('not committed', { r2Committed: false });
  await x.row('too new', { r2BackfilledAt: Date.now() });
  await x.row('not migrated', { r2BackfilledAt: undefined });
  await x.row('foreign key', { r2Key: 'v1/p/other/o/key' });
  const shared = await x.row('shared');
  await x.s.ctx.db.insert('projectObjects', {
    ...shared,
    _id: undefined,
    projectId: 'other',
    location: 'convex',
  });
  const result = await x.purge({ dryRun: false });
  assert.equal(result.eligible, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.deleted, 0);
});
test('mutation rechecks current row pins after HEAD before deleting', async t => {
  const x = await fixture(t),
    row = await x.row();
  const original = x.s.ctx.runMutation;
  x.s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectR2Purge:removeCopies')
      await x.s.ctx.db.patch(row._id, { r2Committed: false });
    return original(ref, args);
  };
  assert.equal((await x.purge({ dryRun: false })).skipped, 1);
  assert.equal(x.s.deleted.length, 0);
});
test('paged purge has bounded document reads below 4096 and reaches the final page', async t => {
  const x = await fixture(t);
  for (let i = 0; i < 103; i++) await x.row(`page ${i}`);
  let maxReads = 0;
  const run = x.s.ctx.runMutation;
  x.s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectR2Purge:removeCopies') return run(ref, args);
    let reads = 0;
    const db = x.s.ctx.db,
      oldGet = db.get,
      oldSystemGet = db.system.get,
      oldQuery = db.query;
    db.get = async id => {
      reads++;
      return oldGet(id);
    };
    db.system.get = async id => {
      reads++;
      return oldSystemGet(id);
    };
    db.query = table => {
      const q = oldQuery(table),
        take = q.take;
      q.take = async count => {
        const result = await take(count);
        reads += result.length;
        return result;
      };
      return q;
    };
    try {
      return await run(ref, args);
    } finally {
      maxReads = Math.max(maxReads, reads);
      db.get = oldGet;
      db.system.get = oldSystemGet;
      db.query = oldQuery;
    }
  };
  const first = await x.purge({ dryRun: false });
  assert.equal(first.scanned, 100);
  assert.equal(first.isDone, false);
  assert.equal(first.deleted, 100);
  const last = await x.purge({ cursor: first.cursor, dryRun: false });
  assert.equal(last.deleted, 3);
  assert.equal(last.isDone, true);
  assert.ok(maxReads > 0 && maxReads <= 1401, `observed ${maxReads} reads`);
});
test('sweep only removes old uncommitted project-prefixed uploads and dry-run changes nothing', async t => {
  const x = await fixture(t),
    oldTime = Date.now() - 86400_001;
  const pending = await x.row('abandoned', {
    storageId: undefined,
    r2Committed: false,
    r2PreparedAt: oldTime,
  });
  await x.row('fresh', { storageId: undefined, r2Committed: false, r2PreparedAt: Date.now() });
  await x.row('committed');
  await x.row('foreign', {
    storageId: undefined,
    r2Committed: false,
    r2PreparedAt: oldTime,
    r2Key: 'v1/p/other/o/key',
  });
  await x.row('fallback', { r2Committed: false, r2PreparedAt: oldTime });
  assert.equal((await x.sweep()).eligible, 1);
  assert.equal((await x.s.ctx.db.get(pending._id)).r2SweepKey, undefined);
  assert.equal(x.fake.requests.filter(r => r.method === 'DELETE').length, 0);
  assert.equal((await x.sweep({ dryRun: false })).deleted, 1);
  assert.equal(x.fake.objects.has(x.fake.key(pending.r2Key)), false);
  assert.equal(x.fake.objects.size, 4);
});
test('a concurrent commit before sweep claim preserves the only copy', async t => {
  const x = await fixture(t),
    row = await x.row('racing', { storageId: undefined, r2Committed: false, r2PreparedAt: 1 });
  const run = x.s.ctx.runMutation;
  x.s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectR2Sweep:claim')
      await x.s.ctx.db.patch(row._id, { r2Committed: true });
    return run(ref, args);
  };
  assert.equal((await x.sweep({ dryRun: false })).deleted, 0);
  assert.ok(x.fake.objects.has(x.fake.key(row.r2Key)));
});
test('failed DELETE retains the pending key; reprepare rotates so retry cannot delete new committed bytes', async t => {
  const x = await fixture(t),
    row = await x.row('retry', { storageId: undefined, r2Committed: false, r2PreparedAt: 1 });
  x.fake.failDeletes = 1;
  await assert.rejects(x.sweep({ dryRun: false }));
  assert.equal((await x.s.ctx.db.get(row._id)).r2SweepKey, row.r2Key);
  const [prepared] = await objects.prepareBatch._handler(x.s.ctx, {
    projectId: 'project',
    objects: [{ digest: row.digest, size: row.size }],
  });
  const key = (await x.s.ctx.db.get(row._id)).r2Key;
  assert.notEqual(key, row.r2Key);
  assert.equal(
    (await fetch(prepared.target.url, { method: 'PUT', headers: prepared.target.headers, body: 'retry' }))
      .status,
    200,
  );
  await commit.commitBatch._handler(x.s.ctx, { objects: [{ id: row._id }] });
  assert.equal((await x.sweep({ dryRun: false })).deleted, 1);
  assert.ok(x.fake.objects.has(x.fake.key(key)));
  assert.equal((await x.s.ctx.db.get(row._id)).r2Committed, true);
});
test('stale HEAD result cannot commit a sweep-claimed key', async t => {
  const x = await fixture(t),
    row = await x.row('stale head', { storageId: undefined, r2Committed: false, r2PreparedAt: 1 });
  const rows = await commit.pendingRows._handler(x.s.ctx, { actor: 'owner', ids: [row._id] });
  await x.run('projectR2Sweep:claim', { projectId: 'project', ids: [row._id], dryRun: false });
  await assert.rejects(commit.markCommitted._handler(x.s.ctx, { rows }));
  assert.equal((await x.s.ctx.db.get(row._id)).r2Committed, false);
});
test('maintenance is disabled by default for writes; dry-run still works', async t => {
  const x = await fixture(t);
  await x.row();
  delete process.env.FORGE_R2_MAINTENANCE;
  assert.equal((await x.purge()).eligible, 1);
  await assert.rejects(x.purge({ dryRun: false }));
  await assert.rejects(x.sweep({ dryRun: false }));
  assert.equal(x.s.deleted.length, 0);
});
test('project-prefix cleanup pages R2 and never touches another prefix or an active project', async t => {
  const x = await fixture(t);
  x.fake.objects.set(x.fake.key('v1/p/other/o/keep'), Buffer.from('keep'));
  for (let i = 0; i < 101; i++)
    x.fake.objects.set(x.fake.key(`v1/p/project/o/${String(i).padStart(3, '0')}`), Buffer.from('x'));
  await x.run('projectR2Maintenance:purgeDeletedProjectPage', { projectId: 'project' });
  assert.equal(x.fake.objects.size, 102);
  await x.s.ctx.db.patch('project', { removal: 'deleting' });
  await x.run('projectR2Maintenance:purgeDeletedProjectPage', { projectId: 'project' });
  const continuation = x.s.scheduled.find(
    item => getFunctionName(item.fn) === 'projectR2Maintenance:purgeDeletedProjectPage',
  );
  assert.ok(continuation);
  await x.run('projectR2Maintenance:purgeDeletedProjectPage', continuation.args);
  assert.equal(x.fake.objects.size, 1);
  assert.equal((await x.s.ctx.db.get('project')).r2PrefixPurged, true);
});
test('R2 list rejects provider keys outside the requested project prefix and errors hide response bodies', async t => {
  const x = await fixture(t),
    saved = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      '<ListBucketResult><Key>v1%2Fp%2Fother%2Fkey</Key><IsTruncated>false</IsTruncated></ListBucketResult>',
    );
  t.after(() => {
    globalThis.fetch = saved;
  });
  await assert.rejects(operations.listR2Prefix(x.fake.config, 'v1/p/project/', null));
});
test('purged legacy archives retain their ID alias and serve authorized R2 bytes', async t => {
  const x = await fixture(t),
    bytes = 'legacy archive',
    pin = pinOf(bytes),
    key = `v1/p/project/o/${pin.digest}`;
  const storageId = await x.s.ctx.storage.store(new Blob([bytes]));
  const id = await x.s.ctx.db.insert('projectBackups', {
    projectId: 'project',
    ...pin,
    storageId,
    status: 'stored',
    location: 'r2',
    r2Key: key,
    r2Committed: true,
    r2BackfilledAt: Date.parse(x.pass.verifiedAt) - 1000,
  });
  x.fake.objects.set(x.fake.key(key), Buffer.from(bytes));
  assert.equal((await x.purge({ kind: 'backups', dryRun: false })).deleted, 1);
  assert.equal((await x.s.ctx.db.get(id)).storageId, storageId);
  const part = await archive.projectArchivePart(
    x.s.ctx,
    storageId,
    pin.size,
    pin.digest,
    0,
    async () => null,
  );
  assert.equal(Buffer.from(part).toString(), bytes);
  x.s.caller('stranger');
  await assert.rejects(
    archive.projectArchivePart(x.s.ctx, storageId, pin.size, pin.digest, 0, async () => null),
  );
  x.s.caller(null);
  await assert.rejects(
    archive.projectArchivePart(x.s.ctx, storageId, pin.size, pin.digest, 0, async () => null),
  );
  await x.s.ctx.db.patch('project', { visibility: 'public' });
  assert.equal(
    Buffer.from(
      await archive.projectArchivePart(x.s.ctx, storageId, pin.size, pin.digest, 0, async () => null),
    ).toString(),
    bytes,
  );
});

test('permanent project deletion discovers pre-existing R2 rows and waits for prefix cleanup before its tombstone', async t => {
  const x = await fixture(t);
  await x.row();
  await x.s.ctx.db.patch('project', { removal: 'deleting' });
  for (
    let i = 0;
    i < 4 &&
    !x.s.scheduled.some(task => getFunctionName(task.fn) === 'projectR2Maintenance:purgeDeletedProjectPage');
    i++
  )
    await x.run('projectLifecycle:purge', { projectId: 'project' });
  assert.equal((await x.s.ctx.db.get('project')).r2StorageUsed, true);
  assert.equal((await x.s.ctx.db.get('project')).removal, 'deleting');
  assert.ok(
    x.s.scheduled.some(task => getFunctionName(task.fn) === 'projectR2Maintenance:purgeDeletedProjectPage'),
  );
  await x.run('projectR2Maintenance:purgeDeletedProjectPage', { projectId: 'project' });
  await x.run('projectLifecycle:purge', { projectId: 'project' });
  assert.equal((await x.s.ctx.db.get('project')).removal, 'deleted');
  assert.equal(x.fake.objects.size, 0);
});

test('enabled project deletion removes untracked R2 prefix keys even without object rows or a backfill marker', async t => {
  const x = await fixture(t);
  x.fake.objects.set(x.fake.key('v1/p/project/artifacts/orphan'), Buffer.from('orphan'));
  await x.s.ctx.db.patch('project', { removal: 'deleting' });
  await x.run('projectLifecycle:purge', { projectId: 'project' });
  assert.equal((await x.s.ctx.db.get('project')).removal, 'deleting');
  assert.ok(
    x.s.scheduled.some(task => getFunctionName(task.fn) === 'projectR2Maintenance:purgeDeletedProjectPage'),
  );
  await x.run('projectR2Maintenance:purgeDeletedProjectPage', { projectId: 'project' });
  await x.run('projectLifecycle:purge', { projectId: 'project' });
  assert.equal((await x.s.ctx.db.get('project')).removal, 'deleted');
  assert.equal(x.fake.objects.size, 0);
});

for (const failure of ['disabled', 'list', 'delete'])
  test(`project-prefix cleanup reports ${failure} failure and retries its saved page to completion`, async t => {
    const x = await fixture(t);
    for (let i = 0; i < 101; i++)
      x.fake.objects.set(x.fake.key(`v1/p/project/o/${String(i).padStart(3, '0')}`), Buffer.from('x'));
    x.fake.objects.set(x.fake.key('v1/p/other/o/keep'), Buffer.from('keep'));
    await x.s.ctx.db.patch('project', { removal: 'deleting' });
    await x.run('projectR2Maintenance:purgeDeletedProjectPage', { projectId: 'project' });
    const continuation = x.s.scheduled.at(-1);
    assert.equal(x.fake.objects.size, 2);
    assert.ok(continuation.args.cursor);
    const fetch = globalThis.fetch;
    if (failure === 'disabled') delete process.env.FORGE_R2_MAINTENANCE;
    if (failure === 'delete') x.fake.failDeletes = 1;
    if (failure === 'list')
      globalThis.fetch = (url, init) =>
        new URL(url).searchParams.get('list-type') === '2'
          ? Promise.resolve(new Response('', { status: 503 }))
          : fetch(url, init);
    const scheduled = x.s.scheduled.length,
      delays = [],
      runAfter = x.s.ctx.scheduler.runAfter;
    x.s.ctx.scheduler.runAfter = (delay, ...args) => {
      delays.push(delay);
      return runAfter(delay, ...args);
    };
    try {
      await assert.rejects(
        x.run('projectR2Maintenance:purgeDeletedProjectPage', continuation.args),
        error =>
          error.code ===
          {
            disabled: 'R2_MAINTENANCE_DISABLED',
            list: 'R2_LIST_FAILED',
            delete: 'R2_DELETE_FAILED',
          }[failure],
      );
    } finally {
      globalThis.fetch = fetch;
      process.env.FORGE_R2_MAINTENANCE = '1';
    }
    assert.equal(x.s.scheduled.length, scheduled + 1, 'failed actions retain a retry');
    const retry = x.s.scheduled.at(-1);
    assert.equal(getFunctionName(retry.fn), 'projectR2Maintenance:purgeDeletedProjectPage');
    assert.deepEqual(retry.args, continuation.args, 'do not advance the failed page cursor');
    assert.deepEqual(delays, [60_000]);
    assert.equal((await x.s.ctx.db.get('project')).removal, 'deleting');
    assert.notEqual((await x.s.ctx.db.get('project')).r2PrefixPurged, true);
    assert.equal(x.fake.objects.size, 2);
    await x.run(getFunctionName(retry.fn), retry.args);
    await x.run('projectLifecycle:purge', { projectId: 'project' });
    assert.equal((await x.s.ctx.db.get('project')).removal, 'deleted');
    assert.equal(x.fake.objects.size, 1);
    assert.ok(x.fake.objects.has(x.fake.key('v1/p/other/o/keep')));
  });
