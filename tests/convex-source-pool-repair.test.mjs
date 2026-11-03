// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const pool = await import(moduleUrl('../convex/projectConvexSourcePool.ts'));

test('lease repair retains completed siblings and old in-progress slots across projects', async () => {
  const f = recordsFixture(),
    { projectId } = await f.setup(),
    scheduled = new Map();
  let serial = 0;
  f.ctx.db.system = { get: async id => scheduled.get(id) ?? null };
  f.ctx.scheduler = {
    runAfter: async (_delay, _ref, args) => {
      const id = `run-${++serial}`;
      scheduled.set(id, { state: { kind: 'pending' }, args });
      return id;
    },
    cancel: async id => {
      scheduled.get(id).state.kind = 'canceled';
    },
  };
  const makeBatch = async (project, statuses) => {
    const id = await f.ctx.db.insert('projectSourceBatches', {
      projectId: project,
      jobId: project,
      step: 1,
      kind: 'states',
      end: 0,
      total: statuses.length,
      next: statuses.length,
      completed: statuses.filter(s => s === 'done').length,
      status: 'fenced',
      failure: null,
    });
    const tasks = [];
    for (const [index, state] of statuses.entries()) {
      const scheduledId = `old-${project}-${index}`;
      scheduled.set(scheduledId, { state: { kind: state === 'done' ? 'success' : state } });
      tasks.push(
        await f.ctx.db.insert('projectSourceTasks', {
          projectId: project,
          jobId: project,
          step: 1,
          batchId: id,
          index,
          input: '{}',
          status: state === 'done' ? 'done' : 'running',
          generation: 2,
          scheduledId,
          progress: state === 'done' ? null : { id: `cursor-${index}`, sha256: 'a'.repeat(64) },
          output: state === 'done' ? { id: 'output', sha256: 'b'.repeat(64) } : null,
          failure: null,
        }),
      );
    }
    return { id, tasks };
  };
  const a = await makeBatch(projectId, ['done', 'inProgress', 'pending', 'queued']);
  await f.ctx.db.patch(a.tasks[3], { status: 'queued', scheduledId: undefined });
  const b = await makeBatch('other-project', ['inProgress', 'inProgress']);
  const slots = [...a.tasks.slice(1, 3), ...b.tasks].map(id => {
    const task = f.tables.projectSourceTasks.get(id);
    return { task: id, batch: task.batchId, scheduled: task.scheduledId };
  });
  // Only three live calculations; a pending delivery has no active CPU.
  await f.ctx.db.insert('projectSourcePools', { key: 'source', active: slots });
  const retained = JSON.stringify(f.tables.projectSourceTasks.get(a.tasks[0]));
  await f.run('repair', () => pool.requeueSourceBatch(f.ctx, f.tables.projectSourceBatches.get(a.id)));
  assert.equal(JSON.stringify(f.tables.projectSourceTasks.get(a.tasks[0])), retained);
  assert.equal(f.tables.projectSourceTasks.get(a.tasks[1]).generation, 3);
  assert.deepEqual(f.tables.projectSourceTasks.get(a.tasks[1]).progress, {
    id: 'cursor-1',
    sha256: 'a'.repeat(64),
  });
  assert.equal(scheduled.get(`old-${projectId}-2`).state.kind, 'canceled');
  assert.equal(f.tables.projectSourceBatches.get(a.id).completed, 1);
  // Another project remains live through this batch's lease recovery.
  await f.ctx.db.patch(b.id, { status: 'waiting' });
  const drain = () => f.run('drain', () => pool.drainSourcePool(f.ctx, async () => true));
  await drain();
  const active = [...f.tables.projectSourcePools.values()][0].active;
  assert.equal(active.length, 4);
  assert(
    active.some(slot => slot.scheduled === `old-${projectId}-1`),
    'old CPU still owns its slot',
  );
  assert.equal(serial, 1, 'only one free slot is available');
  const current = f.tables.projectSourceTasks.get(a.tasks[1]);
  assert.equal(current.scheduledId, `old-${projectId}-1`, 'no replacement while old action runs');
  scheduled.get(current.scheduledId).state.kind = 'success';
  await drain();
  assert.equal(serial, 2, 'stopped old action is replaced in its original slot');
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 4);
  const retry = f.tables.projectSourceTasks.get(a.tasks[1]);
  assert.equal(scheduled.get(retry.scheduledId).args.generation, 4);
  assert.equal(JSON.stringify(f.tables.projectSourceTasks.get(a.tasks[0])), retained);

  // A fenced begin can still be returning after releasing its slot. It is
  // already done computing; a repair must not steal a fifth slot back.
  const c = await makeBatch('third-project', ['done']);
  const fenced = f.tables.projectSourceTasks.get(c.tasks[0]);
  await f.ctx.db.patch(fenced._id, { failure: 'SOURCE_JOB_FENCED', output: null });
  scheduled.get(fenced.scheduledId).state.kind = 'inProgress';
  await f.run('releasedBeginRepair', () =>
    pool.requeueSourceBatch(f.ctx, f.tables.projectSourceBatches.get(c.id)),
  );
  await drain();
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 4);
  assert.equal(f.tables.projectSourceTasks.get(fenced._id).status, 'queued');
  assert.equal(serial, 2, 'all four slots remain owned by current computations');
});
