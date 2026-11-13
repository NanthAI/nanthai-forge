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
const pipelineEnv = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-admission-pipeline' };
const prior = Object.fromEntries(Object.keys(pipelineEnv).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, pipelineEnv));
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

// A full pre-queue admission can reserve the exact first head without holding
// queue order. A global-risk follower uses its combined check immediately.
for (const failed of ['predecessor', 'follower', 'follower-source', 'neither'])
  test(`70a9bd2f: admission train preserves original source after ${failed} fails`, async t => {
    const f = await batchesFixture(t, {
      count: 2,
      admissionCheck: 'full',
      batchMaxSize: null,
      memberPaths: ['build.rs', 'src/feature.ts'],
      fileCount: 2,
    });
    f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
    await drainActive(f);
    const runs = f.runs();
    assert.equal(runs.length, 2, 'one admission and one exact combined check');
    const a = runs.find(run => {
      const manifest = JSON.parse(f.c.objects.get(run.request.expectedHead));
      return !manifest.files.some(file => file.path === 'src/feature.ts');
    });
    const c = runs.find(run => run.id !== a.id);
    const combined = JSON.parse(f.c.objects.get(c.request.expectedHead));
    assert(combined.files.some(file => file.path === 'build.rs'));
    assert(combined.files.some(file => file.path === 'src/feature.ts'));
    if (failed === 'predecessor') {
      const late = await f.rawChecks.activate(c.id);
      await f.fail(a.id);
      await drainActive(f);
      assert.equal(states(f)[0].phase, 'terminal-failed');
      // A late success of the invalidated combined tree cannot publish A.
      await assert.rejects(f.rawChecks.pass(late), error => error.data?.code === 'CHECK_CANCELLED');
    } else {
      if (failed.startsWith('follower')) await f.fail(c.id);
      else await f.rawChecks.pass(await f.rawChecks.activate(c.id));
      await drainActive(f);
      assert.equal(states(f)[0].phase, 'checking', 'C never publishes before A passes');
      assert.notEqual(states(f)[1].phase, 'landed');
      await f.rawChecks.pass(await f.rawChecks.activate(a.id));
    }
    await drainActive(f);
    for (let step = 0; !['landed', 'terminal-failed'].includes(states(f)[1].phase); step++) {
      assert(step < 10, JSON.stringify(states(f)));
      for (const run of f.runs().filter(run => run.status === 'queued')) {
        if (failed === 'follower-source') await f.fail(run.id);
        else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      }
      await drainActive(f);
    }
    const main = JSON.parse(f.c.objects.get(f.currentMain().head));
    assert.equal(
      main.files.some(file => file.path === 'build.rs'),
      failed !== 'predecessor',
    );
    assert.equal(
      main.files.some(file => file.path === 'src/feature.ts'),
      failed !== 'follower-source',
      'only a passing original C selection may publish',
    );
    assert.equal(states(f)[1].phase, failed === 'follower-source' ? 'terminal-failed' : 'landed');
    if (failed === 'neither') {
      assert.equal(f.runs().length, 2, 'an early passing follower keeps its combined check');
      assert(
        [...f.tables.projectHostedAcceptances.values()].some(
          row => JSON.parse(row.value).check.runId === c.id,
        ),
      );
    }
    assert.equal(f.pending().length, 0, 'settled admission train costs zero while idle');
  });

for (const [name, options] of [
  ['one pipeline slot', { concurrency: 1 }],
  ['overlapping paths', { memberPaths: ['src/same.ts', 'src/same.ts'] }],
  ['independent paths', { memberPaths: ['src/a.ts', 'src/b.ts'] }],
])
  test(`70a9bd2f: ${name} retains the ordinary solo admissions`, async t => {
    const f = await batchesFixture(t, {
      count: 2,
      fileCount: 2,
      admissionCheck: 'full',
      batchMaxSize: null,
      memberPaths: ['build.rs', 'src/feature.ts'],
      ...options,
    });
    const rows = [...f.tables.projectHostedLandingRequests.values()];
    assert(rows.every(row => row.admission?.full && row.admission.status === 'checking'));
    assert.equal(f.runs().length, 2);
    assert(![...f.tables.projectHostedLandingQueues.values()].some(queue => queue.train?.length));
  });

