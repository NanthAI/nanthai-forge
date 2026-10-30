// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingApi, compose } from './hosted-finish-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
});
const lifecycle = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));
const cancellation = await import(moduleUrl('../convex/projectHostedLifecycleCancel.ts'));
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));

async function abandon(f, entry = f.entries[0]) {
  const lane = await f.readLane(entry.lane.laneId);
  const request = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    action: 'abandon',
    reason: 'Stop this work',
    target: {
      kind: 'lane',
      laneId: lane.id,
      expected: {
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
      },
    },
  };
  const args = { projectId: f.projectId, request: JSON.stringify(request) };
  const result = JSON.parse(await f.transaction('abandonLanding', lifecycle.transition, args));
  assert.equal(result.status, 'applied');
  return args;
}

async function directRun(f) {
  const run = f.runs()[0],
    configuration = {
      provider: 'github-actions',
      repository: 'synthetic/project',
      runsOn: 'ubuntu-latest',
      runtime: run.configuration.runtime,
      environmentFingerprint: run.configuration.environmentFingerprint,
    };
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === run.id);
  f.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify({ ...run, configuration }) });
  const input = { projectId: f.projectId, runId: run.id };
  const reserved = await f.transaction('reserveCancelProvider', direct.reserve, input);
  await f.transaction('bindCancelProvider', direct.observe, {
    ...input,
    fence: reserved.fence,
    outcome: 'accepted',
    executionId: '123',
  });
  return run.id;
}
const providerCancels = f =>
  [...f.tables._scheduled_functions.values()].filter(t => t.name === 'projectHostedActionsWebhook:cancel');

for (const phase of ['queued', 'checking'])
  test(`abandon cancels the Lane ${phase} submission through the ordinary cancellation path; replay is inert`, async t => {
    const f = await batchesFixture(t, { count: 1 });
    if (phase === 'checking') {
      await f.drain();
      await directRun(f);
    }
    const args = await abandon(f);
    assert.equal(states(f)[0].error.code, 'LANDING_CANCELLED');
    assert.match(states(f)[0].error.message, /was abandoned.*landing was cancelled/);
    assert.doesNotMatch(states(f)[0].error.message, /peers requeued/);
    assert.equal(states(f)[0].phase, 'terminal-failed');
    assert([...f.tables.projectHostedOperations.values()].every(op => !op.metricMutation));
    assert(
      [...(f.tables.projectSelfMetricReceipts?.values() ?? [])].every(row => !row.key.endsWith(':cancel')),
      'automatic child cancellation is not an operator intervention',
    );
    assert.equal(
      [...(f.tables.projectSelfMetricReceipts?.values() ?? [])].filter(row => row.key.endsWith(':abandon'))
        .length,
      1,
      'the owner abandon is one intervention',
    );
    if (phase === 'checking') {
      assert.equal(f.runs()[0].status, 'cancelled');
      assert.equal(providerCancels(f).length, 1);
    }
    const before = structuredClone(f.tables);
    await f.transaction('abandonReplay', lifecycle.transition, args);
    assert.deepEqual(f.tables, before);
    assert.equal((await f.readLane(f.entries[0].lane.laneId)).head, f.entries[0].lane.head);
  });

test('abandoning a member of a real hosted batch preserves its provider until the last live peer leaves', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  const runId = await directRun(f);
  await abandon(f, f.entries[1]);
  assert.notEqual(f.runs()[0].status, 'cancelled');
  assert.equal(providerCancels(f).length, 0);
  for (const entry of f.entries.filter((_, i) => i !== 1))
    await f.transaction('cancelBatchPeer', landingApi.cancel, {
      projectId: f.projectId,
      request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: entry.state.id }),
    });
  assert.equal(f.runs().find(r => r.id === runId).status, 'cancelled');
  assert.equal(providerCancels(f).length, 1);
});

