// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { storageClock } from './storage-clock.mjs';
import { invitationFixture, inbox, refusal, values } from './invitation-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';

const [teamActions, teams, teamInvitationReads, teamInvitationWrites, policy, membership] = await Promise.all(
  [
    'teamActions',
    'teams',
    'teamInvitationReads',
    'teamInvitationWrites',
    'projectInvitationPolicy',
    'teamInvitationMembership',
  ].map(name => import(moduleUrl('../convex/' + name + '.ts'))),
);
const address = 'guest@example.test';
const { invitationEmailHash } = policy;

function env(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

function fixture(t, clerkKey) {
  env(t, 'CLERK_SECRET_KEY', clerkKey);
  const s = invitationFixture(t);
  s.tables.teams.set('team', {
    _id: 'team',
    _creationTime: 1,
    owner: 'owner',
    name: 'Synthetic team',
    operationId: randomUUID(),
  });
  const original = s.ctx.runQuery;
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return { teams, teamInvitationWrites }[module]?.[name]?._handler(s.ctx, args) ?? original(ref, args);
  };
  const wire = (email, opts) => teamActions.addByEmail._handler(s.ctx, { id: 'team', email, ...opts });
  const issue = async (email = address, opts = { operationId: randomUUID(), pending: true }) => {
    s.caller('owner', 'owner@example.test');
    return wire(email, opts);
  };
  const reply = (row, choice = 'accept', operationId = randomUUID()) =>
    teamActions.answerInvitation._handler(s.ctx, { invitationId: row._id, choice, operationId });
  const known = (id = 'guest', email = address) => {
    s.tables.users.set(id, {
      _id: id,
      _creationTime: Date.UTC(2026, 10, 10, 12),
      accountKey: id,
      email,
      emailVerified: true,
      emailConfirmedAt: Date.UTC(2026, 10, 10, 12),
    });
  };
  return { ...s, issue, wire, reply, known };
}

test('team invitations by email stay pending and owner reads are identical for unknown, known and ambiguous addresses', async t => {
  storageClock(t);
  const s = fixture(t),
    fetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Creating a pending invitation must not call a provider');
  t.after(() => {
    globalThis.fetch = fetch;
  });
  const op = { operationId: randomUUID(), pending: true };
  const entered = ' Guest@example.test ';
  assert.equal(await s.issue(entered, op), 'pending');
  const pending = () => teamInvitationReads.pending._handler(s.ctx, { teamId: 'team' });
  const before = await pending();
  assert.deepEqual(
    before.rows.map(row => [row.target, row.state]),
    [['Guest@example.test', 'pending']],
  );
  assert.equal(s.tables.teamMembers.size, 0);
  s.known();
  assert.equal(await s.issue(entered, op), 'pending');
  assert.deepEqual(await pending(), before);
  s.known('other');
  assert.equal(await s.issue(entered, op), 'pending');
  assert.deepEqual(await pending(), before);
  assert.equal(s.tables.projectInvites.size, 1);
  assert.equal(values(s, 'projectInvites')[0].recipient, undefined);
  assert.equal(s.tables.teamMembers.size, 0);
  assert.ok(values(s, 'deviceAttempts').every(row => row.count === 1));
  await assert.rejects(s.issue('other@example.test', op), refusal('WORK_OPERATION_CHANGED'));
});

test('a browser recipient accepts an email invitation and exact retry cannot restore removed team membership', async t => {
  storageClock(t);
  const s = fixture(t);
  s.known();
  assert.equal(await s.issue(address, {}), null, 'an old browser keeps its response contract');
  const row = values(s, 'projectInvites')[0];
  assert.equal(s.tables.teamMembers.size, 0);
  s.caller('other', 'other@example.test');
  await assert.rejects(s.reply(row), refusal('PROJECT_UNAVAILABLE'));
  s.caller('guest', address, { emailVerified: false });
  await assert.rejects(s.reply(row), refusal('PROJECT_UNAVAILABLE'));
  s.caller();
  assert.equal(
    (await inbox.inbox._handler(s.ctx, { kind: 'email', includeTeams: true })).rows[0].teamName,
    'Synthetic team',
  );
  const operationId = randomUUID();
  await s.reply(row, 'accept', operationId);
  assert.equal(values(s, 'teamMembers')[0].member, 'guest');
  assert.equal(values(s, 'teamMembers')[0].handle, 'wren');
  assert.equal(values(s, 'projectInvites')[0].state, 'accepted');
  s.caller('owner', 'owner@example.test');
  await teams.removeMember._handler(s.ctx, { id: 'team', member: 'guest' });
  s.caller();
  await s.reply(row, 'accept', operationId);
  assert.equal(s.tables.teamMembers.size, 0);
  await assert.rejects(s.reply(row, 'decline', operationId), refusal('WORK_OPERATION_CHANGED'));
});

