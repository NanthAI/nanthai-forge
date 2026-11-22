// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { batchesFixture, states } from '../hosted-landing-batches-fixture.mjs';
import { current, requestRow, settle } from '../hosted-stale-check-fixture.mjs';
import { storageClock } from '../storage-clock.mjs';
import { overlapBase, overlapEdits, receipts } from './overtake-drive.mjs';

const shared = 'src/shared.ts';
const epoch = Date.UTC(2026, 10, 10, 12);
const checkStarts = f => f.runs().filter(run => run.gate?.mode !== 'audit');
const pass = async (f, run) => f.rawChecks.pass(await f.rawChecks.activate(run.id));

async function driveUntil(f, reached, skip = () => false) {
  for (let step = 0; !reached(); step++) {
    const task = f.pending().find(task => !/MainAudit:start|LandingStall/.test(task.name) && !skip(task));
    assert(
      task && step < 300,
      JSON.stringify({
        entries: states(f).map((state, index) => [
          index,
          state.phase,
          state.observation.pendingReason,
          requestRow(f, index).orderWait,
          state.error?.code,
        ]),
        checks: checkStarts(f).map(run => run.status),
      }),
    );
    await f.execute(task);
  }
}

function spendHolder(f, index) {
  f.patch('projectHostedLandingRequests', requestRow(f, index)._id, {
    overtaken: 'earlier:run',
    unsealed: 'not-eligible',
    orderLive: true,
  });
}

export async function retireSpentHolder(t) {
  storageClock(t);
  const f = await batchesFixture(t, {
    admissionCheck: false,
    requestCheck: true,
    batching: false,
    count: 3,
    fileCount: 2,
    memberPaths: [shared, shared, 'src/follower.ts'],
    baselineFiles: [[shared, overlapBase]],
    memberContents: overlapEdits,
    startAt: epoch,
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  await f.drain();
  spendHolder(f, 1);
  const [mover, holder, follower] = checkStarts(f);
  await f.rawChecks.activate(holder.id);
  f.advanceClock(50);
  await pass(f, follower);
  await driveUntil(f, () => requestRow(f, 2).orderWait === current(f, 1).id);
  const passedAt = requestRow(f, 2).passedAt;
  assert(passedAt > 0);
  f.advanceClock(50);
  await pass(f, mover);
  await driveUntil(f, () => f.runs().find(run => run.id === holder.id).status === 'cancelled');
  const waiting = requestRow(f, 2);
  assert.equal(waiting.orderWait, undefined);
  assert.equal(waiting.orderWaits.at(-1).release, 'baton-repin');
  await driveUntil(f, () => current(f, 2).phase === 'landed');
  assert(f.now() - passedAt < 600_000);
  await settle(f);
  assert.equal(checkStarts(f).length, 4, 'only the cancelled holder needs a replacement check');
}

export async function retrySpentSingleton(t) {
  storageClock(t);
  const f = await batchesFixture(t, {
    count: 0,
    fileCount: 2,
    batchMaxSize: 1,
    memberPaths: ['src/predecessor.ts', shared, shared, 'src/follower.ts'],
    baselineFiles: [[shared, overlapBase]],
    memberContents: ['predecessor', overlapEdits[1], overlapEdits[0], 'follower'],
    startAt: epoch,
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  await f.add(0);
  await f.drain();
  await f.add(1);
  await f.drain();
  const [predecessor, holder] = checkStarts(f);
  const holderBatch = current(f, 1).batchId;
  assert(holderBatch);
  await pass(f, predecessor);
  await f.drain();
  assert.equal(current(f, 0).phase, 'landed');
  assert.equal(requestRow(f, 1).runId, holder.id);
  await f.rawChecks.activate(holder.id);
  spendHolder(f, 1);
  await f.add(2, { request: { agent: false, priority: 'urgent' } });
  await f.drain();
  const mover = checkStarts(f).at(-1);
  const { autonomyPolicy: policy } = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, landing: 'serial' } },
  });
  await f.add(3);
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  await f.drain();
  const follower = checkStarts(f).at(-1);
  const followerId = current(f, 3).id;
  const skipFollower = task =>
    /projectHostedFinishDriver:/.test(task.name) && task.args?.[0]?.submissionId === followerId;
  f.advanceClock(50);
  await pass(f, follower);
  await driveUntil(f, () => current(f, 3).phase === 'ready', skipFollower);
  // Restore the earlier parked edge at the check callback boundary. From here
  // the production cancellation, re-pin, check and finish mutations own it.
  const passedAt = requestRow(f, 3).passedAt;
  assert(passedAt > 0);
  const holderRow = requestRow(f, 1);
  f.patch('projectHostedLandingRequests', holderRow._id, { orderWaited: true });
  f.patch('projectHostedLandingRequests', requestRow(f, 3)._id, {
    orderWait: holderRow.submissionId,
    orderWaits: [
      { submissionId: holderRow.submissionId, held: 'overtaken', footprints: 'disjoint', at: f.now() },
    ],
  });
  f.advanceClock(50);
  await pass(f, mover);
  await driveUntil(
    f,
    () => Boolean(requestRow(f, 1).runId && requestRow(f, 1).runId !== holder.id),
    skipFollower,
  );
  assert.equal(current(f, 1).batchId, holderBatch);
  assert.equal(current(f, 1).phase, 'checking');
  const replacementId = requestRow(f, 1).runId;
  await f.drain();
  await settle(f);
  const holderId = current(f, 1).id;
  const holderAttempts = [...f.tables.projectHostedLandingAttempts.values()]
    .filter(attempt => attempt.submissionId === holderId)
    .map(attempt => JSON.parse(attempt.value));
  const holderRuns = new Set(holderAttempts.map(attempt => attempt.check?.runId).filter(Boolean));
  const landings = receipts(f);
  const followerReceipt = landings.find(receipt => receipt.submissionId === followerId);
  const holderReceipt = landings.find(receipt => receipt.submissionId === holderId);
  assert(followerReceipt && holderReceipt);
  const passToLandMs = Date.parse(followerReceipt.at) - passedAt;
  const replacement = holderAttempts.find(attempt => attempt.check?.runId === replacementId);
  const moverReceipt = landings.find(receipt => receipt.submissionId === current(f, 2).id);
  const ownerOf = receiptId => landings.find(receipt => receipt.id === receiptId)?.submissionId;
  const nameOf = id =>
    ['predecessor', 'holder', 'mover', 'follower'][f.entries.findIndex(entry => entry.state.id === id)];
  t.diagnostic(
    JSON.stringify({
      starts: checkStarts(f).length,
      holderStarts: holderRuns.size,
      passToLandMs,
      landingOrder: landings.map(receipt => nameOf(receipt.submissionId)),
      replacementMain: nameOf(ownerOf(replacement?.main.receiptId)) ?? null,
      finalMain: nameOf(ownerOf(holderReceipt.previous.receiptId)) ?? null,
    }),
  );
  assert(moverReceipt && followerReceipt.snapshot.revision === moverReceipt.snapshot.revision + 1);
  assert.equal(replacement?.main.receiptId, moverReceipt.id);
  assert.equal(holderReceipt.previous.receiptId, followerReceipt.id);
  assert(passToLandMs >= 0 && passToLandMs < 600_000);
  // The follower lands ahead of the holder even if the replacement bound first.
  // Until the replacement drain lands, one extra holder check fits this replay.
  assert(checkStarts(f).length <= 6);
  assert(holderRuns.size <= 3);
}
