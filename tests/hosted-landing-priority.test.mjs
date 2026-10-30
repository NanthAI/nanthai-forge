// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture, code } from './hosted-landing-fixture.mjs';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { api as finishApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedLandingStateSchema, hostedLandingRequestSchema } from '../dist/hosted-landing.js';
import { api as landingApi } from './hosted-landing-fixture.mjs';
import { orderLandingEntries } from '../dist/landing-batch-order.js';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
const priority = await import(moduleUrl('../convex/projectHostedLandingPriority.ts'));
const order = await import(moduleUrl('../convex/projectHostedLandingOrder.ts'));
const batchPriority = await import(moduleUrl('../convex/projectHostedLandingBatchPriority.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const command = (f, submissionId, overrides = {}) => ({
  projectId: f.projectId,
  submissionId,
  operationId: randomUUID(),
  priority: 'urgent',
  authorityEpoch: 1,
  expectedVersion: 0,
  ...overrides,
});
const prioritize = (f, input, actor = 'owner') =>
  f.transaction('priorityChange', priority.prioritize, input, actor).then(JSON.parse);

test('owner urgent finishes pass earlier normal arrivals; default is normal and status shows position', async () => {
  const f = await landingFixture();
  const normal = await f.enqueue();
  for (let i = 1; i < 12; i++) await f.enqueue();
  f.patch('projectHostedLandingRequests', [...f.tables.projectHostedLandingRequests.values()][0]._id, {
    priority: undefined,
  });
  const urgent = await f.enqueue(f.request({ priority: 'urgent' }));
  assert.equal(normal.priority, 'normal');
  assert.equal(urgent.priority, 'urgent');
  assert.equal((await f.status(urgent.id)).queuePosition, 1);
  assert.equal((await f.status(normal.id)).queuePosition, 2);
  const selected = await f.execute();
  assert.equal(selected.id, urgent.id);
  assert.equal((await f.status(normal.id)).request.priority, 'normal');
});

test('hosted ordering uses native priority and same-class fairness including legacy normal entries', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    submissionId: String(i),
    sequence: i + 1,
    actor: i === 9 ? 'other' : 'owner',
    priority: i >= 6 ? 'urgent' : undefined,
  }));
  const actual = order.orderHostedLandingRows(rows).map(r => r.submissionId);
  const expected = orderLandingEntries(
    rows.map(r => ({
      ...r,
      priority: r.priority ?? 'normal',
      arrivedAt: String(r.sequence).padStart(20, '0'),
      submitter: r.actor,
    })),
  ).map(r => r.submissionId);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.slice(0, 4), ['6', '7', '9', '8']);
});

