// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue fe5bea80: the owner accepts or declines a landing held for review in one step; agents never can.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
import { finishFixture, code, landingApi } from './hosted-finish-fixture.mjs';
import { batchesFixture } from './hosted-landing-batches-fixture.mjs';
import { policyPreset as preset } from '../dist/autonomy-policy.js';
// Server preflight gate (Issue 029138ef) has its own tests (hosted-landing-desired.test.mjs).
const policyPreset = name => ({ ...preset(name), agentDefaults: { preflight: 'advise' } });
import { cliReplyLines } from '../dist/cli-reply-lines.js';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import { hostedObservationContinuation } from '../dist/hosted-agent-finish-result.js';
import { waitEventLine } from '../dist/hosted-wait-line.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { approvalWait, deriveApproval } from '../dist/approval-state.js';
import { openApprovalsReply } from '../dist/hosted-agent-approval.js';
const acceptance = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
const review = await import(moduleUrl('../convex/projectHostedOwnerReview.ts'));
const { grantedApproval } = await import(moduleUrl('../convex/projectHostedOwnerGrant.ts'));

const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const history = await import(moduleUrl('../convex/projectHostedLandingAttemptHistory.ts'));
const finish = await import(moduleUrl('../convex/projectHostedFinish.ts'));
const { set: setPolicy } = await import(moduleUrl('../convex/projectAutonomy.ts'));

const needsMe = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const { needsView } = await import(moduleUrl('../web/src/app/needs/model.ts'));
const { decideTarget } = await import(moduleUrl('../web/src/app/needs/decide.ts'));
const thread = await import(moduleUrl('../convex/projectDiscussionThread.ts'));