test('explicit cancellation stops a shared batch provider while its live requests retain their pins', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  const runId = await directRun(f);
  const before = structuredClone(f.tables.projectHostedLandingRequests);
  const operationId = randomUUID();
  const run = await f.rawChecks.cancel(runId, 'owner', operationId);
  assert.equal(run.status, 'cancelled');
  assert.equal(providerCancels(f).length, 1);
  assert.deepEqual(f.tables.projectHostedLandingRequests, before);
  const after = structuredClone(f.tables);
  assert.deepEqual(await f.rawChecks.cancel(runId, 'owner', operationId), run);
  assert.deepEqual(f.tables, after);
});

test('abandon lookup reads only the selected Lane at doubled dogfood history size', async t => {
  const f = await batchesFixture(t, { count: 1 });
  await f.drain();
  await directRun(f);
  for (let i = 0; i < 5600; i++)
    f.insert('projectHostedComposeSelections', {
      projectId: f.projectId,
      actor: 'owner',
      operationId: randomUUID(),
      kind: 'inputs',
      key: randomUUID(),
    });
  for (let i = 0; i < 1150; i++)
    f.insert('projectHostedLandingRequests', {
      projectId: f.projectId,
      channel: 'main',
      candidateId: randomUUID(),
      submissionId: randomUUID(),
      operationId: randomUUID(),
      actor: 'owner',
      sequence: i + 2,
      runnable: false,
      phase: 'checking',
      runId: randomUUID(),
      attemptId: randomUUID(),
      value: '{}',
    });
  const started = performance.now(),
    rss = process.memoryUsage().rss,
    calls = f.counts.length;
  const args = await abandon(f);
  const meter = f.counts.slice(calls).find(c => c.name === 'abandonLanding');
  assert(meter.documents <= 80 && meter.writes <= 35);
  assert(meter.readBytes < 128 * 1024 && meter.writeBytes < 256 * 1024);
  assert.equal(providerCancels(f).length, 1);
  const scheduled = f.pending().length;
  await f.transaction('idleAbandonReplay', lifecycle.transition, args);
  assert.equal(f.pending().length, scheduled);
  t.diagnostic(
    JSON.stringify({
      selections: 5600,
      landingHistory: 1150,
      calls: 1,
      documents: meter.documents,
      writes: meter.writes,
      readBytes: meter.readBytes,
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      rssGrowthBytes: process.memoryUsage().rss - rss,
      newIdleCalls: 0,
    }),
  );
});

test('paged abandonment continuation ignores newer submissions after reopen', async t => {
  const f = await batchesFixture(t, { count: 1 });
  const args = await abandon(f);
  const plan = [...f.tables.projectHostedLifecyclePlans.values()][0];
  const entry = f.entries[0];
  const lane = await f.readLane(entry.lane.laneId);
  await f.transaction('reopenAfterAbandon', lifecycle.transition, {
    projectId: f.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      action: 'reopen',
      authorityEpoch: 1,
      target: {
        kind: 'lane',
        laneId: lane.id,
        expected: {
          head: lane.head,
          version: lane.version,
          sourceVersion: lane.sourceVersion,
          lifecycleVersion: lane.lifecycleVersion,
        },
      },
    }),
  });
  await f.enqueue({ ...entry.request, operationId: randomUUID(), agent: false, finish: undefined });
  const before = structuredClone(f.tables.projectHostedLandingRequests);
  await f.transaction('abandonContinuation', cancellation.advance, {
    planId: plan._id,
    targets: [{ laneId: entry.lane.laneId, cursor: null }],
  });
  assert.deepEqual(f.tables.projectHostedLandingRequests, before);
  await f.transaction('oldAbandonReplay', lifecycle.transition, args);
  assert.deepEqual(f.tables.projectHostedLandingRequests, before);
});

