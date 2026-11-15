// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state, projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { deriveApproval } from '../dist/approval-state.js';
const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));
const store = await import(moduleUrl('../convex/projectHostedApprovalStore.ts'));
function fixture(change) {
  const s = state([]);
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
  test(`person approval applies the exact retained ${change.kind} request and reconciles a retry`, async () => {
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
    assert.equal(
      s.tables[
        change.kind === 'reader'
          ? 'projectReaders'
          : change.kind === 'invite'
            ? 'projectInvites'
            : 'projectContributors'
      ].size,
      1,
    );
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
