import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { get, begin } = await import(moduleUrl('../convex/imports.ts'));
const job = {
  _id: 'import',
  task: 'old-task',
  phase: 'indexing',
  generation: 2,
  artifactKey: 'previous-object',
  repository: 'example/project',
  ref: 'main',
  scope: 'public',
  owner: '',
  visibility: 'public',
  processed: 5,
  total: 5,
};

test('failed or unrestored scheduler status is retryable without changing source, and retry preserves the previous artifact', async () => {
  for (const kind of ['failed', 'canceled', null]) {
    const db = { get: async () => job, system: { get: async () => (kind ? { state: { kind } } : null) } };
    const result = await get._handler({ db }, { id: job._id });
    assert.equal(result.phase, 'error');
    assert.match(result.error, /worker stopped.*Retry/);
    assert.equal(result.artifactKey, job.artifactKey);
    assert.equal(result.generation, job.generation);
    assert.equal(job.phase, 'indexing', 'Status is a projection, not a metadata write.');
    let patch, scheduled;
    db.query = () => ({ withIndex: () => ({ unique: async () => job }) });
    db.patch = async (id, changes) => {
      assert.equal(id, job._id);
      patch = changes;
    };
    const scheduler = {
      runAfter: async (delay, handler, args) => {
        scheduled = { delay, args };
        return 'new-task';
      },
    };
    const retried = await begin._handler(
      { db, scheduler },
      { repository: job.repository, ref: job.ref, owner: '', visibility: 'public' },
    );
    assert.deepEqual(retried, { id: job._id, run: true, generation: 3 });
    assert.deepEqual(scheduled, { delay: 0, args: { id: job._id, generation: 3 } });
    assert.equal(patch.task, 'new-task');
    assert.equal(patch.phase, 'queued');
    assert.ok(!('artifactKey' in patch), 'Retry must retain the previous published object.');
  }
  for (const kind of ['pending', 'inProgress']) {
    const db = {
      get: async () => job,
      system: { get: async () => ({ state: { kind } }) },
      query: () => ({ withIndex: () => ({ unique: async () => job }) }),
    };
    assert.equal(await get._handler({ db }, { id: job._id }), job);
    const scheduler = { runAfter: () => assert.fail('Active imports must coalesce, not restart.') };
    assert.deepEqual(await begin._handler({ db, scheduler }, job), {
      id: job._id,
      run: false,
      generation: 2,
    });
  }
  const db = {
    get: async () => ({ ...job, phase: 'ready' }),
    system: { get: () => assert.fail('A published result does not inherit an old task failure.') },
  };
  assert.equal((await get._handler({ db }, { id: job._id })).phase, 'ready');
  assert.equal(await get._handler({ db: { get: async () => null } }, { id: 'missing' }), null);
});