test('contributors requesting urgent stay normal with an explicit governance reason; cannot reprioritise', async () => {
  const f = await landingFixture();
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  const state = await f.enqueue(f.request({ priority: 'urgent', agent: false }), 'contributor');
  assert.equal(state.priority, 'normal');
  assert.match(state.priorityReason, /only the project owner/);
  await assert.rejects(prioritize(f, command(f, state.id), 'contributor'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(prioritize(f, command(f, state.id), null), code('PROJECT_UNAVAILABLE'));
  assert.equal((await f.status(state.id)).request.priority, 'normal');
});

test('owner reprioritisation is one write, retries are inert and stale retries cannot undo newer priority', async () => {
  const f = await landingFixture(),
    a = await f.enqueue(),
    b = await f.enqueue();
  const input = command(f, b.id),
    beforeTasks = f.metrics.scheduled;
  const changed = await prioritize(f, input);
  assert.equal(changed.priority, 'urgent');
  assert.equal(changed.priorityVersion, 1);
  assert.equal(f.counts.at(-1).writes, 1);
  assert.equal(f.metrics.scheduled, beforeTasks);
  assert.deepEqual(await prioritize(f, input), changed);
  assert.equal(f.counts.at(-1).writes, 0);
  await assert.rejects(prioritize(f, { ...input, priority: 'normal' }), code('WORK_OPERATION_CHANGED'));
  const newer = command(f, b.id, { priority: 'normal', expectedVersion: 1 });
  await prioritize(f, newer);
  await assert.rejects(prioritize(f, input), code('WORK_STALE'));
  assert.equal((await f.status(b.id)).request.priority, 'normal');
  assert.equal((await f.execute()).id, a.id);
});

test('reprioritising never cancels an already running check or its lease', async () => {
  const f = await landingFixture();
  const run = await f.rawChecks.enqueue(f.rawChecks.selection());
  const s = await f.enqueue(f.request({ check: { kind: 'run', runId: run.id } }));
  await f.drain();
  const before = await f.rawChecks.status(run.id),
    cancelled = f.metrics.cancelled;
  const current = (await f.status(s.id)).request;
  assert.equal(current.phase, 'checking');
  const attempt = current.attemptId;
  const changed = await prioritize(f, command(f, s.id));
  assert.equal(changed.priority, 'urgent');
  assert.equal(changed.phase, 'checking');
  assert.equal(changed.attemptId, attempt);
  assert.equal(f.counts.at(-1).writes, 1);
  assert.deepEqual(await f.rawChecks.status(run.id), before);
  assert.equal(f.metrics.cancelled, cancelled);
});

test('urgent priority applies at READY and wins the next free acceptance lease', async () => {
  const f = await acceptanceFixture();
  const normal = await f.ready();
  const urgent = await f.ready();
  const before = (await f.status(urgent.state.id)).attempt;
  const input = command(f, urgent.state.id);
  const changed = await prioritize(f, input);
  assert.equal(changed.phase, 'ready');
  assert.equal(changed.priority, 'urgent');
  assert.equal(f.counts.at(-1).writes, 1);
  assert.deepEqual(await prioritize(f, input), changed);
  assert.equal(await f.claimAcceptance(normal.state), null);
  const lease = await f.claimAcceptance(urgent.state);
  assert(lease);
  assert.deepEqual((await f.status(urgent.state.id)).attempt, before);
  assert.equal((await f.commit(lease)).status, 'landed');
  await assert.rejects(
    prioritize(f, command(f, urgent.state.id, { expectedVersion: 1 })),
    code('WORK_STALE'),
  );
});

test('promoted member escapes a composing normal batch', async t => {
  const f = await batchesFixture(t);
  await f.execute(f.pending().find(t => t.name === 'projectHostedLandingDriver:drive'));
  let batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  assert.equal(batch.phase, 'composing');
  const selected = f.entries[2].state.id;
  await prioritize(f, command(f, selected));
  assert.equal(f.counts.at(-1).writes, 1);
  const status = JSON.parse(
    await f.transaction('priorityFinishStatus', finishApi.status, {
      projectId: f.projectId,
      submissionId: selected,
      version: 1,
      priorityInfo: 1,
    }),
  );
  assert.equal(status.submission.priority, 'urgent');
  assert.equal(status.queuePosition, 1);
  assert.equal(status.unchanged, false);
  const released = await f.transaction(
    'priorityBatch',
    {
      _handler: ctx =>
        batchPriority.releaseUnstartedBatchForPriority(
          ctx,
          { projectId: f.projectId, batchId: batch.id },
          batch,
        ),
    },
    {},
  );
  assert.equal(released, true);
  assert.equal(f.runs().length, 0);
  const next = await f.transaction(
    'priorityNext',
    { _handler: ctx => order.nextLandingRow(ctx, { projectId: f.projectId, channel: 'main' }) },
    {},
  );
  assert.equal(next.submissionId, selected);
  assert.equal(JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value).phase, 'superseded');
  await f.drain();
  assert.equal(f.runs()[0].request.candidateId, f.entries[2].candidate.id);
});

test('reserved batch checks remain intact', async t => {
  const running = await batchesFixture(t);
  await running.drain();
  const batch = JSON.parse([...running.tables.projectHostedLandingBatches.values()][0].value);
  assert.equal(batch.phase, 'checking');
  const before = [...running.tables.projectHostedCheckRuns.values()].map(r => r.value);
  assert.equal(
    await running.transaction(
      'keepRunningBatch',
      {
        _handler: ctx =>
          batchPriority.releaseUnstartedBatchForPriority(
            ctx,
            { projectId: running.projectId, batchId: batch.id },
            batch,
          ),
      },
      {},
    ),
    false,
  );
  assert.deepEqual(
    [...running.tables.projectHostedCheckRuns.values()].map(r => r.value),
    before,
  );
});

test('fallback urgency takes precedence over normal members and a suspect hint', async t => {
  const f = await batchesFixture(t, { count: 3 });
  await f.drain();
  await f.fail(f.runs()[0].id);
  for (
    let tick = 0;
    JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value).phase !== 'fallback';
    tick++
  ) {
    assert(tick < 100);
    await f.execute(f.pending()[0]);
  }
  const row = [...f.tables.projectHostedLandingBatches.values()][0],
    batch = JSON.parse(row.value),
    urgent = f.entries[2];
  f.patch('projectHostedLandingBatches', row._id, {
    value: JSON.stringify({ ...batch, failure: { ...batch.failure, suspects: [urgent.state.id] } }),
  });
  await prioritize(f, command(f, urgent.state.id));
  await f.drain();
  assert.equal(f.runs().length, 2, 'one failed shared check and one selected solo check');
  const files = JSON.parse(f.c.objects.get(f.runs()[1].request.expectedHead)).files;
  assert(
    files.some(file => file.path === 'member-2'),
    'owner urgency overrides a suspect hint',
  );
  assert(!files.some(file => file.path === 'member-0'));
});

