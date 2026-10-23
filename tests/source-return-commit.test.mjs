// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fixture } from './project-exchange-fixture.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const progress = await import(moduleUrl('../convex/projectSourceReturnProgress.ts'));
const commit = await import(moduleUrl('../convex/projectReturnCommit.ts'));
const row = (key, value = key) => ({
  collection: 'synthetic',
  key,
  value: JSON.stringify({ value }),
  parent: '',
  position: 0,
});

async function setup() {
  const s = fixture();
  s.tables.hostedProjects.get('project').work = {
    backupId: 'prior',
    revision: 1,
    initialRevision: 1,
    generationId: 'public',
  };
  const generation = {
    projectId: 'project',
    backupId: 'prior',
    revision: 1,
    initialRevision: 1,
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    nextBatch: 1,
    metadata: '{"schema":18,"counts":{}}',
    _creationTime: 1,
  };
  s.tables.projectWorkGenerations.set('public', { ...generation, _id: 'public' });
  s.tables.projectWorkGenerations.set('private', {
    ...generation,
    _id: 'private',
    backupId: 'candidate',
    revision: 3,
    returnOperationId: 'operation',
    returnAt: 'now',
    returnStep: 1,
  });
  s.tables.projectBackups.set('candidate', {
    _id: 'candidate',
    projectId: 'project',
    status: 'stored',
    preview: { revision: 2 },
  });
  for (let i = 0; i < 10050; i++)
    s.tables.projectWorkRecords.set(`original-${i}`, {
      ...row(`key-${i}`),
      _id: `original-${i}`,
      _creationTime: i,
      projectId: 'project',
      generationId: 'public',
    });
  const final = {
    projectId: 'project',
    owner: 'owner',
    operationId: 'operation',
    request: 'request',
    command: '{}',
    backupId: 'candidate',
    expectedBackupId: 'prior',
    expectedRevision: 1,
    localRevision: 2,
    at: 'now',
  };
  const entries = Array.from({ length: 10050 }, (_, i) => row(`key-${i + 100}`, `changed-${i}`));
  const removed = Array.from({ length: 100 }, (_, i) => ({ collection: 'synthetic', key: `key-${i}` }));
  const c = {
    protocol: 3,
    phase: 'done',
    final,
    generationId: 'public',
    snapshot: {},
    rows: [],
    metadata: { schema: 18, counts: { synthetic: 10050 } },
    delta: { entries, removed },
  };
  s.tables.projectWorkGenerations.get('private').returnCursor = await s.ctx.storage.store(
    new Blob([JSON.stringify(c)]),
  );
  const input = { projectId: 'project', expectedBackupId: 'prior', revision: 1, operationId: 'operation' };
  return { ...s, input, final, entries, removed };
}

// Count document reads at the fake DB boundary, including missing indexed lookups.
function meter(s) {
  let active = null;
  const counts = [],
    get = s.ctx.db.get,
    query = s.ctx.db.query,
    mutate = s.ctx.runMutation;
  const add = n => {
    if (active) {
      active.reads += n;
      assert(active.reads < 4096, `${active.name}: ${active.reads} reads`);
    }
  };
  s.ctx.db.get = async id => {
    add(1);
    return get(id);
  };
  s.ctx.db.query = table => {
    const q = query(table);
    for (const method of ['unique', 'take', 'paginate']) {
      const call = q[method];
      q[method] = async (...args) => {
        const result = await call(...args);
        add(method === 'unique' ? 1 : method === 'take' ? result.length : result.page.length);
        return result;
      };
    }
    return q;
  };
  s.ctx.runMutation = async (ref, args) => {
    assert.equal(active, null);
    active = { name: getFunctionName(ref), reads: 0 };
    try {
      return await s.transaction(() => mutate(ref, args));
    } finally {
      counts.push(active);
      active = null;
    }
  };
  return counts;
}