test('abandon continues all selected composition pages with bounded calls and rechecks authority', async t => {
  const f = await batchesFixture(t, { count: 1 });
  await f.drain();
  for (let i = 0; i < 12; i++) {
    const selection = f.c.selection([f.entries[0].lane]);
    const candidate = await compose(f.c, selection);
    await f.enqueue(
      f.request({
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        agent: false,
        finish: undefined,
      }),
    );
  }
  await abandon(f);
  assert.equal(states(f).filter(s => s.error?.code === 'LANDING_CANCELLED').length, 2);
  let ticks = 0;
  while (true) {
    const task = f.pending().find(t => t.name === 'projectHostedLifecycleCancel:advance');
    if (!task) break;
    assert(++ticks < 15);
    if (ticks === 1) {
      const before = structuredClone(f.tables);
      f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
      await assert.rejects(
        f.transaction('revokedCancelContinuation', cancellation.advance, task.args[0]),
        error => error.code === 'SOURCE_AUTHORITY_CHANGED',
      );
      f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
      assert.deepEqual(f.tables, before);
    }
    await f.transaction('cancelContinuationPage', cancellation.advance, task.args[0]);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  }
  assert.equal(states(f).filter(s => s.error?.code === 'LANDING_CANCELLED').length, 13);
  assert(f.runs().every(r => r.status === 'cancelled'));
  assert(
    f.counts
      .filter(c => c.name === 'cancelContinuationPage')
      .every(c => c.documents <= 120 && c.writes <= 40),
  );
  t.diagnostic(JSON.stringify({ submissions: 13, continuationCalls: ticks }));
});

test('applied Intent cascade cancels every selected child submission through the same path', async t => {
  const f = await batchesFixture(t, { count: 2 });
  const lane = await f.readLane(f.entries[0].lane.laneId);
  const intent = [...f.tables.projectHostedRecordHeads.values()].find(
    r => r.kind === 'intent' && r.key === lane.intentId,
  );
  const request = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    action: 'abandon',
    reason: 'Stop the selected Intent',
    target: { kind: 'intent', intentId: lane.intentId, version: intent.version, cascade: true },
  };
  const input = { projectId: f.projectId, operationId: request.operationId };
  await f.transaction('cascadeCancelBegin', lifecycle.transition, {
    projectId: f.projectId,
    request: JSON.stringify(request),
  });
  let plan;
  for (let i = 0; i < 10; i++) {
    plan = [...f.tables.projectHostedLifecyclePlans.values()].find(
      p => p.operationId === request.operationId,
    );
    if (plan.materialized) break;
    await f.transaction('cascadeCancelAdvance', lifecycle.advance, input);
  }
  assert(plan.materialized);
  assert.equal(
    f.pending().filter(t => t.name === 'projectHostedLifecycleCancel:advance').length,
    0,
    'two live children cancel inside the existing lifecycle page without per-Lane calls',
  );
  for (const task of f.pending().filter(t => t.name === 'projectHostedLifecycleCancel:advance'))
    await f.transaction('cascadeCancelSubmissions', cancellation.advance, task.args[0]);
  assert.equal(states(f).find(s => s.id === f.entries[0].state.id).error.code, 'LANDING_CANCELLED');
  assert.equal(states(f).find(s => s.id === f.entries[1].state.id).error.code, 'LANDING_CANCELLED');
});

test('pending Intent abandonment cancels requests admitted before application', async t => {
  const f = await batchesFixture(t, { count: 1 });
  const entry = f.entries[0];
  const lane = await f.readLane(entry.lane.laneId);
  const intent = [...f.tables.projectHostedRecordHeads.values()].find(
    r => r.kind === 'intent' && r.key === lane.intentId,
  );
  const request = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    action: 'abandon',
    reason: 'Stop the pending Intent',
    target: { kind: 'intent', intentId: lane.intentId, version: intent.version, cascade: true },
  };
  const pending = JSON.parse(
    await f.transaction('pendingAbandonBegin', lifecycle.transition, {
      projectId: f.projectId,
      request: JSON.stringify(request),
    }),
  );
  assert.equal(pending.status, 'pending');
  f.advanceClock(1);
  await f.enqueue({ ...entry.request, operationId: randomUUID(), agent: false, finish: undefined });
  let plan;
  for (let i = 0; i < 10; i++) {
    plan = [...f.tables.projectHostedLifecyclePlans.values()].find(
      p => p.operationId === request.operationId,
    );
    if (plan.materialized) break;
    await f.transaction('pendingAbandonAdvance', lifecycle.advance, {
      projectId: f.projectId,
      operationId: request.operationId,
    });
  }
  assert(plan.materialized);
  assert.equal(states(f).length, 2);
  assert(states(f).every(s => s.error?.code === 'LANDING_CANCELLED'));
});
