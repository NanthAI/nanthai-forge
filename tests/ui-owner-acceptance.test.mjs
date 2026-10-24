// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { ownerDecisionLabel, ownerDecisionState, ownerRecovery } = await import(
  moduleUrl('../web/src/lane/owner-decision-model.ts')
);
const { revertPrompt } = await import(moduleUrl('../web/src/lane/RevertAcceptance.tsx'));
test('native review reports requests, named waiting and rejections; only a local accepted receipt completes it', () => {
  assert.equal(ownerDecisionLabel({ justRequested: true }), 'Requested');
  assert.equal(ownerDecisionLabel({ state: 'requested', machineName: 'Owner Mac' }), 'Waiting for Owner Mac');
  assert.equal(
    ownerDecisionLabel({ state: 'rejected', reason: 'Needs re-check: paths overlap.' }),
    'Not accepted: Needs re-check: paths overlap.',
  );
  assert.equal(ownerDecisionLabel({ state: 'accepted' }), 'Accepted into main');
  assert.doesNotMatch(ownerDecisionLabel({}), /Accepted/);
});
test('revert handoff pins the original acceptance and requests a checked compensating Lane without rewinding main', () => {
  const prompt = revertPrompt(
    { id: 'acceptance', viewId: 'view', head: 'accepted', previous: 'before' },
    'intent',
  );
  for (const pin of ['acceptance', 'view', 'accepted', 'before', 'intent']) assert.ok(prompt.includes(pin));
  assert.match(prompt, /reverse.*diff/);
  assert.match(prompt, /preserving later accepted work/);
  assert.match(prompt, /check.*new exact Candidate/);
  assert.match(prompt, /Main must never be rewound/);
});

test('Review header and panel share all owner request states and optimistic acknowledgements', () => {
  assert.equal(ownerDecisionState({}).label, 'Ready');
  assert.equal(ownerDecisionState({ state: 'requested' }).label, 'Requested');
  assert.equal(ownerDecisionState({ state: 'requested', machineName: 'Mac' }).label, 'Waiting for Mac');
  assert.equal(ownerDecisionState({ state: 'accepted' }).label, 'Accepted');
  assert.equal(ownerDecisionState({ state: 'rejected' }).label, 'Not accepted');
  assert.equal(ownerDecisionState({ state: 'rejected', optimistic: true }).label, 'Requested');
});
test('overlap recovery recomposes/checks; only transient failures offer request again', () => {
  assert.equal(ownerRecovery({ code: 'NEEDS_RECHECK' }), 'recheck');
  assert.equal(
    ownerRecovery({ reason: 'Needs re-check: main moved and changed paths overlap the requested View.' }),
    'recheck',
  );
  assert.equal(ownerRecovery({ code: 'OWNER_UNAVAILABLE' }), 'retry');
  assert.equal(ownerRecovery({ code: 'OWNER_ACCEPT_FAILED' }), 'retry');
  assert.equal(ownerRecovery({ code: 'REVIEW_REQUIRED' }), 'none');
  assert.equal(ownerRecovery({ code: 'VIEW_STALE' }), 'none');
});
