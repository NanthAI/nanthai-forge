// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 2766ef9e: the replays every purge that removes attachments runs (Item purge, comment purge). A removed
// binding's R2 delete is tracked on its row and retried until it succeeds, and an upload that started before the purge
// cannot leave its bytes behind: its commit deletes them, and the binding's tracking stays open until a delete that
// starts after the signed upload window (convex/artifactStorage.ts). Scheduled work runs only when due on a fixed clock.
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';

const artifactStorage = await import(moduleUrl('../convex/artifactStorage.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
const ran = new WeakMap(),
  due = new WeakMap();
/** The signed upload window (convex/artifactStorage.ts uploadWindowMs). */
const WINDOW = (900 + 60) * 1000 + 10 * 60_000;

/** A fake R2 for discussion keys (`v1/p/…/discussion/…`), with deletes that can be refused. A test that already has
 * one (tests/planning-purge-executor.test.mjs storage) passes it instead. */
export function discussionR2(t) {
  const objects = new Map();
  let refuse = false;
  const keys = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const prior = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'synthetic';
  t.after(() => {
    for (const [key, value] of prior)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname,
      at = path.indexOf('/v1/p/');
    if (at < 0 || !path.includes('/discussion/')) return original(url, init);
    const key = path.slice(at + 1),
      method = init?.method ?? 'GET';
    if (method === 'DELETE') {
      if (refuse) return new Response(null, { status: 403 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 });
  });
  return { objects, refuseDeletions: value => (refuse = value) };
}

/** Fix the clock at `start` and record when each task `runAfter` schedules is due. Returns `tick`, which moves the
 * clock forward. */
function clock(t, s, start) {
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const at = new Map(),
    scheduler = s.ctx.scheduler,
    time = { now: start };
  due.set(s, { at, time });
  s.ctx.scheduler = {
    ...scheduler,
    runAfter: async (delay, fn, args) => {
      const id = await scheduler.runAfter(delay, fn, args);
      at.set(id, time.now + delay);
      return id;
    },
  };
  return ms => {
    t.mock.timers.tick(ms);
    time.now += ms;
  };
}

/** Run every due, not yet run and not canceled artifact cleanup task (`deleteBytes` or `retryDelete`), once.
 * Returns how many ran and how many threw. */
async function drain(s, name) {
  const done = ran.get(s) ?? new Set();
  ran.set(s, done);
  let count = 0,
    failed = 0;
  for (const task of [...s.scheduled]) {
    if (getFunctionName(task.fn) !== `artifactStorage:${name}` || done.has(task.id)) continue;
    const { at, time } = due.get(s);
    if (s.tasks.get(task.id)?.state.kind === 'canceled' || (at.get(task.id) ?? 0) > time.now) continue;
    done.add(task.id);
    count++;
    const handler = artifactStorage[name];
    await (
      name === 'retryDelete'
        ? s.transaction(() => handler._handler(s.ctx, task.args))
        : handler._handler(s.ctx, task.args)
    ).catch(error => {
      assert.ok(code('R2_DELETE_FAILED')(error), error);
      failed++;
    });
  }
  return { count, failed };
}
const pending = s => artifactStorage.pendingDeletes._handler(s.ctx, {});
const newest = rows => Math.max(...rows.map(row => row._creationTime));

/** Replay a failing R2 delete that later succeeds. `rows` are committed attachments, uploaded long before the purge,
 * whose bytes are in `r2`; `purge` removes them. Until a delete succeeds every row stays counted and its retry comes
 * after a growing delay; the count goes to 0 when it does, and nothing stays scheduled afterwards. A delivery
 * scheduled before deletes were tracked, and a project deletion that takes over the bytes, keep the row counted. */
export async function replayFailedDelete(t, { s, r2, rows, purge }) {
  const { deleteRetryMs } = artifactStorage;
  assert.deepEqual([0, 1, 2].map(deleteRetryMs), [60_000, 120_000, 240_000], 'the retry backs off');
  assert.equal(deleteRetryMs(60), 6 * 3_600_000, 'and is bounded at six hours');
  const tick = clock(t, s, newest(rows) + WINDOW + 60_000);
  for (const row of rows) r2.objects.set(row.r2Key, Buffer.from('bytes'));
  r2.refuseDeletions(true);
  await purge();
  assert.deepEqual(await pending(s), { pending: rows.length, more: false, mostAttempts: 0 });
  assert.deepEqual(await drain(s, 'deleteBytes'), { count: rows.length, failed: rows.length });
  assert.ok(
    rows.every(row => r2.objects.has(row.r2Key)),
    'a refused delete leaves the bytes',
  );
  assert.equal((await drain(s, 'retryDelete')).count, 0, 'the retry is not due yet');
  tick(60_000);
  assert.equal((await drain(s, 'retryDelete')).count, rows.length, 'each failed attempt has its retry');
  assert.equal((await pending(s)).mostAttempts, 1, 'the retry counts as an attempt');
  assert.equal((await drain(s, 'deleteBytes')).failed, rows.length);
  tick(60_000);
  assert.equal((await drain(s, 'retryDelete')).count, 0, 'the second retry waits twice as long');
  tick(60_000);
  assert.equal((await drain(s, 'retryDelete')).count, rows.length);
  r2.refuseDeletions(false);
  assert.deepEqual(await drain(s, 'deleteBytes'), { count: rows.length, failed: 0 });
  assert.ok(
    rows.every(row => !r2.objects.has(row.r2Key)),
    'the later attempt removes the bytes',
  );
  assert.deepEqual(await pending(s), { pending: 0, more: false, mostAttempts: 0 });
  tick(7 * 3_600_000);
  assert.deepEqual(await drain(s, 'retryDelete'), { count: 0, failed: 0 }, 'the armed retries are canceled');
  for (const row of rows) {
    const stored = s.tables.artifactBlobs.get(row._id);
    assert.equal(stored.removed, true);
    assert.equal(stored.deleteTask, undefined);
  }

  // A delivery scheduled before deletes were tracked (no `attempts`) tracks the row before any R2 call.
  const [row] = rows,
    ref = `r2blob:${row._id}`;
  r2.objects.set(row.r2Key, Buffer.from('bytes'));
  r2.refuseDeletions(true);
  await artifactStorage.deleteBytes._handler(s.ctx, { ref });
  assert.equal((await pending(s)).pending, 1, 'the old delivery is tracked');
  assert.equal((await drain(s, 'deleteBytes')).failed, 1);
  // A project deletion takes over the bytes: the row stays counted until the project purge removes it.
  const project = [...s.tables.hostedProjects.values()].find(item =>
    row.namespace.startsWith(`v1/p/${item._id}/`),
  );
  s.tables.hostedProjects.set(project._id, { ...project, removal: 'deleting' });
  tick(60_000);
  await drain(s, 'retryDelete');
  assert.deepEqual(await drain(s, 'deleteBytes'), { count: 1, failed: 0 });
  assert.equal(
    (await pending(s)).pending,
    1,
    'a project purge that has not removed the row leaves it counted',
  );
  s.tables.hostedProjects.set(project._id, project);
  r2.refuseDeletions(false);
  tick(120_000);
  await drain(s, 'retryDelete');
  await drain(s, 'deleteBytes');
  assert.equal(r2.objects.has(row.r2Key), false);
  assert.deepEqual(await pending(s), { pending: 0, more: false, mostAttempts: 0 });
}

/** Replay uploads in flight across the purge. `committing` and `abandoned` are reservations whose uploads started just
 * before `purge`. `abandoned` is committed by a first upload; a second create-only PUT for it is still in flight.
 * The purge's first delete finds nothing; then both PUTs land. The committing upload's commit is refused and deletes
 * its own bytes; the second upload of `abandoned` never commits, and the row stays counted until a delete that starts
 * after the signed upload window removes its bytes. */
export async function replayLateUpload(t, { s, r2, committing, abandoned, purge }) {
  const tick = clock(t, s, newest([committing, abandoned]));
  await artifactStorage.markCommitted._handler(s.ctx, { ref: `r2blob:${abandoned._id}` });
  await purge();
  assert.deepEqual(await drain(s, 'deleteBytes'), { count: 2, failed: 0 });
  assert.equal((await pending(s)).pending, 2, 'a delete before the upload window ends is not final');
  for (const row of [committing, abandoned]) r2.objects.set(row.r2Key, Buffer.from('late bytes'));
  await assert.rejects(
    artifactStorage.commit._handler(s.ctx, { ref: `r2blob:${committing._id}` }),
    code('INVALID_ARTIFACT'),
  );
  assert.equal(r2.objects.has(committing.r2Key), false, 'the refused commit deletes its own bytes');
  assert.equal(s.tables.artifactBlobs.get(committing._id).committed, false);
  assert.ok(r2.objects.has(abandoned.r2Key), 'the second upload landed after the first delete');
  tick(WINDOW - 60_000);
  assert.equal((await drain(s, 'retryDelete')).count, 0, 'no retry before the window ends');
  tick(60_000);
  await drain(s, 'retryDelete');
  await drain(s, 'deleteBytes');
  assert.equal(r2.objects.has(abandoned.r2Key), false, 'the delete after the window removes the late bytes');
  assert.deepEqual(await pending(s), { pending: 0, more: false, mostAttempts: 0 });
  assert.deepEqual(await drain(s, 'retryDelete'), { count: 0, failed: 0 });

  // A refused commit whose own delete fails keeps the row counted until a later delete succeeds.
  r2.objects.set(committing.r2Key, Buffer.from('late bytes'));
  r2.refuseDeletions(true);
  await assert.rejects(
    artifactStorage.commit._handler(s.ctx, { ref: `r2blob:${committing._id}` }),
    code('INVALID_ARTIFACT'),
  );
  assert.equal((await pending(s)).pending, 1, 'the failed own delete is tracked');
  r2.refuseDeletions(false);
  await drain(s, 'deleteBytes');
  assert.equal(r2.objects.has(committing.r2Key), false);
  assert.deepEqual(await pending(s), { pending: 0, more: false, mostAttempts: 0 });
}
