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
const acceptance = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
const review = await import(moduleUrl('../convex/projectHostedOwnerReview.ts'));
const { grantedApproval } = await import(moduleUrl('../convex/projectHostedOwnerGrant.ts'));
const { OwnerApproval } = await import(moduleUrl('../web/src/review/OwnerApproval.tsx'));

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
/** A public project whose owner agent's finish touches a protected path: checked, then held. */
async function heldLanding(t) {
  syntheticR2(t);
  const f = await finishFixture(t);
  const policy = policyPreset('trusted');
  policy.acceptance.ownerApprovalPaths = ['selected.txt'];
  f.patch('hostedProjects', f.projectId, { visibility: 'public', autonomyPolicy: policy });
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
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