test('removing a team member ends earlier email invitations and leaves a fresh invitation usable', async t => {
  storageClock(t);
  const s = fixture(t);
  s.known();
  await s.issue();
  const older = values(s, 'projectInvites')[0];
  await s.transaction(() => membership.addTeamMembership(s.ctx, 'team', 'guest'));
  await teams.removeMember._handler(s.ctx, { id: 'team', member: 'guest' });
  s.caller();
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'email', includeTeams: true })).rows, []);
  await assert.rejects(s.reply(older), refusal('BAD_ARGUMENT'));
  await s.issue();
  const fresh = values(s, 'projectInvites').find(row => row.state === 'pending');
  s.caller();
  await s.reply(fresh);
  assert.equal(values(s, 'teamMembers')[0].member, 'guest');
});

test('a mismatched legacy provider account or a changed native binding prevents team acceptance', async t => {
  storageClock(t);
  const s = fixture(t, 'synthetic-team-fixture');
  s.known();
  await s.issue();
  const row = values(s, 'projectInvites')[0];
  const before = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = before;
  });
  let legacyId = 'other';
  let changeNative = false;
  globalThis.fetch = async () => {
    if (changeNative) s.tables.users.get('guest').emailVerified = false;
    return Response.json([
      { id: legacyId, email_addresses: [{ email_address: address, verification: { status: 'verified' } }] },
    ]);
  };
  s.caller('guest', address, { forgeAuthUser: 'guest' });
  await assert.rejects(s.reply(row), refusal('BAD_ARGUMENT'));
  assert.equal(s.tables.teamMembers.size, 0);
  legacyId = 'guest';
  changeNative = true;
  await assert.rejects(s.reply(row), refusal('PROJECT_UNAVAILABLE'));
  assert.equal(s.tables.teamMembers.size, 0);
});

test('team email invitation creation shares inviter counters, without a mail or recipient budget', async t => {
  storageClock(t);
  const f = lanesFixture();
  const teamId = f.insert('teams', { owner: 'owner', name: 'Synthetic team', operationId: randomUUID() });
  f.insert('deviceAttempts', {
    owner: 'invitation:inviter-hour:owner',
    count: 19,
    windowAt: Date.UTC(2026, 10, 10, 12),
  });
  const create = target =>
    f.call('Team email invite', teamInvitationWrites.create, { teamId, target, operationId: randomUUID() });
  await create(address);
  const meter = f.counts.at(-1);
  assert.equal(meter.readRangesByTable.users ?? 0, 0);
  assert.equal(meter.readRangesByTable.teamMembers ?? 0, 0);
  assert.equal(meter.writes, 4);
  assert.ok(meter.documents <= 8 && meter.readBytes < 4096);
  assert.equal(f.scheduled.length, 0);
  await assert.rejects(create('new@example.test'), refusal('RATE_LIMITED'));
  assert.equal(f.tables.projectInvites.size, 1);
  assert.deepEqual([...f.tables.deviceAttempts.values()].map(row => row.owner).sort(), [
    'invitation:inviter-day:owner',
    'invitation:inviter-hour:owner',
  ]);
  console.log(
    JSON.stringify({
      teamCreateDocuments: meter.documents,
      teamCreateReads: meter.readBytes,
      teamCreateWrites: meter.writes,
      teamCreateWriteBytes: meter.writeBytes,
    }),
  );
});

