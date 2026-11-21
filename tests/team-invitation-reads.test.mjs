// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { invitationFixture, inbox, refusal } from './invitation-fixture.mjs';

const { pending } = await import(moduleUrl('../convex/teamInvitationReads.ts'));
const address = 'guest@example.test';
const createdAt = Date.UTC(2026, 10, 10, 12);

function fixture(t) {
  const s = invitationFixture(t);
  s.tables.teams.set('team', { _id: 'team', owner: 'owner', name: 'Synthetic team' });
  const invite = {
    _id: 'team-invitation',
    _creationTime: createdAt,
    teamId: 'team',
    email: address,
    target: 'Guest@example.test',
    inviter: 'owner',
    state: 'pending',
  };
  s.tables.projectInvites.set(invite._id, invite);
  return { ...s, teamInvite: invite };
}

test('the shared inbox serves team invitations only to the verified recipient and compatible clients', async t => {
  const s = fixture(t);
  const projectInvite = await s.invite(address);
  s.caller();
  const compatible = await inbox.inbox._handler(s.ctx, { kind: 'email', includeTeams: true });
  assert.deepEqual(
    compatible.rows.find(row => row.invitationId === s.teamInvite._id),
    {
      invitationId: s.teamInvite._id,
      teamName: 'Synthetic team',
      inviterHandle: 'olive',
      state: 'pending',
      href: '/-/account/people',
    },
  );
  assert.deepEqual(
    (await inbox.inbox._handler(s.ctx, { kind: 'email' })).rows.map(row => row.invitationId),
    [projectInvite._id],
  );
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'handle', includeTeams: true })).rows, []);
  s.caller('other', 'other@example.test');
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'email', includeTeams: true })).rows, []);
  s.caller('guest', address, { emailVerified: false });
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'email', includeTeams: true })).rows, []);
});

test('owner pending team reads expose the typed target and state independent of recipient accounts', async t => {
  const s = fixture(t);
  s.caller('owner', 'owner@example.test');
  const expected = {
    rows: [{ id: s.teamInvite._id, target: 'Guest@example.test', state: 'pending' }],
    cursor: null,
  };
  assert.deepEqual(await pending._handler(s.ctx, { teamId: 'team' }), expected);
  s.tables.users.set('guest', {
    _id: 'guest',
    _creationTime: createdAt,
    accountKey: 'guest',
    email: address,
    emailVerified: true,
  });
  assert.deepEqual(await pending._handler(s.ctx, { teamId: 'team' }), expected);
  s.caller();
  await assert.rejects(pending._handler(s.ctx, { teamId: 'team' }), refusal('GITHUB_UNAVAILABLE'));
});

test('deleted teams and blocked inviters are absent from the team recipient inbox', async t => {
  const s = fixture(t),
    read = () => inbox.inbox._handler(s.ctx, { kind: 'email', includeTeams: true });
  s.caller();
  assert.equal((await read()).rows.length, 1);
  s.tables.invitationBlocks.set('block', { recipient: 'guest', inviter: 'owner', blocked: true });
  assert.deepEqual((await read()).rows, []);
  s.tables.invitationBlocks.clear();
  s.tables.teams.get('team').removal = 'deleting';
  assert.deepEqual((await read()).rows, []);
  await assert.rejects(s.answer(s.teamInvite), refusal('PROJECT_UNAVAILABLE'));
});

test('owner and recipient team invitation pages read bounded records at 400 and 800 pending rows', async () => {
  for (const total of [400, 800]) {
    const f = lanesFixture();
    const teamId = f.insert('teams', { name: 'Synthetic team', owner: 'owner', operationId: 'team' });
    f.insert('forgeAccounts', { owner: 'owner', handle: 'olive' });
    for (let i = 0; i < total; i++) {
      f.insert('projectInvites', { teamId, email: address, inviter: 'owner', state: 'pending' });
    }
    const owner = await f.call('Owner pending page', pending, { teamId });
    const ownerMeter = f.counts.at(-1);
    assert.equal(owner.rows.length, 25);
    assert.ok(owner.cursor);
    assert.equal(ownerMeter.readDocumentsByTable.projectInvites, 25);
    assert.equal(ownerMeter.readRangesByTable.users ?? 0, 0);
    assert.equal(ownerMeter.writes, 0);
    const args = { kind: 'email', includeTeams: true };
    const recipient = { subject: 'guest', email: address, emailVerified: true };
    const first = await f.call('Recipient team page', inbox.inbox, args, recipient);
    const recipientMeter = f.counts.at(-1);
    const next = await f.call(
      'Next recipient team page',
      inbox.inbox,
      { ...args, cursor: first.cursor },
      recipient,
    );
    assert.equal(new Set([...first.rows, ...next.rows].map(row => row.invitationId)).size, 50);
    assert.equal(recipientMeter.readDocumentsByTable.projectInvites, 25);
    assert.ok(recipientMeter.documents <= 102 && recipientMeter.readBytes < 32_000);
    assert.equal(recipientMeter.writes, 0);
    console.log(
      JSON.stringify({
        teamInvitations: total,
        ownerDocuments: ownerMeter.documents,
        ownerBytes: ownerMeter.readBytes,
        recipientDocuments: recipientMeter.documents,
        recipientBytes: recipientMeter.readBytes,
      }),
    );
  }
});

test('a growing reactive invitation page stays bounded and the split continuation retains unread invitations', async () => {
  const f = lanesFixture();
  const teamId = f.insert('teams', { name: 'Synthetic team', owner: 'owner', operationId: 'team' });
  const ids = Array.from({ length: 40 }, () =>
    f.insert('projectInvites', { teamId, email: address, inviter: 'owner', state: 'pending' }),
  );
  // A subscription reuses the original end cursor after new rows enter its range.
  // Model that larger range and the provider split using the real fixture's row cap.
  f.extendContext(ctx => {
    const query = ctx.db.query.bind(ctx.db);
    ctx.db.query = table => {
      const result = query(table);
      if (table !== 'projectInvites') return result;
      const paginate = result.paginate.bind(result);
      result.paginate = async opts => {
        if (opts.cursor !== null) return paginate(opts);
        const page = await paginate({ ...opts, numItems: ids.length });
        return {
          ...page,
          isDone: true,
          continueCursor: String(ids.length),
          splitCursor: '12',
          pageStatus: 'SplitRequired',
        };
      };
      return result;
    };
  });
  const recipient = { subject: 'guest', email: address, emailVerified: true };
  for (const read of [
    cursor => f.call('Growing owner page', pending, { teamId, cursor }),
    cursor =>
      f.call('Growing recipient page', inbox.inbox, { kind: 'email', includeTeams: true, cursor }, recipient),
  ]) {
    const first = await read(null);
    assert.equal(first.rows.length, 25);
    assert.equal(f.counts.at(-1).readDocumentsByTable.projectInvites, 25);
    const seen = new Set(first.rows.map(row => row.id ?? row.invitationId));
    let cursor = first.cursor;
    for (let i = 0; cursor !== null && i < 2; i++) {
      const page = await read(cursor);
      for (const row of page.rows) seen.add(row.id ?? row.invitationId);
      cursor = page.cursor;
    }
    assert.equal(cursor, null);
    assert.deepEqual(seen, new Set(ids));
  }
});
