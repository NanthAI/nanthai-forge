// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item b030c3c5, line 2: one next recovery name across web and agent replies. A failed landing check names the same
// cause, suspects and next step in `status {submissionId}` and the land/wait page as the Failed check screen's read;
// a landing still checking carries no cause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { compose, finishFixture, desired, api } from './hosted-finish-fixture.mjs';
import { batchesFixture, states } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { synthetic } from './hosted-revert-fixture.mjs';

const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const screen = await import(moduleUrl('../convex/projectFailureCause.ts'));
const { failureCauseField } = await import(moduleUrl('../src/check-failure-cause.ts'));

const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function submitted(t) {
  const f = await finishFixture(t);
  const command = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    composeOperationId: f.selection.request.operationId,
    after: null,
    check: f.request().check,
  };
  await f.tx('desiredSubmit', desired.submit, { projectId: f.projectId, request: JSON.stringify(command) });
  for (let n = 0; !f.tables.projectHostedCheckRuns.size; n++) {
    assert(n < 30);
    await f.execute();
  }
  const [row] = f.tables.projectHostedCheckRuns.values();
  const runId = JSON.parse(row.value).id;
  const active = await f.rawChecks.activate(runId);
  const landing = () =>
    JSON.parse(
      [...f.tables.projectHostedLandingRequests.values()].find(r => r.operationId === command.operationId)
        .value,
    );
  const replies = async () => ({
    status: JSON.parse(
      await f.tx('causeStatus', api.status, { projectId: f.projectId, submissionId: landing().id }),
    ),
    page: JSON.parse(
      await f.tx('causePage', observe.page, {
        projectId: f.projectId,
        operationId: command.operationId,
        nextVersion: 0,
      }),
    ),
    screen: JSON.parse(
      await f.tx('causeScreen', screen.forLane, { projectId: f.projectId, laneId: f.lane.laneId }),
    ),
  });
  return { f, active, runId, landing, replies };
}

test('a failed check names the same cause and next step in status and the land wait as the Failed check screen', async t => {
  const { f, active, runId, landing, replies } = await submitted(t);
  for (let i = 0; i < active.plan.shardCount; i++)
    await f.rawChecks.callback(f.rawChecks.shard(active, i, i === 0 ? 'failed' : 'passed'));
  await f.rawChecks.callback(f.rawChecks.complete(active, 'failed'));
  await f.drain();
  assert.equal(landing().phase, 'terminal-failed');
  const { status, page, screen: read } = await replies();
  assert(read.cause, 'the screen explains the failed check');
  const expected = failureCauseField(read.cause);
  assert.deepEqual(status.failureCause, expected);
  assert.equal(status.checkRunId, runId);
  assert.deepEqual(page.failureCause, expected);
  assert.equal(page.checkRunId, runId);
  assert.equal(page.events.at(-1).checkRunId, runId);
  assert.deepEqual(page.events.at(-1).failureCause, expected, 'the wait event an agent receives carries it');
  assert.equal(Object.keys(expected.suspects).join(), 'change,test,main,ci');
  assert.equal(read.expected, null, 'a settled check states no expected answer time');
});

test('a failed admission check exposes the original CI result on the live and pinned landing check', async t => {
  const f = await batchesFixture(t, { batchMaxSize: null, admissionCheck: 'full', count: 1 });
  const [{ lane }] = f.entries;
  const [{ id: runId }] = f.runs();
  const active = await f.rawChecks.activate(runId);
  const files = ['tests/admission.test.mjs', 'tests/fixture.test.mjs'];
  for (let i = 0; i < active.plan.shardCount; i++)
    await f.rawChecks.callback(f.rawChecks.shard(active, i, i === 0 ? 'failed' : 'passed'));
  await f.rawChecks.callback(
    f.rawChecks.complete(active, 'failed', {
      contractReports: Object.fromEntries(
        files.map(file => [file, { failed: true, durationMs: 80, firstError: 'expected true' }]),
      ),
      cost: {
        status: 'observed',
        seconds: 240,
        estimatedCostUsd: null,
        receipt: f.rawChecks.put('synthetic CI usage'),
      },
    }),
  );
  await f.drain();
  const [failed] = states(f);
  assert.equal(failed.phase, 'terminal-failed');
  assert.match(failed.error.message, /admission check/);
  const current = JSON.parse(
    await f.tx('currentAdmission', screen.forLane, { projectId: f.projectId, laneId: lane.laneId }),
  );
  const pinned = JSON.parse(
    await f.tx('pinnedAdmission', screen.forLane, {
      projectId: f.projectId,
      laneId: lane.laneId,
      attemptId: failed.attemptId,
    }),
  );
  for (const read of [current, pinned]) {
    assert.equal(read.run?.runId, runId);
    assert.deepEqual(
      read.cause?.failing.map(({ file }) => file),
      files,
    );
    assert.equal(read.run.timings.shards, active.plan.shardCount);
    assert.equal(typeof read.run.timings.wallSeconds, 'number');
    assert.equal(read.run.cost.seconds, 240);
    assert.equal(
      read.run.providerUrl,
      `https://github.com/${active.configuration.repository}/actions/runs/${active.executionId}`,
    );
  }
  const status = JSON.parse(
    await f.tx('admissionStatus', api.status, { projectId: f.projectId, submissionId: failed.id }),
  );
  assert.equal(status.checkRunId, runId);
  assert.deepEqual(status.failureCause, failureCauseField(current.cause));
});

