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

async function setup(count = 10050) {
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
  for (let i = 0; i < count; i++)
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
  const entries = Array.from({ length: count }, (_, i) => row(`key-${i + 100}`, `changed-${i}`));
  const removed = Array.from({ length: Math.min(100, count) }, (_, i) => ({
    collection: 'synthetic',
    key: `key-${i}`,
  }));
  const c = {
    protocol: 3,
    phase: 'done',
    final,
    generationId: 'public',
    snapshot: {},
    rows: [],
    metadata: { schema: 18, counts: { synthetic: count } },
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
  for (const method of ['insert', 'patch', 'replace', 'delete']) {
    const call = s.ctx.db[method];
    s.ctx.db[method] = async (...args) => {
      if (active) {
        active.writes++;
        assert(active.writes < 4100);
      }
      return call(...args);
    };
  }
  s.ctx.runMutation = async (ref, args) => {
    assert.equal(active, null);
    active = { name: getFunctionName(ref), reads: 0, writes: 0 };
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
  assert(counts.filter(c => c.name === 'projectReturnCommit:batch').length >= 17);
  assert(counts.filter(c => c.name === 'projectReturnCommit:batch').length <= 25);
  t.diagnostic(
    JSON.stringify({
      rows: actual.length,
      mutations: counts.length,
      maxReads: Math.max(...counts.map(c => c.reads)),
      finalReads: counts.find(c => c.name === 'projectWork:returnSource').reads,
      totalReads: counts.reduce((sum, count) => sum + count.reads, 0),
      totalWrites: counts.reduce((sum, count) => sum + count.writes, 0),
      maxWrites: Math.max(...counts.map(count => count.writes)),
    }),
  );
});

for (const changed of ['owner', 'revision', 'superseded', 'plan'])
  test(`private commit rejects changed ${changed} without publishing`, async () => {
    // Keep a second copy page pending so rejection still happens mid-copy.
    // The scale/retry case above retains the full 10,050-row projection.
    const s = await setup(2001);
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
    const staged = await commit.batch._handler(s.ctx, args);
    assert.equal(staged.returnCommitCopied, false, 'the private copy is still in progress');
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

test('final cursor detachment drains thousands of output pages in bounded partition batches', async () => {
  const s = fixture(),
    store = await import(moduleUrl('../convex/projectReturnMetadataStore.ts'));
  s.tables.projectWorkGenerations.set('private', {
    _id: 'private',
    returnMetadataSnapshot: JSON.stringify({
      key: 'snapshot',
      cleanup: Array.from({ length: 5000 }, (_, i) => `output-${i}`),
    }),
  });
  for (let i = 0; i < 5000; i++)
    s.tables.projectReturnPages.set(`page-${i}`, {
      _id: `page-${i}`,
      projectId: 'project',
      partitionId: 'private',
      key: `output-${i}`,
      position: 0,
      body: 'Synthetic',
    });
  await store.detachReturnMetadata(s.ctx, s.tables.projectWorkGenerations.get('private'));
  assert.equal(s.tables.projectWorkGenerations.get('private').returnMetadataSnapshot, undefined);
  let cursor = 0,
    calls = 0;
  while (cursor < s.scheduled.length) {
    const task = s.scheduled[cursor++];
    if (getFunctionName(task.fn) !== 'projectReturnMetadataStore:release') continue;
    const before = s.tables.projectReturnPages.size;
    await store.release._handler(s.ctx, task.args);
    assert(before - s.tables.projectReturnPages.size <= 200);
    calls++;
  }
  assert.equal(calls, 25);
  assert.equal(s.tables.projectReturnPages.size, 0);
  assert.equal(s.tables.projectWorkGenerations.get('private').returnCleanupRefs, undefined);
});

test('paged changed-output projection resumes after a lost apply reply and preserves unrelated rows', async t => {
  const s = await setup(2100),
    metadata = await import(moduleUrl('../convex/projectSourceReturnMetadata.ts'));
  const stage = s.tables.projectWorkGenerations.get('private');
  const blob = await s.ctx.storage.get(stage.returnCursor);
  const cursor = JSON.parse(await blob.text());
  const refs = [];
  for (let offset = 0; offset < cursor.delta.entries.length; offset += 1000) {
    const rows = cursor.delta.entries.slice(offset, offset + 1000);
    refs.push({
      ...(await metadata.storeReturnMetadata(s.ctx, 'project', 'owner', 'private', rows)),
      records: rows.length,
    });
  }
  cursor.delta.entries = [];
  cursor.delta.outputRefs = refs;
  cursor.delta.staged = true;
  stage.returnCursor = await s.ctx.storage.store(new Blob([JSON.stringify(cursor)]));
  const counts = meter(s);
  const mutate = s.ctx.runMutation;
  let lost = false,
    reads = 0;
  const query = s.ctx.runQuery;
  s.ctx.runQuery = async (ref, args) => {
    if (getFunctionName(ref) === 'projectReturnMetadataStore:readBatch') reads++;
    return query(ref, args);
  };
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (
      !lost &&
      getFunctionName(ref) === 'projectReturnCommit:batch' &&
      !args.copy &&
      (args.entries.length || args.output)
    ) {
      lost = true;
      throw Error('lost output apply reply');
    }
    return result;
  };
  const run = () => progress.returnProgress(s.ctx, structuredClone(stage), s.input, 'owner');
  await assert.rejects(run(), /lost output apply reply/);
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, 'prior');
  let receipt;
  do receipt = await run();
  while (!receipt);
  assert.equal(receipt.revision, 3);
  const rows = [...s.tables.projectWorkRecords.values()].filter(row => row.generationId === 'private');
  assert.equal(rows.length, 2100);
  assert.equal(new Set(rows.map(row => row.key)).size, 2100);
  assert.equal(rows.find(row => row.key === 'key-100').value, row('key-100', 'changed-0').value);
  assert(!rows.some(row => row.key === 'key-0'));
  assert.equal(reads, 0, 'private output stays in the database during commit');
  assert(
    Math.max(...counts.map(count => count.reads)) < 4096,
    'fresh copy avoids per-row destination lookups',
  );
  t.diagnostic(
    JSON.stringify({
      freshCopyRows: 2100,
      mutations: counts.length,
      maxReads: Math.max(...counts.map(count => count.reads)),
      maxWrites: Math.max(...counts.map(count => count.writes)),
      totalReads: counts.reduce((sum, count) => sum + count.reads, 0),
      totalWrites: counts.reduce((sum, count) => sum + count.writes, 0),
    }),
  );
});

test('private output reference must exist in the original partition before any apply or publication', async () => {
  const s = await setup(1),
    stage = s.tables.projectWorkGenerations.get('private');
  stage.returnCommitCopied = true;
  await assert.rejects(
    commit.batch._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      generationId: 'public',
      partitionId: 'private',
      expectedBackupId: 'prior',
      revision: 1,
      operationId: 'operation',
      plan: 'output-plan',
      copy: false,
      cursor: null,
      offset: 0,
      total: 1,
      entries: [],
      removed: [],
      output: { key: 'missing-output', parts: 1, skip: 0 },
    }),
    error => error.data?.code === 'WORK_STALE' || error.code === 'WORK_STALE',
  );
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, 'prior');
  assert.equal(s.tables.projectWorkEvents.size, 0);
});