function syntheticR2(t, web = 'https://forge.example.invalid') {
  const synthetic = {
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
    FORGE_WEB_URL: web,
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
function syntheticDevice(f) {
  f.insert('cliCredentials', {
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'Synthetic device',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    scope: 'cli',
    expiresAt: Date.now() + 60 * 60_000,
    revoked: false,
  });
}
/** A public project whose owner agent's finish touches a protected path: checked, then held. */
async function heldLanding(t, mode = 'trusted', web) {
  syntheticR2(t, web);
  const f = await finishFixture(t);
  const policy = policyPreset(mode);
  if (mode === 'trusted') policy.acceptance.ownerApprovalPaths = ['selected.txt'];
  f.patch('hostedProjects', f.projectId, { visibility: 'public', autonomyPolicy: policy });
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  syntheticDevice(f);
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const read = await f.current(state.id);
  assert.equal(read.submission.observation.pendingReason, 'waiting-for-review');
  const select = async () => {
    const now = (await f.current(state.id)).submission;
    return { projectId: f.projectId, submissionId: now.id, attemptId: now.attemptId };
  };
  return { f, state, select };
}
const device = { subject: 'owner', forgeCredential: 'synthetic-device' };

async function approvalReadback(f, state) {
  const input = { projectId: f.projectId, submissionId: state.id };
  const operation = { projectId: f.projectId, operationId: state.operationId };
  const queue = JSON.parse(await f.tx('reviewQueue', history.read, input));
  const events = [];
  await observeHostedSubmissions(
    {
      root: '/tmp/root',
      address: { url: 'https://forge.example.invalid', projectId: f.projectId },
      dispatch: async () => ({ result: { actor: 'owner' } }),
      query: async (_, { nextVersion }) => f.tx('reviewWait', observe.page, { ...operation, nextVersion }),
    },
    { operationIds: [state.operationId], until: 'acceptance', timeoutSeconds: 0 },
    undefined,
    event => events.push(event),
  );
  const wait = events.map(waitEventLine).findLast(event => event?.line.type === 'submission')?.line;
  return { queue, wait, operation, selection: { ...input, attemptId: queue.currentAttemptId } };
}

test('incident 9497ec68: protected review starts beside CI, stays idle through main moves, and one approved exact check owns publication', async t => {
  syntheticR2(t);
  const f = await batchesFixture(t, {
    count: 0,
    fileCount: 2,
    requestCheck: true,
    admissionCheck: 'full',
    landingMode: 'fast',
    checkCommand: { executable: 'bash', args: ['ci/verify.sh'] },
    memberPaths: ['ci/verify.sh', 'one.txt', 'two.txt', 'three.txt', 'four.txt'],
  });
  const settleDue = async () => {
    for (let count = 0; ; count++) {
      const task = f.pending().find(task => task.scheduledTime <= f.now());
      if (!task) return;
      assert(count < 150, 'only event-driven work runs');
      await f.execute(task);
    }
  };
  const pass = async (id, runnerSeconds) => {
    const run = await f.rawChecks.activate(id);
    if (runnerSeconds === undefined) await f.rawChecks.pass(run);
    else {
      const shardSeconds = runnerSeconds / run.plan.shardCount;
      const startedAt = new Date(f.now()).toISOString();
      f.advanceClock(Math.ceil(shardSeconds * 1000));
      const endedAt = new Date(f.now()).toISOString();
      for (let i = 0; i < run.plan.shardCount; i++)
        await f.rawChecks.callback(
          f.rawChecks.shard(run, i, 'passed', {
            execution: { startedAt, endedAt, seconds: shardSeconds },
          }),
        );
      await f.rawChecks.callback(f.rawChecks.complete(run));
    }
    await settleDue();
  };
  const protectedAt = f.now();
  const state = await f.add(0);
  const initial = await approvalReadback(f, state);
  const link = JSON.parse(await f.tx('earlyReviewLink', review.link, initial.operation));
  const timeToLink = (f.now() - protectedAt) / 1000;
  assert.equal(link.held, true);
  assert.match(link.url, /\/approve\?/);
  assert.equal(initial.queue.reviewState, 'held');
  assert.equal(
    cliReplyLines(['agent', '.', 'queue'], { result: initial.queue })[0],
    'Waiting for owner approval',
  );
  assert.equal(initial.wait.reviewState, 'held');
  assert.equal(initial.wait.phase, 'checking');
  const first = f.runs()[0];
  assert.equal(first.status, 'queued', 'the link and run are available together');
  await settleDue();

  // A later unrelated submission can land even while the first check is still live.
  await f.add(1);
  await settleDue();
  await pass(f.runs().at(-1).id);
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  assert.equal(f.runs().filter(run => run.request.candidateId === first.request.candidateId).length, 1);
  // Reuse the incident's measured first-run execution cost as a synthetic replay input.
  await pass(first.id, 5476);
  assert.equal(f.pending().length, 0, 'the settled check leaves the owner wait idle');
  for (const i of [2, 3]) {
    const follower = await f.add(i);
    await settleDue();
    await pass(f.runs().at(-1).id);
    assert.equal((await f.current(follower.id)).submission.phase, 'landed');
    assert.equal(f.pending().length, 0);
  }
  assert.equal(f.runs().length, 4, 'three main moves start no additional protected check');
  const held = await approvalReadback(f, state);
  assert.equal(held.selection.attemptId, initial.selection.attemptId, 'the same approval link remains live');
  assert.equal(held.queue.reviewState, 'held');
  assert.equal(held.wait.reviewState, 'held');
  const readCount = f.counts.length;
  f.advanceClock(60 * 60_000);
  assert.equal(await f.drain(), 0);
  assert.equal(f.counts.length, readCount, 'idle owner wait performs zero Convex calls');
  const approved = JSON.parse(
    await f.tx('earlyOwnerApprove', acceptance.approve, {
      ...held.selection,
      reason: 'The protected change is in scope.',
    }),
  );
  assert.equal(approved.status, 'pending');
  assert.equal(
    [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === state.id).ownerGrant
      .reason,
    'The protected change is in scope.',
  );
  f.advanceClock(1_000);
  await settleDue();
  const exact = f.runs().at(-1);
  assert.notEqual(exact.id, first.id);
  assert.equal(f.runs().length, 5, 'exactly one replacement starts after approval');
  const carried = await approvalReadback(f, state);
  assert.equal(carried.queue.reviewState, 'approved-carried');
  assert.equal(carried.wait.reviewState, 'approved-carried');
  const queue = [...f.tables.projectHostedLandingQueues.values()][0];
  assert.equal(queue.lease, null, 'CI does not hold the publication lease');

  const mainBefore = f.currentMain().receipt.id;
  const overtaker = await f.add(4);
  await settleDue();
  const fast = f.runs().at(-1);
  assert.notEqual(fast.id, exact.id);
  await pass(fast.id);
  assert.equal(f.currentMain().receipt.id, mainBefore, 'the later pass cannot overtake approved exact CI');
  assert.equal((await f.current(overtaker.id)).submission.phase, 'ready');
  await pass(exact.id);
  const landed = (await f.current(state.id)).submission;
  assert.equal(landed.phase, 'landed');
  const receipt = [...f.tables.projectHostedAcceptances.values()].find(
    record => record.submissionId === state.id,
  );
  assert.equal(JSON.parse(receipt.value).check.runId, exact.id);
  assert.equal(landed.acceptance.acceptedBy.carried, true);
  const result = await approvalReadback(f, state);
  assert.equal(result.queue.reviewState, 'approved-carried');
  assert.equal(result.wait.reviewState, 'approved-carried');
  const replayRuns = result.queue.attempts.filter(attempt => attempt.runId).map(attempt => attempt.runId);
  assert.deepEqual([...new Set(replayRuns)], [exact.id, first.id]);
  const discardedRunnerSeconds = [...f.tables.projectHostedCheckShards.values()]
    .filter(shard => replayRuns.includes(shard.runId) && shard.runId !== exact.id)
    .reduce((seconds, shard) => seconds + JSON.parse(shard.value).execution.seconds, 0);
  assert.equal(discardedRunnerSeconds, 5476);
  t.diagnostic(
    JSON.stringify({
      timeToLinkSeconds: timeToLink,
      discardedRunnerSeconds,
      preApprovalRechecks: 0,
      postApprovalChecks: 1,
      idleCalls: 0,
    }),
  );
});

test('incident 9497ec68: unchanged path names do not carry approval over changed reviewed bytes', async t => {
  syntheticR2(t);
  const file = 'selected.txt';
  const f = await finishFixture(t, {
    baselineFiles: [[file, 'one\nanchor\nthree\n']],
    selectedFiles: [[file, 'ours\nanchor\nthree\n']],
    mainFiles: [[file, 'one\nanchor\ntheirs\n']],
  });
  const policy = policyPreset('trusted');
  policy.acceptance.ownerApprovalPaths = [file];
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const before = await approvalReadback(f, state);
  f.moveMain();
  await f.tx('approvePreviousBytes', acceptance.approve, before.selection);
  await f.drain();
  const changed = await approvalReadback(f, state);
  assert.notEqual(changed.selection.attemptId, before.selection.attemptId);
  assert.equal(changed.queue.reviewState, 'needs-reapproval');
  assert.equal(changed.wait.reviewState, 'needs-reapproval');
  assert.deepEqual(changed.wait.hold.paths, [file]);
  await assert.rejects(f.tx('staleApproval', acceptance.approve, before.selection), code('WORK_STALE'));
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  await f.passChecks();
  await f.drain();
  const result = JSON.parse(await f.tx('approveNewBytes', acceptance.approve, changed.selection));
  assert.equal(result.status, 'landed');
  assert.equal((await f.current(state.id)).submission.acceptance.acceptedBy.carried, undefined);
});

test('incident 9497ec68: early approval carries if main moves while the first check still runs', async t => {
  syntheticR2(t);
  const f = await finishFixture(t);
  const policy = policyPreset('trusted');
  policy.acceptance.ownerApprovalPaths = ['selected.txt'];
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  const state = await f.enqueue(f.request());
  await f.drain();
  const first = await approvalReadback(f, state);
  assert.equal(first.wait.phase, 'checking');
  const pending = await f.tx('needsReadBeforeCheck', needsMe.read, { projectId: f.projectId });
  assert.equal(needsView(pending).now[0].reviewCheck, 'pending', 'a reserved run is not execution evidence');
  const approved = JSON.parse(await f.tx('approveDuringFirstCheck', acceptance.approve, first.selection));
  assert.equal(approved.status, 'pending');
  assert.equal((await approvalReadback(f, state)).wait.reviewState, 'approved');
  f.moveMain();
  await f.passChecks();
  await f.drain();
  const carried = await approvalReadback(f, state);
  assert.equal(carried.wait.reviewState, 'approved-carried');
  assert.equal(carried.wait.phase, 'checking');
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  await f.passChecks();
  await f.drain();
  const landed = (await f.current(state.id)).submission;
  assert.equal(landed.phase, 'landed');
  assert.equal(landed.acceptance.acceptedBy.carried, true);
});

test('a lost provider attempt retries the first protected check and keeps owner review open', async t => {
  syntheticR2(t);
  const f = await finishFixture(t);
  const policy = policyPreset('trusted');
  policy.acceptance.ownerApprovalPaths = ['selected.txt'];
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  const state = await f.enqueue(f.request());
  await f.drain();
  const before = await approvalReadback(f, state);
  assert.equal(before.queue.reviewState, 'held');
  const run = await f.rawChecks.activate(before.queue.attempts[0].runId);
  await f.rawChecks.callback(f.rawChecks.complete(run, 'runner-unavailable'));
  await f.drain();
  const retried = await approvalReadback(f, state);
  assert.equal(retried.wait.phase, 'checking');
  assert.equal(retried.wait.reviewState, 'held');
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  await f.passChecks();
  await f.drain();
  assert.equal(f.pending().length, 0);
  const ready = await approvalReadback(f, state);
  assert.equal(ready.queue.reviewState, 'held');
});

test('a protected finish with a retained run starts one exact replacement after approval', async t => {
  syntheticR2(t);
  const f = await finishFixture(t);
  const policy = policyPreset('trusted');
  policy.acceptance.ownerApprovalPaths = ['selected.txt'];
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  const run = await f.rawChecks.enqueue(f.rawChecks.selection());
  const state = await f.enqueue(f.request({ check: { kind: 'run', runId: run.id } }));
  await f.drain();
  await f.passChecks();
  await f.drain();
  const original = await approvalReadback(f, state);
  const checked = await f.tx('needsReadWithRetainedCheck', needsMe.read, { projectId: f.projectId });
  assert.equal(needsView(checked).now[0].reviewCheck, 'ran', 'a retained passing check counts');
  f.moveMain();
  await f.tx('approveRetainedRun', acceptance.approve, original.selection);
  await f.drain();
  const replacement = await approvalReadback(f, state);
  assert.equal(replacement.wait.reviewState, 'approved-carried');
  assert.equal(replacement.wait.phase, 'checking');
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
});

test('a supervised landing names its public approver and approval URL on land, observe and status', async t => {
  const web = 'https://forge-dogfood.example.invalid';
  const { f, state, select } = await heldLanding(t, 'supervised', web);
  const input = { projectId: f.projectId, operationId: state.operationId, nextVersion: 0 };
  const url = `${web}/approve?project=${f.projectId}&submission=${state.id}`;
  const observeLanding = () => f.tx('heldObservation', observe.page, input, device).then(JSON.parse);
  const unnamed = await observeLanding();
  assert.equal(unnamed.submission.observation.pendingReason, 'waiting-for-review');
  assert.equal(unnamed.url, url);
  assert.equal(unnamed.approver, undefined, 'no subject or fallback name when no handle is configured');
  const handle = 'forge-' + 'r'.repeat(33);
  f.insert('forgeAccounts', { owner: 'owner', handle });
  const named = await observeLanding();
  const reviewDetails = { approver: handle, url };
  const approvalOf = ({ approver, url }) => ({ approver, url });
  assert.deepEqual(approvalOf(named), reviewDetails);
  assert.deepEqual(approvalOf(await f.current(state.id)), reviewDetails);
  assert.deepEqual(approvalOf(await f.enqueue(state.request)), reviewDetails);
  assert(
    named.events.every(event => event.url === undefined),
    'the current approval link appears once per page',
  );
  const { approver: _approver, url: _url, ...bare } = named;
  const wireBytes = Buffer.byteLength(JSON.stringify(named)) - Buffer.byteLength(JSON.stringify(bare));
  assert(
    wireBytes + (32 - f.projectId.length) <= 200,
    `held reply grows by ${wireBytes} bytes on the fixture`,
  );
  const link = JSON.parse(
    await f.tx('link', review.link, { projectId: f.projectId, operationId: state.operationId }, device),
  );
  assert.equal(link.held, true);
  assert.equal(link.approver, handle);
  assert.equal(link.url, url);
  const result = hostedObservationContinuation('/tmp/root', named);
  assert.equal(result.hold.kind, 'review');
  assert.deepEqual(result.hold.review, reviewDetails);
  const submission = { ...named.submission, ...reviewDetails };
  const line = `Held, waiting for @${handle}. Open ${url}`;
  assert.equal(landSummary({ result: { submission } })[0], line);
  assert.equal(cliReplyLines(['agent', '.', 'observe'], { result: named })[0], line);
  const events = [];
  const waited = await observeHostedSubmissions(
    {
      root: '/tmp/root',
      address: { url: web, projectId: f.projectId },
      dispatch: async () => ({ result: { actor: handle } }),
      query: async (_, { nextVersion }) => f.tx('heldWait', observe.page, { ...input, nextVersion }, device),
    },
    { operationIds: [state.operationId], until: 'acceptance', timeoutSeconds: 0 },
    undefined,
    event => events.push(event),
  );
  assert.deepEqual(approvalOf(waited.result.submissions[0].submission), reviewDetails);
  assert.deepEqual(waitEventLine(events.at(-1)).line.hold.review, reviewDetails);
  assert.equal(landSummary({ result: waited.result.submissions[0] })[0], line);
  await f.tx('ownerApprove', acceptance.approve, await select());
  assert.equal(
    (await observeLanding()).url,
    undefined,
    'a settled landing no longer carries approval details',
  );
});

test('agents, device sign-ins and contributors cannot approve or decline; the link names the hold', async t => {
  const { f, state, select } = await heldLanding(t);
  for (const actor of [device, 'contributor']) {
    await assert.rejects(
      f.tx(
        'approveRefused',
        acceptance.approve,
        { ...(await select()), reason: 'Unauthorized approval' },
        actor,
      ),
      code('PROJECT_UNAVAILABLE'),
    );
    await assert.rejects(
      f.tx('declineRefused', review.decline, { ...(await select()), operationId: randomUUID() }, actor),
      code('PROJECT_UNAVAILABLE'),
    );
  }
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(
    [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id).ownerGrant,
    undefined,
    'a refused approval records no grant',
  );
  // Any project reader (the agent's own credential) reads the link; it carries no attempt id.
  const link = JSON.parse(
    await f.tx('link', review.link, { projectId: f.projectId, operationId: state.operationId }, device),
  );
  assert.equal(link.held, true);
  assert.equal(link.submissionId, state.id);
  assert.match(link.reason, /protected paths selected\.txt/);
  assert.equal(
    link.url,
    `https://forge.example.invalid/approve?project=${encodeURIComponent(f.projectId)}&submission=${state.id}`,
  );
  assert.equal(f.pending().length, 0, 'the hold and the link read leave no idle task');
});

test('the owner approves the exact held attempt and the waiting submission lands as the owner', async t => {
  const { f, state, select } = await heldLanding(t);
  const approved = JSON.parse(await f.tx('ownerApprove', acceptance.approve, await select()));
  assert.equal(approved.status, 'landed');
  assert.deepEqual(approved.receipt.actor, { id: 'owner', kind: 'person' });
  await f.drain();
  const read = await f.current(state.id);
  assert.equal(read.submission.observation.state, 'landed');
  assert.equal(read.submission.operationId, state.operationId, 'the agent waits on its own operation');
  const by = read.submission.acceptance.acceptedBy;
  assert.equal(by.kind, 'person');
  assert.equal(by.actor, 'owner');
  assert.equal(by.head, read.submission.acceptance.head, 'the exact Candidate the owner accepted landed');
  assert.deepEqual(by.paths, ['selected.txt']);
  assert.equal(by.carried, undefined);
});

test('approval reason is optional, bounded, replay-safe and adds no approval transaction work', async t => {
  const costs = [];
  for (const reason of [undefined, `  ${'X'.repeat(510)}  `]) {
    const { f, state, select } = await heldLanding(t);
    const input = await select();
    const readGrant = () =>
      [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === state.id)
        .ownerGrant;
    const args = { ...input, ...(reason === undefined ? {} : { reason }) };
    const approval = JSON.parse(await f.tx('approve', acceptance.approve, args));
    const { ranges, documents, writes } = f.counts.at(-1);
    costs.push({ ranges, documents, writes });
    assert.equal(approval.status, 'landed');
    assert.equal(readGrant().reason, reason === undefined ? undefined : 'X'.repeat(500));
    assert.equal(readGrant().attemptId, input.attemptId);
    const replay = JSON.parse(
      await f.tx('approveAgain', acceptance.approve, { ...args, reason: 'Different text' }),
    );
    assert.equal(replay.receipt.id, approval.receipt.id);
    assert.equal(readGrant().reason, reason === undefined ? undefined : 'X'.repeat(500));
    await f.drain();
    const notice = f.counts.findLast(count => count.name === 'acceptedByNote');
    t.diagnostic(
      JSON.stringify({
        withReason: reason !== undefined,
        approval: { documents, ranges, writes },
        notice: {
          documents: notice.documents,
          ranges: notice.ranges,
          writes: notice.writes,
          readBytes: notice.readBytes,
          writeBytes: notice.writeBytes,
        },
      }),
    );
  }
  assert.deepEqual(costs[1], costs[0]);
});

test('J05: the accepted Lane notice gives the team the persisted exact-attempt approval reason', async t => {
  const { f, select } = await heldLanding(t);
  const reason = 'Verified <change> in the release check.\n' + '界'.repeat(450);
  const pin = await select();
  const approved = JSON.parse(await f.tx('approve', acceptance.approve, { ...pin, reason }));
  assert.equal(approved.status, 'landed');
  assert.equal(
    JSON.parse(await f.tx('approveReplay', acceptance.approve, { ...pin, reason: 'Replacement' })).receipt.id,
    approved.receipt.id,
  );
  await f.drain();
  const read = actor =>
    f.tx(
      'acceptedLaneThread',
      thread.read,
      {
        projectId: f.projectId,
        scope: 'lane',
        id: f.lane.laneId,
      },
      actor,
    );
  const { entries } = await read('contributor');
  const notices = entries.filter(entry => /accepted this landing/.test(entry.text));
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /protected paths selected\.txt/);
  assert.equal(notices[0].approvalReason, reason);
  const stats = f.counts.at(-1);
  t.diagnostic(
    `Lane Thread with reason: ${stats.documents} documents, ${stats.ranges} ranges, ${stats.readBytes} read bytes`,
  );
  assert.deepEqual(await read('stranger'), { canRead: false, entries: [], before: null });
});

test('48049998 replay: a protected-path policy hold has no Lane request, yet Needs me offers Approve and Decline on its exact attempt', async t => {
  const { f, state, select } = await heldLanding(t);
  const read = await f.tx('needsRead', needsMe.read, { projectId: f.projectId });
  assert.equal(read.canDecide, true, 'the owner decides');
  assert.deepEqual(
    JSON.parse(read.approvals).requests.filter(request => request.kind === 'lane'),
    [],
    'a landing-policy hold opens no Lane approval request (the live case: no buttons before this fix)',
  );
  const [row] = needsView(read).now;
  assert.equal(row.why, 'review');
  assert.equal(row.approval, null);
  assert.equal(row.reviewCheck, 'ran', 'the held review already has a recorded check run');
  const held = await select();
  assert.deepEqual(row.landing, { submissionId: held.submissionId, attemptId: held.attemptId });
  const target = decideTarget(row);
  assert.deepEqual(
    target,
    { landing: row.landing },
    'the held attempt itself, as the /approve page decides it',
  );
  // The web's grant is the /approve page's call on that exact attempt (decide.ts), with no other authority.
  const approved = JSON.parse(
    await f.tx('needsApprove', acceptance.approve, { projectId: f.projectId, ...target.landing }),
  );
  assert.equal(approved.status, 'landed');
  assert.deepEqual(approved.receipt.actor, { id: 'owner', kind: 'person' });
  await f.drain();
  assert.equal((await f.current(state.id)).submission.observation.state, 'landed');
  assert.deepEqual(
    (await f.tx('needsReadAfter', needsMe.read, { projectId: f.projectId })).held,
    [],
    'approved anywhere, it leaves Needs me',
  );
});

test('48049998: Decline from Needs me on a policy hold ends it REVIEW_DECLINED, as the /approve page does', async t => {
  const { f, state } = await heldLanding(t);
  const read = await f.tx('needsRead', needsMe.read, { projectId: f.projectId });
  const target = decideTarget(needsView(read).now[0]);
  const declined = JSON.parse(
    await f.tx('needsDecline', review.decline, {
      projectId: f.projectId,
      ...target.landing,
      operationId: randomUUID(),
    }),
  );
  assert.equal(declined.error.code, 'REVIEW_DECLINED');
  await f.drain();
  assert.equal((await f.current(state.id)).submission.observation.state, 'terminal-failed');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('main moves after the hold: approval does not publish the stale Candidate; a fresh attempt is checked and lands with it', async t => {
  const { f, state, select } = await heldLanding(t);
  const held = await select();
  const before = f.currentMain();
  f.moveMain();
  const moved = f.currentMain();
  const reply = JSON.parse(await f.tx('ownerApproveRace', acceptance.approve, held));
  assert.equal(reply.status, 'pending');
  assert.match(reply.reason, /main moved/);
  assert.equal(f.tables.projectHostedAcceptances.size, 0, 'the stale exact Candidate never lands');
  assert.equal(f.currentMain().head, moved.head);
  assert.notEqual(moved.head, before.head);
  await f.drain();
  const fresh = await f.current(state.id);
  assert.notEqual(fresh.submission.attemptId, held.attemptId, 'a fresh attempt, never the approved one');
  assert.notEqual(fresh.submission.observation.state, 'landed', 'the fresh attempt waits for its own check');
  // The old attempt can no longer be approved: the exact selection is stale.
  await assert.rejects(f.tx('approveStale', acceptance.approve, held), code('WORK_STALE'));
  await f.passChecks();
  await f.drain();
  const landed = await f.current(state.id);
  assert.equal(landed.submission.observation.state, 'landed');
  const [receipt] = [...f.tables.projectHostedAcceptances.values()].map(row => JSON.parse(row.value));
  assert.equal(receipt.attemptId, landed.submission.attemptId);
  assert.deepEqual(receipt.actor, { id: 'owner', kind: 'person' });
  assert.equal(receipt.previous.head, moved.head);
  assert(receipt.check, 'the fresh attempt carries its own check');
  const row = [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === state.id);
  assert.equal(
    row.runnerAccounting.runs,
    2,
    'the protected-path hold and main move discarded the first check',
  );
  const keys = [...f.tables.projectHostedCheckRuns.values()].map(run => run.runId.slice(-8));
  assert.deepEqual(row.runnerAccounting.runIds, keys);
});

test('a queued owner approval still requires the exact held policy when it reaches publication', async t => {
  const { f, state, select } = await heldLanding(t);
  const held = await select();
  const [queue] = f.tables.projectHostedLandingQueues.values();
  f.patch('projectHostedLandingQueues', queue._id, {
    lease: {
      owner: 'busy',
      token: queue.fence,
      until: Number.MAX_SAFE_INTEGER,
      submissionId: held.submissionId,
      attemptId: held.attemptId,
    },
  });
  const approval = JSON.parse(await f.tx('deferredOwnerApprove', acceptance.approve, held));
  assert.equal(approval.reason, 'approved; lands in its turn');
  const deferred = (await f.current(state.id)).submission;
  assert.equal(deferred.observation.pendingReason, 'queued');
  assert.equal(deferred.attemptId, held.attemptId);
  const edit = await f.tx('editDeferredApprovalPolicy', setPolicy, {
    projectId: f.projectId,
    command: JSON.stringify({
      action: 'set-policy',
      operationId: randomUUID(),
      acceptance: { protectedPaths: ['unrelated/**'] },
    }),
  });
  assert.deepEqual(edit.invalidatedSubmissionIds, [state.id]);
  await assert.rejects(
    f.tx('deferredOwnerPublish', acceptance.publish, {
      ...held,
      channel: 'main',
      owner: 'busy',
      token: queue.fence,
    }),
    code('POLICY_CHANGED'),
  );
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('the owner declines: the submission ends REVIEW_DECLINED with the reason; a replay returns it', async t => {
  const { f, state, select } = await heldLanding(t);
  const operationId = randomUUID();
  const input = { ...(await select()), operationId, reason: 'keep the old workflow' };
  const declined = JSON.parse(await f.tx('ownerDecline', review.decline, input));
  assert.equal(declined.phase, 'terminal-failed');
  assert.equal(declined.error.code, 'REVIEW_DECLINED');
  assert.match(declined.error.message, /keep the old workflow/);
  assert.deepEqual(JSON.parse(await f.tx('ownerDeclineReplay', review.decline, input)), declined);
  await f.drain();
  const read = await f.current(state.id);
  assert.equal(read.submission.observation.state, 'terminal-failed');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('a retained grant carries only to verified Candidate bytes under the same owner, pins and policy', () => {
  const attempt = {
    id: 'a1',
    candidate: {
      digest: 'verified-files',
      inputs: { sha256: 'i', size: 1 },
      dependencies: { sha256: 'd', size: 1 },
    },
    policyDigest: 'p',
    check: { runId: 'r' },
  };
  const grant = {
    actor: 'owner',
    attemptId: 'a0',
    inputs: JSON.stringify(attempt.candidate.inputs),
    dependencies: JSON.stringify(attempt.candidate.dependencies),
    policyDigest: 'p',
    paths: ['selected.txt', 'src/a.ts'],
    verifiedDigest: 'verified-files',
    at: 0,
  };
  const owner = { kind: 'person', id: 'owner' };
  assert.deepEqual(grantedApproval(grant, attempt, 'owner'), owner);
  assert.equal(grantedApproval(undefined, attempt, 'owner'), undefined);
  assert.equal(grantedApproval(grant, attempt, 'someone-else'), undefined);
  assert.equal(grantedApproval({ ...grant, inputs: '{"sha256":"x","size":1}' }, attempt, 'owner'), undefined);
  assert.equal(grantedApproval({ ...grant, dependencies: '{}' }, attempt, 'owner'), undefined);
  assert.equal(grantedApproval({ ...grant, policyDigest: 'q' }, attempt, 'owner'), undefined);
  assert.equal(grantedApproval({ ...grant, verifiedDigest: undefined }, attempt, 'owner'), undefined);
  assert.equal(grantedApproval({ ...grant, verifiedDigest: 'different-files' }, attempt, 'owner'), undefined);
  assert.equal(grantedApproval(grant, { ...attempt, check: null }, 'owner'), undefined);
  assert.deepEqual(grantedApproval({ ...grant, attemptId: 'a1', paths: null }, attempt, 'owner'), owner);
});

/** A Lane with no protected path whose builder (the owner's device, an agent) asks for approval. */
async function requestedLane(t) {
  syntheticR2(t);
  const f = await finishFixture(t);
  f.patch('hostedProjects', f.projectId, { visibility: 'public' });
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  syntheticDevice(f);
  const laneId = f.lane.laneId;
  const ask = {
    projectId: f.projectId,
    operationId: randomUUID(),
    laneId,
    reason: 'touches the billing migration; please look first',
  };
  const requested = JSON.parse(await f.tx('request', approvals.request, ask, device));
  const read = async () =>
    JSON.parse(await f.tx('observe', approvals.observe, { projectId: f.projectId, laneId }, device));
  const decide = async (decision, head, actor = 'owner', reason) =>
    JSON.parse(
      await f.tx(
        'decide',
        approvals.decide,
        {
          projectId: f.projectId,
          operationId: randomUUID(),
          laneId,
          decision,
          head,
          ...(reason ? { reason } : {}),
        },
        actor,
      ),
    );
  return { f, laneId, ask, requested, read, decide };
}
const hold = async f => {
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  return { state, read: await f.current(state.id) };
};

test('a builder requests approval on a saved Lane: one row, a project board note, a replay-safe reply', async t => {
  const { f, laneId, ask, requested, read, decide } = await requestedLane(t);
  assert.equal(requested.status, 'requested');
  assert.equal(requested.reason, ask.reason);
  assert.equal(requested.head, f.lane.head);
  assert.equal(
    requested.url,
    `https://forge.example.invalid/approve?project=${encodeURIComponent(f.projectId)}&lane=${laneId}`,
  );
  assert.match(requested.next, /wait '\{"approval":"/);
  assert.deepEqual(JSON.parse(await f.tx('requestReplay', approvals.request, ask, device)), requested);
  assert.equal(f.tables.projectHostedApprovals.size, 1);
  const notes = [...f.tables.projectBoardMessages.values()];
  assert.equal(notes.length, 1, 'the replay posts no second note');
  assert.equal(notes[0].targetKey, 'project');
  assert.match(notes[0].body, /Approval requested on Lane .*billing migration/);
  assert.equal((await read()).status, 'requested');
  // Another member cannot request on a Lane that is not theirs; a reason is required.
  await assert.rejects(
    f.tx('requestOther', approvals.request, { ...ask, operationId: randomUUID() }, 'contributor'),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    f.tx('requestEmpty', approvals.request, { ...ask, operationId: randomUUID(), reason: '  ' }, device),
    code('BAD_ARGUMENT'),
  );
  assert.equal(f.pending().length, 0, 'a request leaves no idle task');
  // Real reasons and the owner link exceed one board note (240 chars): the reason is shortened, the
  // note still posts with the whole link (live proof 2026-11-09: a 255-char note was skipped).
  const long = 'x'.repeat(500);
  await f.tx('requestLong', approvals.request, { ...ask, operationId: randomUUID(), reason: long }, device);
  const second = [...f.tables.projectBoardMessages.values()].at(-1);
  assert.equal(f.tables.projectBoardMessages.size, 2);
  assert.ok([...second.body].length <= 240, second.body);
  assert.ok(second.body.endsWith(` Owner: ${requested.url}`));
  assert.match(second.body, /x…/);
  await decide('decline', f.lane.head, 'owner', long);
  const decision = [...f.tables.projectBoardMessages.values()].at(-1);
  assert.equal(decision.targetKey, `lane:${laneId}`);
  assert.ok([...decision.body].length <= 240 && decision.body.endsWith('request-approval again.'));
});

test('landing a Lane with an open request holds after its check, names the reason, and agents cannot decide', async t => {
  const { f, read: approval, decide } = await requestedLane(t);
  const { state, read } = await hold(f);
  assert.equal(read.submission.observation.pendingReason, 'waiting-for-review');
  assert.equal(read.submission.error.code, 'REVIEW_REQUIRED');
  assert.match(read.submission.error.message, /approval requested on Lane .*billing migration/);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  for (const actor of [device, 'contributor'])
    await assert.rejects(decide('grant', f.lane.head, actor), code('PROJECT_UNAVAILABLE'));
  assert.equal((await approval()).status, 'requested');
  // A grant for a head the owner did not see is refused.
  await assert.rejects(decide('grant', '0'.repeat(64)), code('WORK_STALE'));
  // The owner's one grant on the Lane approves the held landing: it lands as the owner.
  const granted = await decide('grant', f.lane.head);
  assert.equal(granted.approval.status, 'granted');
  assert.equal(granted.landing.status, 'landed');
  assert.deepEqual(granted.landing.receipt.actor, { id: 'owner', kind: 'person' });
  await f.drain();
  assert.equal((await f.current(state.id)).submission.observation.state, 'landed');
  const after = await approval();
  assert.equal(after.live, false, 'landing with the grant ends the request');
  assert.equal(after.ended.kind, 'landed');
});

test('a grant before landing lets that exact Lane head land without a hold', async t => {
  const { f, read: approval, decide } = await requestedLane(t);
  assert.equal((await decide('grant', f.lane.head)).landing, null);
  const { read } = await hold(f);
  assert.equal(read.submission.observation.state, 'landed');
  assert.equal((await approval()).ended.kind, 'landed');
});

test('approving the held landing directly also grants the Lane request; declining declines it', async t => {
  {
    const { f, read: approval } = await requestedLane(t);
    const { read } = await hold(f);
    const selection = {
      projectId: f.projectId,
      submissionId: read.submission.id,
      attemptId: read.submission.attemptId,
    };
    assert.equal(JSON.parse(await f.tx('approve', acceptance.approve, selection)).status, 'landed');
    const after = await approval();
    assert.equal(after.status, 'granted');
    assert.equal(after.decision.via, 'landing');
    assert.equal(after.live, false);
  }
  {
    const { f, read: approval, decide } = await requestedLane(t);
    const { state } = await hold(f);
    const declined = await decide('decline', f.lane.head, 'owner', 'split the migration first');
    assert.equal(declined.approval.status, 'declined');
    assert.equal(declined.landing.error.code, 'REVIEW_DECLINED');
    await f.drain();
    assert.equal((await f.current(state.id)).submission.observation.state, 'terminal-failed');
    const after = await approval();
    assert.equal(after.decision.reason, 'split the migration first');
    assert.equal(after.live, true, 'a declined request still holds the next landing');
    const lane = [...f.tables.projectBoardMessages.values()].find(
      row => row.targetKey === `lane:${f.lane.laneId}`,
    );
    assert.match(lane.body, /declined the approval request.*split the migration first/);
  }
});

test('both exact grant paths retain the reason and deliver one Lane notice for multiline text', async t => {
  for (const via of ['landing', 'lane']) {
    const { f, laneId, read: approval, decide } = await requestedLane(t);
    const { read } = await hold(f);
    const reason = 'Release verified.\n\tMigration checked.';
    if (via === 'landing') {
      const result = JSON.parse(
        await f.tx('approveWithReason', acceptance.approve, {
          projectId: f.projectId,
          submissionId: read.submission.id,
          attemptId: read.submission.attemptId,
          reason,
        }),
      );
      assert.equal(result.status, 'landed');
    } else {
      assert.equal((await decide('grant', f.lane.head, 'owner', reason)).landing.status, 'landed');
    }
    const after = await approval();
    assert.equal(after.status, 'granted');
    assert.match(after.decision.reason, /Release verified\.\s+Migration checked\./);
    const notices = [...f.tables.projectBoardMessages.values()].filter(
      row => row.targetKey === `lane:${laneId}`,
    );
    assert.equal(notices.length, 1, `${via} grant must notify the requester`);
    assert.match(notices[0].body, /granted the approval request.*Release verified\. Migration checked\./);
  }
});

test('the requester withdraws the request and the Lane lands as before', async t => {
  const { f, laneId, read: approval } = await requestedLane(t);
  const withdrawn = JSON.parse(
    await f.tx('withdraw', approvals.withdraw, { projectId: f.projectId, laneId }, device),
  );
  assert.equal(withdrawn.live, false);
  assert.equal(withdrawn.ended.kind, 'withdrawn');
  assert.equal((await hold(f)).read.submission.observation.state, 'landed');
  assert.equal((await approval()).ended.kind, 'withdrawn');
});

test('a held landing names the policy it is pinned to; a policy edit re-reads only on approval', async t => {
  const { f, state, select } = await heldLanding(t);
  f.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  f.patch('hostedProjects', f.projectId, { visibility: 'private' });
  const input = { projectId: f.projectId, submissionId: state.id, priorityInfo: 1 };
  const bySubmission = (actor = device) =>
    f.tx('observeSubmission', finish.status, input, actor).then(JSON.parse);
  await assert.rejects(bySubmission('other'), code('PROJECT_UNAVAILABLE'));
  for (const operationId of [state.operationId, randomUUID()])
    await assert.rejects(
      f.tx('privateHold', observe.page, { projectId: f.projectId, operationId, nextVersion: 0 }, 'other'),
      code('PROJECT_UNAVAILABLE'),
    );
  const linkOf = async label =>
    JSON.parse(
      await f.tx(label, review.link, { projectId: f.projectId, operationId: state.operationId }, device),
    );
  const pinned = await linkOf('linkPinned');
  assert.equal(pinned.policy.changed, false);
  assert.equal(typeof pinned.policy.attempt, 'number');
  assert.match(pinned.policyNote, /^Pinned to the landing policy of attempt \d+ .*only on a fresh attempt/);
  const readPage = () =>
    f
      .tx(
        'observerBudgetPage',
        observe.page,
        { projectId: f.projectId, operationId: state.operationId, nextVersion: 0 },
        device,
      )
      .then(JSON.parse);
  const ordinaryStatus = () =>
    f
      .tx('landingStatus', landingApi.status, { projectId: f.projectId, submissionId: state.id }, device)
      .then(JSON.parse);
  const current = await ordinaryStatus();
  const unchanged = await readPage();
  const heldCost = f.counts.at(-1);
  t.diagnostic(`held finish indexed reads: ${heldCost.ranges}`);
  assert.equal(unchanged.submission.error.message, current.request.error.message);
  assert.doesNotMatch(unchanged.submission.error.message, /policy changed since/);
  const directPinned = await bySubmission();
  const directPinnedCost = f.counts.at(-1);
  t.diagnostic(`held submission observe indexed reads: ${directPinnedCost.ranges}`);
  assert.deepEqual(directPinned.policy, pinned.policy);
  assert.equal(directPinned.policyNote, pinned.policyNote);
  assert.equal(directPinned.submission.error.message, unchanged.submission.error.message);
  const edit = fields =>
    f.tx('editHeldPolicy', setPolicy, {
      projectId: f.projectId,
      command: JSON.stringify({ action: 'set-policy', operationId: randomUUID(), ...fields }),
    });
  await edit({ notify: { awaySummary: false } });
  assert.equal((await readPage()).submission.error.message, current.request.error.message);
  const isCurrent = f.readSet();
  await edit({ governanceVersion: 1, acceptance: { ownerApprovalPaths: ['selected.txt', 'other.txt'] } });
  assert.equal(isCurrent(), false, 'a changed landing policy invalidates the held wait');
  const link = await linkOf('linkStale');
  assert.equal(link.policy.changed, true);
  assert.match(link.policyNote, /policy changed since.*holds for the owner once more/);
  const page = await readPage();
  for (const { ranges, readRangesByTable, writes } of [heldCost, f.counts.at(-1)]) {
    assert.equal(
      readRangesByTable.hostedProjects,
      1,
      'a hold authorizes and reads its current policy together',
    );
    assert(ranges <= 15, 'the held finish wait adds no reads over its baseline');
    assert.equal(writes, 0);
  }
  assert.equal(page.submission.error.message, (await ordinaryStatus()).request.error.message);
  const directChanged = await bySubmission();
  const directChangedCost = f.counts.at(-1);
  for (const { ranges, readRangesByTable, writes } of [directPinnedCost, directChangedCost]) {
    assert(ranges <= 15, 'held submission observe stays within the held finish budget');
    assert.equal(readRangesByTable.hostedProjects, 1, 'the authorized project row supplies the policy');
    assert.equal(readRangesByTable.projectHostedLandingAttempts, 1, 'only the held attempt is read');
    assert.equal(writes, 0);
  }
  assert.deepEqual(directChanged.policy, link.policy);
  assert.equal(directChanged.policyNote, link.policyNote);
  assert.equal(directChanged.submission.error.message, page.submission.error.message);
  const directHold = hostedObservationContinuation('/tmp/root', directChanged).hold;
  assert.equal(directHold.kind, 'review');
  assert.equal(directHold.reason, page.submission.error.message);
  assert.deepEqual(directHold.paths, ['selected.txt']);
  assert.equal(
    page.events.find(event => event.submission.version === page.submission.version)?.submission.error.message,
    page.submission.error.message,
  );
  assert.match(
    page.submission.error.message,
    /protected paths selected\.txt.*Pinned to the landing policy.*changed since/,
  );
  const held = await select();
  const reply = JSON.parse(await f.tx('approvePolicy', acceptance.approve, held));
  assert.equal(reply.status, 'pending');
  assert.match(reply.reason, /policy changed/);
  assert.equal(f.tables.projectHostedAcceptances.size, 0, 'the old-policy attempt never lands');
  await f.drain();
  await f.passChecks();
  await f.drain();
  const fresh = await f.current(state.id);
  assert.notEqual(fresh.submission.attemptId, held.attemptId);
  // The new policy still protects selected.txt: the fresh attempt holds once more for the owner.
  assert.equal(fresh.submission.observation.pendingReason, 'waiting-for-review');
  assert.doesNotMatch(fresh.submission.error.message, /changed since/);
  const landed = JSON.parse(await f.tx('approveFresh', acceptance.approve, await select()));
  assert.equal(landed.status, 'landed');
});

test('observing a submission outside owner review adds no policy lookup or idle work', async t => {
  syntheticR2(t);
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  const read = async (phase, baseline) => {
    const reply = await f.current(state.id);
    const { ranges, readRangesByTable, writes } = f.counts.at(-1);
    t.diagnostic(`${phase} submission observe indexed reads: ${ranges}`);
    assert(ranges <= baseline, `${phase} observe stays within its existing read budget`);
    assert.equal(reply.submission.phase, phase);
    assert.equal(reply.policy, undefined);
    assert.equal(reply.policyNote, undefined);
    assert.equal(readRangesByTable.projectHostedLandingAttempts, undefined);
    assert.equal(writes, 0);
  };
  await read('queued', 8);
  await f.drain();
  await read('checking', 6);
  await f.passChecks();
  await f.drain();
  await read('landed', 5);
  assert.equal(f.pending().length, 0);
});

test('991a1a94 replay: path lifted while held, main moves, the owner approves: it lands without review in the submitter name', async t => {
  const { f, state, select } = await heldLanding(t);
  const held = await select();
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  f.moveMain();
  // Main is compared before the policy: the reply still says the policy changed.
  const reply = JSON.parse(await f.tx('approveLifted', acceptance.approve, held));
  assert.equal(reply.status, 'pending');
  assert.match(reply.reason, /policy changed.*lands without review.*names the submitter/);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const landed = await f.current(state.id);
  assert.equal(landed.submission.observation.state, 'landed');
  const [receipt] = [...f.tables.projectHostedAcceptances.values()].map(row => JSON.parse(row.value));
  assert.equal(receipt.attemptId, landed.submission.attemptId);
  assert.equal(receipt.actor.kind, 'agent', 'the approval was for the old policy; the new one needs none');
  const by = landed.submission.acceptance.acceptedBy;
  assert.equal(by.kind, 'auto', 'an automatic acceptance says so: no person reviewed it');
  assert.equal(by.actor, 'owner');
  assert.match(by.note, /no person reviewed it/);
  assert.equal(
    [...f.tables.projectBoardMessages.values()].filter(note => /a person\) accepted/.test(note.body)).length,
    0,
    'an automatic acceptance posts no acceptance note',
  );
});

test('6b6f17e7 replay: held for review, the owner accepts, main moved, it re-checks and lands; observe shows the person', async t => {
  const { f, state, select } = await heldLanding(t);
  const held = await select();
  const attempt = [...f.tables.projectHostedLandingAttempts.values()]
    .map(row => JSON.parse(row.value))
    .find(value => value.id === held.attemptId);
  f.moveMain();
  const reply = JSON.parse(await f.tx('ownerAccepts', acceptance.approve, held));
  assert.equal(reply.status, 'pending');
  assert.match(reply.reason, /main moved/);
  const grantAt = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id)
    .ownerGrant.at;
  await f.drain();
  await f.passChecks();
  await f.drain();
  // The builder's own read of its landing (device credential = agent), exactly as in the incident.
  // The re-check moved the fixture clock past the synthetic credential's hour.
  for (const row of f.tables.cliCredentials.values()) row.expiresAt = Date.now() + 60 * 60_000;
  const page = JSON.parse(
    await f.tx(
      'observeLanded',
      observe.page,
      { projectId: f.projectId, operationId: state.operationId, nextVersion: 0 },
      device,
    ),
  );
  const { submission } = page;
  assert.equal(submission.observation.state, 'landed');
  assert.notEqual(submission.attemptId, held.attemptId, 'it landed on a fresh attempt');
  // The submitter and the owner share one handle: actor alone cannot tell who accepted it.
  assert.equal(submission.actor, 'owner');
  const by = submission.acceptance.acceptedBy;
  assert.equal(by.kind, 'person', 'observe names the person acceptance');
  assert.equal(by.actor, 'owner');
  assert.equal(by.at, new Date(grantAt).toISOString(), 'the time the person accepted, not the landing time');
  assert.equal(by.head, attempt.candidate.head, 'the Candidate head the person accepted');
  assert.deepEqual(by.paths, ['selected.txt'], 'the protected paths the person reviewed');
  assert.equal(by.carried, true, 'main moved: the same source was checked again and landed with it');
  // The landing receipt line the CLI prints after LANDED.
  const lines = landSummary({ result: { phase: 'finish', submission } });
  assert.match(lines[0], /^LANDED receipt /);
  assert.match(
    lines[1],
    /^ACCEPTED BY A PERSON @owner: A person accepted it at .*protected paths selected\.txt.*checked again/,
  );
  assert.doesNotMatch(by.note, /owner/, 'the note names nobody; actor carries the public handle');
  // The board: the landing's Lane gets one note, once.
  const notes = [...f.tables.projectBoardMessages.values()].filter(note =>
    /a person\) accepted/.test(note.body),
  );
  assert.equal(notes.length, 1);
  assert.match(
    notes[0].body,
    /^@owner \(a person\) accepted this landing at .*protected paths selected\.txt/,
  );
  assert.match(notes[0].targetKey, /^lane:/);
  assert.equal(f.pending().length, 0, 'nothing left running');
});

test('a fork PR head asks the owner once; only the owner person grants, which starts its run', async t => {
  syntheticR2(t);
  const f = await finishFixture(t);
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  syntheticDevice(f);
  const { forkGate } = await import(moduleUrl('../convex/projectGithubPullFork.ts'));
  const { liveApprovals } = await import(moduleUrl('../convex/projectHostedApprovalStore.ts'));
  const { forkStatus, forkApprovalTtlMs } = await import('../dist/github-pull-check.js');
  const laneId = f.lane.laneId,
    head = 'b'.repeat(40),
    projectId = f.projectId;
  const jobId = f.insert('projectGithubMirrorJobs', {
    projectId,
    receiptId: `pull:${randomUUID()}`,
    sequence: 0.5,
    repository: 'synthetic/mirror',
    authorityEpoch: 1,
    status: 'done',
    step: 1,
    cursor: null,
    state: '0'.repeat(64),
    pullKey: '7',
    waitKey: randomUUID(),
    inbound: JSON.stringify({ phase: 'checking', pull: { number: 7, head, fork: true }, laneId }),
  });
  const gate = label =>
    f.tx(
      label,
      { _handler: async ctx => forkGate(ctx, await ctx.db.get(jobId), await ctx.db.get(projectId)) },
      {},
    );
  const tasks = name => f.pending().filter(task => task.name === name);
  assert.equal(await gate('forkAsk'), false, 'a fork head never runs before the grant');
  const rows = () => [...f.tables.projectHostedApprovals.values()];
  assert.equal(rows().length, 1);
  const [row] = rows();
  assert.equal(row.live, false, 'it holds no landing');
  assert.equal(row.pullRequest, 7);
  assert.equal(row.status, 'requested');
  assert.equal(row.head, f.lane.head);
  assert.match(row.reason, /GitHub PR #7 from a fork/);
  const job = f.tables.projectGithubMirrorJobs.get(jobId);
  const approval = JSON.parse(job.inbound).pull.approval;
  assert.equal(job.waitKey, approval, 'the head waits on its request');
  const url = `https://forge.example.invalid/approve?project=${encodeURIComponent(projectId)}&lane=${laneId}`;
  assert.deepEqual(
    tasks('projectGithubPullStatus:post').map(task => task.args[0]),
    [
      {
        projectId,
        repository: 'synthetic/mirror',
        sha: head,
        state: 'pending',
        description: forkStatus.pending,
        link: url,
        checked: true,
      },
    ],
    'one pending status with the approve link',
  );
  const [expiry] = tasks('projectGithubPullQueue:expire');
  assert.deepEqual(expiry.args[0], { jobId, key: approval });
  const notes = () => [...f.tables.projectBoardMessages.values()];
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].targetKey, 'project');
  assert.ok(notes()[0].body.endsWith(` Owner: ${url}`));
  // Any other wake while it waits changes nothing.
  assert.equal(await gate('forkWait'), false);
  assert.equal(rows().length, 1);
  assert.equal(notes().length, 1);
  assert.equal(tasks('projectGithubPullStatus:post').length, 1);
  // The landing gate never reads it.
  assert.deepEqual(await f.tx('live', { _handler: ctx => liveApprovals(ctx, projectId) }, {}), []);
  const read = JSON.parse(await f.tx('observe', approvals.observe, { projectId, laneId, detail: 1 }, device));
  assert.equal(read.live, true, 'open on the approve page');
  assert.equal(read.pullRequest, 7);
  assert.equal(read.currentHead, f.lane.head);
  assert.equal(read.url, url);
  const decide = (decision, actor = 'owner') =>
    f.tx(
      'decide',
      approvals.decide,
      { projectId, operationId: randomUUID(), laneId, decision, head: f.lane.head },
      actor,
    );
  for (const actor of [device, 'contributor'])
    await assert.rejects(decide('grant', actor), code('PROJECT_UNAVAILABLE'));
  assert.equal(tasks('projectGithubPull:start').length, 0);
  const granted = JSON.parse(await decide('grant'));
  assert.equal(granted.approval.status, 'granted');
  assert.deepEqual(
    tasks('projectGithubPull:start').map(task => task.args[0]),
    [{ jobId, key: approval }],
    'the grant starts the run',
  );
  assert.equal(notes().length, 1, 'the PR head status carries the decision, not a Lane note');
  await assert.rejects(decide('decline'), code('WORK_STALE'));
  // The started check closes the request and says it started.
  assert.equal(await gate('forkRun'), true);
  assert.equal(rows()[0].ended.kind, 'settled');
  assert.equal(rows()[0].live, false);
  assert.equal(tasks('projectGithubPullStatus:post').at(-1).args[0].description, forkStatus.started);
  assert.equal(await gate('forkRunAgain'), false, 'one run per grant');
  const [asked] = tasks('projectGithubPullStatus:post');
  assert.equal(expiry.scheduledTime - asked.scheduledTime, forkApprovalTtlMs, 'expires in 30 days');
});

// SM-D machine M3 (owner approval requests). Bug M3-a: `list` returned only stored `live` rows, so open
// fork pull request run requests and held settings changes (never live) were missing from it, and no
// surface told the owner about any request except a board note.
test('M3 list: every open request kind (Lane, fork run, held settings) with a derived state; ended ones are not listed', async t => {
  const { f, laneId } = await requestedLane(t);
  const row = fields => ({
    projectId: f.projectId,
    operationId: randomUUID(),
    requester: 'owner',
    reason: 'synthetic reason',
    head: 'a'.repeat(64),
    at: Date.now(),
    status: 'requested',
    live: false,
    version: 1,
    ...fields,
  });
  f.insert('projectHostedApprovals', row({ laneId: 'fork-open', pullRequest: 12 }));
  f.insert(
    'projectHostedApprovals',
    row({ laneId: 'fork-done', pullRequest: 13, ended: { kind: 'settled', at: 1 } }),
  );
  // A declined settings change stays open: the owner can still grant it, but it no longer waits for them.
  f.insert(
    'projectHostedApprovals',
    row({
      laneId: 'setting:policy',
      setting: { origin: 'policy', request: '{}' },
      status: 'declined',
      decision: { operationId: randomUUID(), by: 'owner', at: 2, head: 'a'.repeat(64), via: 'lane' },
    }),
  );
  f.insert(
    'projectHostedApprovals',
    row({
      laneId: 'setting:runner',
      setting: { origin: 'runner', request: '{}' },
      ended: { kind: 'applied', at: 3 },
    }),
  );
  f.insert('projectHostedApprovals', row({ laneId: 'lane-withdrawn', ended: { kind: 'withdrawn', at: 4 } }));
  const listed = JSON.parse(await f.tx('list', approvals.list, { projectId: f.projectId }, 'owner'));
  assert.equal(listed.complete, true);
  const byLane = Object.fromEntries(listed.requests.map(request => [request.laneId, request]));
  assert.deepEqual(Object.keys(byLane).sort(), [laneId, 'fork-open', 'setting:policy'].sort());
  assert.deepEqual(
    [byLane[laneId], byLane['fork-open'], byLane['setting:policy']].map(r => [r.kind, r.state, r.needsOwner]),
    [
      ['lane', 'requested', true],
      ['fork', 'requested', true],
      ['setting', 'declined', false],
    ],
  );
  for (const request of listed.requests) {
    assert.ok(request.label && request.nextStep && request.tone, `${request.laneId} carries its words`);
    assert.equal(request.live, true, 'existing fields keep their meaning: live reads as open');
    assert.match(request.url, /^https:\/\/forge\.example\.invalid\/approve\?project=/);
  }
});
// Item 4f1f7984: the list read the newest 100 not-live rows, a window shared with closed Lane rows, so
// enough abandoned/withdrawn Lanes pushed a pending fork request out of Needs me (complete:false).
test('4f1f7984 list: a pending fork request is still listed after 150 newer closed rows', async t => {
  const { f, laneId } = await requestedLane(t);
  const row = fields => ({
    projectId: f.projectId,
    operationId: randomUUID(),
    requester: 'owner',
    reason: 'synthetic reason',
    head: 'a'.repeat(64),
    status: 'requested',
    live: false,
    version: 1,
    ...fields,
  });
  // The pending fork request is the oldest row; 150 closed rows come after it.
  f.insert('projectHostedApprovals', row({ laneId: 'fork-pending', pullRequest: 7, at: 1 }));
  for (let i = 0; i < 150; i++)
    f.insert(
      'projectHostedApprovals',
      row({ laneId: `closed-${i}`, at: 10 + i, ended: { kind: 'settled', at: 10 + i } }),
    );
  const listed = JSON.parse(await f.tx('list', approvals.list, { projectId: f.projectId }, 'owner'));
  assert.deepEqual(listed.requests.map(request => request.laneId).sort(), [laneId, 'fork-pending'].sort());
  assert.equal(listed.complete, true, 'closed history never fills the pending page');
});
test('M3 derive: kind and phase for each request, one row per phase, unknown is never open', () => {
  const lane = { status: 'requested', live: true };
  const row = (record, kind, state, open, needsOwner) => {
    const got = deriveApproval(record);
    assert.deepEqual([got.kind, got.state, got.open, got.needsOwner], [kind, state, open, needsOwner]);
    assert.ok(got.label && got.nextStep);
  };
  row(lane, 'lane', 'requested', true, true);
  row({ ...lane, status: 'granted' }, 'lane', 'granted', true, false);
  row({ ...lane, status: 'declined' }, 'lane', 'declined', true, false);
  row({ status: 'granted', live: false, ended: { kind: 'landed' } }, 'lane', 'landed', false, false);
  row({ status: 'requested', live: false, ended: { kind: 'withdrawn' } }, 'lane', 'withdrawn', false, false);
  // Fork and settings requests are never stored live; open means not ended.
  row({ status: 'requested', live: true, pullRequest: 4 }, 'fork', 'requested', true, true);
  row(
    { status: 'requested', live: true, pullRequest: 4, ended: { kind: 'settled' } },
    'fork',
    'settled',
    false,
    false,
  );
  row({ status: 'declined', live: true, setting: { origin: 'runner' } }, 'setting', 'declined', true, false);
  row(
    { status: 'granted', live: false, setting: {}, ended: { kind: 'applied' } },
    'setting',
    'applied',
    false,
    false,
  );
  // Records that fit no writer are "can't confirm", not open and not closed.
  row({ status: 'requested', live: false }, 'lane', 'unknown', false, false);
  row({ status: 'mystery', live: true }, 'lane', 'unknown', false, false);
  row({ status: 'granted', live: false, ended: { kind: 'future-kind' } }, 'lane', 'unknown', false, false);
});

test('W7: a decision outranks how the request ended, in the same branch order as `wait {approval}`', () => {
  const lane = { status: 'granted', live: false };
  const phase = (record, state) => assert.equal(deriveApproval(record).state, state, JSON.stringify(record));
  // The old Lane page read `!live` first: a granted request that had ended said the builder withdrew it.
  phase({ ...lane, ended: { kind: 'settled' } }, 'granted');
  phase({ ...lane, ended: { kind: 'withdrawn' } }, 'granted');
  phase({ ...lane, ended: { kind: 'landed' } }, 'landed');
  phase({ ...lane, ended: { kind: 'applied' } }, 'applied');
  phase({ status: 'declined', live: false, ended: { kind: 'withdrawn' } }, 'declined');
  phase({ status: 'requested', live: false, ended: { kind: 'withdrawn' } }, 'withdrawn');
  phase({ status: 'requested', live: false, ended: { kind: 'settled' } }, 'settled');
  phase({ status: 'requested', live: true, pullRequest: 7, ended: { kind: 'settled' } }, 'settled');
  phase({ status: 'granted', live: false, pullRequest: 7, ended: { kind: 'settled' } }, 'granted');
  // An ended request is not open, whatever was decided; an undecided open one waits for the owner.
  assert.equal(deriveApproval({ ...lane, ended: { kind: 'settled' } }).open, false);
  assert.equal(deriveApproval({ status: 'requested', live: true }).needsOwner, true);
  // The CLI wait before this change, and now: one branch order for every row.
  const oracle = read =>
    read.status === 'granted' || read.status === 'declined'
      ? 'decided'
      : read.status === 'none' || read.live === false
        ? 'none'
        : 'waiting';
  const decisionPhases = new Set(['granted', 'declined', 'landed', 'applied']);
  for (const status of ['none', 'requested', 'granted', 'declined'])
    for (const live of [undefined, true, false])
      for (const ended of [undefined, 'landed', 'withdrawn', 'settled', 'applied'])
        for (const extra of [{}, { pullRequest: 7 }, { setting: { origin: 'policy' } }]) {
          const read = { status, live, ...(ended ? { ended: { kind: ended } } : {}), ...extra };
          assert.equal(approvalWait(read), oracle(read), JSON.stringify(read));
          // `landed` and `applied` follow a grant; no writer ends an undecided request that way.
          if (status !== 'none' && !(status === 'requested' && ['landed', 'applied'].includes(ended)))
            assert.equal(
              approvalWait(read) === 'decided',
              decisionPhases.has(deriveApproval({ ...read, live: live ?? true }).state),
              `wait and page agree on ${JSON.stringify(read)}`,
            );
        }
});
