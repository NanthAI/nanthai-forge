// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { landingBodyCounts } from './observer-projection-budget.mjs';
import { seedTicket } from './landing-ticket-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture, wake, store } from './hosted-landing-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function drainActive(f) {
  for (let steps = 0; ; steps++) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:'));
    if (!task) return;
    assert(steps < 1000, 'finite event-driven delivery');
    await f.execute(task);
  }
}

for (const admissionCheck of [false, true]) {
  test(`nonterminal progress keeps ${admissionCheck ? 'admission' : 'deferred solo'} completion owned without idle work`, async t => {
    const f = await batchesFixture(t, { count: 1, admissionCheck, batchMaxSize: null });
    await drainActive(f);
    const run = await f.rawChecks.activate(f.runs()[0].id);
    await drainActive(f);
    const event = f.rawChecks.shard(run, 0);
    await f.rawChecks.callback(event);
    await drainActive(f);
    assert.equal(states(f)[0].phase, 'checking');
    const calls = f.counts.length;
    await drainActive(f);
    assert.equal(f.counts.length, calls, 'idle makes zero Convex calls');
    await f.rawChecks.callback(event);
    await drainActive(f);
    await f.rawChecks.pass(run);
    await drainActive(f);
    assert.equal(states(f)[0].phase, 'landed');
    assert.equal(f.runs().length, 1);
    assert.equal(f.pending().length, 0);
  });
}

test('FAILED singleton after progress retires shared generation and delivers canonical failure', async t => {
  const f = await batchesFixture(t, { count: 4, batching: 'default', batchMaxSize: null });
  await drainActive(f);
  assert.equal(f.runs().length, 2);
  const active = [];
  for (const run of f.runs()) {
    active.push(await f.rawChecks.activate(run.id));
    await drainActive(f);
    await f.rawChecks.callback(f.rawChecks.shard(active.at(-1), 0));
    await drainActive(f);
  }
  const singleton = [...f.tables.projectHostedLandingBatches.values()]
    .map(row => JSON.parse(row.value))
    .find(batch => batch.members.length === 1);
  assert(singleton?.predecessor);
  const member = singleton.members[0].submissionId;
  const run = active.find(run => run.id === singleton.runId);
  assert(run);
  await f.rawChecks.callback(f.rawChecks.shard(run, 1, 'failed'));
  await drainActive(f);
  assert.equal(states(f).find(state => state.id === member).phase, 'checking');
  const terminal = f.rawChecks.complete(run, 'failed', {
    contractReports: { 'tests/member-3.test.mjs': { failed: true, durationMs: 1 } },
  });
  await f.rawChecks.callback(terminal);
  await drainActive(f);
  const retired = JSON.parse(
    [...f.tables.projectHostedLandingBatches.values()].find(row => row.batchId === singleton.id).value,
  );
  // FAILED is consumed instead of stranded. Its own changes explain no failing
  // file and its predecessor has not passed, so the singleton recomposes once on
  // main without it (51bbbd00 unstack) rather than splitting into a solo that
  // costs the same one recheck.
  assert.equal(
    retired.transition?.code,
    'STACKED_FAILURE_UNSTACKED',
    'FAILED is consumed instead of stranded',
  );
  assert.notEqual(retired.runId, run.id, 'the failed shared run is retired');
  assert.equal(retired.predecessor, undefined, 'recomposed on main, not on the unpassed predecessor');
  await f.rawChecks.pass(active.find(current => current.id !== run.id));
  await drainActive(f);
  for (
    let wave = 0;
    states(f).some(state => state.phase !== 'landed' && state.phase !== 'terminal-failed');
    wave++
  ) {
    assert(wave < 10);
    const pending = f.runs().filter(run => run.status === 'queued');
    assert(pending.length);
    for (const queued of pending) {
      const current = await f.rawChecks.activate(queued.id);
      await drainActive(f);
      await f.rawChecks.callback(f.rawChecks.shard(current, 0));
      await drainActive(f);
      await f.rawChecks.callback(
        f.rawChecks.complete(current, 'failed', {
          contractReports: { 'tests/member-3.test.mjs': { failed: true, durationMs: 1 } },
        }),
      );
    }
    await drainActive(f);
  }
  const failed = states(f).find(state => state.id === member);
  assert.equal(failed.phase, 'terminal-failed');
  assert.equal(failed.error.code, 'CHECK_FAILED');
  assert.match(failed.error.message, /tests\/member-3.test.mjs/);
  assert.equal(states(f).filter(state => state.phase === 'landed').length, 3);
  assert.equal(f.pending().length, 0);
  const before = states(f).map(state => state.version);
  await f.rawChecks.callback(terminal);
  await drainActive(f);
  assert.deepEqual(
    states(f).map(state => state.version),
    before,
  );
  assert.equal(f.pending().length, 0);
});