test('a pinned Lane check still reads the failed attempt after another Candidate is composed', async t => {
  const { f, active, runId, landing, replies } = await submitted(t);
  for (let i = 0; i < active.plan.shardCount; i++)
    await f.rawChecks.callback(f.rawChecks.shard(active, i, i === 0 ? 'failed' : 'passed'));
  await f.rawChecks.callback(f.rawChecks.complete(active, 'failed'));
  await f.drain();
  const attemptId = landing().attemptId;
  f.moveMain();
  const main = f.currentMain();
  const newer = await compose(
    f.c,
    f.c.selection([f.lane], [], {
      expectedMain: { head: main.head, receiptId: main.receipt.id },
    }),
  );
  const latest = (await replies()).screen;
  assert.equal(latest.candidateId, newer.id);
  assert.equal(latest.run, null);
  const pinned = laneId =>
    f.tx('pinnedCheck', screen.forLane, { projectId: f.projectId, laneId, attemptId }).then(JSON.parse);
  assert.equal((await pinned(f.lane.laneId)).run.runId, runId);
  assert.equal((await pinned(randomUUID())).run, null, 'the attempt must have selected this Lane');
});

test('a check still running carries no cause in any agent reply and the screen states its usual time honestly', async t => {
  const { replies, runId } = await submitted(t);
  const { status, page, screen: read } = await replies();
  assert.equal(status.failureCause, undefined);
  assert.equal(status.checkRunId, runId);
  assert.equal(page.failureCause, undefined);
  assert.equal(page.checkRunId, runId);
  assert.equal(read.cause, null);
  // No settled landing has reported a check time yet: not reported, never a guess.
  assert.equal(read.expected, null);
});

test('the usual check time is the median of reported check minutes and needs three landings', () => {
  const { expectedFromSamples, EXPECTED_MIN_SAMPLES } = screen;
  const sample = minutes => [0, 1, minutes, 'id'];
  assert.equal(EXPECTED_MIN_SAMPLES, 3);
  assert.equal(expectedFromSamples([sample(5), sample(7)]), null);
  assert.equal(expectedFromSamples([sample(5), sample(null), sample(7)]), null, 'a gap is not a sample');
  assert.deepEqual(expectedFromSamples([sample(9), sample(5), sample(6)]), { seconds: 360, landings: 3 });
  assert.deepEqual(expectedFromSamples([sample(4), sample(5), sample(6), sample(8)]), {
    seconds: 330,
    landings: 4,
  });
});

test('the Lanes page reads the usual check (median) and the usual slowest (p90, nearest rank) from the same window', () => {
  const { usualFromSamples } = screen;
  const sample = minutes => [0, 1, minutes, 'id'];
  assert.equal(
    usualFromSamples([sample(5), sample(null), sample(7)]),
    null,
    'three reported checks or nothing',
  );
  assert.deepEqual(usualFromSamples([sample(9), sample(5), sample(6)]), {
    seconds: 360,
    slowSeconds: 540,
    landings: 3,
  });
  const ten = [3, 4, 5, 6, 7, 8, 9, 10, 11, 30].map(sample);
  assert.deepEqual(
    usualFromSamples(ten),
    { seconds: 450, slowSeconds: 660, landings: 10 },
    'one outlier is not p90',
  );
});
