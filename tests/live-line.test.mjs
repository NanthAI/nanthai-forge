// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const line = await import(moduleUrl('../convex/projectLiveLine.ts'));
const submission = await import(moduleUrl('../convex/projectLiveLineSubmission.ts'));
const store = await import(moduleUrl('../convex/projectLiveLineStore.ts'));
const landing = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const previousEnvironment = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const read = (f, actor = 'owner', includeChecks = false) =>
  f.tx('observerBudgetPage', line.read, { projectId: f.projectId, includeChecks }, actor);
const marks = f => [...f.tables.projectLiveLineLanes.values()];

async function seedLineLanes(f, count, holdFirst = false) {
  const seed = [...f.tables.projectHostedOverlapLanes.values()][0];
  await f.tx(
    'seedOpenLineLanes',
    {
      _handler: async ctx => {
        for (let i = 1; i < count; i++) {
          const row = Object.fromEntries(
            Object.entries({ ...seed, laneId: randomUUID() }).filter(([k]) => !k.startsWith('_')),
          );
          const sourceId = await ctx.db.insert('projectHostedOverlapLanes', row);
          await store.trackLineLane(ctx, sourceId, row, null, false);
        }
        if (!holdFirst) return;
        const first = await ctx.db
          .query('projectLiveLineLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', f.projectId).eq('laneId', seed.laneId))
          .unique();
        await store.changeLineMark(ctx.db, first, { held: true });
      },
    },
    {},
  );
}

async function measureLanding(t, count) {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  assert.equal(marks(f).length, 1);
  await seedLineLanes(f, count);
  assert.equal(marks(f).length, count);
  // Compare the same visible landing at both scales. Newer marks come first in the capped reply.
  const first = marks(f)[0];
  f.tables.projectLiveLineLanes.set(first._id, {
    ...first,
    _creationTime: marks(f).at(-1)._creationTime + 1,
  });
  const watch = includeChecks => {
    let readSet;
    let lastReply;
    let tables;
    return {
      latest: undefined,
      samples: [],
      async refresh(trigger, writes = []) {
        if (readSet?.()) return;
        const started = performance.now();
        this.latest = await read(f, 'owner', includeChecks);
        const queryMs = performance.now() - started;
        readSet = f.readSet();
        const serialized = JSON.stringify(this.latest);
        const changed = serialized !== lastReply;
        const meter = f.counts.at(-1);
        assert.equal(meter.writes, 0);
        this.samples.push({
          trigger,
          stage: this.latest.lanes.find(lane => lane.laneId === f.lane.laneId)?.stage ?? 'left',
          changed,
          queryMs,
          readBytes: meter.readBytes,
          replyBytes: Buffer.byteLength(serialized),
          ...(!changed && { overlappingWrites: writes.filter(table => tables.includes(table)) }),
        });
        lastReply = serialized;
        tables = Object.keys(meter.readRangesByTable);
      },
    };
  };
  const line = watch(false);
  const flow = watch(true);
  const refresh = async (trigger, start = f.counts.length) => {
    const writes = [...new Set(f.counts.slice(start).flatMap(meter => meter.written))];
    await line.refresh(trigger, writes);
    await flow.refresh(trigger, writes);
  };
  await refresh('initial read');
  assert.equal(line.samples[0].stage, 'queued', 'a submitted Lane waits In queue (Item 85f456c1)');
  assert.equal(line.latest.checks, undefined);
  assert.deepEqual(flow.latest.checks?.runs, []);
  const drain = async () => {
    while (f.pending().length) {
      const task = f.pending()[0];
      const start = f.counts.length;
      await f.execute(task);
      await refresh(task.name, start);
    }
  };
  await drain();
  const passageStart = f.counts.length;
  await f.passChecks();
  await refresh('check passage', passageStart);
  await drain();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const { latest } = line;
  assert.equal(latest.lanes.length, Math.min(60, count - 1));
  assert(!latest.lanes.some(lane => lane.laneId === f.lane.laneId));
  assert.equal(latest.more, Math.max(0, count - 1 - 60));
  assert.equal(latest.exit.kind, 'landed');
  assert.equal(latest.exit.laneId, f.lane.laneId);
  assert.equal(
    latest.main.head,
    JSON.parse([...f.tables.projectHostedAcceptances.values()][0].value).candidate.head,
  );
  assert.equal(latest.main.check, 'passed');
  assert.equal(f.pending().length, 0, 'no line wake or idle server timer');
  const before = [line.samples.length, flow.samples.length];
  f.advanceClock(30 * 60_000);
  await refresh('idle');
  assert.deepEqual(
    [line.samples.length, flow.samples.length],
    before,
    'thirty simulated idle minutes add no execution or DB I/O',
  );
  assert.deepEqual(
    line.samples.map(sample => sample.stage),
    ['queued', 'checking', 'ready', 'left'],
  );
  assert(
    line.samples.every(sample => sample.changed),
    'every stage-only read advances the line',
  );
  const flowReadBudget = count === 50 ? 27_000 : 30_000;
  assert(
    line.samples.every(sample => sample.readBytes < 27_000) &&
      flow.samples.every(sample => sample.readBytes < flowReadBudget),
    'both subscriptions bound whole-document reads through a landing',
  );
  t.diagnostic(
    JSON.stringify({
      open: count,
      fixturePeakRssKiB: process.resourceUsage().maxRSS,
      line: { reruns: line.samples.length - 1, samples: line.samples },
      flow: { reruns: flow.samples.length - 1, samples: flow.samples },
    }),
  );
}

