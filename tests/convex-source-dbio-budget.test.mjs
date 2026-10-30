// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSavePages, saveBytes } from '../dist/hosted-save.js';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';

// Dogfood scale: a save that changes 2,000 files on a 4,000-file State.
const changed = 2000,
  tree = 4000;
async function saveInput(s) {
  const original = await s.putSpec(Buffer.from('baseline\n')),
    files = Array.from({ length: tree }, (_, i) => ({
      path: `src/a/b/${String(i).padStart(6, '0')}.ts`,
      blob: original.sha256,
      mode: 'file',
    }));
  const baseline = await s.json({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files,
    message: 'b',
    at,
  });
  const changes = [];
  for (let i = 0; i < changed; i++) {
    const pin = await s.putSpec({ size: 4 * 1024, index: i });
    changes.push({
      path: files[i].path,
      before: { blob: original.sha256, mode: 'file' },
      after: { blob: pin.sha256, mode: 'file', content: { object: pin, recipe: null } },
    });
  }
  const pages = buildSavePages(changes);
  for (const p of pages.pages) await s.json(p.value);
  return s.json({
    schema: 1,
    kind: 'forge-hosted-save-input',
    baseline: { object: baseline, recipe: null },
    pages: pages.root,
    pageCount: pages.pages.length,
    changeCount: changed,
    message: 'budget',
    at,
  });
}

test('source save at dogfood scale stays inside its document read and write budget', async t => {
  const s = await scaleFixture();
  try {
    const input = await saveInput(s),
      start = s.counts.length,
      id = await s.enqueue(input),
      report = await s.drain();
    assert.equal((await s.job(id)).status, 'completed');
    const by = {};
    for (const c of s.counts.slice(start)) {
      const b = (by[c.name] ??= { calls: 0, documents: 0, readBytes: 0, writes: 0 });
      b.calls++;
      b.documents += c.documents;
      b.readBytes += c.readBytes;
      b.writes += c.writes;
    }
    const per = name => ({
      calls: by[name].calls,
      documents: by[name].documents / by[name].calls,
      readBytes: by[name].readBytes / by[name].calls,
      writes: by[name].writes,
    });
    const resolve = per('projectConvexSourceObjects:resolve'),
      complete = per('projectConvexSourceFanout:complete'),
      fork = per('projectConvexSourceFanout:fork');
    t.diagnostic(JSON.stringify({ report, resolve, complete, fork }));
    // Each object row is read once per resolve window (was twice), and a window
    // writes one cleanup fence rather than one per newly referenced object.
    assert(resolve.documents <= 64, `resolve documents/call ${resolve.documents}`);
    assert(resolve.writes <= changed * 1.05, `resolve writes ${resolve.writes}`);
    // A child completion reads its own task, not every running task's input window.
    assert(complete.readBytes <= 32 * 1024, `complete bytes/call ${complete.readBytes}`);
    // Filling several pool slots from one batch validates the batch once.
    assert(fork.documents <= 32, `fork documents/call ${fork.documents}`);
    assert(report.documentsRead <= 3600, `documents read ${report.documentsRead}`);
    assert(report.functionCalls <= 130, `function calls ${report.functionCalls}`);
  } finally {
    s.restore();
  }
});

test('pool drain keeps running slots without reading task inputs and rewrites legacy ids as slots', async () => {
  const { recordsFixture } = await import('./hosted-records-fixture.mjs');
  const { moduleUrl } = await import('./convex-module.mjs');
  const pool = await import(moduleUrl('../convex/projectConvexSourcePool.ts'));
  const f = recordsFixture(),
    { projectId } = await f.setup(),
    scheduled = new Map();
  let serial = 0;
  const schedule = async () => {
    const id = `scheduled-${++serial}`;
    scheduled.set(id, { state: { kind: 'pending' } });
    return id;
  };
  f.ctx.db.system = { get: async id => scheduled.get(id) ?? null };
  f.ctx.scheduler = {
    runAfter: schedule,
    cancel: async id => (scheduled.get(id).state = { kind: 'canceled' }),
  };
  const input = 'x'.repeat(12 * 1024);
  const make = async () => {
    const batchId = await f.ctx.db.insert('projectSourceBatches', {
      projectId,
      jobId: 'job',
      step: 1,
      kind: 'files',
      end: 0,
      total: 1,
      next: 1,
      completed: 0,
      status: 'waiting',
      failure: null,
    });
    const run = await schedule();
    const task = await f.ctx.db.insert('projectSourceTasks', {
      projectId,
      jobId: 'job',
      step: 1,
      batchId,
      index: 0,
      input,
      status: 'running',
      generation: 0,
      scheduledId: run,
      progress: null,
      output: null,
      failure: null,
    });
    return { task, batchId, run };
  };
  const a = await make(),
    b = await make();
  await f.ctx.db.insert('projectSourcePools', { key: 'source', active: [a.task, b.task] });
  const drain = name =>
    f.run(name, () =>
      pool.drainSourcePool(f.ctx, async () => {
        throw Error('running slots are never revalidated');
      }),
    );
  const active = async () => (await f.run('read', () => pool.sourcePool(f.ctx))).active;
  // Earlier bare ids read their task once and become slots.
  await drain('legacy');
  assert.deepEqual(await active(), [
    { task: a.task, batch: a.batchId, scheduled: a.run },
    { task: b.task, batch: b.batchId, scheduled: b.run },
  ]);
  assert(f.counts.at(-2).readBytes >= 2 * input.length);
  // Running slots: batch and scheduled state only, no task input windows.
  await drain('slots');
  assert(f.counts.at(-2).readBytes < input.length, `slot drain read ${f.counts.at(-2).readBytes} bytes`);
  // A finished hint falls back to the task, which already has a newer live run.
  scheduled.get(a.run).state = { kind: 'success' };
  const next = await schedule();
  await f.run('reschedule', () => f.ctx.db.patch(a.task, { generation: 1, scheduledId: next }));
  await drain('stale');
  assert.deepEqual((await active())[0], { task: a.task, batch: a.batchId, scheduled: next });
  // A fenced batch still settles its task exactly as before.
  await f.run('fence', () => f.ctx.db.patch(b.batchId, { status: 'fenced' }));
  await drain('fenced');
  assert.deepEqual(await active(), [{ task: a.task, batch: a.batchId, scheduled: next }]);
  assert.equal(scheduled.get(b.run).state.kind, 'canceled');
  assert.equal(f.tables.projectSourceTasks.get(b.task).status, 'done');
});