test('only the owner can cancel a pending address, and declining or blocking grants no team membership', async t => {
  storageClock(t);
  const s = fixture(t);
  s.known();
  await s.issue();
  const row = values(s, 'projectInvites')[0];
  const cancel = () =>
    teamInvitationWrites.cancel._handler(s.ctx, {
      teamId: 'team',
      invitationId: row._id,
      operationId: 'owner-cancel-current',
    });
  s.caller();
  await assert.rejects(cancel(), refusal('GITHUB_UNAVAILABLE'));
  s.caller('owner', 'owner@example.test');
  await cancel();
  await cancel();
  s.caller();
  await assert.rejects(s.reply(row), refusal('BAD_ARGUMENT'));
  await s.issue();
  let pending = values(s, 'projectInvites').find(invite => invite.state === 'pending');
  s.caller();
  await s.reply(pending, 'decline');
  await s.issue();
  pending = values(s, 'projectInvites').find(invite => invite.state === 'pending');
  s.caller();
  await s.reply(pending, 'block');
  await s.issue();
  assert.equal((await teamInvitationReads.pending._handler(s.ctx, { teamId: 'team' })).rows.length, 1);
  s.caller();
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'email', includeTeams: true })).rows, []);
  assert.equal(s.tables.teamMembers.size, 0);
});

test('an active device cannot create or accept team invitations as the person', async t => {
  storageClock(t);
  const s = fixture(t);
  s.known();
  await s.issue();
  const row = values(s, 'projectInvites')[0];
  for (const subject of ['owner', 'guest']) {
    s.tables.cliCredentials.set(subject, {
      _id: subject,
      _creationTime: 1,
      owner: subject,
      credentialId: 'active-team-' + subject,
      name: 'Team fixture device',
      scope: 'cli',
      tokenHash: 'synthetic',
      issuedAt: Date.UTC(2026, 10, 10, 12),
      expiresAt: Date.UTC(2026, 10, 10, 13),
      revoked: false,
    });
  }
  s.caller('owner', 'owner@example.test', { forgeCredential: 'active-team-owner' });
  await assert.rejects(
    s.wire('another@example.test', { operationId: randomUUID() }),
    refusal('AUTH_SCOPE_DENIED'),
  );
  s.caller('guest', address, { forgeCredential: 'active-team-guest' });
  await assert.rejects(s.reply(row), refusal('AUTH_SCOPE_DENIED'));
  assert.equal(s.tables.projectInvites.size, 1);
  assert.equal(s.tables.teamMembers.size, 0);
});

test('an original direct add from before pending invitations replays without an invitation, charge or second grant', async t => {
  storageClock(t);
  const s = fixture(t);
  s.known();
  const op = { operationId: randomUUID() };
  // The receipt shape the retired direct path wrote: no address, only its digest.
  s.tables.projectInvites.set('receipt', {
    _id: 'receipt',
    _creationTime: 1,
    teamId: 'team',
    email: '',
    target: invitationEmailHash(address),
    state: 'accepted',
    operationId: op.operationId,
  });
  assert.equal(await s.issue(address, op), null);
  // The retired path trimmed without a raw limit: an exact padded retry still replays its receipt.
  assert.equal(await s.issue(' '.repeat(300) + address, op), null);
  await assert.rejects(s.issue('another@example.test', op), refusal('WORK_OPERATION_CHANGED'));
  assert.equal(s.tables.teamMembers.size, 0);
  assert.equal(s.tables.deviceAttempts.size, 0);
  assert.equal(s.tables.projectInvites.size, 1);
});

test('large answer and cancellation operation keys keep fixed-size receipts and replay exactly', async t => {
  storageClock(t);
  const s = fixture(t);
  await s.issue();
  const [invite] = values(s, 'projectInvites');
  const answerKey = 'answer-operation'.repeat(2048);
  s.caller();
  await s.reply(invite, 'decline', answerKey);
  await s.reply(invite, 'decline', answerKey);
  const answer = s.tables.projectInvites.get(invite._id).answer;
  assert.match(answer.operationId, /^[a-f0-9]{64}$/);
  await s.issue();
  const next = values(s, 'projectInvites').find(row => row.state === 'pending');
  const cancelArgs = { teamId: 'team', invitationId: next._id, operationId: 'cancel-operation'.repeat(2048) };
  await teamInvitationWrites.cancel._handler(s.ctx, cancelArgs);
  await teamInvitationWrites.cancel._handler(s.ctx, cancelArgs);
  assert.match(s.tables.projectInvites.get(next._id).answer.operationId, /^[a-f0-9]{64}$/);
});

