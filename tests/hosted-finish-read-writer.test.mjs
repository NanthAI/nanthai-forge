// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const {
  finishReadFields,
  finishReadProjection,
  finishOwnerProjection,
  finishPeerProjection,
  finishAheadQueueProjection,
} = await import(moduleUrl('../convex/projectFinishReadProjection.ts'));
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const { finishReadReader } = await import(moduleUrl('../convex/projectFinishReadReader.ts'));
const expected = (kind, row) => [
  finishReadProjection(kind, row),
  ...(kind === 'projectHostedFinishes' ? [finishOwnerProjection(row)] : []),
  ...(kind === 'projectHostedLandingRequests' ? [finishPeerProjection(row)] : []),
  ...(kind === 'projectHostedLandingQueues' ? [finishAheadQueueProjection(row)] : []),
];
function assertProjection(f, kind, row) {
  for (const value of expected(kind, row)) {
    const saved = [...f.tables.projectFinishReadRows.values()].find(
      r => r.sourceId === row._id && r.kind === value.kind,
    );
    assert(saved, value.kind);
    assert.deepEqual(
      Object.fromEntries(Object.entries(saved).filter(([key]) => !key.startsWith('_'))),
      value,
    );
  }
}

test('no-DB handlers stay lazy and method decoration preserves the underlying writer', async () => {
  let accesses = 0;
  const lazy = finishReadWriter({
    get db() {
      accesses++;
      throw Error('synthetic forbidden DB access');
    },
  });
  assert.equal(accesses, 0);
  assert.throws(() => lazy.db.get('unused'), /forbidden DB access/);
  assert.equal(accesses, 1);
  const capabilities = { query: () => null, patch: () => null };
  const checked = finishReadWriter({ db: capabilities });
  assert('patch' in checked.db, 'mutation capability checks still see the original writer');
  delete capabilities.patch;
  assert(!('patch' in checked.db), 'a read-only port does not gain mutation capabilities');
  assert('query' in checked.db);
  assert.equal(checked.db.get, undefined, 'a narrow port does not gain a read capability');
  const f = await landingFixture();
  const state = await f.enqueue();
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  let patches = 0;
  await f.call(
    'decoratedWriter',
    {
      _handler: async ctx => {
        const patch = ctx.db.patch.bind(ctx.db);
        ctx.db.patch = (...args) => {
          patches++;
          return patch(...args);
        };
        await ctx.db.patch(row._id, { priorityVersion: 3 });
      },
    },
    {},
  );
  assert.equal(patches, 1);
  assertProjection(f, 'projectHostedLandingRequests', f.tables.projectHostedLandingRequests.get(row._id));
});

test('projection patches are idempotent and match recomputing the complete source row', async () => {
  const f = await landingFixture();
  await f.enqueue();
  for (const kind of Object.keys(finishReadFields)) {
    for (const row of [...f.tables[kind].values()]) {
      const field = finishReadFields[kind].find(key => row[key] !== undefined);
      const patch = { [field]: row[field] };
      await f.call('installLegacyProjection', { _handler: ctx => ctx.db.patch(row._id, patch) }, {});
      assertProjection(f, kind, f.tables[kind].get(row._id));
      const writes = f.tables.projectFinishReadRows.size;
      await f.call('sameProjection', { _handler: ctx => ctx.db.patch(row._id, patch) }, {});
      assert.equal(
        f.counts.at(-1).written.filter(t => t === 'projectFinishReadRows').length,
        0,
        'unchanged projection writes zero bytes',
      );
      assert.equal(f.tables.projectFinishReadRows.size, writes);
    }
  }
});