test('legacy ready projection over 10,000 rows commits privately with bounded reads and retry after lost batches/final flip', async t => {
  const s = await setup(),
    counts = meter(s),
    mutate = s.ctx.runMutation;
  let copied = false,
    applied = false,
    flipped = false;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutate(ref, args),
      name = getFunctionName(ref);
    if (name === 'projectReturnCommit:batch') {
      assert.equal(s.tables.hostedProjects.get('project').work.backupId, 'prior');
      assert.equal(s.tables.projectWorkGenerations.get('public').recordsGenerationId, undefined);
      assert.equal(s.tables.projectWorkRecords.get('original-100').value, row('key-100').value);
      if (!copied || (result.returnCommitOffset > 0 && !applied)) {
        const before = s.tables.projectWorkRecords.size;
        const replay = await mutate(ref, args);
        assert.equal(replay.returnCommitCursor, result.returnCommitCursor);
        assert.equal(replay.returnCommitOffset, result.returnCommitOffset);
        assert.equal(s.tables.projectWorkRecords.size, before, 'replaying a batch writes no duplicate rows');
        if (!copied) {
          copied = true;
          const { modules } = await import('./project-exchange-fixture.mjs');
          await assert.rejects(
            modules.projectWork.returnSource._handler(s.ctx, {
              ...s.final,
              projection: {
                generationId: 'public',
                partitionId: 'private',
                entries: [],
                removed: [],
                metadata: '{"schema":18,"counts":{}}',
              },
            }),
            e => e.data?.code === 'WORK_STALE',
          );
          assert.equal(s.tables.projectWorkEvents.size, 0);
        } else applied = true;
        throw Error('lost private batch reply');
      }
    }
    if (name === 'projectWork:returnSource' && !flipped) {
      flipped = true;
      throw Error('lost final reply');
    }
    return result;
  };
  const run = () =>
    progress.returnProgress(
      s.ctx,
      structuredClone(s.tables.projectWorkGenerations.get('private')),
      s.input,
      'owner',
    );
  // Copying under contention can use the action budget before the next
  // injected interruption. Follow every pending continuation; a wall-clock
  // budget cannot guarantee how many calls reach a particular batch.
  const untilInterrupted = async () => {
    for (let call = 0; call < 50; call++)
      assert.equal(await run(), null, 'the injected interruption must precede any returned receipt');
    assert.fail('private commit did not reach its injected interruption');
  };
  await assert.rejects(untilInterrupted(), /lost private batch reply/);
  await assert.rejects(untilInterrupted(), /lost private batch reply/);
  await assert.rejects(untilInterrupted(), /lost final reply/);
  // The final receipt path is authoritative even after its private cursor is detached.
  const { modules } = await import('./project-exchange-fixture.mjs');
  const first = [...s.tables.projectWorkEvents.values()][0];
  assert.deepEqual(await modules.projectWork.returnSource._handler(s.ctx, s.final), first);
  assert.equal(s.tables.projectWorkEvents.size, 1);
  const partition = s.tables.projectWorkGenerations.get('public').recordsGenerationId;
  assert.equal(partition, 'private');
  const actual = [...s.tables.projectWorkRecords.values()].filter(r => r.generationId === partition);
  assert.equal(actual.length, 10050);
  assert(!actual.some(r => r.key === 'key-0'));
  assert.equal(actual.find(r => r.key === 'key-100').value, row('key-100', 'changed-0').value);
  assert.equal(new Set(actual.map(r => r.key)).size, actual.length);
  assert(counts.filter(c => c.name === 'projectReturnCommit:batch').length > 20);
  t.diagnostic(
    JSON.stringify({
      rows: actual.length,
      mutations: counts.length,
      maxReads: Math.max(...counts.map(c => c.reads)),
      finalReads: counts.find(c => c.name === 'projectWork:returnSource').reads,
    }),
  );
});

for (const changed of ['owner', 'revision', 'superseded', 'plan'])
  test(`private commit rejects changed ${changed} without publishing`, async () => {
    const s = await setup();
    const args = {
      projectId: 'project',
      owner: 'owner',
      generationId: 'public',
      partitionId: 'private',
      expectedBackupId: 'prior',
      revision: 1,
      operationId: 'operation',
      plan: 'plan',
      copy: true,
      cursor: null,
      offset: 0,
      total: 1,
      entries: [row('new')],
      removed: [],
    };
    await commit.batch._handler(s.ctx, args);
    if (changed === 'owner') s.tables.hostedProjects.get('project').owner = 'other';
    if (changed === 'revision') s.tables.hostedProjects.get('project').work.revision++;
    if (changed === 'superseded')
      s.tables.projectReturnSupersessions.set('superseded', {
        projectId: 'project',
        operationId: 'operation',
      });
    if (changed === 'plan') args.plan = 'changed';
    await assert.rejects(commit.batch._handler(s.ctx, args), e =>
      ['PROJECT_UNAVAILABLE', 'WORK_STALE', 'WORK_OPERATION_CHANGED', 'SOURCE_RETURN_SUPERSEDED'].includes(
        e.data?.code ?? e.code,
      ),
    );
    assert.equal(s.tables.hostedProjects.get('project').work.backupId, 'prior');
  });

test('final cursor detachment schedules cleanup in bounded groups for thousands of output pages', async () => {
  const s = fixture(),
    store = await import(moduleUrl('../convex/projectReturnMetadataStore.ts'));
  s.tables.projectWorkGenerations.set('private', {
    _id: 'private',
    returnMetadataSnapshot: JSON.stringify({
      key: 'snapshot',
      cleanup: Array.from({ length: 5000 }, (_, i) => `output-${i}`),
    }),
  });
  await store.detachReturnMetadata(s.ctx, s.tables.projectWorkGenerations.get('private'));
  assert.equal(s.tables.projectWorkGenerations.get('private').returnMetadataSnapshot, undefined);
  let cursor = 0,
    calls = 0;
  while (cursor < s.scheduled.length) {
    const task = s.scheduled[cursor++];
    if (getFunctionName(task.fn) !== 'projectReturnMetadataStore:release') continue;
    const before = s.scheduled.length;
    await store.release._handler(s.ctx, task.args);
    assert(s.scheduled.length - before <= 51);
    calls++;
  }
  assert(calls > 100);
  assert.equal(
    s.scheduled.filter(t => getFunctionName(t.fn) === 'projectReturnMetadataStore:retire').length,
    5001,
  );
  assert.equal(s.tables.projectWorkGenerations.get('private').returnCleanupRefs, undefined);
});