test('70a9bd2f: an admission platform retry keeps the exact combined successor', async t => {
  const f = await batchesFixture(t, {
    count: 2,
    fileCount: 2,
    admissionCheck: 'full',
    batchMaxSize: null,
    memberPaths: ['build.rs', 'src/feature.ts'],
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  await drainActive(f);
  const a = f
    .runs()
    .find(
      run =>
        !JSON.parse(f.c.objects.get(run.request.expectedHead)).files.some(
          file => file.path === 'src/feature.ts',
        ),
    );
  const c = f.runs().find(run => run.id !== a.id);
  await f.rawChecks.pass(await f.rawChecks.activate(c.id));
  await drainActive(f);
  const active = await f.rawChecks.activate(a.id);
  await f.rawChecks.callback(f.rawChecks.complete(active, 'cancelled'));
  await drainActive(f);
  t.diagnostic(
    JSON.stringify({
      admission: [...f.tables.projectHostedLandingRequests.values()].map(row => ({
        admission: row.admission,
        phase: row.phase,
        attemptId: row.attemptId,
      })),
      runs: f.runs().map(run => ({ id: run.id, status: run.status, head: run.request.expectedHead })),
    }),
  );
  const retry = f.runs().find(run => run.status === 'queued');
  assert(retry && retry.id !== a.id);
  assert.equal(retry.request.expectedHead, a.request.expectedHead);
  await f.rawChecks.pass(await f.rawChecks.activate(retry.id));
  await drainActive(f);
  assert(states(f).every(state => state.phase === 'landed'));
  assert.equal(f.runs().length, 3, 'only the platform-failed admission repeats');
  assert(
    [...f.tables.projectHostedAcceptances.values()].some(row => JSON.parse(row.value).check.runId === c.id),
  );
  assert.equal(f.pending().length, 0);
});

test('70a9bd2f: a self-hosted check uses the same exact admission pipeline', async t => {
  const f = await batchesFixture(t, {
    count: 2,
    fileCount: 2,
    admissionCheck: 'full',
    batchMaxSize: null,
    memberPaths: ['build.rs', 'src/feature.ts'],
    runner: {
      provider: 'self-hosted',
      machineId: randomUUID(),
      environmentFingerprint: 'd'.repeat(64),
      platform: { os: 'linux', arch: 'x64' },
    },
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  await drainActive(f);
  assert.equal(f.runs().length, 2);
  for (const run of f.runs()) {
    assert.equal(run.configuration.provider, 'self-hosted');
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainActive(f);
  }
  assert(states(f).every(state => state.phase === 'landed'));
  assert.equal(f.runs().length, 2);
  assert.equal(f.pending().length, 0);
});

test('70a9bd2f: an owner-held admission releases its predicted successor onto surviving main', async t => {
  const f = await batchesFixture(t, {
    count: 2,
    fileCount: 2,
    admissionCheck: 'full',
    batchMaxSize: null,
    memberPaths: ['build.rs', 'src/feature.ts'],
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  await drainActive(f);
  f.insert('cliCredentials', {
    credentialId: 'admission-hold',
    owner: 'owner',
    name: 'Synthetic device',
    tokenHash: 'synthetic',
    issuedAt: Date.now(),
    scope: 'cli',
    expiresAt: Date.now() + 3600000,
    revoked: false,
  });
  await f.tx(
    'holdAdmission',
    approvals.request,
    {
      projectId: f.projectId,
      operationId: randomUUID(),
      laneId: f.entries[0].lane.laneId,
      reason: 'Synthetic owner decision',
    },
    { subject: 'owner', forgeCredential: 'admission-hold' },
  );
  for (let step = 0; states(f)[1].phase !== 'landed'; step++) {
    assert(step < 10, JSON.stringify(states(f)));
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainActive(f);
  }
  assert.equal(states(f)[0].observation.pendingReason, 'waiting-for-review');
  const main = JSON.parse(f.c.objects.get(f.currentMain().head));
  assert(!main.files.some(file => file.path === 'build.rs'));
  assert(main.files.some(file => file.path === 'src/feature.ts'));
  assert.equal(f.pending().length, 0);
});

test('70a9bd2f: a moved main retires the admission prediction and retains accepted source', async t => {
  const f = await batchesFixture(t, {
    count: 2,
    fileCount: 2,
    admissionCheck: 'full',
    batchMaxSize: null,
    memberPaths: ['build.rs', 'src/feature.ts'],
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  await drainActive(f);
  const combined = f
    .runs()
    .find(run =>
      JSON.parse(f.c.objects.get(run.request.expectedHead)).files.some(
        file => file.path === 'src/feature.ts',
      ),
    );
  await f.rawChecks.pass(await f.rawChecks.activate(combined.id));
  await drainActive(f);
  f.moveMain();
  for (let step = 0; states(f).some(state => state.phase !== 'landed'); step++) {
    assert(step < 10, JSON.stringify(states(f)));
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainActive(f);
  }
  const main = JSON.parse(f.c.objects.get(f.currentMain().head));
  for (const path of ['accepted.txt', 'build.rs', 'src/feature.ts'])
    assert(main.files.some(file => file.path === path));
  assert(
    ![...f.tables.projectHostedAcceptances.values()].some(
      row => JSON.parse(row.value).check.runId === combined.id,
    ),
    'the stale combined tree is never published',
  );
  assert.equal(f.pending().length, 0);
});
