// SPDX-License-Identifier: Apache-2.0
// Agent withdraw (Issue 78a97771): a builder ends its own known failing landing by Lane, keeps the
// Lane, confirms the terminal cancellation and lands a fix on the same Lane with a new operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, landingApi, code, compose } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { withdrawReceipt } from '../dist/hosted-agent-withdraw.js';
import { lowerVerb, parseVerbForm } from '../dist/agent-verbs.js';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const withdrawApi = await import(moduleUrl('../convex/projectHostedLandingWithdraw.ts'));
const laneFinish = await import(moduleUrl('../convex/projectHostedLaneFinish.ts'));

async function begin(f, overrides = {}) {
  const request = f.request(overrides),
    state = await f.enqueue(request);
  await f.drain();
  return { request, state };
}
const withdraw = (f, request, actor = 'owner') =>
  f
    .tx(
      'withdraw',
      withdrawApi.withdraw,
      {
        projectId: f.projectId,
        request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, ...request }),
      },
      actor,
    )
    .then(JSON.parse);
const live = (f, laneId) =>
  f.tx(
    'liveLaneFinish',
    {
      _handler: ctx => laneFinish.liveLaneFinish(ctx, { projectId: f.projectId, laneId, headWrittenAt: '' }),
    },
    {},
  );

test('land --withdraw lowers to the hosted withdraw action', () => {
  const [form] = parseVerbForm('land', ['--withdraw', '{}']);
  assert.equal(lowerVerb(form, true), 'withdraw');
});

test('withdraw by Lane cancels the live landing, keeps the Lane and fences the late check', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f),
    lane = await f.readLane(f.lane.laneId),
    main = f.currentMain(),
    run = (await f.status(state.id)).attempt.check.runId;
  const active = await f.rawChecks.activate(run);
  assert.equal((await live(f, f.lane.laneId)).submissionId, state.id, 'the Lane holds a live finish');
  const operationId = randomUUID();
  const before = f.counts.length;
  const withdrawn = await withdraw(f, { operationId, laneId: f.lane.laneId });
  const calls = f.counts.slice(before).filter(c => c.name === 'withdraw');
  assert.equal(calls.length, 1, 'one mutation per withdraw');
  assert(calls[0].documents <= 80, `bounded metadata reads: ${calls[0].documents}`);
  t.diagnostic(JSON.stringify({ calls: calls.length, reads: calls[0].documents, writes: calls[0].writes }));
  assert.equal(withdrawn.id, state.id);
  assert.equal(withdrawn.phase, 'terminal-failed');
  assert.equal(withdrawn.error.code, 'LANDING_CANCELLED');
  assert.match(withdrawn.error.message, /Withdrawn by its agent/);
  // The check stops (no other landing needs it), its record stays, and a late pass is refused.
  assert.equal((await f.rawChecks.status(run)).status, 'cancelled');
  await assert.rejects(f.rawChecks.pass(active), code('CHECK_CANCELLED'));
  await f.drain();
  assert.deepEqual(await f.readLane(f.lane.laneId), lane, 'the Lane, its head and saves stay');
  assert.deepEqual(f.currentMain(), main, 'main never moves');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.pending().length, 0, 'zero idle work after withdraw');
  // The freeze is lifted: the Lane has no live finish, so a save may move its head.
  assert.equal(await live(f, f.lane.laneId), null);
  // Retry-safe: a replay of the same operation returns the first receipt with no write.
  const writes = f.counts.length;
  const replay = await withdraw(f, { operationId, laneId: f.lane.laneId });
  assert.deepEqual(replay, withdrawn);
  assert(
    f.counts.slice(writes).every(c => c.writes === 0),
    'replay writes nothing',
  );
  // The canonical wait on the original landing operation is terminal at once.
  const observed = await f.current(state.id);
  assert.equal(observed.submission.phase, 'terminal-failed');
  assert.equal(observed.submission.error.code, 'LANDING_CANCELLED');
  // The canonical wait ends on observation.state !== 'pending' (hosted-agent-submission-wait.ts).
  assert.equal(observed.submission.observation.state, 'terminal-failed');
  const receipt = withdrawReceipt('/tmp/forge-root', f.lane.laneId, withdrawn);
  assert.equal(receipt.withdrawn, true);
  assert.deepEqual(receipt.confirm.next, {
    action: 'wait',
    operationIds: [state.operationId],
    until: 'acceptance',
  });
  assert.match(receipt.recovery, /LANDING_CANCELLED.*save, and land --save again/);
  // Re-land the same Lane with a new operation: a fresh submission checks and lands.
  const again = await begin(f);
  assert.notEqual(again.state.id, state.id);
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(again.state.id)).submission.phase, 'landed');
  assert.equal((await f.current(state.id)).submission.error.code, 'LANDING_CANCELLED', 'evidence kept');
});

test('withdraw without a live landing refuses with no operation written', async t => {
  const f = await finishFixture(t);
  const operations = f.tables.projectHostedOperations?.size ?? 0;
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }), code('LANDING_NOT_LIVE'));
  assert.equal(f.tables.projectHostedOperations?.size ?? 0, operations);
});

test('only the Lane author or the project owner can withdraw; readers cannot', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'writer' });
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }, 'writer'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }, 'reader'), code('PROJECT_UNAVAILABLE'));
  assert.equal((await f.current(state.id)).submission.phase, 'checking', 'refusals change nothing');
  const withdrawn = await withdraw(f, { laneId: f.lane.laneId });
  assert.equal(withdrawn.error.code, 'LANDING_CANCELLED');
});

test('an already accepted landing is never undone by a late withdraw', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  await f.passChecks();
  await f.drain();
  const main = f.currentMain();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }), code('LANDING_NOT_LIVE'));
  assert.deepEqual(f.currentMain(), main);
});

// Friction a0faf3a9: the landing moved to a Lane the owner did not name (a resolution Lane shares its
// origin's Intent). The queue names the Lane the landing composed, and withdraw by submissionId reaches it.
const queueView = await import(moduleUrl('../convex/projectHostedQueueView.ts'));
test('queue names the landing’s own Lane when its Intent has several, and withdraw by Lane says how to reach it', async t => {
  const f = await finishFixture(t);
  // A second Lane on the same Intent, created after the first, carries the live landing.
  const sibling = await f.c.lane(f.lane.state.object);
  const selection = f.c.selection([sibling]);
  const candidate = await compose(f.c, selection);
  const state = await f.enqueue(
    f.request({
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      finish: { composeOperationId: selection.request.operationId, after: null },
    }),
  );
  await f.drain();
  const view = JSON.parse(await f.tx('queueView', queueView.read, { projectId: f.projectId }));
  const entry = view.entries.find(item => item.submissionId === state.id);
  assert.equal(entry.laneId, sibling.laneId, 'the composed Lane, not the Intent’s first Lane');
  assert.equal(entry.moreLanes, true);
  // The Intent's first Lane has no live landing: the refusal names the submissionId route.
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }), error => {
    assert.equal(error.data?.code ?? error.code, 'LANDING_NOT_LIVE');
    assert.match(error.data?.message ?? error.message, /submissionId the queue lists/);
    return true;
  });
  assert.notEqual((await f.current(state.id)).submission.phase, 'terminal-failed');
});