test('fallback priority preserves a running normal check and selects urgent next', async t => {
  const f = await batchesFixture(t, { count: 3 });
  await f.drain();
  await f.fail(f.runs()[0].id, 'tests/unattributed.test.mjs');
  await f.drain();
  assert.equal(f.runs().length, 2);
  const running = await f.rawChecks.activate(f.runs()[1].id);
  await prioritize(f, command(f, f.entries[2].state.id));
  await f.drain();
  assert.equal(f.runs().length, 2, 'priority does not start another check beside the running fallback');
  assert.equal(f.runs()[1].status, 'running');
  assert.equal(f.runs()[1].cancelRequested, false);
  await f.rawChecks.pass(running);
  await f.drain();
  assert.equal(f.runs().length, 3);
  const files = JSON.parse(f.c.objects.get(f.runs()[2].request.expectedHead)).files;
  assert(files.some(file => file.path === 'member-2'));
  assert(!files.some(file => file.path === 'member-1'), 'urgent overtakes the remaining normal member');
});

test('fallback priority keeps an in-flight solo preparation and reads only its batch', async t => {
  const f = await batchesFixture(t, { count: 3 });
  await f.drain();
  await f.fail(f.runs()[0].id, 'tests/unattributed.test.mjs');
  for (
    let tick = 0;
    JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value).phase !== 'fallback';
    tick++
  ) {
    assert(tick < 100);
    await f.execute(f.pending()[0]);
  }
  await f.execute(
    f
      .pending()
      .find(
        task =>
          task.name === 'projectHostedFinishDriver:drive' &&
          task.args[0].submissionId === f.entries[0].state.id,
      ),
  );
  const finish = [...f.tables.projectHostedFinishes.values()].find(
    row => row.submissionId === f.entries[0].state.id,
  );
  assert(JSON.parse(finish.value).pending, 'normal solo preparation has already started');
  for (let i = 0; i < 575; i++)
    f.insert('projectHostedFinishes', {
      ...finish,
      _id: undefined,
      _creationTime: undefined,
      submissionId: randomUUID(),
      composeOperationId: null,
      wake: null,
      value: JSON.stringify({ ...JSON.parse(finish.value), pending: null }),
    });
  await prioritize(f, command(f, f.entries[2].state.id));
  const before = f.counts.length;
  await f.execute(
    f
      .pending()
      .find(
        task =>
          task.name === 'projectHostedFinishDriver:drive' &&
          task.args[0].submissionId === f.entries[2].state.id,
      ),
  );
  assert.equal(f.counts.length - before, 1);
  assert(f.counts.at(-1).documents <= 80, 'no unrelated finish history is loaded');
  t.diagnostic(
    JSON.stringify({ preparingFallbackDocuments: f.counts.at(-1).documents, calls: 1, history: 575 }),
  );
  await f.drain();
  assert.equal(f.runs().length, 2, 'the selected preparation keeps its one original check');
  await f.passChecks();
  await f.drain();
  const files = JSON.parse(f.c.objects.get(f.runs()[2].request.expectedHead)).files;
  assert(
    files.some(file => file.path === 'member-2'),
    'urgent runs after the selected preparation',
  );
});

