// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic, batchStore } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedFinishBackoff } from '../dist/hosted-finish.js';
const wake = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
// These are handoff replays, not a claim that the incident's long-running
// provider action has been reproduced or bounded by the finish scheduler.
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(r => JSON.parse(r.value));
const finish = (f, id) => [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === id);
const tx = (f, name, fn) => f.transaction(name, { _handler: fn }, {});
// Convex lets a canceled running action continue, but cancels its newly
// scheduled descendants. A fake that only marks the old timer misses this loss.
function causalCancellation(f) {
  const parents = new Map(),
    canceled = new Set();
  let parent = null;
  const retired = id => !!id && (canceled.has(id) || retired(parents.get(id)));
  f.extendContext(ctx => {
    const scheduler = ctx.scheduler;
    ctx.scheduler = {
      ...scheduler,
      cancel: async id => {
        if (f.tables._scheduled_functions.get(id)?.state.kind === 'inProgress') canceled.add(id);
        return scheduler.cancel(id);
      },
      runAfter: async (...args) => {
        const id = await scheduler.runAfter(...args);
        parents.set(id, parent);
        if (retired(parent)) await ctx.db.patch(id, { state: { kind: 'canceled' } });
        return id;
      },
    };
  });
  const execute = f.execute;
  f.execute = async (...args) => {
    const previous = parent;
    parent = args[0]._id;
    try {
      return await execute(...args);
    } finally {
      parent = previous;
    }
  };
}
async function sourcePending(f) {
  for (let n = 0; n < 100; n++) {
    if (f.pending().some(t => t.name === 'projectConvexSource:step')) return batches(f)[0];
    await f.execute(f.pending()[0]);
  }
  assert.fail('the shared compose owns a source step');
}
test('c01d5457: a retry replaces the retired compose timer with an immediate finish owner', async t => {
  const f = await batchesFixture(t, { count: 2 });
  const batch = await sourcePending(f);
  const old = finish(f, batch.leaderId).wake;
  const key = { projectId: f.projectId, batchId: batch.id };
  await tx(f, 'retry-cohort', ctx => batchStore.retryLandingBatch(ctx, key, batch));
  const next = finish(f, batch.leaderId).wake;
  t.diagnostic(
    JSON.stringify({
      oldDelay: old.at - Date.now(),
      nextDelay: next.at - Date.now(),
      sameTask: old.taskId === next.taskId,
    }),
  );
  assert(next.at <= Date.now(), 'a new compose generation is runnable now, not at its retired watchdog');
  assert.notEqual(next.taskId, old.taskId);
  const retried = batches(f)[0];
  assert.notEqual(retried.composeOperationId, batch.composeOperationId);
  for (let duplicate = 0; duplicate < 2; duplicate++)
    await tx(f, 'late-retired-generation', ctx =>
      wake.notifyFinishCompose(ctx, f.projectId, batch.composeOperationId),
    );
  assert.deepEqual(finish(f, batch.leaderId).wake, next);
  await settle(f);
  assert.equal(f.runs().length, 1, 'a retired source completion cannot reserve a second check');
});

test('c01d5457: a retired split callback cannot steal its successor finish wake', async t => {
  const f = await batchesFixture(t, { count: 4 });
  const batch = await sourcePending(f);
  const split = await import(moduleUrl('../convex/projectHostedLandingBatchSplit.ts'));
  const key = { projectId: f.projectId, batchId: batch.id };
  await tx(f, 'split-cohort', ctx => split.splitLandingBatch(ctx, key, batch));
  const children = batches(f).filter(b => b.parentId === batch.id);
  assert.equal(children.length, 2);
  for (const child of children) assert(finish(f, child.leaderId).wake.at <= Date.now());
  const before = finish(f, batch.leaderId).wake;
  await tx(f, 'late-retired-compose', ctx =>
    wake.notifyFinishCompose(ctx, f.projectId, batch.composeOperationId),
  );
  assert.deepEqual(
    finish(f, batch.leaderId).wake,
    before,
    'the retired compose cannot replace its child owner',
  );
});

test('c01d5457: a singleton split replaces its compose watch with the solo generation backoff', async t => {
  const f = await batchesFixture(t, { count: 1, batchMaxSize: 1 });
  await f.drain();
  await f.add(1);
  const batch = await sourcePending(f);
  assert.equal(batch.members.length, 1);
  const old = finish(f, batch.leaderId).wake;
  const split = await import(moduleUrl('../convex/projectHostedLandingBatchSplit.ts'));
  await tx(f, 'split-singleton', ctx =>
    split.splitLandingBatch(ctx, { projectId: f.projectId, batchId: batch.id }, batch),
  );
  const current = finish(f, batch.leaderId),
    pending = JSON.parse(current.value).pending;
  assert(pending, 'the singleton owns an exact solo source generation');
  assert.equal(current.wake.at, Date.now() + hostedFinishBackoff(pending.number));
  assert.notEqual(current.wake.taskId, old.taskId);
  assert.equal(f.tables._scheduled_functions.get(old.taskId).state.kind, 'canceled');
  await tx(f, 'late-singleton-compose', ctx =>
    wake.notifyFinishCompose(ctx, f.projectId, batch.composeOperationId),
  );
  assert.deepEqual(finish(f, batch.leaderId).wake, current.wake);
  await settle(f);
});