test('a pinned Plan repair switches a stale pointer and installs its ready generation in one transaction', async () => {
  const f = await landingFixture();
  const { HOSTED_WORK_INDEX_FORMAT } = await import('../dist/work-hosted-summary.js');
  const { plan } = await import(moduleUrl('../convex/projectFinishReadRepair.ts'));
  const project = f.tables.hostedProjects.get(f.projectId);
  const backupId = 'projectBackups-plan-finish-repair';
  const generation = {
    projectId: f.projectId,
    backupId,
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    revision: 0,
    initialRevision: 0,
    nextBatch: 1,
    metadata: JSON.stringify({ schema: 24 }),
  };
  const ids = await f.call(
    'preparePlanRepairFixture',
    {
      _handler: async ctx => {
        const previous = await ctx.db.insert('projectWorkGenerations', generation);
        const next = await ctx.db.insert('projectWorkGenerations', generation);
        await ctx.db.patch(f.projectId, {
          work: {
            backupId,
            generationId: previous,
            operationId: 'plan-source',
            initialRevision: 0,
            revision: 0,
          },
        });
        return { previous, next };
      },
    },
    {},
  );
  // A pre-projection source publication can leave both the old Plan pin and a missing compact header.
  const original = f.tables.hostedProjects.get(project._id);
  original.work.generationId = ids.next;
  const compact = kind =>
    [...f.tables.projectFinishReadRows.values()].find(row => row.sourceId === ids.next && row.kind === kind);
  f.tables.projectFinishReadRows.delete(compact('projectWorkGenerations')._id);
  const readPlan = () =>
    f.call(
      'readPlanHeader',
      {
        _handler: async ctx => {
          const { db } = finishReadReader(ctx, 'plan');
          const selected = (await db.get(f.projectId)).work.generationId;
          const header = await db.get(selected);
          return { selected, status: header.status };
        },
      },
      {},
    );
  assert.deepEqual(await readPlan(), { selected: ids.previous, status: 'ready' });
  const input = { projectId: f.projectId, generationId: ids.next, apply: false };
  assert.deepEqual(await f.transaction('inspectMissingPlanHeader', plan, input, 'owner'), {
    eligible: 2,
    oversized: 0,
    different: 2,
    changed: 0,
  });
  await assert.rejects(
    () =>
      f.transaction(
        'refuseStalePlanRepair',
        plan,
        { ...input, generationId: ids.previous, apply: true },
        'owner',
      ),
    error => error.code === 'WORK_STALE',
  );
  assert.equal(
    (await f.transaction('repairPlanHeaders', plan, { ...input, apply: true }, 'owner')).changed,
    2,
  );
  assert.deepEqual(await readPlan(), { selected: ids.next, status: 'ready' });
  assert.equal(
    (await f.transaction('replayPlanRepair', plan, { ...input, apply: true }, 'owner')).changed,
    0,
  );
  assert.equal(f.tables.hostedProjects.get(project._id).work.generationId, ids.next);
});

test('parallel same-row patches, field removal, replacement, rollback and deletion preserve the read model', async () => {
  const f = await landingFixture();
  const state = await f.enqueue();
  const original = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  await f.call(
    'parallelPatches',
    {
      _handler: ctx =>
        Promise.all([
          ctx.db.patch(original._id, { priorityReason: 'synthetic reason' }),
          ctx.db.patch(original._id, { priorityVersion: 5 }),
          ctx.db.patch(original._id, { runnable: false }),
        ]),
    },
    {},
  );
  assertProjection(
    f,
    'projectHostedLandingRequests',
    f.tables.projectHostedLandingRequests.get(original._id),
  );
  await f.call(
    'removeField',
    { _handler: ctx => ctx.db.patch(original._id, { priorityReason: undefined }) },
    {},
  );
  assertProjection(
    f,
    'projectHostedLandingRequests',
    f.tables.projectHostedLandingRequests.get(original._id),
  );
  const before = structuredClone([...f.tables.projectFinishReadRows.values()]);
  await assert.rejects(
    f.call(
      'rollback',
      {
        _handler: async ctx => {
          await ctx.db.patch(original._id, { priorityVersion: 6 });
          throw new Error('synthetic rollback');
        },
      },
      {},
    ),
    /synthetic rollback/,
  );
  assert.deepEqual([...f.tables.projectFinishReadRows.values()], before);
  const replacement = Object.fromEntries(Object.entries(original).filter(([key]) => !key.startsWith('_')));
  await f.call('replace', { _handler: ctx => ctx.db.replace(original._id, replacement) }, {});
  assertProjection(
    f,
    'projectHostedLandingRequests',
    f.tables.projectHostedLandingRequests.get(original._id),
  );
  await f.call('delete', { _handler: ctx => ctx.db.delete(original._id) }, {});
  assert(![...f.tables.projectFinishReadRows.values()].some(r => r.sourceId === original._id));
});