for (const size of [575, 1150])
  test(`priority costs stay one write and constant selection reads at ${size} active entries`, async t => {
    const f = await landingFixture(),
      first = await f.enqueue();
    const original = [...f.tables.projectHostedLandingRequests.values()][0];
    for (let i = 1; i < size; i++) {
      const id = randomUUID(),
        sequence = i + 1;
      const actor = i === size - 1 ? 'other' : 'owner';
      f.insert('projectHostedLandingRequests', {
        ...original,
        _id: undefined,
        _creationTime: undefined,
        submissionId: id,
        actor,
        sequence,
        value: JSON.stringify({ ...first, id, actor, sequence }),
      });
    }
    for (let i = 0; i < 575; i++)
      f.insert('projectHostedLandingRequests', {
        ...original,
        _id: undefined,
        _creationTime: undefined,
        submissionId: randomUUID(),
        phase: 'landed',
        runnable: false,
        sequence: size + i,
      });
    f.decorateContext(ctx => {
      const query = ctx.db.query.bind(ctx.db);
      ctx.db.query = table => {
        const result = query(table);
        if (table === 'projectHostedLandingRequests')
          result.paginate = async () => {
            throw new Error('Queue ordering must not consume Convex built-in pagination slots.');
          };
        return result;
      };
    });
    const started = performance.now(),
      callsBefore = f.counts.length;
    const ordered = await f.transaction(
      'priorityScaleOrder',
      { _handler: ctx => order.activeLandingOrder(ctx, { projectId: f.projectId, channel: 'main' }) },
      {},
    );
    const reads = f.counts.at(-1);
    assert.equal(ordered.length, size);
    assert.equal(ordered[2].submitter, 'other', 'fairness finds the peer beyond the first metadata page');
    assert(reads.documents <= size + 3, 'no retained history or per-entry lookups');
    assert(reads.ranges <= Math.ceil(size / 50) + 3, 'bounded metadata pages');
    const retainedKeyBytes = Buffer.byteLength(JSON.stringify(ordered));
    assert(retainedKeyBytes <= size * 256, 'only compact ordering metadata retained');
    await prioritize(f, command(f, first.id));
    const change = f.counts.at(-1);
    assert.equal(change.writes, 1);
    assert(change.documents <= 4);
    const selected = await f.transaction(
      'priorityScaleNext',
      { _handler: ctx => order.nextLandingRow(ctx, { projectId: f.projectId, channel: 'main' }) },
      {},
    );
    assert.equal(selected.submissionId, first.id);
    assert(f.counts.at(-1).documents <= 3);
    assert.equal(f.counts.length - callsBefore, 3, 'one call per order read, priority change and selection');
    t.diagnostic(
      JSON.stringify({
        active: size,
        history: 575,
        calls: 3,
        orderDocuments: reads.documents,
        orderPages: reads.ranges,
        prioritiseDocuments: change.documents,
        prioritiseWrites: change.writes,
        retainedKeyBytes,
        wallMs: performance.now() - started,
        rssBytes: process.memoryUsage().rss,
        idleCalls: 0,
      }),
    );
  });

test('an urgent Candidate outside a composing normal batch gets its check first through the actual driver', async t => {
  const f = await batchesFixture(t, { count: 9 });
  await f.execute(f.pending().find(t => t.name === 'projectHostedLandingDriver:drive'));
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  const urgent = f.entries.find(e => !batch.members.some(m => m.submissionId === e.state.id));
  assert(urgent);
  await prioritize(f, command(f, urgent.state.id));
  await f.drain();
  assert.equal(f.runs()[0].request.candidateId, urgent.candidate.id);
  assert.equal(JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value).phase, 'superseded');
});

