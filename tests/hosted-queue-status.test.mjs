// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture, store } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedLandingStall } from '../dist/hosted-landing-stall.js';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';
import { queueStatusPage, rankQueueStatus } from '../dist/hosted-queue-status.js';
const projection = await import(moduleUrl('../convex/projectHostedQueueStatus.ts'));
const alarms = await import(moduleUrl('../convex/projectHostedLandingStall.ts'));
const writer = await import(moduleUrl('../convex/projectHostedQueueStatusWrite.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const { finishFixture } = await import('./hosted-finish-fixture.mjs');
const { synthetic } = await import('./hosted-landing-batches-fixture.mjs');
const rowOf = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === id);
const setState = async (f, state) =>
  f.transaction(
    'queue-progress',
    { _handler: async ctx => store.writeLanding(ctx, rowOf(f, state.id), state, false) },
    {},
  );

test('queued receipts name exact position, entries ahead, live predecessor and a group-aware ETA', async () => {
  const f = await landingFixture();
  const a = await f.enqueue(),
    b = await f.enqueue(),
    c = await f.enqueue();
  const at = new Date().toISOString(),
    batchId = randomUUID();
  await setState(f, {
    ...a,
    version: a.version + 1,
    phase: 'checking',
    batchId,
    timing: { ...a.timing, selectedAt: at, checkReservedAt: at },
    observation: { state: 'pending', pendingReason: 'checking', cause: null },
  });
  await setState(f, {
    ...b,
    version: b.version + 1,
    phase: 'checking',
    batchId,
    timing: { ...b.timing, selectedAt: at, checkReservedAt: at },
    observation: { state: 'pending', pendingReason: 'checking', cause: null },
  });
  const scheduled = f.metrics.scheduled;
  const status = await f.status(c.id);
  assert.equal(status.queuePosition, 3);
  assert.equal(status.queue.total, 3);
  assert.equal(status.queue.entriesAhead, 2);
  assert.equal(status.queue.groupsAhead, 1, 'two members of one shared check cost one service group');
  assert.equal(status.queue.groupCount, 2);
  assert.equal(status.queue.predecessor.id, a.id);
  assert.equal(status.queue.predecessor.phase, 'checking');
  assert.match(status.queue.message, /Queued, position 3 of 3/);
  assert(status.queue.eta.milliseconds > 0 && status.queue.eta.milliseconds <= 180_000);
  const wouldConflict = {
    paths: ['synthetic.ts'],
    more: 0,
    landedSubmissionId: randomUUID(),
    at,
    next: 'sync-and-land',
  };
  f.patch('projectHostedLandingRequests', rowOf(f, c.id)._id, {
    wouldConflict: JSON.stringify(wouldConflict),
  });
  const observed = JSON.parse(
    await f.call('statusObserve', observe.page, {
      projectId: f.projectId,
      operationId: c.operationId,
      nextVersion: 0,
    }),
  );
  assert.equal(observed.queue.position, 3);
  assert.deepEqual(observed.wouldConflict, wouldConflict);
  assert.equal(f.metrics.scheduled, scheduled, 'reads do not schedule work');
});

test('selected finish status includes the current queue receipt', async t => {
  for (const [key, value] of Object.entries(synthetic)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  const read = await f.current(state.id);
  assert.equal(read.submission.id, state.id);
  assert.equal(read.queuePosition, 1);
  assert.equal(read.queue.position, 1);
  assert.equal(read.queue.entriesAhead, 0);
});

test('six parallel checking groups contribute one service wave to queued ETA', async () => {
  const f = await landingFixture();
  const entries = [];
  for (let n = 0; n < 7; n++) entries.push(await f.enqueue());
  const at = new Date().toISOString();
  for (const state of entries.slice(0, 6)) {
    await setState(f, {
      ...state,
      phase: 'checking',
      batchId: randomUUID(),
      version: state.version + 1,
      timing: { ...state.timing, selectedAt: at },
      observation: { state: 'pending', pendingReason: 'checking', cause: null },
    });
  }
  const status = await f.status(entries.at(-1).id);
  assert.equal(status.queue.groupsAhead, 6);
  assert.equal(status.queue.parallelGroups, 6);
  assert(status.queue.eta.milliseconds > 0 && status.queue.eta.milliseconds <= 180_000);
});

test('moving train progress suppresses the follower alarm and retracts a retained false alarm', async () => {
  const f = await landingFixture();
  const a = await f.enqueue(),
    b = await f.enqueue();
  const old = new Date(Date.now() - 3 * LANDING_STALL_MS).toISOString();
  const fresh = new Date().toISOString();
  const head = {
    ...a,
    phase: 'checking',
    version: a.version + 1,
    timing: { submittedAt: a.at, selectedAt: fresh, ciProgressAt: fresh },
    observation: { state: 'pending', pendingReason: 'checking', cause: null },
  };
  await setState(f, head);
  const queued = { ...b, at: old, timing: { submittedAt: old }, observation: { ...b.observation } };
  const oldRow = rowOf(f, b.id);
  f.patch('projectHostedLandingRequests', oldRow._id, {
    value: JSON.stringify(queued),
    alarm: { taskId: [...f.tables._scheduled_functions.values()][0]._id, lastProgressAt: old },
  });
  assert(hostedLandingStall(queued), 'incident: entry age alone used to raise the alarm');
  const status = await f.status(b.id);
  assert.equal(hostedLandingStall(queued, Date.now(), status.queue), undefined);
  await f.run('movingTrainAlarm', (ctx, input) => alarms.raiseLandingAlarm(ctx, input), {
    projectId: f.projectId,
    submissionId: b.id,
    lastProgressAt: old,
  });
  assert.equal(JSON.parse(rowOf(f, b.id).value).observation.stall, undefined);
  assert.equal(
    f.pendingTasks().filter(task => task.name === 'projectHostedLandingStall:deadline').length,
    1,
    'existing orphan-recovery deadline remains without a false alarm',
  );
  const stalled = { ...queued, observation: { ...queued.observation, stall: hostedLandingStall(queued) } };
  f.patch('projectHostedLandingRequests', oldRow._id, { value: JSON.stringify(stalled) });
  assert.equal(
    (await f.status(b.id)).request.observation.stall,
    undefined,
    'old false alarms are not returned again',
  );
});

test('genuinely ownerless queued work alarms with the predecessor identity it waits behind', async () => {
  const f = await landingFixture();
  const a = await f.enqueue(),
    b = await f.enqueue();
  const old = new Date(Date.now() - 2 * LANDING_STALL_MS).toISOString();
  for (const state of [a, b]) {
    const queued = { ...state, at: old, timing: { submittedAt: old } };
    f.patch('projectHostedLandingRequests', rowOf(f, state.id)._id, { value: JSON.stringify(queued) });
  }
  f.patch('projectHostedLandingQueues', f.queue()._id, {
    status: { ...f.queue().status, lastProgressAt: old },
    wake: null,
    lease: null,
  });
  const row = rowOf(f, b.id);
  f.patch('projectHostedLandingRequests', row._id, {
    alarm: { taskId: [...f.tables._scheduled_functions.values()][0]._id, lastProgressAt: old },
  });
  await f.run('ownerlessAlarm', (ctx, input) => alarms.raiseLandingAlarm(ctx, input), {
    projectId: f.projectId,
    submissionId: b.id,
    lastProgressAt: old,
  });
  const stalled = JSON.parse(rowOf(f, b.id).value).observation.stall;
  assert.equal(stalled.code, 'LANDING_STALLED');
  assert.match(stalled.missingOwner, new RegExp(a.id));
});

test('legacy directory initialization uses current row priority and preserves orphan recovery without a live owner', async () => {
  const f = await landingFixture();
  const a = await f.enqueue(),
    b = await f.enqueue(),
    c = await f.enqueue();
  f.patch('projectHostedLandingRequests', rowOf(f, b.id)._id, { priority: 'urgent' });
  f.tables.projectHostedLandingQueueStatus.clear();
  f.patch('projectHostedLandingQueues', f.queue()._id, { status: undefined });
  await setState(f, {
    ...c,
    version: c.version + 1,
    phase: 'terminal-failed',
    observation: { state: 'terminal-failed', pendingReason: null, cause: 'conflict' },
  });
  assert.equal((await f.status(b.id)).queue.position, 1);
  assert.equal((await f.status(a.id)).queue.position, 2);
  const old = new Date(Date.now() - 2 * LANDING_STALL_MS).toISOString();
  const row = rowOf(f, a.id);
  const queued = { ...a, at: old, timing: { submittedAt: old } };
  f.patch('projectHostedLandingRequests', row._id, {
    value: JSON.stringify(queued),
    alarm: { taskId: [...f.tables._scheduled_functions.values()][0]._id, lastProgressAt: old },
  });
  f.patch('projectHostedLandingQueues', f.queue()._id, {
    wake: null,
    lease: null,
    status: { ...f.queue().status, lastProgressAt: new Date().toISOString() },
  });
  // Remove any predecessor owner too. Recent train progress postpones the alarm,
  // while the existing deadline still reconciles an unowned entry.
  f.patch('projectHostedLandingRequests', rowOf(f, b.id)._id, {
    value: JSON.stringify({ ...b, at: old, timing: { submittedAt: old } }),
  });
  await f.run('recentOwnerlessAlarm', (ctx, input) => alarms.raiseLandingAlarm(ctx, input), {
    projectId: f.projectId,
    submissionId: a.id,
    lastProgressAt: old,
  });
  assert.equal(JSON.parse(rowOf(f, a.id).value).observation.stall, undefined);
  assert.equal(f.pendingTasks().filter(task => task.name === 'projectHostedLandingStall:deadline').length, 1);
});

async function syntheticQueue(size) {
  const f = await landingFixture();
  const first = await f.enqueue();
  const template = rowOf(f, first.id);
  f.tables.projectHostedLandingQueueStatus.clear();
  const keys = [];
  let last;
  for (let index = 0; index < size; index++) {
    const id = index ? randomUUID() : first.id;
    const state = { ...first, id, sequence: index + 1 };
    if (index)
      f.insert('projectHostedLandingRequests', {
        ...Object.fromEntries(Object.entries(template).filter(([key]) => !key.startsWith('_'))),
        submissionId: id,
        sequence: index + 1,
        value: JSON.stringify(state),
      });
    keys.push({ id, sequence: index + 1, actor: 'owner', priority: 'normal', phase: 'queued' });
    last = state;
  }
  const ranked = rankQueueStatus(keys),
    pages = new Map();
  for (const key of ranked.order) {
    const page = queueStatusPage(key.sequence);
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(key);
  }
  for (const [page, entries] of pages)
    f.insert('projectHostedLandingQueueStatus', {
      projectId: f.projectId,
      page,
      value: JSON.stringify(entries),
    });
  f.patch('projectHostedLandingQueues', f.queue()._id, {
    status: {
      total: size,
      groups: size,
      horizon: keys.slice(0, 8).map(key => key.id),
      lastProgressAt: first.at,
    },
  });
  return { f, first, last, pages };
}

test('10/575/1150-entry queues use constant status reads, bounded projection pages and zero idle or source work', async t => {
  const costs = [];
  for (const size of [10, 575, 1150]) {
    const { f, first, last, pages } = await syntheticQueue(size);
    const scheduled = f.metrics.scheduled;
    const started = performance.now();
    const status = await f.status(last.id);
    const durationMs = performance.now() - started;
    assert.equal(status.queue.position, size);
    assert.equal(status.queue.entriesAhead, size - 1);
    const reads = f.counts.at(-1);
    assert.equal(reads.writes, 0);
    assert(reads.documents <= 40);
    assert(!reads.touched.includes('projectWorkRecords'));
    assert(!reads.touched.includes('projectObjects'));
    assert.equal(f.metrics.scheduled, scheduled);
    const bytes = [...pages.values()].reduce(
      (sum, entries) => sum + Buffer.byteLength(JSON.stringify(entries)),
      0,
    );
    assert([...pages.values()].every(entries => entries.length <= 128));
    costs.push({
      size,
      documents: reads.documents,
      ranges: reads.ranges,
      readBytes: reads.readBytes,
      pages: pages.size,
      compactBytes: bytes,
      durationMs,
      rssBytes: process.memoryUsage().rss,
    });
    const head = {
      ...first,
      version: 1,
      phase: 'landed',
      observation: { state: 'landed', pendingReason: null, cause: null },
    };
    await f.transaction(
      'queueProjectionUpdate',
      { _handler: ctx => projection.retainQueueStatus(ctx, head) },
      {},
    );
    const update = f.counts.at(-1);
    assert(update.documents <= pages.size + 2);
    assert(update.writes <= pages.size + 1);
    assert.equal((await f.status(last.id)).queue.position, size - 1);
    costs.at(-1).update = { documents: update.documents, writes: update.writes };
    const batchId = randomUUID();
    const members = [...f.tables.projectHostedLandingRequests.values()]
      .filter(row => row.submissionId !== first.id)
      .slice(0, 8)
      .map(row => JSON.parse(row.value));
    await f.transaction(
      'queueProjectionBatch',
      {
        _handler: ctx =>
          writer.withQueueStatusBatch(ctx, async () => {
            for (const member of members)
              await projection.retainQueueStatus(ctx, { ...member, batchId, phase: 'checking' });
          }),
      },
      {},
    );
    const batch = f.counts.at(-1);
    assert(batch.documents <= pages.size + 2, 'eight members reuse one invocation-local directory');
    assert(batch.writes <= pages.size + 1, 'bulk member events flush each page and summary once');
    costs.at(-1).batch = { members: members.length, documents: batch.documents, writes: batch.writes };
  }
  assert.equal(costs[1].documents, costs[2].documents);
  assert.equal(costs[1].ranges, costs[2].ranges);
  t.diagnostic(JSON.stringify(costs));
});
