// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item fe2b0a86 part B: the owner's approval of one submission's protected paths stands for a later
// held submission of the same Intent when its protected entries (before and after content) are the
// same. Incident (licence Lane, Item ffb6cc49, 2026-11-23): submission 37016080 was approved and then
// failed its check; the fixes 1b489c1f and c750f126 and the resolution Lane's c49fae56 each started
// without an approval and asked the owner again for the same protected change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { policyPreset as preset } from '../dist/autonomy-policy.js';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import { waitEventLine } from '../dist/hosted-wait-line.js';
const acceptance = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
const history = await import(moduleUrl('../convex/projectHostedLandingAttemptHistory.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));

const GUARD = 'guard.txt';
const SHARED = 'shared.txt';
const LANE_GUARD = [GUARD, 'guard v2\nkeep\nguard end\n'];
const LANE_SHARED = [SHARED, 'header agpl\nmiddle\nend\n'];

function syntheticR2(t) {
  const synthetic = {
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
    FORGE_WEB_URL: 'https://forge.example.invalid',
    FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  };
  const previous = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** The licence shape: the Lane edits the protected file and an ordinary file; the owner approves the
 * first submission while its check runs. */
async function approvedFirst(t, { mode = 'trusted', mainFiles } = {}) {
  syntheticR2(t);
  const f = await finishFixture(t, {
    baselineFiles: [
      [GUARD, 'guard v1\nkeep\nguard end\n'],
      [SHARED, 'header apache\nmiddle\nend\n'],
    ],
    selectedFiles: [LANE_GUARD, LANE_SHARED],
    mainFiles,
  });
  const policy = { ...preset(mode), agentDefaults: { preflight: 'advise' } };
  policy.acceptance.ownerApprovalPaths = [GUARD];
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  const first = await f.enqueue(f.request());
  await f.drain();
  const held = await readback(f, first);
  assert.equal(held.wait.reviewState, 'held');
  await f.tx('approveFirst', acceptance.approve, held.selection);
  await f.drain();
  return { f, first };
}

async function readback(f, state) {
  const queue = JSON.parse(
    await f.tx('carryQueue', history.read, { projectId: f.projectId, submissionId: state.id }),
  );
  const events = [];
  await observeHostedSubmissions(
    {
      root: '/tmp/root',
      address: { url: 'https://forge.example.invalid', projectId: f.projectId },
      dispatch: async () => ({ result: { actor: 'owner' } }),
      query: async (_, { nextVersion }) =>
        f.tx('carryWait', observe.page, {
          projectId: f.projectId,
          operationId: state.operationId,
          nextVersion,
        }),
    },
    { operationIds: [state.operationId], until: 'acceptance', timeoutSeconds: 0 },
    undefined,
    event => events.push(event),
  );
  const wait = events.map(waitEventLine).findLast(event => event?.line.type === 'submission')?.line;
  return {
    queue,
    wait,
    selection: { projectId: f.projectId, submissionId: state.id, attemptId: queue.currentAttemptId },
  };
}

async function failChecks(f) {
  for (const row of [...f.tables.projectHostedCheckRuns.values()]) {
    const run = JSON.parse(row.value);
    if (run.status === 'queued')
      await f.rawChecks.callback(f.rawChecks.complete(await f.rawChecks.activate(run.id), 'failed'));
  }
  await f.drain();
}

const rowOf = (f, state) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === state.id);
const grants = f => [...f.tables.projectHostedLandingRequests.values()].filter(row => row.ownerGrant);
const sharedEdit = n => [SHARED, `header apache\nmiddle\nmain edit ${n}\n`];
const UNCHANGED_GUARD = [GUARD, 'guard v1\nkeep\nguard end\n'];

test('incident replay 37016080: the licence sequence (two fixes after failed checks, then a resolution Lane through four main moves) needs one owner approval', async t => {
  const { f, first } = await approvedFirst(t);
  await failChecks(f);
  assert.equal((await f.current(first.id)).submission.phase, 'terminal-failed');
  // 1b489c1f and c750f126: fixes in an ordinary file; the protected change is the same.
  let previous = first;
  for (const fix of ['fix one\n', 'fix two\n']) {
    const next = await f.enqueue(await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', fix]]));
    await f.drain();
    const row = rowOf(f, next);
    assert.equal(row.protectedCarry?.submissionId, first.id, 'the first approval is offered');
    assert(row.protectedCarry.verified, 'its protected entries matched');
    assert.notEqual((await readback(f, next)).wait.reviewState, 'held', 'no new owner request');
    await failChecks(f);
    previous = next;
  }
  assert.notEqual(previous.id, first.id);
  // c49fae56: the resolution Lane's submission, then main moves through the shared file four times.
  const last = await f.enqueue(
    await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', 'fix two\n'], ['resolved.txt', 'r\n']]),
  );
  await f.drain();
  for (const n of [1, 2, 3, 4]) {
    f.moveMain({ files: [UNCHANGED_GUARD, sharedEdit(n)] });
    await f.passChecks();
    await f.drain();
  }
  await f.passChecks();
  await f.drain();
  const landed = (await f.current(last.id)).submission;
  assert.equal(landed.phase, 'landed');
  const { queue } = await readback(f, last);
  assert(queue.attempts.length >= 5, `recomposed after each main move: ${queue.attempts.length} attempts`);
  assert.deepEqual(rowOf(f, last).protectedCarry.paths, [GUARD], 'the compared set is recorded');
  assert.equal(grants(f).length, 1, 'exactly one owner approval');
  const by = landed.acceptance.acceptedBy;
  assert.equal(by.kind, 'auto', 'the submitter stays the acceptor');
  assert.equal(by.protectedApproval.submissionId, first.id);
  assert.deepEqual(by.protectedApproval.paths, [GUARD]);
});

test('fe2b0a86 part B fail closed: a different change to the protected file asks the owner again', async t => {
  const { f, first } = await approvedFirst(t);
  await failChecks(f);
  const next = await f.enqueue(await f.resubmission([[GUARD, 'guard v3\nkeep\nguard end\n'], LANE_SHARED]));
  await f.drain();
  assert.equal(rowOf(f, next).protectedCarry?.submissionId, first.id);
  assert(rowOf(f, next).protectedCarry.refused, 'the protected entries differ');
  assert.equal((await readback(f, next)).wait.reviewState, 'held');
  await f.passChecks();
  await f.drain();
  assert.notEqual((await f.current(next.id)).submission.phase, 'landed');
});

test('fe2b0a86 part B fail closed: main changing the protected file between submissions asks again', async t => {
  const { f } = await approvedFirst(t, {
    mainFiles: [[GUARD, 'guard v1\nkeep\nmain guard edit\n'], sharedEdit(1)],
  });
  await failChecks(f);
  f.moveMain();
  const next = await f.enqueue(await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', 'fix\n']]));
  await f.drain();
  assert(rowOf(f, next).protectedCarry?.refused, 'before-content differs');
  assert.equal((await readback(f, next)).wait.reviewState, 'held');
});

test('fe2b0a86 part B fail closed: a policy change since the approval asks again', async t => {
  const { f } = await approvedFirst(t);
  await failChecks(f);
  const policy = { ...preset('trusted'), agentDefaults: { preflight: 'advise' } };
  policy.acceptance.ownerApprovalPaths = [GUARD, 'other.txt'];
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  const next = await f.enqueue(await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', 'fix\n']]));
  await f.drain();
  assert.equal(rowOf(f, next).protectedCarry, undefined);
  assert.equal((await readback(f, next)).wait.reviewState, 'held');
});

test('fe2b0a86 part B fail closed: an approval of other work (another Intent) is not offered', async t => {
  const { f, first } = await approvedFirst(t);
  await failChecks(f);
  f.patch('projectHostedLandingRequests', rowOf(f, first)._id, { heldIntent: 'another-intent' });
  const next = await f.enqueue(await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', 'fix\n']]));
  await f.drain();
  assert.equal(rowOf(f, next).protectedCarry, undefined);
  assert.equal((await readback(f, next)).wait.reviewState, 'held');
});

test('fe2b0a86 part B fail closed: a declined newer submission ends the search', async t => {
  const { f, first } = await approvedFirst(t);
  await failChecks(f);
  const declined = await f.enqueue(
    await f.resubmission([[GUARD, 'guard v3\nkeep\nguard end\n'], LANE_SHARED]),
  );
  await f.drain();
  const row = rowOf(f, declined);
  const value = JSON.parse(row.value);
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'terminal-failed',
    value: JSON.stringify({ ...value, error: { code: 'REVIEW_DECLINED', message: 'no' } }),
  });
  const next = await f.enqueue(await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', 'fix\n']]));
  await f.drain();
  assert.equal(rowOf(f, next).protectedCarry, undefined, `not ${first.id}`);
});

test('fe2b0a86 part B: supervised review still holds the rest for a person after the protected paths carry', async t => {
  const { f } = await approvedFirst(t, { mode: 'supervised' });
  await failChecks(f);
  const next = await f.enqueue(await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', 'fix\n']]));
  await f.drain();
  assert(rowOf(f, next).protectedCarry?.verified, 'the protected entries matched');
  await f.passChecks();
  await f.drain();
  const state = (await f.current(next.id)).submission;
  assert.notEqual(state.phase, 'landed', 'a person still reviews the new content');
  assert.equal((await readback(f, next)).wait.reviewState, 'held');
  assert.equal(grants(f).length, 1);
});

test('fe2b0a86 part B fail closed: an approved listing that is gone asks again', async t => {
  const { f, first } = await approvedFirst(t);
  await failChecks(f);
  const approvedCandidate = JSON.parse(
    [...f.tables.projectHostedRecords.values()].find(
      row => row.candidateFiles && row.key === rowOf(f, first).candidateId,
    )?.value ?? 'null',
  );
  const listing = [...f.tables.projectHostedRecords.values()].find(row => row.candidateFiles)?.candidateFiles;
  assert(listing, 'the approved Candidate pins a listing');
  void approvedCandidate;
  const object = [...f.tables.projectObjects.values()].find(row => row.digest === listing.sha256);
  f.patch('projectObjects', object._id, { removed: true });
  const next = await f.enqueue(await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', 'fix\n']]));
  await f.drain();
  assert(rowOf(f, next).protectedCarry?.refused, 'unprovable: refused');
  assert.equal((await readback(f, next)).wait.reviewState, 'held');
});

test('fe2b0a86 part B fail closed: a decline after the approval was offered revokes it at comparison', async t => {
  const { f, first } = await approvedFirst(t);
  await failChecks(f);
  const other = await f.enqueue(await f.resubmission([[GUARD, 'guard v3\nkeep\nguard end\n'], LANE_SHARED]));
  await f.drain();
  // Offered at submission (the other change is still only held), then the owner declines it.
  const next = await f.enqueue(await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', 'fix\n']]));
  assert.equal(rowOf(f, next).protectedCarry?.submissionId, first.id);
  const row = rowOf(f, other);
  const value = JSON.parse(row.value);
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'terminal-failed',
    value: JSON.stringify({ ...value, error: { code: 'REVIEW_DECLINED', message: 'no' } }),
  });
  await f.drain();
  assert(rowOf(f, next).protectedCarry.refused, 'no longer the newest approval');
  assert.equal((await readback(f, next)).wait.reviewState, 'held');
});

test('fe2b0a86 part B fail closed: a gone approved attempt asks the owner instead of failing', async t => {
  const { f, first } = await approvedFirst(t);
  await failChecks(f);
  const approved = rowOf(f, first).ownerGrant.attemptId;
  for (const [id, row] of f.tables.projectHostedLandingAttempts)
    if (row.attemptId === approved || row.id === approved) f.tables.projectHostedLandingAttempts.delete(id);
  const next = await f.enqueue(await f.resubmission([LANE_GUARD, LANE_SHARED, ['fix.txt', 'fix\n']]));
  await f.drain();
  assert(rowOf(f, next).protectedCarry?.refused, 'unprovable: refused');
  assert.notEqual((await f.current(next.id)).submission.phase, 'terminal-failed');
  assert.equal((await readback(f, next)).wait.reviewState, 'held');
});