test('an unstarted urgent batch also takes precedence over an unstarted normal batch', async t => {
  const f = await batchesFixture(t, { count: 10 });
  await f.execute(f.pending().find(task => task.name === 'projectHostedLandingDriver:drive'));
  const normal = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  const urgent = f.entries.filter(entry => !normal.members.some(m => m.submissionId === entry.state.id));
  assert.equal(urgent.length, 2);
  for (const entry of urgent) await prioritize(f, command(f, entry.state.id));
  await f.execute(f.pending().find(task => task.name === 'projectHostedLandingDriver:drive'));
  const urgentBatch = [...f.tables.projectHostedLandingBatches.values()]
    .map(row => JSON.parse(row.value))
    .find(batch => batch.id !== normal.id);
  assert(urgentBatch);
  assert.equal(urgentBatch.phase, 'composing');
  for (const entry of urgent) {
    const row = [...f.tables.projectHostedLandingRequests.values()].find(
      r => r.submissionId === entry.state.id,
    );
    assert.equal(row.runnable, false);
  }
  const retained = [...f.tables.projectHostedLandingRequests.values()].find(row => row.priority === 'urgent');
  for (let i = 0; i < 575; i++)
    f.insert('projectHostedLandingRequests', {
      ...retained,
      _id: undefined,
      _creationTime: undefined,
      submissionId: randomUUID(),
      phase: 'landed',
      sequence: 11 + i,
    });
  const calls = f.counts.length;
  assert.equal(
    await f.transaction(
      'releaseNormalBeforeUrgentBatch',
      {
        _handler: ctx =>
          batchPriority.releaseUnstartedBatchForPriority(
            ctx,
            { projectId: f.projectId, batchId: normal.id },
            normal,
          ),
      },
      {},
    ),
    true,
  );
  assert.equal(f.counts.length - calls, 1);
  const released = f.counts.at(-1);
  assert(released.documents <= 64, 'fixed-size batch release excludes retained urgent history');
  t.diagnostic(
    JSON.stringify({
      batchReleaseDocuments: released.documents,
      batchReleaseWrites: released.writes,
      history: 575,
      calls: 1,
    }),
  );
  await f.drain();
  const checkedUrgent = [...f.tables.projectHostedLandingBatches.values()]
    .map(row => JSON.parse(row.value))
    .find(batch => batch.id === urgentBatch.id);
  assert.equal(f.runs()[0].id, checkedUrgent.runId);
});

test('released strict wait and stack readers retain legacy shapes; priority readers opt in', async () => {
  const f = await landingFixture(),
    submitted = await f.enqueue(f.request({ priority: 'urgent' }));
  const legacySchema = hostedLandingStateSchema
    .omit({ priority: true, priorityReason: true, priorityVersion: true })
    .extend({ request: hostedLandingRequestSchema.omit({ priority: true }) })
    .strict();
  const args = { projectId: f.projectId, submissionId: submitted.id };
  const legacy = JSON.parse(await f.transaction('legacyQueueStatus', landingApi.status, args));
  assert(legacySchema.safeParse(legacy.request).success);
  assert.equal(legacy.request.priority, undefined);
  assert.equal(legacy.request.request.priority, undefined);
  const current = JSON.parse(
    await f.transaction('priorityQueueStatus', landingApi.status, { ...args, priorityInfo: 1 }),
  );
  assert.equal(current.request.priority, 'urgent');
  const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
  const pageArgs = { projectId: f.projectId, operationId: submitted.operationId, nextVersion: 0 };
  const page = JSON.parse(await f.transaction('legacyQueueObserve', observe.page, pageArgs));
  assert(legacySchema.safeParse(page.submission).success);
  assert(page.events.every(event => legacySchema.safeParse(event.submission).success));
  const opt = JSON.parse(
    await f.transaction('priorityQueueObserve', observe.page, { ...pageArgs, priorityInfo: 1 }),
  );
  assert.equal(opt.submission.priority, 'urgent');
});