test('private copy pages a 235 MiB, 10,352-record Work baseline within 50 calls', async t => {
  const { offlineStore } = await import('../scripts/return-offline-store.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'forge-copy-budget-'));
  const store = offlineStore(join(directory, 'db'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const s = await setup(0);
  for (const [table, rows] of Object.entries(s.tables))
    for (const value of rows.values()) store.put(table, value);
  s.ctx.db = store.db;
  const count = 10352,
    payload = 'x'.repeat(Math.ceil((235 * 1024 * 1024) / count));
  for (let i = 0; i < count; i++)
    store.put('projectWorkRecords', {
      ...row(`record-${i}`, payload),
      _id: `record-${i}`,
      _creationTime: i,
      projectId: 'project',
      generationId: 'public',
    });
  store.reset();
  let stage = await store.db.get('private'),
    calls = 0;
  while (!stage.returnCommitCopied) {
    stage = await commit.batch._handler(s.ctx, {
      ...s.input,
      owner: 'owner',
      generationId: 'public',
      partitionId: 'private',
      plan: 'copy-budget',
      copy: true,
      copyFresh: true,
      cursor: stage.returnCommitCursor ?? null,
      offset: 0,
      total: 0,
      entries: [],
      removed: [],
    });
    calls++;
    assert(calls <= 50, 'Copy call count follows bytes/pages, not records');
  }
  let copied = 0,
    cursor = null;
  do {
    const page = await store.db
      .query('projectWorkRecords')
      .withIndex('by_generation', q => q.eq('generationId', 'private'))
      .paginate({ cursor, numItems: 1000, maximumBytesRead: 8000000 });
    copied += page.page.length;
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  assert.equal(copied, count);
  assert(store.accounting.writtenBytes >= 235 * 1024 * 1024);
  t.diagnostic(JSON.stringify({ records: count, calls, writtenBytes: store.accounting.writtenBytes }));
});