test('a queued bound generation is still woken, and rebinding fences its old events', async () => {
  const f = await landingFixture();
  const run = await f.rawChecks.enqueue(f.rawChecks.selection());
  const state = await f.enqueue(f.request({ check: { kind: 'run', runId: run.id } }));
  await f.drain();
  const active = await f.rawChecks.activate(run.id);
  await f.drain();
  // Exercise a queued projection independently of the checking evaluator.
  const original = [...f.tables.projectHostedLandingRequests.values()][0];
  await f.run(
    'queueBoundRun',
    async ctx => {
      const { row, state } = await store.loadLanding(ctx, {
        projectId: f.projectId,
        submissionId: original.submissionId,
      });
      await store.writeLanding(ctx, row, { ...state, phase: 'queued', version: state.version + 1 }, false);
    },
    {},
  );
  await f.rawChecks.callback(f.rawChecks.shard(active, 0));
  await f.drain();
  assert.equal((await f.status(state.id)).request.phase, 'checking');
  const oldTask = [...f.tables._scheduled_functions.values()].find(task => task.name.endsWith(':checkWake'));
  const next = await f.rawChecks.enqueue(f.rawChecks.selection({ operationId: randomUUID() }));
  await f.run(
    'replaceBoundRun',
    async ctx => {
      const { row, state } = await store.loadLanding(ctx, {
        projectId: f.projectId,
        submissionId: original.submissionId,
      });
      const attempt = await store.loadLandingAttempt(ctx, {
        projectId: f.projectId,
        attemptId: state.attemptId,
      });
      const child = {
        ...attempt,
        id: randomUUID(),
        parentAttemptId: attempt.id,
        number: attempt.number + 1,
        check: { ...attempt.check, runId: next.id },
      };
      await store.insertLandingAttempt(ctx, child);
      await store.writeLanding(
        ctx,
        row,
        { ...state, phase: 'queued', attemptId: child.id, version: state.version + 1 },
        false,
      );
    },
    {},
  );
  assert.equal([...f.tables.projectHostedLandingRequests.values()][0].checkWakeVersion, undefined);
  const before = canonicalPayload([...f.tables.projectHostedLandingRequests.values()]);
  await assert.rejects(f.rawChecks.pass(active), error => error.data?.code === 'CHECK_CANCELLED');
  await f.run('lateOldWake', wake.wakeLandingCheck, oldTask.args[0]);
  assert.equal(canonicalPayload([...f.tables.projectHostedLandingRequests.values()]), before);
  assert.equal(f.pendingTasks().length, 0, 'old run and task cannot revive a replaced generation');
  const current = await f.rawChecks.activate(next.id);
  for (let index = 0; index < current.plan.shardCount; index++)
    await f.rawChecks.callback(f.rawChecks.shard(current, index));
  const terminal = f.rawChecks.complete(current);
  await f.rawChecks.callback(terminal);
  await f.drain();
  assert.equal((await f.status(state.id)).request.phase, 'ready');
  await f.rawChecks.callback(terminal);
  assert.equal(f.pendingTasks().length, 0, 'duplicate terminal event schedules nothing');
});

