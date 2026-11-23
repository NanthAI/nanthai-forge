// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { desired, landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedVerdictKey } from '../dist/hosted-check-evidence.js';
import { compactDiscardedChecks } from './landing-ticket-fixture.mjs';
import { landingCosts } from '../dist/hosted-landings-view.js';
const { statsLanding } = await import(moduleUrl('../convex/projectStats.ts'));

const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function setup(t, mode, deferred = false) {
  Object.assign(process.env, synthetic);
  const f = await batchesFixture(t, { count: 0, batching: deferred });
  const first = deferred ? await f.add(0) : null;
  const request = deferred ? f.entries[0].request : f.request({ agent: true });
  const base =
    mode === 'direct'
      ? request
      : {
          operationId: request.operationId,
          authorityEpoch: 1,
          composeOperationId: request.finish.composeOperationId,
          check: request.check,
          after: null,
        };
  const send = command =>
    mode === 'direct'
      ? f.enqueue(command)
      : f
          .tx('desiredSubmit', desired.submit, { projectId: f.projectId, request: JSON.stringify(command) })
          .then(JSON.parse);
  return { f, base, send, first: first ?? (await send(base)) };
}

// Run-header usage comes from the result fold, whose callback/order budgets have their own guard.
// The raw legacy callback fixture stores shards without computing this aggregate.
function stamp(f, id, seconds, attested = false) {
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => JSON.parse(r.value).id === id);
  const run = JSON.parse(row.value);
  const next = { ...run, execution: { seconds, shards: run.plan.shardCount } };
  f.patch('projectHostedCheckRuns', row._id, {
    value: JSON.stringify(next),
    ...(attested ? { verdictKey: hostedVerdictKey(next) } : {}),
  });
}

async function pass(f, seconds = 300, attested = false) {
  const queued = f.runs().filter(r => r.status === 'queued');
  assert.equal(queued.length, 1);
  const run = await f.rawChecks.activate(queued[0].id);
  await f.rawChecks.pass(run);
  stamp(f, run.id, seconds, attested);
  return run.id;
}

async function ready(f, id) {
  for (let step = 0; states(f).find(s => s.id === id)?.phase !== 'ready'; step++) {
    assert(step < 100, 'the passed check reaches Ready before publication');
    await f.execute(f.pending()[0]);
  }
}

function seedLandingHistory(f, count) {
  for (let index = 0; index < count; index++) {
    const submissionId = randomUUID();
    f.insert('projectHostedLandingRequests', {
      projectId: f.projectId,
      channel: 'main',
      actor: 'owner',
      submissionId,
      operationId: randomUUID(),
      sequence: -index - 1,
      attemptId: randomUUID(),
      phase: 'landed',
      runnable: false,
      batchable: false,
      runId: randomUUID(),
      value: JSON.stringify({ phase: 'landed', id: submissionId }),
    });
  }
}

function cost(f, start) {
  const calls = f.counts.slice(start);
  return {
    transactions: calls.length,
    documents: calls.reduce((total, call) => total + call.documents, 0),
    readBytes: calls.reduce((total, call) => total + call.readBytes, 0),
  };
}