test('team add by Forge handle stays pending until that account accepts on Home; the owner sees only what they typed', async t => {
  storageClock(t);
  const s = fixture(t, 'synthetic-team-fixture'),
    fetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('A handle invitation never asks the identity provider');
  t.after(() => {
    globalThis.fetch = fetch;
  });
  const handle = (member, opts = {}) => {
    s.caller('owner', 'owner@example.test');
    return teamActions.addMember._handler(s.ctx, { id: 'team', member, ...opts });
  };
  const op = { operationId: randomUUID() };
  assert.equal(await handle(' @Wren ', op), 'pending');
  assert.equal(await handle(' @Wren ', op), 'pending', 'an exact retry replays');
  await assert.rejects(handle('@rook', op), refusal('WORK_OPERATION_CHANGED'));
  await assert.rejects(handle('@nobody'), refusal('BAD_ARGUMENT'));
  assert.equal(
    await handle('@olive'),
    null,
    "the owner's own handle is already a member: nothing is written",
  );
  s.caller('other', 'other@example.test');
  await assert.rejects(
    teamActions.addMember._handler(s.ctx, { id: 'team', member: '@wren' }),
    refusal('GITHUB_UNAVAILABLE'),
  );
  assert.equal(s.tables.teamMembers.size, 0);
  const [row] = values(s, 'projectInvites');
  assert.equal(s.tables.projectInvites.size, 1);
  assert.deepEqual([row.kind, row.recipient, row.state], ['handle', 'guest', 'pending']);
  assert.ok(
    values(s, 'deviceAttempts').every(counter => counter.count === 1),
    'inviter counters charged once',
  );
  s.caller('owner', 'owner@example.test');
  assert.deepEqual(
    (await teamInvitationReads.pending._handler(s.ctx, { teamId: 'team' })).rows.map(r => [
      r.target,
      r.state,
    ]),
    [['@Wren', 'pending']],
  );
  // Another account neither sees nor accepts it.
  s.caller('other', 'other@example.test');
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'handle', includeTeams: true })).rows, []);
  await assert.rejects(s.reply(row), refusal('PROJECT_UNAVAILABLE'));
  s.caller();
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'email', includeTeams: true })).rows, []);
  const [home] = (await inbox.inbox._handler(s.ctx, { kind: 'handle', includeTeams: true })).rows;
  assert.deepEqual([home.teamName, home.inviterHandle, home.state], ['Synthetic team', 'olive', 'pending']);
  assert.equal(s.tables.teamMembers.size, 0, 'seeing it on Home grants nothing');
  await s.reply(row);
  assert.deepEqual(
    values(s, 'teamMembers').map(m => [m.member, m.handle]),
    [['guest', 'wren']],
  );
  assert.equal(s.tables.projectInvites.get(row._id).state, 'accepted');
  assert.equal(
    await handle(' @Wren ', op),
    'pending',
    'a retry after acceptance returns its first answer without a second grant',
  );
  assert.equal(s.tables.projectInvites.size, 1);
  assert.equal(s.tables.teamMembers.size, 1);
});

test('a bare handle the public wrapper resolves invites that account, and exact retries keep their first answer', async t => {
  storageClock(t);
  const s = fixture(t);
  const handle = (member, opts = {}) => {
    s.caller('owner', 'owner@example.test');
    return teamActions.addMember._handler(s.ctx, { id: 'team', member, ...opts });
  };
  const op = { operationId: randomUUID() };
  assert.equal(await handle('wren', op), 'pending');
  const [row] = values(s, 'projectInvites');
  assert.deepEqual([row.recipient, row.target, row.email], ['guest', 'wren', '@wren']);
  assert.deepEqual(
    (await teamInvitationReads.pending._handler(s.ctx, { teamId: 'team' })).rows.map(r => r.target),
    ['wren'],
    'the owner sees the handle they typed, never the account id it resolved to',
  );
  // The recipient renames: the exact retry still answers from its retained row.
  s.tables.forgeAccounts.get('guest').handle = 'wren-renamed';
  s.tables.accountHandles.delete('h-wren');
  s.tables.accountHandles.set('h-wren-renamed', {
    _id: 'h-wren-renamed',
    _creationTime: 1,
    owner: 'guest',
    handle: 'wren-renamed',
  });
  assert.equal(await handle('wren', op), 'pending');
  s.caller();
  await s.reply(row);
  assert.equal(await handle('wren', op), 'pending', 'after acceptance the retry keeps its first answer');
  // A reused operation id naming someone else, even a current member, is refused rather than answered.
  await assert.rejects(handle('@olive', op), refusal('WORK_OPERATION_CHANGED'));
  const emailOp = { operationId: randomUUID(), pending: true };
  await s.issue(address, emailOp);
  await assert.rejects(
    handle('@rook', { operationId: emailOp.operationId }),
    refusal('WORK_OPERATION_CHANGED'),
  );
  assert.deepEqual(
    values(s, 'teamMembers').map(m => m.member),
    ['guest'],
  );
  // An original direct add by account id kept no receipt: after removal its retry is a new pending invitation.
  s.caller('owner', 'owner@example.test');
  await teams.removeMember._handler(s.ctx, { id: 'team', member: 'guest' });
  assert.equal(await handle('guest'), null);
  assert.equal(s.tables.teamMembers.size, 0, 'the retry grants nothing');
  const fresh = values(s, 'projectInvites').find(r => r.kind === 'handle' && r.state === 'pending');
  assert.deepEqual([fresh.recipient, fresh.target], ['guest', 'wren-renamed']);
});

