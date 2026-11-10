// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { hostedBatching, hostedPipelineWidth } from '../dist/hosted-landing-batch.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { landingObservation } from '../dist/hosted-landing.js';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));
const acceptance = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Checks settle explicitly at a modeled 180 seconds, before stall deadlines.
// Do not jump the fake clock hours ahead while a test deliberately holds CI.
async function drainActive(f) {
  let steps = 0;
  for (;;) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:'));
    if (!task) return;
    assert(++steps < 1000, 'bounded event-driven source/queue progress');
    await f.execute(task);
  }
}

for (const identical of [true, false])
  for (const followerFirst of [true, false, 'failed', 'legacy'])
    test(`incident 62033ba2: owner-held predecessor releases its follower (${identical ? 'same' : 'changed'} tree, follower ${String(followerFirst)})`, async t => {
      const f = await batchesFixture(t, {
        count: 0,
        batching: 'default',
        batchMaxSize: 1,
        ...(identical ? { memberPaths: ['shared.txt', 'shared.txt'], memberContents: ['same', 'same'] } : {}),
      });
      const full = JSON.stringify({ scope: 'full', tests: [] });
      f.rawChecks.setPlanSelection(full);
      await f.add(2);
      await drainActive(f);
      await f.passChecks();
      await drainActive(f);
      await f.add(0);
      await f.add(1);
      f.insert('cliCredentials', {
        credentialId: 'held-replay',
        owner: 'owner',
        name: 'Synthetic device',
        tokenHash: 'synthetic',
        issuedAt: Date.now(),
        scope: 'cli',
        expiresAt: Date.now() + 3600000,
        revoked: false,
      });
      await f.tx(
        'requestOwnerHold',
        approvals.request,
        {
          projectId: f.projectId,
          operationId: randomUUID(),
          laneId: f.entries[1].lane.laneId,
          reason: 'Synthetic owner decision',
        },
        { subject: 'owner', forgeCredential: 'held-replay' },
      );
      await drainActive(f);
      const original = f.runs().filter(run => run.status === 'queued');
      assert.equal(original.length, 2);
      const head = await f.rawChecks.activate(original[0].id);
      const follower = await f.rawChecks.activate(original[1].id);
      const rootRow = () =>
        [...f.tables.projectHostedLandingRequests.values()].find(
          row => row.submissionId === f.entries[1].state.id,
        );
      f.patch('projectHostedLandingRequests', rootRow()._id, { reservedUntil: Date.now() + 600000 });
      if (followerFirst === true || followerFirst === 'legacy') {
        await f.rawChecks.pass(follower);
        await drainActive(f);
      }
      await f.rawChecks.pass(head);
      if (followerFirst === 'legacy') {
        // A pre-upgrade hold retained the train and reservation. Its next queue
        // event must repair it without approval, a migration or a background sweep.
        for (let step = 0; states(f)[1].phase !== 'ready'; step++) {
          assert(step < 100);
          await f.execute(f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:')));
        }
        const row = rootRow(),
          state = JSON.parse(row.value);
        f.patch('projectHostedLandingRequests', row._id, {
          orderLive: undefined,
          runnable: false,
          value: JSON.stringify({
            ...state,
            observation: landingObservation('waiting-for-review'),
            error: { code: 'REVIEW_REQUIRED', message: 'Synthetic retained hold' },
          }),
        });
      }
      await drainActive(f);
      const held = states(f)[1];
      assert.equal(held.observation.pendingReason, 'waiting-for-review');
      assert(![...f.tables.projectHostedLandingQueues.values()].some(row => row.train?.includes(held.id)));
      assert.notEqual((await f.current(f.entries[2].state.id)).orderWait?.submissionId, held.id);
      assert(!f.runs().find(run => run.id === follower.id).cancelRequested, 'keep the follower proof');
      if (followerFirst !== true && followerFirst !== 'legacy') {
        if (followerFirst === 'failed') await f.rawChecks.callback(f.rawChecks.complete(follower, 'failed'));
        else await f.rawChecks.pass(follower);
        await drainActive(f);
      }
      const afterCompose = f.runs().length;
      assert.equal(
        afterCompose,
        3 + Number(!identical || followerFirst === 'failed'),
        'baseline, predecessor, follower; only a changed tree rechecks',
      );
      for (const run of f.runs().filter(run => run.status === 'queued'))
        await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      await drainActive(f);
      const landed = states(f)[2];
      assert.equal(landed.phase, 'landed', JSON.stringify(landed));
      assert.equal(states(f)[1].observation.pendingReason, 'waiting-for-review');
      const receipt = [...f.tables.projectHostedAcceptances.values()]
        .map(row => JSON.parse(row.value))
        .find(receipt => receipt.submissionId === landed.id);
      assert.equal(receipt.check.runId === follower.id, identical && followerFirst !== 'failed');
      assert.equal(
        receipt.crossHeadProof?.algorithm,
        identical && followerFirst !== 'failed' ? 'exact-tree-v1' : undefined,
      );
      assert.equal(f.pending().length, 0, 'owner hold costs zero while idle');
      const approved = JSON.parse(
        await f.tx('laterOwnerApproval', acceptance.approve, {
          projectId: f.projectId,
          submissionId: held.id,
          attemptId: held.attemptId,
        }),
      );
      assert.equal(approved.status, 'pending');
      await drainActive(f);
      await f.passChecks();
      await drainActive(f);
      assert(states(f).every(state => state.phase === 'landed'));
      assert.equal(f.pending().length, 0);
    });

test('existing auto policies group by default; serial opts out and runner width is six', () => {
  const policy = policyPreset('trusted');
  assert(hostedBatching(policy));
  assert(!hostedBatching(policyPreset('supervised')));
  assert(
    !hostedBatching({ ...policy, acceptance: { ...policy.acceptance, landing: 'optimistic' } }),
    'legacy explicit hosted serial behavior remains an opt-out',
  );
  assert(!hostedBatching({ ...policy, acceptance: { ...policy.acceptance, landing: 'serial' } }));
  assert.equal(hostedPipelineWidth(policy), 6);
  assert.equal(hostedPipelineWidth({ ...policy, checks: { runner: 'github-actions', concurrency: 2 } }), 2);
});

test('ten default finishes check stacked exact heads concurrently and publish in order without reruns', async t => {
  const f = await batchesFixture(t, { count: 10, batching: 'default', batchMaxSize: null });
  await drainActive(f);
  const runs = f.runs();
  assert.equal(runs.length, 4, 'default first-check cohorts contain three members');
  assert.equal(states(f).filter(state => state.phase === 'checking').length, 10);
  const originalMain = f.currentMain();
  const active = new Map();
  for (const run of runs) {
    active.set(run.id, await f.rawChecks.activate(run.id));
    await drainActive(f);
    // Deliver and evaluate real shard progress while the physical run is live.
    const event = f.rawChecks.shard(active.get(run.id), 0);
    await f.rawChecks.callback(event);
    await drainActive(f);
    await f.rawChecks.callback(event); // exact duplicate callback
    await drainActive(f);
    assert(states(f).every(state => state.phase === 'checking'));
    assert.equal(f.pending().filter(task => !task.name.startsWith('projectHostedLandingStall:')).length, 0);
  }
  assert(states(f).every(state => state.checkProgress && state.timing.ciObservedAt));
  assert(
    [...f.tables.projectHostedLandingBatches.values()].some(
      row => JSON.parse(row.value).members.length === 1,
    ),
    'singleton speculative group',
  );
  // Complete successors first: they retain their proof while the predecessor checks.
  for (const run of runs.slice(1).reverse()) await f.rawChecks.pass(active.get(run.id));
  await drainActive(f);
  assert.equal(
    f.currentMain().head,
    originalMain.head,
    'a speculative pass never publishes a prefix out of order',
  );
  assert.equal(f.runs().length, 4);
  await f.rawChecks.pass(active.get(runs[0].id));
  await drainActive(f);
  assert(
    states(f).every(state => state.phase === 'landed'),
    JSON.stringify({
      states: states(f).map(state => ({
        id: state.id,
        phase: state.phase,
        batchId: state.batchId,
        error: state.error,
      })),
      rows: [...f.tables.projectHostedLandingRequests.values()].map(row => ({
        id: row.submissionId,
        orderWait: row.orderWait,
        runnable: row.runnable,
      })),
      runs: f.runs().map(run => ({ id: run.id, status: run.status })),
      pending: f.pending().map(task => task.name),
    }),
  );
  assert.equal(f.runs().length, 4, 'passing predecessor preserves every exact successor proof');
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(row => JSON.parse(row.value));
  assert.deepEqual(
    receipts.map(receipt => receipt.submissionId),
    f.entries.map(entry => entry.state.id),
  );
  for (const receipt of receipts) {
    const run = runs.find(run => run.id === receipt.check.runId);
    assert.equal(receipt.candidate.head, run.request.expectedHead);
    assert.equal(receipt.previous.head, run.candidate.base.head);
    assert.equal(receipt.previous.receiptId, run.candidate.base.receiptId);
  }
  assert.equal(f.pending().length, 0);
  const calls = f.counts.length;
  for (const run of active.values()) {
    // Fresh late callbacks for a completed generation cannot revive its waiters.
    await assert.rejects(
      f.rawChecks.callback(f.rawChecks.complete(run)),
      error => error.code === 'EVIDENCE_CHANGED',
    );
  }
  assert.equal(f.pending().length, 0);
  assert.equal(f.counts.slice(calls).filter(count => count.name === 'landingCheckWake').length, 0);
});

for (const count of [10, 50])
  test(`no-model N=${count}: serial versus grouped pipelined checks, bounded calls and zero idle work`, async t => {
    const results = [];
    for (const batching of [false, 'default']) {
      const f = await batchesFixture(t, { count, batching, batchMaxSize: null });
      const before = f.counts.length;
      const start = performance.now();
      let waves = 0,
        peakChecks = 0;
      await drainActive(f);
      while (states(f).some(state => state.phase !== 'landed')) {
        assert(++waves <= count);
        const pending = f.runs().filter(run => run.status === 'queued');
        assert(
          pending.length,
          JSON.stringify({
            batching,
            states: states(f),
            tasks: f.pending(),
            queues: [...f.tables.projectHostedLandingQueues.values()],
            rows: [...f.tables.projectHostedLandingRequests.values()].map(
              ({ submissionId, runnable, runId, attemptId }) => ({
                submissionId,
                runnable,
                runId,
                attemptId,
              }),
            ),
            finishes: [...f.tables.projectHostedFinishes.values()].map(row => ({
              id: row.submissionId,
              value: JSON.parse(row.value),
            })),
          }),
        );
        peakChecks = Math.max(peakChecks, pending.length);
        assert(pending.length <= 6);
        await f.passChecks();
        await drainActive(f);
      }
      const counts = f.counts.slice(before);
      const result = {
        mode: batching ? 'grouped-pipeline' : 'serial',
        count,
        waves,
        // Deterministic CI-service model; fixture CPU time is reported separately.
        ciServiceMs: 180_000,
        timeToAllLandedMs: waves * 180_000,
        ciRuns: f.runs().length,
        peakChecks,
        calls: counts.length,
        reads: counts.reduce((sum, count) => sum + count.documents, 0),
        writes: counts.reduce((sum, count) => sum + count.writes, 0),
        maxReadsPerCall: Math.max(...counts.map(count => count.documents)),
        fixtureWallMs: performance.now() - start,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      };
      assert.equal(f.pending().length, 0, 'event-driven queue has zero idle calls');
      assert(result.maxReadsPerCall < 256, JSON.stringify(result));
      results.push(result);
    }
    assert.equal(results[0].ciRuns, count);
    assert(results[1].timeToAllLandedMs < results[0].timeToAllLandedMs);
    assert(results[1].calls / count < 80, JSON.stringify(results));
    t.diagnostic(
      JSON.stringify({
        results,
        githubEquivalent: {
          model:
            'HEADGREEN singleton prefixes, six concurrent merge groups, same 180s CI; excludes PR checks',
          ciRuns: count,
          timeToAllLandedMs: Math.ceil(count / 6) * 180_000,
        },
      }),
    );
  });

test('a failing predecessor discards speculative descendants, returns the bad member with tests, and lands good members', async t => {
  const f = await batchesFixture(t, { count: 10, batching: 'default', batchMaxSize: null });
  await drainActive(f);
  const initial = f.runs();
  assert.equal(initial.length, 4);
  const active = [];
  for (const run of initial) {
    active.push(await f.rawChecks.activate(run.id));
    await drainActive(f);
    await f.rawChecks.callback(f.rawChecks.shard(active.at(-1), 0));
    await drainActive(f);
  }
  await f.rawChecks.callback(
    f.rawChecks.complete(active[0], 'failed', {
      contractReports: { 'tests/combined.test.mjs': { failed: true, durationMs: 1 } },
    }),
  );
  await drainActive(f);
  assert(
    [...f.tables.projectHostedLandingBatches.values()].some(
      row => JSON.parse(row.value).phase === 'superseded',
    ),
  );
  const generations = states(f).map(state => state.attemptId);
  for (const run of active.slice(1))
    await assert.rejects(f.rawChecks.pass(run), error => error.data?.code === 'CHECK_CANCELLED');
  await drainActive(f);
  assert.deepEqual(
    states(f).map(state => state.attemptId),
    generations,
    'late superseded runs cannot bind or publish descendant attempts',
  );
  let waves = 1;
  while (states(f).some(state => state.phase !== 'landed' && state.phase !== 'terminal-failed')) {
    assert(++waves < 20);
    const pending = f.runs().filter(run => run.status === 'queued');
    assert(pending.length, JSON.stringify(states(f)));
    for (const run of pending) {
      const checking = await f.rawChecks.activate(run.id);
      await drainActive(f);
      await f.rawChecks.callback(f.rawChecks.shard(checking, 0));
      await drainActive(f);
      const files = JSON.parse(f.c.objects.get(run.request.expectedHead)).files;
      if (files.some(file => file.path === 'member-1'))
        await f.rawChecks.callback(
          f.rawChecks.complete(checking, 'failed', {
            contractReports: { 'tests/member-1.test.mjs': { failed: true, durationMs: 1 } },
          }),
        );
      else await f.rawChecks.pass(checking);
    }
    await drainActive(f);
  }
  const failed = states(f).filter(state => state.phase === 'terminal-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, f.entries[1].state.id);
  assert.match(failed[0].error.message, /tests\/member-1.test.mjs/);
  assert.equal(states(f).filter(state => state.phase === 'landed').length, 9);
  assert(!JSON.parse(f.c.objects.get(f.currentMain().head)).files.some(file => file.path === 'member-1'));
  assert.equal(f.pending().length, 0);
  t.diagnostic(
    JSON.stringify({
      count: 10,
      failingEntry: 1,
      goodLanded: 9,
      ciRuns: f.runs().length,
      waves,
      timeToGoodLandedMs: waves * 180_000,
      discardedInitialRuns: initial.length - 1,
    }),
  );
});