for (const mode of ['direct', 'desired']) {
  test(`${mode} resubmission keeps unreported predecessor execution unknown after a known pass`, async t => {
    const { f, base, send, first } = await setup(t, mode);
    await f.drain();
    const run = await f.rawChecks.activate(f.runs()[0].id);
    await f.rawChecks.callback(f.rawChecks.shard(run, 0, 'failed'));
    await f.rawChecks.callback(
      f.rawChecks.complete(run, 'failed', {
        contractReports: {
          'tests/failure.test.mjs': { failed: true, durationMs: 1, firstError: 'Synthetic' },
        },
      }),
    );
    await f.drain();
    assert.equal(states(f).find(s => s.id === first.id).phase, 'terminal-failed');
    const next = await send({ ...base, operationId: randomUUID() });
    await f.drain();
    await pass(f, 300, true);
    await ready(f, next.id);
    await f.tx('cancelKnownAfterUnknown', landingApi.cancel, {
      projectId: f.projectId,
      request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: next.id }),
    });
    await f.drain();
    const reused = await send({ ...base, operationId: randomUUID() });
    await f.drain();
    assert.equal(f.runs().length, 2, 'the known pass is reused after the unreported failure');
    const landed = states(f).find(s => s.id === reused.id);
    assert.equal(landed.phase, 'landed');
    assert.equal(landed.counts.runnerSeconds, 300);
    assert.equal(landed.counts.discardedRunnerUnknown, 'superseded-check-execution-unreported');
    assert.equal(landingCosts(landed, 0).runnerDiscarded, null);
    assert.equal(statsLanding({ id: 'receipt', at: landed.at }, landed).discardedRunnerSeconds, null);
  });

  for (const history of [0, 575, 1150]) {
    const deferred = history > 0;
    test(`${mode} resubmission lands from a retained ${deferred ? 'deferred' : 'immediate'} pass with ${history} historical landings`, async t => {
      compactDiscardedChecks(t);
      const { f, base, send, first } = await setup(t, mode, deferred);
      seedLandingHistory(f, history);
      const freshStart = f.counts.length;
      await f.drain();
      const runId = await pass(f, 300, true);
      await ready(f, first.id);
      const fresh = cost(f, freshStart);
      await f.tx('cancelPassed', landingApi.cancel, {
        projectId: f.projectId,
        request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: first.id }),
      });
      await f.drain();
      const cancelled = states(f).find(s => s.id === first.id);
      const replayStart = f.counts.length;
      const started = performance.now();
      const rss = process.memoryUsage().rss;
      const next = await send({ ...base, operationId: randomUUID() });
      await f.drain();
      assert.equal(f.runs().length, 1, 'the original provider verdict is reused');
      const landed = states(f).find(s => s.id === next.id);
      const replay = cost(f, replayStart);
      const repairCalls = f.counts
        .slice(replayStart)
        .filter(call => /^(finishCheckWake|landingAlarm|landingRepair|landingDeadline)$/.test(call.name));
      assert.deepEqual(repairCalls, [], 'the binding hands its verdict to the ordinary queue');
      t.diagnostic(
        JSON.stringify({
          history,
          fresh,
          replay,
          wallMs: performance.now() - started,
          rssBefore: rss,
          rssAfter: process.memoryUsage().rss,
        }),
      );
      assert.equal(landed.phase, 'landed', JSON.stringify(landed));
      assert.deepEqual(
        states(f).find(s => s.id === first.id),
        cancelled,
      );
      assert.equal(cancelled.error.code, 'LANDING_CANCELLED');
      assert.equal(f.tables.projectHostedAcceptances.size, 1);
      assert.equal(f.currentMain().receipt.id, landed.acceptance.receiptId);
      assert.equal(landingCosts(landed, 0).runnerAccepted, 5);
      assert.equal(landingCosts(landed, 0).runnerDiscarded, 0);
      assert.equal(landed.counts.discardedRunnerUnknown, undefined);
      const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === next.id);
      assert.equal(row.runId, runId);
      assert.equal(row.supersededCheck, undefined, 'binding consumes the accounting checkpoint');
      if (mode === 'desired') {
        const desiredRow = [...f.tables.projectHostedLandingDesired.values()].find(
          entry => entry.submissionId === next.id,
        );
        assert.equal(desiredRow.supersededCheck, undefined, 'admission consumes the desired copy');
      }
      const idleStart = f.counts.length;
      f.advanceClock(24 * 60 * 60_000);
      await f.drain();
      assert.deepEqual(cost(f, idleStart), { transactions: 0, documents: 0, readBytes: 0 });
      assert.equal(f.pending().length, 0);
    });
  }
}

test('a desired landing replaced before admission carries an explicit zero rather than unknown execution', async t => {
  const { f, base, send, first } = await setup(t, 'desired');
  const row = [...f.tables.projectHostedLandingDesired.values()][0];
  await f.tx('failBeforeAdmission', desired.fail, {
    projectId: f.projectId,
    submissionId: first.id,
    wakeId: row.wake.id,
    code: 'SOURCE_RETRY_EXHAUSTED',
    message: 'Synthetic source failure before check admission',
  });
  assert.equal(f.runs().length, 0);
  const next = await send({ ...base, operationId: randomUUID() });
  assert.deepEqual(next.counts, { discardedRunnerSeconds: 0 });
  assert.equal(next.supersedes, first.id);
  await f.drain();
  await pass(f);
  await f.drain();
  assert.equal(
    landingCosts(
      states(f).find(s => s.id === next.id),
      0,
    ).runnerDiscarded,
    0,
  );
});