test('a handle invitee can decline or block, and a retried original direct add replays without granting', async t => {
  storageClock(t);
  const s = fixture(t);
  s.known();
  const handle = (member, opts = { operationId: randomUUID() }) => {
    s.caller('owner', 'owner@example.test');
    return teamActions.addMember._handler(s.ctx, { id: 'team', member, ...opts });
  };
  const pendingRow = () => values(s, 'projectInvites').find(row => row.state === 'pending');
  await handle('@wren');
  s.caller();
  await s.reply(pendingRow(), 'decline');
  assert.equal(s.tables.teamMembers.size, 0);
  await handle('@wren');
  s.caller();
  await s.reply(pendingRow(), 'block');
  assert.equal(s.tables.teamMembers.size, 0);
  const [block] = values(s, 'invitationBlocks');
  assert.deepEqual(
    [block.recipient, block.inviter, block.blocked, block.emailHash],
    ['guest', 'owner', true, invitationEmailHash(address)],
    'the block keeps the verified address so it also suppresses later invitation mail',
  );
  await handle('@wren');
  assert.equal((await teamInvitationReads.pending._handler(s.ctx, { teamId: 'team' })).rows.length, 1);
  s.caller();
  assert.deepEqual((await inbox.inbox._handler(s.ctx, { kind: 'handle', includeTeams: true })).rows, []);
  await assert.rejects(s.reply(pendingRow()), refusal('BAD_ARGUMENT'));
  assert.equal(s.tables.teamMembers.size, 0);
  // The retired direct add took an account id: its retry for a current member replays and writes nothing.
  await s.transaction(() => membership.addTeamMembership(s.ctx, 'team', 'other'));
  const rows = s.tables.projectInvites.size,
    charged = values(s, 'deviceAttempts').map(counter => counter.count);
  assert.equal(await handle('other', {}), null);
  assert.equal(s.tables.projectInvites.size, rows);
  assert.deepEqual(
    values(s, 'deviceAttempts').map(counter => counter.count),
    charged,
  );
  await assert.rejects(handle('not-a-member', {}), refusal('BAD_ARGUMENT'));
  assert.deepEqual(
    values(s, 'teamMembers').map(m => m.member),
    ['other'],
  );
});

test('team handle invitation creation is one bounded write path sharing the inviter counters', async t => {
  storageClock(t);
  const f = lanesFixture();
  const teamId = f.insert('teams', { owner: 'owner', name: 'Synthetic team', operationId: randomUUID() });
  f.insert('forgeAccounts', { owner: 'guest', handle: 'wren' });
  f.insert('deviceAttempts', {
    owner: 'invitation:inviter-hour:owner',
    count: 19,
    windowAt: Date.UTC(2026, 10, 10, 12),
  });
  const create = target =>
    f.call('Team handle invite', teamInvitationWrites.createForHandle, {
      teamId,
      target,
      operationId: randomUUID(),
    });
  assert.equal(await create('@wren'), 'pending');
  const meter = f.counts.at(-1);
  assert.equal(meter.readRangesByTable.users ?? 0, 0);
  assert.ok(meter.writes <= 4 && meter.documents <= 8 && meter.readBytes < 4096);
  assert.equal(f.scheduled.length, 0);
  f.insert('forgeAccounts', { owner: 'other', handle: 'rook' });
  await assert.rejects(create('@rook'), refusal('RATE_LIMITED'));
  assert.equal(f.tables.projectInvites.size, 1);
  console.log(
    JSON.stringify({
      teamHandleCreateDocuments: meter.documents,
      teamHandleCreateReads: meter.readBytes,
      teamHandleCreateWrites: meter.writes,
      teamHandleCreateWriteBytes: meter.writeBytes,
    }),
  );
});