async function drainEvents(f) {
  const end = Date.now() + 10000;
  for (let n = 0; n < 300; n++) {
    const task = f
      .pending()
      .find(t => t.scheduledTime < end && !/LandingStall|CheckLease:expire/.test(t.name));
    if (!task) return;
    await f.execute(task);
  }
  assert.fail('event-driven work settles within its finite source/check steps');
}
async function settle(f) {
  for (let n = 0; n < 12; n++) {
    await drainEvents(f);
    const runs = f.runs().filter(r => r.status === 'queued');
    if (!runs.length) break;
    for (const run of runs) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  }
  await drainEvents(f);
  assert(
    states(f).every(s => s.phase === 'landed'),
    JSON.stringify(states(f)),
  );
  assert(states(f).every(s => !s.observation.stall));
  assert.equal(f.metrics.stallDeliveries.length, 0);
  assert.equal(f.pending().length, 0, 'terminal work owns no idle timer');
}
for (const count of [2, 8])
  test(`incident c01d5457: failed shared compose splits ${count} saved Lanes without a watchdog or changed member pins`, async t => {
    const f = await batchesFixture(t, { count, fileCount: count === 8 ? 4000 : 3 });
    causalCancellation(f);
    const batch = await sourcePending(f);
    const pins = await Promise.all(
      f.entries.map(async e => ({
        operationId: e.request.operationId,
        head: (await f.readLane(e.lane.laneId)).head,
        candidateId: e.candidate.id,
      })),
    );
    const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
    const composeJobs = await import(moduleUrl('../convex/projectHostedComposeJobs.ts'));
    const composeStore = await import(moduleUrl('../convex/projectHostedComposeStore.ts'));
    const auth = {
      projectId: f.projectId,
      actor: batch.members[0].actor.id,
      operationId: batch.composeOperationId,
    };
    const source = await tx(f, 'read-cohort-compose', ctx => composeStore.loadCompose(ctx, auth, false));
    // The worker completion is a later event, so solo fallback needs a fresh plan.
    f.advanceClock(1);
    // The source worker reports a deterministic failed composition; no test ran.
    await tx(f, 'fail-cohort-source', async ctx => {
      const job = await jobs.loadSourceJob(ctx, f.projectId, source.row.jobId);
      await jobs.saveSourceJob(
        ctx,
        f.projectId,
        job,
        {
          ...job,
          status: 'failed',
          control: {
            ...job.control,
            failureCode: 'SOURCE_UNAVAILABLE',
            failureReason: 'Synthetic shared composition failure.',
          },
        },
        Date.now(),
      );
    });
    await f.transaction('publish-cohort-failure', composeJobs.resultDownload, {
      projectId: f.projectId,
      jobId: source.row.jobId,
    });
    await drainEvents(f);
    assert.equal(batches(f).find(b => b.id === batch.id).phase, 'split');
    const before = [...f.tables.projectHostedFinishes.values()].map(r => ({
      id: r.submissionId,
      wake: r.wake,
    }));
    const mark = f.counts.length;
    for (let duplicate = 0; duplicate < 2; duplicate++)
      await tx(f, 'late-split-compose-callback', ctx =>
        wake.notifyFinishCompose(ctx, f.projectId, batch.composeOperationId),
      );
    assert.deepEqual(
      [...f.tables.projectHostedFinishes.values()].map(r => ({ id: r.submissionId, wake: r.wake })),
      before,
    );
    assert.equal(
      f.counts.slice(mark).reduce((n, c) => n + c.writes, 0),
      0,
      'late/duplicate retired callbacks perform no writes',
    );
    await settle(f);
    for (let i = 0; i < count; i++) {
      const current = states(f).find(s => s.id === f.entries[i].state.id);
      assert.equal(current.operationId, pins[i].operationId);
      assert.equal((await f.readLane(f.entries[i].lane.laneId)).head, pins[i].head);
      const receipt = [...f.tables.projectHostedAcceptances.values()]
        .map(r => JSON.parse(r.value))
        .find(r => r.submissionId === current.id);
      assert(receipt?.check?.runId, 'every accepted member retains an exact passed run');
      const run = f.runs().find(r => r.id === receipt.check.runId);
      assert.equal(run.status, 'passed');
      assert.equal(run.request.expectedHead, receipt.candidate.head);
    }
    const counts = f.counts;
    const cost = {
      count,
      transactions: counts.length,
      readBytes: counts.reduce((n, c) => n + c.readBytes, 0),
      writeBytes: counts.reduce((n, c) => n + c.writeBytes, 0),
      sourceCalls: f.metrics.convexSourceCalls.length,
      legacyStorageCalls: f.metrics.convexStorageCalls,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
    assert(
      cost.transactions < 400 && cost.readBytes + cost.writeBytes < 20 * 1024 * 1024,
      JSON.stringify(cost),
    );
    assert.equal(cost.legacyStorageCalls, 0, 'source bytes stay in R2');
    assert(cost.peakRssBytes < 768 * 1024 * 1024, JSON.stringify(cost));
    t.diagnostic(JSON.stringify(cost));
  });