for (const reported of [false, true]) {
  for (const role of ['leader', 'non-leader']) {
    test(`resubmitted batch ${role} keeps ${reported ? 'its recorded share known' : 'unreported shared execution unknown'}`, async t => {
      Object.assign(process.env, synthetic);
      const f = await batchesFixture(t, { count: 2 });
      await f.drain();
      const batchRow = [...f.tables.projectHostedLandingBatches.values()].find(
        row => JSON.parse(row.value).phase === 'checking',
      );
      const batch = () => JSON.parse(f.tables.projectHostedLandingBatches.get(batchRow._id).value);
      const member = f.entries.find(entry => (entry.state.id === batch().leaderId) === (role === 'leader'));
      const run = await f.rawChecks.activate(f.runs()[0].id);
      await f.rawChecks.callback(f.rawChecks.shard(run, 0, 'failed'));
      if (reported) stamp(f, run.id, 240);
      await f.rawChecks.callback(
        f.rawChecks.complete(run, 'failed', {
          contractReports: {
            'tests/combined.test.mjs': {
              failed: true,
              durationMs: 1,
              firstError: 'Synthetic shared failure',
            },
          },
        }),
      );
      for (let step = 0; batch().phase === 'checking'; step++) {
        assert(step < 100, 'the shared failure reaches every member before fallback checks start');
        await f.execute(f.pending()[0]);
      }
      const accounted = states(f).find(state => state.id === member.state.id);
      if (reported) {
        assert.equal(accounted.counts.discardedRunnerSeconds, 120);
        assert.equal(
          accounted.counts?.discardedRunnerUnknown,
          undefined,
          'an exact shared failure remains known',
        );
      } else {
        assert.equal(
          accounted.counts?.discardedRunnerUnknown,
          'superseded-check-execution-unreported',
          'failure accounting stamps unknown even on a non-leader with no timing or run ID',
        );
      }
      // Withdraw after the failed shared generation, before its individual fallback runs.
      for (const entry of f.entries) {
        const state = states(f).find(state => state.id === entry.state.id);
        if (state.phase !== 'terminal-failed')
          await f.tx('cancelFailedBatchMember', landingApi.cancel, {
            projectId: f.projectId,
            request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: state.id }),
          });
      }
      await f.drain();
      const next = await f.enqueue({ ...member.request, operationId: randomUUID() });
      assert.equal(next.supersedes, member.state.id);
      await f.drain();
      await pass(f, 300, true);
      await f.drain();
      const landed = states(f).find(state => state.id === next.id);
      assert.equal(landed.phase, 'landed');
      assert.equal(landingCosts(landed, 0).runnerDiscarded, reported ? 2 : null);
      assert.equal(
        statsLanding({ id: 'receipt', at: landed.at }, landed).discardedRunnerSeconds,
        reported ? 120 : null,
      );
    });
  }
}

for (const mode of ['direct', 'desired']) {
  test(`${mode} late cancelled usage follows durable supersession attribution into the eventual landing`, async t => {
    const { f, base, send, first } = await setup(t, mode);
    await f.drain();
    const cancelled = f.runs().find(run => run.status === 'queued');
    const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === cancelled.id);
    f.patch('projectHostedCheckRuns', row._id, {
      value: JSON.stringify({ ...cancelled, executionId: '123' }),
    });
    await f.tx('withdrawBeforeProviderStops', landingApi.cancel, {
      projectId: f.projectId,
      request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: first.id }),
    });
    await f.drain();
    const next = await send({ ...base, operationId: randomUUID() });
    const usage = await import(moduleUrl('../convex/projectCancelledRunUsage.ts'));
    await f.tx('completeSupersededUsage', usage.complete, {
      projectId: f.projectId,
      runId: cancelled.id,
      fence: cancelled.fence,
      executionId: '123',
      usage: { seconds: 210, receipt: { sha256: 'f'.repeat(64), size: 100 } },
    });
    await f.drain();
    await pass(f, 300, true);
    await f.drain();
    const landed = states(f).find(state => state.id === next.id);
    assert.equal(landed.phase, 'landed');
    assert.equal(landed.counts.discardedRunnerSeconds, 210);
    assert.equal(landed.counts.discardedRunnerUnknown, undefined);
    const accepted = [...f.tables.projectHostedLandingRequests.values()].find(
      r => r.submissionId === next.id,
    );
    assert.equal(accepted.runnerAccounting.root, first.id);
    assert.equal(accepted.runnerAccounting.pending, 0);
  });
}