test('metrics run projection is transactional, fresh and separate from the status-only finish observer', async t => {
  const f = await landingFixture();
  const run = {
    id: 'metrics-run',
    at: '2026-11-01T00:00:00.000Z',
    endedAt: null,
    status: 'running',
    request: { expectedHead: 'a'.repeat(64) },
    executionId: 'execution',
    cost: { status: 'observed', seconds: 30 },
  };
  const id = await f.call(
    'insertMetricsRun',
    {
      _handler: ctx =>
        ctx.db.insert('projectHostedCheckRuns', {
          projectId: f.projectId,
          runId: run.id,
          candidateId: 'candidate',
          status: run.status,
          value: JSON.stringify(run),
        }),
    },
    {},
  );
  const projection = kind =>
    [...f.tables.projectFinishReadRows.values()].find(row => row.kind === kind && row.sourceId === id);
  const metric = () => projection('projectMetricCheckRuns');
  assert.equal(metric(), undefined, 'the existing first update owns the metric projection');
  await f.call(
    'firstMetricsRunWrite',
    {
      _handler: async ctx => {
        await ctx.db.get(id);
        await ctx.db.patch(id, { value: JSON.stringify(run) });
      },
    },
    {},
  );
  assert.equal(f.tables.projectHostedCheckRuns.get(id).metricsProjected, true);
  assert.equal(metric().sourceCreatedAt, f.tables.projectHostedCheckRuns.get(id)._creationTime);
  assert.equal(JSON.parse(metric().value).runnerMinutes, 0.5);
  const observer = structuredClone(projection('projectHostedCheckRuns'));
  run.cost.seconds = 60;
  await f.call(
    'updateMetricsRun',
    {
      _handler: async ctx => {
        await ctx.db.get(id);
        await ctx.db.patch(id, { value: JSON.stringify(run) });
      },
    },
    {},
  );
  assert.equal(
    f.counts.at(-1).readDocumentsByTable.projectHostedCheckRuns,
    1,
    'upkeep adds no lookup after the canonical get',
  );
  assert.equal(JSON.parse(metric().value).runnerMinutes, 1);
  assert.deepEqual(
    projection('projectHostedCheckRuns'),
    observer,
    'cost changes do not invalidate a finish waiter',
  );
  await f.call(
    'sameMetricsRun',
    {
      _handler: async ctx => {
        await ctx.db
          .query('projectHostedCheckRuns')
          .withIndex('by_project_and_run', q => q.eq('projectId', f.projectId).eq('runId', run.id))
          .unique();
        await ctx.db.patch(id, { value: JSON.stringify(run) });
      },
    },
    {},
  );
  assert.equal(f.counts.at(-1).written.filter(table => table === 'projectFinishReadRows').length, 0);
  await f.call(
    'patchRunIdentity',
    {
      _handler: async ctx => {
        await ctx.db.get(id);
        await ctx.db.patch(id, { runId: run.id });
      },
    },
    {},
  );
  assert.equal(JSON.parse(metric().value).runnerMinutes, 1, 'a metadata patch retains all measured fields');
  f.tables.projectFinishReadRows.delete(metric()._id);
  delete f.tables.projectHostedCheckRuns.get(id).metricsProjected;
  delete f.tables.projectHostedCheckRuns.get(id).metricProjection;
  await f.call(
    'projectLegacyRunOnWrite',
    {
      _handler: async ctx => {
        await ctx.db.get(id);
        await ctx.db.patch(id, { runId: run.id });
      },
    },
    {},
  );
  assert.equal(
    JSON.parse(metric().value).runnerMinutes,
    1,
    'a legacy row migrates on its next ordinary write',
  );
  assert.equal(f.tables.projectHostedCheckRuns.get(id).metricsProjected, true);
  await f.call(
    'uncachedFullRunWrite',
    {
      _handler: ctx =>
        ctx.db.patch(id, { value: JSON.stringify({ ...run, cost: { status: 'observed', seconds: 120 } }) }),
    },
    {},
  );
  assert.equal(
    f.counts.at(-1).readDocumentsByTable.projectHostedCheckRuns ?? 0,
    1,
    'a value write without a cached row reads the exact creation and projection pins once',
  );
  assert.equal(f.tables.projectHostedCheckRuns.get(id).metricsProjected, true);
  assert.equal(JSON.parse(metric().value).runnerMinutes, 2);
  const uncached = f.counts.at(-1);
  t.diagnostic(
    JSON.stringify({
      uncachedMetricsPatch: {
        canonicalReadBytes: uncached.readBytesByTable.projectHostedCheckRuns,
        totalReadBytes: uncached.readBytes,
        canonicalWriteBytes: uncached.writeBytesByTable.projectHostedCheckRuns,
        finishReadWriteBytes: uncached.writeBytesByTable.projectFinishReadRows,
        totalWriteBytes: uncached.writeBytes,
      },
    }),
  );
  const created = metric().sourceCreatedAt;
  run.status = 'passed';
  const replacement = {
    projectId: f.projectId,
    runId: run.id,
    candidateId: 'candidate',
    status: run.status,
    value: JSON.stringify(run),
  };
  await f.call(
    'replaceMetricsRun',
    {
      _handler: ctx => ctx.db.replace(id, replacement),
    },
    {},
  );
  assert.equal(metric().sourceCreatedAt, created);
  assert.equal(JSON.parse(metric().value).status, 'passed');
  assert.equal(f.tables.projectHostedCheckRuns.get(id).metricsProjected, true);
  await f.call('deleteMetricsRun', { _handler: ctx => ctx.db.delete(id) }, {});
  assert.equal(metric(), undefined);
  assert.equal(projection('projectHostedCheckRuns'), undefined);
});