test('575 queued bindings consume progress and terminal events in bounded pages, including an event between pages', async t => {
  const f = await landingFixture();
  const run = await f.rawChecks.enqueue(f.rawChecks.selection());
  await f.enqueue(f.request({ check: { kind: 'run', runId: run.id } }));
  await f.drain();
  const template = [...f.tables.projectHostedLandingRequests.values()][0];
  // Only fanout is measured here: real queue/check reducers are exercised above
  // and by the pipelined publication tests. Retained history shares the run but
  // is excluded by the index, rather than read and filtered by the handler.
  for (let index = 0; index < 575; index++) {
    const value = { ...JSON.parse(template.value), phase: 'queued' };
    const row = { ...template, phase: 'queued', runnable: false, value: canonicalPayload(value) };
    delete row._id;
    delete row._creationTime;
    if (index === 0) f.patch('projectHostedLandingRequests', template._id, row);
    else seedTicket(f, { ...row, submissionId: randomUUID(), sequence: index + 1 });
  }
  for (let index = 0; index < 575; index++) {
    const row = { ...template, phase: 'landed', submissionId: randomUUID(), sequence: 576 + index };
    delete row._id;
    delete row._creationTime;
    seedTicket(f, row);
  }
  const active = await f.rawChecks.activate(run.id);
  const live = () =>
    [...f.tables.projectHostedLandingRequests.values()].filter(row => row.phase === 'queued');
  const fanout = () => f.pendingTasks().find(task => task.name.endsWith(':checkWake'));
  const costs = [];
  const consume = async (label, before = f.counts.length) => {
    const start = performance.now();
    let pages = 0;
    while (fanout()) {
      assert(++pages <= 40, 'finite waiter pages');
      await f.execute(fanout());
    }
    const counts = f.counts.slice(before);
    const result = {
      label,
      calls: counts.length,
      fanoutCalls: counts.filter(count => count.name === 'landingCheckWake').length,
      pages,
      reads: counts.reduce((n, count) => n + count.documents - landingBodyCounts(count).reads, 0),
      writes: counts.reduce((n, count) => n + count.writes - landingBodyCounts(count).writes, 0),
      maxReads: Math.max(...counts.map(count => count.documents - landingBodyCounts(count).reads)),
      wallMs: performance.now() - start,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
    assert(result.maxReads <= 110, JSON.stringify(result));
    assert(result.reads <= 900 && result.writes <= 750, JSON.stringify(result));
    assert(
      counts.every(count => !count.touched.includes('projectHostedLandingAttempts')),
      'no attempt/history hydration',
    );
    costs.push(result);
  };
  await consume('activation-fanout');
  assert(live().every(row => row.checkWakeVersion > 0));
  const progressStart = f.counts.length;
  await f.rawChecks.callback(f.rawChecks.shard(active, 0));
  await consume('shard-progress-event', progressStart);
  const delivered = live()[0].checkWakeVersion;
  await f.rawChecks.callback(f.rawChecks.shard(active, 1));
  await f.execute(fanout()); // progress delivered to only the first page
  const early = live()
    .filter(row => row.checkWakeVersion > delivered)
    .map(row => row._id);
  assert(early.length > 0 && early.length <= 100);
  // A terminal event coalesces into the continuation, and must revisit early.
  const terminalStart = f.counts.length;
  await f.rawChecks.callback(f.rawChecks.complete(active));
  await consume('terminal-event-during-progress', terminalStart);
  const version = [...f.tables.projectHostedLandingCheckWakes.values()][0].version;
  assert(live().every(row => row.checkWakeVersion === version));
  assert(early.every(id => f.tables.projectHostedLandingRequests.get(id).checkWakeVersion === version));
  const scheduled = f.metrics.scheduled;
  const calls = f.counts.length;
  assert.equal(fanout(), undefined);
  assert.equal(f.counts.length, calls, 'idle performs no calls');
  assert.equal(f.metrics.scheduled, scheduled, 'no periodic timer');
  t.diagnostic(JSON.stringify({ waiters: 575, retained: 575, costs }));
});
