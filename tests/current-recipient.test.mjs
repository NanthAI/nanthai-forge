// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
const names = [
  'projectContributors',
  'projectContributorActions',
  'projectWork',
  'projectMemberApprovals',
  'teams',
  'teamActions',
  'authUsers',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
const people = modules.projectContributors,
  actions = modules.projectContributorActions;
const email = 'recipient@example.test';
const refused = value => error => (error.data?.code ?? error.code) === value;
function fixture(t) {
  const s = state([]),
    original = s.ctx.runQuery,
    oldFetch = globalThis.fetch,
    oldKey = process.env.CLERK_SECRET_KEY;
  process.env.CLERK_SECRET_KEY = 'synthetic-provider-key';
  let provider = [],
    fetches = 0,
    beforeGrant;
  globalThis.fetch = async () => {
    fetches++;
    return Response.json(provider);
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = oldKey;
  });
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project' }));
  const calls = [];
  s.ctx.runQuery = s.ctx.runMutation = async (ref, args) => {
    const name = getFunctionName(ref),
      [module, method] = name.split(':');
    calls.push(name);
    if (name === 'projectContributors:invite' || name === 'projectContributors:add' || name === 'teams:add')
      beforeGrant?.();
    return modules[module]?.[method]?._handler(s.ctx, args) ?? original(ref, args);
  };
  const user = (fields = {}) => {
    const row = {
      _id: 'native',
      _creationTime: 1,
      accountKey: 'native-account',
      githubLogin: 'native-login',
      email,
      emailVerified: true,
      ...fields,
    };
    s.tables.users.set(row._id, row);
    return row;
  };
  const invite = (person = email, operationId = randomUUID()) =>
    actions.invitePerson._handler(s.ctx, { projectId: 'project', person, operationId });
  return {
    ...s,
    calls,
    user,
    invite,
    legacy(account) {
      provider = [
        { id: account, email_addresses: [{ email_address: email, verification: { status: 'verified' } }] },
      ];
    },
    fetches: () => fetches,
    beforeGrant(fn) {
      beforeGrant = fn;
    },
  };
}

test('native recipients compare the configured provider once and replay without provider I/O or restoring a removed grant', async t => {
  const s = fixture(t),
    user = s.user(),
    operationId = randomUUID();
  await s.invite(' RECIPIENT@example.test ', operationId);
  assert.equal(s.fetches(), 1);
  assert.deepEqual(s.calls, [
    'projectWork:owner',
    'projectContributors:invitationOperation',
    'projectContributors:invite',
  ]);
  assert.equal([...s.tables.projectContributors.values()][0].contributor, user.accountKey);
  s.tables.projectContributors.clear();
  s.calls.length = 0;
  await s.invite(' RECIPIENT@example.test ', operationId);
  assert.equal(s.tables.projectContributors.size, 0);
  assert.equal(s.fetches(), 1, 'an exact completed replay does not repeat provider lookup');
  assert.deepEqual(s.calls, ['projectWork:owner', 'projectContributors:invitationOperation']);
  await assert.rejects(s.invite('other@example.test', operationId), refused('WORK_OPERATION_CHANGED'));
});

test('a changed native address at the grant boundary stays pending, even when the legacy provider resolves its previous account', async t => {
  const s = fixture(t),
    user = s.user();
  s.legacy(user.accountKey);
  s.beforeGrant(() => {
    delete user.email;
    user.emailVerified = false;
  });
  await s.invite();
  assert.equal(s.tables.projectContributors.size, 0);
  assert.equal([...s.tables.projectInvites.values()][0].email, email);
  assert.equal(s.fetches(), 1, 'configured providers are compared before any grant');
  s.beforeGrant(null);
  await s.invite(email);
  assert.equal(s.fetches(), 2);
  assert.equal(
    s.tables.projectContributors.size,
    1,
    'a separately verified legacy provider keeps its existing authority',
  );
});

test('a legacy verified secondary address remains usable after receiving a different native GitHub profile', async t => {
  const s = fixture(t),
    seed = s.user({
      accountKey: 'legacy-account',
      githubLogin: undefined,
      email: undefined,
      emailVerified: false,
      legacyGithubProvider: true,
    });
  s.legacy(seed.accountKey);
  await s.invite();
  assert.equal(s.tables.projectContributors.size, 1);
  s.tables.projectContributors.clear();
  seed.githubLogin = 'received-native-profile';
  seed.email = 'github-primary@example.test';
  seed.emailVerified = true;
  await s.invite();
  assert.equal(s.tables.projectContributors.size, 1);
  assert.equal(
    await modules.authUsers.verifiedRecipient._handler(s.ctx, { email }),
    null,
    'the legacy secondary is not marked as a native verified address',
  );
});