test('live line follows a real landing atomically, deletes landed marks and retains exact main evidence', t =>
  measureLanding(t, 50));

test('the live line follows the same stages without check-only wakes at 100 open Lanes', t =>
  measureLanding(t, 100));

test('heartbeat, holder, name, device and same-stage submission writes do not invalidate the live line', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  await read(f);
  const unchanged = f.readSet();
  const baseline = structuredClone(marks(f));
  const overlap = [...f.tables.projectHostedOverlapLanes.values()][0];
  await f.tx(
    'syntheticHeartbeat',
    {
      _handler: async ctx => {
        await ctx.db.patch(overlap._id, {
          lastActivityAt: Date.now() + 1,
          actor: 'other',
          agent: 'other-session',
        });
        await ctx.db.patch(f.projectId, { agentGuidance: 'unrelated work metadata' });
        const { row, state: current } = await landing.loadLanding(ctx, {
          projectId: f.projectId,
          submissionId: state.id,
        });
        await landing.writeLanding(ctx, row, { ...current, version: current.version + 1 }, false);
      },
    },
    {},
  );
  assert.deepEqual(marks(f), baseline);
  assert(unchanged(), 'the actual query read set ignores unrelated writes');
  const owner = [...f.tables.projectFinishReadRows.values()].find(r => r.kind === 'projectLiveLineOwner');
  await f.tx(
    'changeSubmissionOwner',
    { _handler: ctx => ctx.db.patch(owner._id, { submissionId: randomUUID() }) },
    {},
  );
  assert(unchanged(), 'holder identity is outside the reactive mark');
  await f.tx('exactConflict', { _handler: ctx => ctx.db.patch(overlap._id, { conflicted: true }) }, {});
  assert(!unchanged(), 'a real overlap change invalidates immediately');
  assert.equal((await read(f)).lanes[0].overlap, true);
});

test('held changes retain stage time on a no-op; a failed transaction cannot publish a mark transition', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  const update = async (held, fail = false) =>
    f.tx(
      'lineHoldTransition',
      {
        _handler: async ctx => {
          const { row, state: before } = await landing.loadLanding(ctx, {
            projectId: f.projectId,
            submissionId: state.id,
          });
          await landing.writeLanding(
            ctx,
            row,
            {
              ...before,
              version: before.version + 1,
              observation: { ...before.observation, pendingReason: held ? 'waiting-for-review' : 'queued' },
            },
            false,
          );
          if (fail) throw Error('synthetic rollback');
        },
      },
      {},
    );
  const stageAt = marks(f)[0].changedAt;
  f.advanceClock(5000);
  await update(true);
  assert.equal((await read(f)).lanes[0].held, true);
  assert.equal(marks(f)[0].changedAt, stageAt, 'a hold does not reset time in stage');
  const before = structuredClone(marks(f));
  await update(true);
  assert.deepEqual(marks(f), before, 'same hold and stage write no mark');
  await assert.rejects(update(false, true), /synthetic rollback/);
  assert.deepEqual(marks(f), before, 'the source and projection roll back together');
});

