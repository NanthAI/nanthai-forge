// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { contributors, inbox, access } from './invitation-fixture.mjs';
const day = 86400000;
function seed(total, distinctRecipients = false) {
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
    const actor = `person-${i}`;
    f.insert('forgeAccounts', { owner: actor, handle: actor });
    f.insert('projectContributors', { projectId, contributor: actor });
    if (distinctRecipients) f.insert('projectActorNames', { projectId, actor, wasMember: true });
    f.insert('projectInvites', {
      projectId,
      email: `@${actor}`,
      kind: 'handle',
      recipient: distinctRecipients ? actor : 'guest',
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
test('Access settings pages invitation history with a distinct revocation record per invitee', async () => {
  for (const total of [400, 800]) {
    const { f, projectId } = seed(total, true);
    const first = await f.call('Access settings first invitation page', access.people, {
      projectId,
      limit: 1,
    });
    const next = await f.call('Access settings next invitation page', access.people, {
      projectId,
      limit: 1,
      invitationCursor: first.invitationCursor,
    });
    assert.equal(next.write.rows.length, 1);
    assert.equal(next.invited.length, 50);
    assert.equal(new Set([...first.invited, ...next.invited].map(row => row.id)).size, 100);
    const count = f.counts.at(-1);
    assert.equal(count.readDocumentsByTable.projectInvites, 50);
    assert.equal(count.readDocumentsByTable.projectActorNames, 50);
    assert.ok(count.documents < 120 && count.readBytes < 40000, JSON.stringify(count));
    assert.equal(count.writes, 0);
    console.log(
      JSON.stringify({
        invitations: total,
        accessSettingsDocuments: count.documents,
        accessSettingsBytes: count.readBytes,
      }),
    );
  }
});
test('concurrent emails cannot overspend the deployment allowance; the held one queues no send', async t => {
  storageClock(t);
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
  // P1-03: the deployment cap holds the mail; both invitations stay pending, one email is queued.
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 2);
  assert.equal(f.tables.projectInvites.size, 2);
  assert.deepEqual([...f.tables.projectInvites.values()].map(row => row.mail.status).sort(), [
    'failed',
    'sending',
  ]);
  assert.equal(
    [...f.tables.projectInvites.values()].find(row => row.mail.status === 'failed').mail.code,
    'daily email limit',
  );
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