test('duplicate native addresses refuse lookup and cleared native verification cannot redeem a native-session invitation', async t => {
  const s = fixture(t),
    user = s.user();
  s.user({ _id: 'second', accountKey: 'other-account' });
  await assert.rejects(s.invite(), refused('BAD_ARGUMENT'));
  assert.equal(s.fetches(), 0);
  s.tables.users.delete('second');
  delete user.email;
  user.emailVerified = false;
  s.tables.projectInvites.set('invite', {
    _id: 'invite',
    _creationTime: 1,
    projectId: 'project',
    email,
    role: 'read',
  });
  await people.redeemInvites(s.ctx, {
    subject: user.accountKey,
    email,
    emailVerified: true,
    forgeAuthUser: user._id,
  });
  assert.equal(s.tables.projectInvites.size, 1);
  assert.equal(s.tables.projectContributors.size, 0);
  user.email = email;
  user.emailVerified = true;
  await people.redeemInvites(s.ctx, {
    subject: user.accountKey,
    email,
    emailVerified: true,
    forgeAuthUser: user._id,
  });
  assert.equal(s.tables.projectInvites.size, 0);
  assert.equal([...s.tables.projectReaders.values()][0].reader, user.accountKey);
});

test('project and team email additions resolve native accounts without another RPC and revalidate before their existing grant mutation', async t => {
  const s = fixture(t),
    user = s.user();
  await actions.addByEmail._handler(s.ctx, { projectId: 'project', email });
  assert.deepEqual(s.calls, ['projectContributors:recipient', 'projectContributors:add']);
  assert.equal(s.fetches(), 1);
  s.tables.projectContributors.clear();
  s.calls.length = 0;
  s.beforeGrant(() => {
    delete user.email;
    user.emailVerified = false;
  });
  await assert.rejects(
    actions.addByEmail._handler(s.ctx, { projectId: 'project', email }),
    refused('BAD_ARGUMENT'),
  );
  assert.equal(s.tables.projectContributors.size, 0);
  s.beforeGrant(null);
  user.email = email;
  user.emailVerified = true;
  s.tables.teams.set('team', {
    _id: 'team',
    _creationTime: 1,
    owner: 'owner',
    name: 'Synthetic team',
    operationId: randomUUID(),
  });
  s.calls.length = 0;
  await modules.teamActions.addByEmail._handler(s.ctx, { id: 'team', email });
  assert.deepEqual(s.calls, ['teams:owned', 'teams:add']);
  assert.equal(s.fetches(), 3);
  s.tables.teamMembers.clear();
  s.beforeGrant(() => {
    delete user.email;
    user.emailVerified = false;
  });
  await assert.rejects(
    modules.teamActions.addByEmail._handler(s.ctx, { id: 'team', email }),
    refused('BAD_ARGUMENT'),
  );
  assert.equal(s.tables.teamMembers.size, 0);
});

test('delayed membership approvals keep their email provenance and cannot grant a stale recipient', async t => {
  const s = fixture(t),
    user = s.user();
  delete user.email;
  user.emailVerified = false;
  const row = {
    projectId: 'project',
    requester: 'owner',
    setting: { request: JSON.stringify({ kind: 'contributor', contributor: user.accountKey, email }) },
  };
  await assert.rejects(
    modules.projectMemberApprovals.applyApprovedMember(s.ctx, row),
    refused('BAD_ARGUMENT'),
  );
  assert.equal(s.tables.projectContributors.size, 0);
});

