// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state, projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { deriveApproval } from '../dist/approval-state.js';
const answers = await import(moduleUrl('../convex/projectInvitationAnswers.ts'));
const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));
const store = await import(moduleUrl('../convex/projectHostedApprovalStore.ts'));
function fixture(change) {
  const s = state([]);
  s.tables.users.set('verified-owner', {
    _id: 'verified-owner',
    _creationTime: 1,
    accountKey: 'owner',
    email: 'owner@example.test',
    emailVerified: true,
  });
  for (const person of ['new-member', 'new-reader'])
    s.tables.forgeAccounts.set(person, { _id: person, _creationTime: 1, owner: person, handle: person });
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project' }));
  s.tables.projectHostedApprovals.set('request', {
    _id: 'request',
    _creationTime: 1,
    projectId: 'project',
    laneId: 'setting:membership:synthetic',
    operationId: randomUUID(),
    requester: 'owner',
    reason: 'Grant project access',
    head: 'a'.repeat(64),
    at: Date.now(),
    status: 'requested',
    live: false,
    setting: { origin: 'membership', request: JSON.stringify(change) },
    version: 1,
  });
  return s;
}
for (const change of [
  { kind: 'contributor', contributor: 'new-member' },
  { kind: 'reader', reader: 'new-reader', present: true, operationId: randomUUID() },
  { kind: 'invite', person: 'new@example.test', email: 'new@example.test', operationId: randomUUID() },
])
  test(`person approval invites the exact retained ${change.kind} request and reconciles a retry`, async () => {
    const s = fixture(change);
    const row = s.tables.projectHostedApprovals.get('request');
    assert.equal(deriveApproval(store.approvalView(row, row.laneId)).kind, 'setting');
    const input = {
      projectId: 'project',
      laneId: row.laneId,
      head: row.head,
      operationId: randomUUID(),
      decision: 'grant',
    };
    const result = JSON.parse(await approvals.decide._handler(s.ctx, input));
    assert.equal(result.approval.status, 'granted');
    assert.equal(result.approval.membership, true);
    assert.equal(result.approval.setting, undefined, 'existing setting origin enums do not change');
    assert.equal(result.applied.rule, 'owner-approved');
    assert.equal(s.tables.projectInvites.size, 1, 'owner approval creates a pending invitation');
    assert.equal(s.tables.projectContributors.size, 0);
    assert.equal(s.tables.projectReaders.size, 0);
    const invitation = [...s.tables.projectInvites.values()][0];
    const originalIdentity = s.ctx.auth.getUserIdentity;
    s.ctx.auth.getUserIdentity = async () => ({
      subject: change.contributor ?? change.reader ?? 'new-person',
      email: 'new@example.test',
      emailVerified: true,
    });
    await answers.answer._handler(s.ctx, {
      invitationId: invitation._id,
      operationId: randomUUID(),
      choice: 'accept',
    });
    s.ctx.auth.getUserIdentity = originalIdentity;
    assert.equal(s.tables[change.kind === 'reader' ? 'projectReaders' : 'projectContributors'].size, 1);
    assert.equal(JSON.parse(await approvals.decide._handler(s.ctx, input)).approval.status, 'granted');
  });
test('declines and stale request heads grant no membership', async () => {
  const s = fixture({ kind: 'contributor', contributor: 'new-member' });
  const row = s.tables.projectHostedApprovals.get('request');
  const input = {
    projectId: 'project',
    laneId: row.laneId,
    operationId: randomUUID(),
    decision: 'grant',
    head: 'b'.repeat(64),
  };
  await assert.rejects(approvals.decide._handler(s.ctx, input), e => e.data?.code === 'WORK_STALE');
  await approvals.decide._handler(s.ctx, {
    ...input,
    operationId: randomUUID(),
    head: row.head,
    decision: 'decline',
  });
  assert.equal(s.tables.projectContributors.size, 0);
});
