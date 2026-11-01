// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { hostedBatching, hostedPipelineWidth } from '../dist/hosted-landing-batch.js';
import { policyPreset } from '../dist/autonomy-policy.js';
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
  // Complete successors first: they retain their proof while the predecessor checks.
  for (const run of runs.slice(1).reverse()) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  await drainActive(f);
  assert.equal(
    f.currentMain().head,
    originalMain.head,
    'a speculative pass never publishes a prefix out of order',
  );
  assert.equal(f.runs().length, 4);
  await f.rawChecks.pass(await f.rawChecks.activate(runs[0].id));
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
        assert(pending.length);
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
  await f.fail(initial[0].id, 'tests/combined.test.mjs');
  await drainActive(f);
  assert(
    [...f.tables.projectHostedLandingBatches.values()].some(
      row => JSON.parse(row.value).phase === 'superseded',
    ),
  );
  let waves = 1;
  while (states(f).some(state => state.phase !== 'landed' && state.phase !== 'terminal-failed')) {
    assert(++waves < 20);
    const pending = f.runs().filter(run => run.status === 'queued');
    assert(pending.length, JSON.stringify(states(f)));
    for (const run of pending) {
      const files = JSON.parse(f.c.objects.get(run.request.expectedHead)).files;
      if (files.some(file => file.path === 'member-1')) await f.fail(run.id);
      else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
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
