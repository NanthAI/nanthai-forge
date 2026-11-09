// SPDX-License-Identifier: Apache-2.0
// Issue fe5bea80: the owner accepts or declines a landing held for review in one step; agents never can.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
import { finishFixture, code } from './hosted-finish-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { landSummary } from '../dist/hosted-land-summary.js';
const acceptance = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
const review = await import(moduleUrl('../convex/projectHostedOwnerReview.ts'));
const { grantedApproval } = await import(moduleUrl('../convex/projectHostedOwnerGrant.ts'));
const { OwnerApproval } = await import(moduleUrl('../web/src/review/OwnerApproval.tsx'));
const { LaneApproval } = await import(moduleUrl('../web/src/review/LaneApproval.tsx'));
const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));

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
async function heldLanding(t) {
  syntheticR2(t);
  const f = await finishFixture(t);
  const policy = policyPreset('trusted');
  policy.acceptance.ownerApprovalPaths = ['selected.txt'];
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

test('agents, device sign-ins and contributors cannot approve or decline; the link names the hold', async t => {
  const { f, state, select } = await heldLanding(t);
  for (const actor of [device, 'contributor']) {
    await assert.rejects(
      f.tx('approveRefused', acceptance.approve, await select(), actor),
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

test('a retained grant carries only to identical source under the same policy, with a check and no new path', () => {
  const attempt = {
    id: 'a1',
    candidate: { inputs: { sha256: 'i', size: 1 }, dependencies: { sha256: 'd', size: 1 } },
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
    at: 0,
  };
  const owner = { kind: 'person', id: 'owner' };
  assert.deepEqual(grantedApproval(grant, attempt, 'owner', ['selected.txt']), owner);
  assert.equal(grantedApproval(undefined, attempt, 'owner', ['selected.txt']), undefined);
  assert.equal(grantedApproval(grant, attempt, 'someone-else', ['selected.txt']), undefined);
  assert.equal(
    grantedApproval({ ...grant, inputs: '{"sha256":"x","size":1}' }, attempt, 'owner', []),
    undefined,
  );
  assert.equal(grantedApproval({ ...grant, dependencies: '{}' }, attempt, 'owner', []), undefined);
  assert.equal(grantedApproval({ ...grant, policyDigest: 'q' }, attempt, 'owner', []), undefined);
  assert.equal(grantedApproval(grant, attempt, 'owner', ['selected.txt', 'new.yml']), undefined);
  assert.equal(grantedApproval(grant, attempt, 'owner', null), undefined);
  assert.equal(grantedApproval(grant, { ...attempt, check: null }, 'owner', []), undefined);
  // The exact approved attempt itself needs no extra condition.
  assert.deepEqual(
    grantedApproval({ ...grant, attemptId: 'a1', paths: null }, attempt, 'owner', null),
    owner,
  );
});

test('the /approve card shows Accept and Decline only for a held landing', () => {
  const noop = { accept() {}, decline() {} };
  const base = { id: randomUUID(), error: null, observation: { state: 'pending', pendingReason: 'queued' } };
  const render = request =>
    renderToStaticMarkup(
      createElement(OwnerApproval, {
        phase: { kind: 'read', request, agent: true },
        review: noop,
        signIn: null,
        reviewHref: '/review',
      }),
    );
  const heldCard = render({
    ...base,
    observation: { state: 'pending', pendingReason: 'waiting-for-review' },
    error: { code: 'REVIEW_REQUIRED', message: 'needs owner approval: protected paths selected.txt' },
  });
  assert.match(heldCard, /Accept into main/);
  assert.match(heldCard, /protected paths selected\.txt/);
  assert.doesNotMatch(render(base), /Accept into main/);
  assert.match(
    render({
      ...base,
      observation: { state: 'terminal-failed', pendingReason: null },
      error: { code: 'REVIEW_DECLINED', message: 'Declined by the project owner.' },
    }),
    /Declined/,
  );
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
  const linkOf = async label =>
    JSON.parse(
      await f.tx(label, review.link, { projectId: f.projectId, operationId: state.operationId }, device),
    );
  const pinned = await linkOf('linkPinned');
  assert.equal(pinned.policy.changed, false);
  assert.equal(typeof pinned.policy.attempt, 'number');
  assert.match(pinned.policyNote, /^Pinned to the landing policy of attempt \d+ .*only on a fresh attempt/);
  const policy = policyPreset('trusted');
  policy.acceptance.ownerApprovalPaths = ['selected.txt', 'other.txt'];
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  const link = await linkOf('linkStale');
  assert.equal(link.policy.changed, true);
  assert.match(link.policyNote, /policy changed since.*holds for the owner once more/);
  const page = JSON.parse(
    await f.tx(
      'observeStale',
      observe.page,
      { projectId: f.projectId, operationId: state.operationId, nextVersion: 0 },
      device,
    ),
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

test('the /approve?lane card offers Grant and Decline only for a live request', () => {
  const noop = { accept() {}, decline() {} };
  const render = approval =>
    renderToStaticMarkup(
      createElement(LaneApproval, { phase: { kind: 'read', approval }, review: noop, signIn: null }),
    );
  const base = {
    laneId: randomUUID(),
    live: true,
    reason: 'touches billing',
    requester: 'thevarsek',
    agent: 'ready-narwhal',
    landing: null,
  };
  const open = render({ ...base, status: 'requested' });
  assert.match(open, />Grant</);
  assert.match(open, /touches billing/);
  assert.match(open, /@thevarsek\/ready-narwhal/);
  assert.doesNotMatch(render({ ...base, status: 'granted' }), />Grant</);
  assert.match(render({ ...base, live: false, status: 'granted', ended: { kind: 'landed' } }), /Landed/);
  assert.match(render({ ...base, status: 'none', live: false }), /no approval request/);
});