test('a newer save detaches an older submission and manual abandonment says set-aside', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  const overlap = [...f.tables.projectHostedOverlapLanes.values()][0];
  await f.tx(
    'newerSave',
    {
      _handler: ctx =>
        store.trackLineLane(ctx, overlap._id, { ...overlap, head: 'a'.repeat(64) }, overlap, false),
    },
    {},
  );
  await f.tx(
    'olderLandingTransition',
    { _handler: ctx => submission.transitionLineSubmission(ctx, state, { ...state, phase: 'checking' }) },
    {},
  );
  assert.equal((await read(f)).lanes[0].stage, 'saved');
  await f.tx('abandonLane', { _handler: ctx => ctx.db.patch(overlap._id, { open: false }) }, {});
  const result = await read(f);
  assert.deepEqual(result.lanes, []);
  assert.equal(result.exit.kind, 'set-aside');
});

for (const count of [50, 100, 150])
  test(`live line is bounded at ${count} open Lanes, prioritizes held marks and counts overflow`, async t => {
    const f = await finishFixture(t);
    await seedLineLanes(f, count, true);
    const started = performance.now();
    const result = await read(f);
    const queryWallMs = performance.now() - started;
    assert.equal(result.lanes.length, Math.min(60, count));
    assert.equal(result.more, Math.max(0, Math.min(101, count) - 60));
    assert.equal(result.moreIsLowerBound, count >= 101);
    assert.equal(result.lanes[0].held, true);
    const meter = f.counts.at(-1);
    assert(meter.readBytes < 27_000, 'bounded whole-document reads including access and main fallback');
    assert(Buffer.byteLength(JSON.stringify(result)) < 9000);
    t.diagnostic(
      JSON.stringify({
        open: count,
        queryWallMs,
        fixtureRssBytes: process.memoryUsage().rss,
        fixturePeakRssKiB: process.resourceUsage().maxRSS,
        queryReadBytes: meter.readBytes,
        queryDocuments: meter.documents,
        replyBytes: Buffer.byteLength(JSON.stringify(result)),
      }),
    );
  });