test('recipient lookup remains a bounded index read at current and doubled people scale', async () => {
  for (const total of [400, 800]) {
    const f = lanesFixture();
    for (let i = 0; i < total; i++)
      f.insert('users', {
        accountKey: `native-${i}`,
        githubLogin: `builder-${i}`,
        email: `person-${i}@example.test`,
        emailVerified: true,
      });
    const result = await f.call('verified lookup', modules.authUsers.verifiedRecipient, {
      email: 'person-3@example.test',
    });
    assert.equal(result, 'native-3');
    const count = f.counts.at(-1);
    assert.equal(count.documents, 1);
    assert.equal(count.ranges, 1);
    assert.equal(count.writes, 0);
    console.log(
      JSON.stringify({
        people: total,
        ranges: count.ranges,
        documents: count.documents,
        bytes: count.readBytes,
        writes: count.writes,
      }),
    );
  }
});

test('owner decision: different native and legacy recipients grant nothing and direct the inviter to a Forge handle', async t => {
  const s = fixture(t);
  s.user();
  s.legacy('different-legacy-account');
  s.tables.teams.set('team', {
    _id: 'team',
    _creationTime: 1,
    owner: 'owner',
    name: 'Synthetic',
    operationId: randomUUID(),
  });
  for (const act of [
    () => s.invite(),
    () => actions.addByEmail._handler(s.ctx, { projectId: 'project', email }),
    () => modules.teamActions.addByEmail._handler(s.ctx, { id: 'team', email }),
  ]) {
    await assert.rejects(
      act(),
      error =>
        refused('BAD_ARGUMENT')(error) &&
        /Invite by Forge handle instead/.test(error.data?.message ?? error.message),
    );
    assert.equal(s.tables.projectContributors.size, 0);
    assert.equal(s.tables.projectReaders.size, 0);
    assert.equal(s.tables.projectInvites.size, 0);
    assert.equal(s.tables.teamMembers.size, 0);
  }
});
test('same-account mixed-provider matches and explicit handles retain their recipient', async t => {
  const s = fixture(t),
    user = s.user();
  s.legacy(user.accountKey);
  await s.invite();
  assert.equal([...s.tables.projectContributors.values()][0].contributor, user.accountKey);
  s.tables.projectContributors.clear();
  s.tables.forgeAccounts.set('account', { _id: 'account', owner: user.accountKey, handle: 'recipient' });
  s.legacy('different-legacy-account');
  const before = s.fetches();
  await s.invite('@recipient');
  assert.equal(s.fetches(), before);
  assert.equal([...s.tables.projectContributors.values()][0].contributor, user.accountKey);
});

test('legacy email grants recheck native ambiguity inside project, team and invitation grant transactions', async t => {
  const s = fixture(t);
  s.legacy('legacy-account');
  s.tables.teams.set('team', {
    _id: 'team',
    _creationTime: 1,
    owner: 'owner',
    name: 'Synthetic',
    operationId: randomUUID(),
  });
  for (const act of [
    () => s.invite(),
    () => actions.addByEmail._handler(s.ctx, { projectId: 'project', email }),
    () => modules.teamActions.addByEmail._handler(s.ctx, { id: 'team', email }),
  ]) {
    s.tables.users.clear();
    s.beforeGrant(() => s.user());
    await assert.rejects(act(), refused('BAD_ARGUMENT'));
    assert.equal(s.tables.projectContributors.size, 0);
    assert.equal(s.tables.projectInvites.size, 0);
    assert.equal(s.tables.teamMembers.size, 0);
  }
});
test('a retained legacy-email approval and legacy redemption cannot grant through a current native conflict', async t => {
  const s = fixture(t);
  s.user();
  const request = { kind: 'invite', person: email, contributor: 'legacy-account', operationId: randomUUID() };
  await assert.rejects(
    modules.projectMemberApprovals.applyApprovedMember(s.ctx, {
      projectId: 'project',
      requester: 'owner',
      setting: { request: JSON.stringify(request) },
    }),
    refused('BAD_ARGUMENT'),
  );
  s.tables.projectInvites.set('invite', {
    _id: 'invite',
    _creationTime: 1,
    projectId: 'project',
    email,
    role: 'write',
  });
  await people.redeemInvites(s.ctx, { subject: 'legacy-account', email, emailVerified: true });
  assert.equal(s.tables.projectInvites.size, 1);
  assert.equal(s.tables.projectContributors.size, 0);
  s.tables.users.get('native').email = 'native-primary@example.test';
  await people.redeemInvites(s.ctx, { subject: 'legacy-account', email, emailVerified: true });
  assert.equal(
    s.tables.projectContributors.size,
    1,
    'a verified legacy secondary address still redeems without a conflicting native binding',
  );
});
