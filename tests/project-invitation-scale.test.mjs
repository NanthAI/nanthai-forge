// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { contributors, inbox, access, refusal } from './invitation-fixture.mjs';
const day = 86400000;
function seed(total) {
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    owner: 'owner',
    name: 'Synthetic project',
    key: 'synthetic',
    slug: 'tools',
    currentBackup: null,
    revision: 0,
  });
  f.insert('forgeAccounts', { owner: 'owner', handle: 'olive' });
  f.insert('users', { accountKey: 'owner', email: 'owner@example.test', emailVerified: true });
  for (let i = 0; i < total; i++) {
    f.insert('forgeAccounts', { owner: `person-${i}`, handle: `person-${i}` });
    f.insert('projectContributors', { projectId, contributor: `person-${i}` });
    f.insert('projectInvites', {
      projectId,
      email: `@person-${i}`,
      kind: 'handle',
      recipient: 'guest',
      inviter: 'owner',
      role: 'read',
      operationId: `invitation-${i}`,
      state: 'pending',
      expiresAt: Date.now() + day,
    });
  }
  return { f, projectId };
}
test('People and recipient pages bound whole-document reads at 400 and 800 people; no per-invitation operation lookup', async () => {
  for (const total of [400, 800]) {
    const { f, projectId } = seed(total);
    const people = await f.call('People page', access.people, { projectId });
    assert.equal(people.write.rows.length, 50);
    assert.equal(people.invited.length, 50);
    assert.ok(people.invitationCursor);
    let count = f.counts.at(-1);
    assert.equal(count.readDocumentsByTable.projectAccessOperations ?? 0, 0);
    assert.ok(count.documents < 180 && count.readBytes < 80000, JSON.stringify(count));
    assert.equal(count.writes, 0);
    const first = await f.call('Recipient page', inbox.inbox, { kind: 'handle' }, 'guest');
    assert.equal(first.rows.length, 25);
    assert.ok(first.cursor);
    count = f.counts.at(-1);
    assert.ok(count.documents <= 125 && count.readBytes < 64000, JSON.stringify(count));
    assert.equal(count.writes, 0);
    const second = await f.call(
      'Recipient next page',
      inbox.inbox,
      { kind: 'handle', cursor: first.cursor },
      'guest',
    );
    assert.equal(new Set([...first.rows, ...second.rows].map(row => row.invitationId)).size, 50);
    console.log(
      JSON.stringify({
        people: total,
        recipientDocuments: count.documents,
        recipientBytes: count.readBytes,
        recipientRanges: count.ranges,
      }),
    );
  }
});
test('concurrent emails cannot overspend the deployment allowance; refusal rolls back all invitation and counter writes', async t => {
  const old = process.env.FORGE_INVITATION_EMAIL;
  process.env.FORGE_INVITATION_EMAIL = '1';
  t.after(() =>
    old === undefined
      ? delete process.env.FORGE_INVITATION_EMAIL
      : (process.env.FORGE_INVITATION_EMAIL = old),
  );
  const { f, projectId } = seed(0),
    now = Date.now();
  f.insert('deviceAttempts', { owner: 'invitation:deployment-day', count: 499, windowAt: now - (now % day) });
  const result = await Promise.allSettled(
    ['one@example.test', 'two@example.test'].map(person =>
      f.call('Concurrent invitation', contributors.invite, {
        projectId,
        owner: 'owner',
        person,
        operationId: randomUUID(),
      }),
    ),
  );
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.ok(refusal('RATE_LIMITED')(result.find(row => row.status === 'rejected').reason));
  assert.equal(f.tables.projectInvites.size, 1);
  assert.equal(
    [...f.tables.deviceAttempts.values()].find(row => row.owner === 'invitation:deployment-day').count,
    500,
  );
});

test('removing a member reads and writes constant metadata at 400 and 800 retained invitations', async () => {
  for (const total of [400, 800]) {
    const { f, projectId } = seed(total);
    await f.call('Remove member', access.setRole, {
      projectId,
      person: 'person-0',
      role: 'none',
      operationId: randomUUID(),
    });
    const count = f.counts.at(-1);
    assert.equal(count.readDocumentsByTable.projectInvites ?? 0, 0);
    assert.equal(count.writes, 4, 'one grant, recipient provenance, generation and retry receipt');
    assert.equal(f.tables.projectInvites.size, total);
    assert.equal(
      [...f.tables.projectActorNames.values()].find(row => row.actor === 'person-0')
        .invitationsEndedBeforeEpoch,
      1,
    );
    console.log(
      JSON.stringify({
        invitations: total,
        removalDocuments: count.documents,
        removalBytes: count.readBytes,
        removalWrites: count.writes,
        removalRanges: count.ranges,
      }),
    );
  }
});