test('live line checks current access, rejects anonymous/revoked readers and never leaks foreign project marks', async t => {
  const f = await finishFixture(t);
  await assert.rejects(read(f, 'stranger'), e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE');
  const reader = f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  assert.equal((await read(f, 'reader')).lanes.length, 1);
  f.tables.projectReaders.delete(reader);
  await assert.rejects(read(f, 'reader'), e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE');
  await assert.rejects(read(f, null), e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE');
});

test('native Work publication preserves the old strip facts without a live Work-generation dependency', async () => {
  const f = lanesFixture();
  f.projectId = f.insert('hostedProjects', {
    owner: 'owner',
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 1,
    sourceAuthority: { mode: 'native-owner', epoch: 1 },
  });
  f.tx = f.call;
  const backupId = f.insert('projectBackups', {
    projectId: f.projectId,
    operationId: randomUUID(),
    request: 'a'.repeat(64),
    nonce: randomUUID(),
    previous: null,
    digest: 'a'.repeat(64),
    size: 0,
    status: 'stored',
    preview: {
      manifestDigest: 'a'.repeat(64),
      head: 'a'.repeat(64),
      format: 'native',
      revision: 1,
      intents: 0,
      lanes: 0,
      views: 0,
      runs: 0,
      files: 0,
      unavailable: 0,
      channels: [],
    },
  });
  const generationId = f.insert('projectWorkGenerations', {
    projectId: f.projectId,
    backupId,
    revision: 1,
    initialRevision: 1,
    nextBatch: 0,
    status: 'ready',
    metadata: JSON.stringify({ sourceKind: 'native' }),
  });
  const head = 'f'.repeat(64);
  const viewId = randomUUID();
  const entry = (collection, key, parent, value, extra = {}) =>
    f.insert('projectWorkRecords', {
      projectId: f.projectId,
      generationId,
      collection,
      key,
      parent,
      position: 0,
      value: JSON.stringify(value),
      ...extra,
    });
  const moveId = randomUUID();
  entry('channels', 'main', '', { name: 'main', head, moveId });
  entry(
    'channelMoves',
    moveId,
    'main',
    {
      channel: 'main',
      head,
      viewId,
      at: '2026-01-01T00:00:00.000Z',
      actor: 'owner',
      status: 'accepted',
      automatic: true,
    },
    { status: 'accepted' },
  );
  entry('runs', randomUUID(), viewId, { status: 'passed', viewId });
  entry(
    'channelMoves',
    randomUUID(),
    'other',
    { channel: 'other', head: 'e'.repeat(64), status: 'accepted' },
    { status: 'accepted' },
  );
  await f.call(
    'nativePublication',
    {
      _handler: ctx =>
        ctx.db.patch(f.projectId, {
          sourceAuthority: { mode: 'native-owner', epoch: 1 },
          work: { backupId, generationId, operationId: randomUUID(), initialRevision: 1, revision: 1 },
        }),
    },
    {},
  );
  const result = await read(f);
  assert.equal(result.main.head, head);
  assert.equal(result.main.check, 'passed');
  assert.equal(result.main.automatic, true);
  assert(!f.counts.at(-1).touched.includes('projectWorkRecords'));
  const unchanged = f.readSet();
  await f.call(
    'unrelatedNativeWork',
    {
      _handler: ctx =>
        ctx.db.patch(f.projectId, {
          work: { backupId, generationId, operationId: randomUUID(), initialRevision: 1, revision: 2 },
        }),
    },
    {},
  );
  assert(unchanged(), 'identical main facts leave the live query untouched');
});

test('the first ordinary write installs a legacy Lane projection without scanning history', async t => {
  const f = await finishFixture(t);
  const source = [...f.tables.projectHostedOverlapLanes.values()][0];
  f.tables.projectLiveLineLanes.clear();
  for (const [id, row] of f.tables.projectFinishReadRows)
    if (['projectLiveLineOwner', 'projectLiveLineSummary'].includes(row.kind))
      f.tables.projectFinishReadRows.delete(id);
  await f.tx(
    'legacyLineInstall',
    { _handler: ctx => store.trackLineLane(ctx, source._id, source, source, false) },
    {},
  );
  const measured = f.counts.at(-1);
  assert.equal(marks(f).length, 1);
  assert(!measured.touched.includes('projectHostedRecords'));
  t.diagnostic(
    JSON.stringify({
      lineSetup: {
        readBytes: measured.readBytes,
        writeBytes: measured.writeBytes,
        writes: measured.writes,
        indexEntriesWritten: measured.indexEntriesWritten,
        documents: measured.documents,
      },
    }),
  );
});

test('binding one saved Lane creates bounded transition ownership and moves its mark to In queue', async t => {
  const f = await finishFixture(t);
  const before = structuredClone(marks(f));
  const state = {
    id: randomUUID(),
    projectId: f.projectId,
    phase: 'queued',
    observation: { pendingReason: 'queued' },
  };
  await f.tx(
    'lineBinding',
    {
      _handler: ctx =>
        submission.bindLineSubmission(ctx, state, {
          actor: 'owner',
          operationId: f.request().finish.composeOperationId,
        }),
    },
    {},
  );
  const measured = f.counts.at(-1);
  // The one mark change binding makes: Saved to In queue (Item 85f456c1); held, check and the rest are untouched.
  assert.deepEqual(
    marks(f).map(({ stage, changedAt: _at, ...rest }) => rest),
    before.map(({ stage, changedAt: _at, ...rest }) => rest),
  );
  assert.deepEqual(
    marks(f).map(mark => mark.stage),
    before.map(() => 'queued'),
  );
  // The owner accepted +1 write per submitted Lane for In queue (2 -> 3 writes, 762 -> 1007 B; Item 85f456c1).
  assert(measured.writes <= 3, `binding writes ${measured.writes}, accepted ceiling 3`);
  assert(measured.writeBytes <= 1100, `binding writes ${measured.writeBytes} B, accepted ceiling 1,100`);
  t.diagnostic(
    JSON.stringify({
      lineBinding: {
        readBytes: measured.readBytes,
        writeBytes: measured.writeBytes,
        writes: measured.writes,
        indexEntriesWritten: measured.indexEntriesWritten,
        documents: measured.documents,
      },
    }),
  );
});

test('a staged lifecycle overlay cannot report a set-aside exit before closure is materialized', async t => {
  const f = await finishFixture(t);
  const mark = marks(f)[0];
  await f.tx(
    'stagedLifecycleOnly',
    { _handler: ctx => store.patchLineLane(ctx.db, mark.sourceId, { lifecyclePlanId: 'staged' }) },
    {},
  );
  assert.equal(marks(f).length, 1);
  assert.equal((await read(f)).exit, null);
  await f.tx('materializedLifecycle', { _handler: ctx => ctx.db.patch(mark.sourceId, { open: false }) }, {});
  assert.equal((await read(f)).exit.kind, 'set-aside');
});

test('closing the last exact-conflict pair clears both live overlaps, while other open pairs remain', async t => {
  const f = await finishFixture(t);
  await f.c.lane(f.c.baseline);
  const rows = [...f.tables.projectHostedOverlapLanes.values()];
  const conflicts = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
  await f.tx(
    'seedPairFlags',
    {
      _handler: async ctx => {
        for (const row of rows) await ctx.db.patch(row._id, { conflicted: true });
        for (const [owner, peer] of [
          [rows[0], rows[1]],
          [rows[1], rows[0]],
        ])
          await ctx.db.insert('projectHostedConflictNotices', {
            projectId: f.projectId,
            laneId: owner.laneId,
            peer: peer.laneId,
            peerGoal: 'Synthetic',
            open: true,
            paths: [],
            laneHead: owner.head,
            peerHead: peer.head,
            flaggedAt: Date.now(),
            updatedAt: Date.now(),
            laneStartedAt: Date.now(),
          });
      },
    },
    {},
  );
  assert((await read(f)).lanes.every(mark => mark.overlap));
  await f.tx(
    'endLastPair',
    { _handler: ctx => conflicts.closeConflictNotices(ctx, f.projectId, rows[0].laneId, 'save') },
    {},
  );
  assert((await read(f)).lanes.every(mark => !mark.overlap));
  assert([...f.tables.projectHostedOverlapLanes.values()].every(row => !row.conflicted));
  await f.c.lane(f.c.baseline);
  const third = [...f.tables.projectHostedOverlapLanes.values()].at(-1);
  await f.tx(
    'seedRemainingPair',
    {
      _handler: async ctx => {
        for (const row of [rows[0], rows[1], third]) await ctx.db.patch(row._id, { conflicted: true });
        for (const [owner, peer] of [
          [rows[0], rows[1]],
          [rows[1], rows[0]],
          [rows[1], third],
          [third, rows[1]],
        ])
          await ctx.db.insert('projectHostedConflictNotices', {
            projectId: f.projectId,
            laneId: owner.laneId,
            peer: peer.laneId,
            peerGoal: 'Synthetic',
            open: true,
            paths: [],
            laneHead: owner.head,
            peerHead: peer.head,
            flaggedAt: Date.now(),
            updatedAt: Date.now(),
            laneStartedAt: Date.now(),
          });
      },
    },
    {},
  );
  await f.tx(
    'endOneOfTwoPairs',
    { _handler: ctx => conflicts.closeConflictNotices(ctx, f.projectId, rows[0].laneId, 'save') },
    {},
  );
  const current = new Map((await read(f)).lanes.map(mark => [mark.laneId, mark.overlap]));
  assert.equal(current.get(rows[0].laneId), false);
  assert.equal(current.get(rows[1].laneId), true, 'a remaining open pair keeps its mark');
  assert.equal(current.get(third.laneId), true);
});

test('projection accounting preserves raw billing totals and rejects oversized ownership pages', async t => {
  const f = await finishFixture(t);
  const budget = await import('./observer-projection-budget.mjs');
  const state = {
    id: randomUUID(),
    projectId: f.projectId,
    phase: 'queued',
    observation: { pendingReason: 'queued' },
  };
  await f.tx(
    'projectionBudgetBinding',
    {
      _handler: ctx =>
        submission.bindLineSubmission(ctx, state, {
          actor: 'owner',
          operationId: f.request().finish.composeOperationId,
        }),
    },
    {},
  );
  const raw = f.counts.at(-1);
  const before = JSON.stringify(raw);
  budget.observerProjectionBudget(raw);
  budget.liveLineProjectionCounts(raw);
  assert.equal(JSON.stringify(raw), before, 'billing and cost guards retain every physical read/write');
  assert.throws(
    () =>
      budget.observerProjectionBudget({
        ...raw,
        liveLine: { ...raw.liveLine, metaWriteBytes: 16 * 1024 * raw.liveLine.metaWrites + 1 },
      }),
    /bounded 100-mark pages/,
  );
});
