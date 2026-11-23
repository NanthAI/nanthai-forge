// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { projectRow, schemaRow, state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const work = await import(moduleUrl('../convex/projectWork.ts'));
const people = await import(moduleUrl('../convex/projectContributors.ts'));
const actions = await import(moduleUrl('../convex/projectContributorActions.ts'));
const accounts = await import(moduleUrl('../convex/urlAccounts.ts'));
function setup() {
  const s = state([]);
  s.tables.users.set('verified-owner', {
    _id: 'verified-owner',
    _creationTime: 1,
    accountKey: 'owner',
    emailVerified: true,
  });
  s.tables.projectInvites = new Map();
  s.tables.projectAccessOperations = new Map();
  s.tables.hostedProjects.set('p', projectRow({ _id: 'p', owner: 'owner', name: 'Test', key: 'p' }));
  s.tables.forgeAccounts.set(
    'a',
    schemaRow('forgeAccounts', { _id: 'a', _creationTime: 1, owner: 'maya-id', handle: 'maya' }),
  );
  const original = s.ctx.runQuery;
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    if (module === 'projectContributors') return people[name]._handler(s.ctx, args);
    if (module === 'projectWork') return work[name]._handler(s.ctx, args);
    return original(ref, args);
  };
  return s;
}
test('handle search and invitations require current access management authority', async () => {
  const s = setup();
  assert.deepEqual(await people.handles._handler(s.ctx, { projectId: 'p', prefix: '@ma' }), [
    { handle: 'maya' },
  ]);
  await actions.invitePerson._handler(s.ctx, { projectId: 'p', person: '@maya', operationId: 'handle-op' });
  assert.equal([...s.tables.projectInvites.values()][0].recipient, 'maya-id');
  assert.equal(s.tables.projectContributors.size, 0);
  await actions.invitePerson._handler(s.ctx, { projectId: 'p', person: '@maya', operationId: 'handle-op' });
  assert.equal(s.tables.projectContributors.size, 0);
  await people.remove._handler(s.ctx, { projectId: 'p', contributor: 'maya-id' });
  await actions.invitePerson._handler(s.ctx, { projectId: 'p', person: '@maya', operationId: 'handle-op' });
  assert.equal(s.tables.projectContributors.size, 0, 'retry must not undo a later removal');
  await assert.rejects(
    actions.invitePerson._handler(s.ctx, { projectId: 'p', person: '@other', operationId: 'handle-op' }),
  );
  s.caller('stranger');
  for (const [fn, args] of [
    [people.handles, { projectId: 'p', prefix: '@ma' }],
    [people.pending, { projectId: 'p' }],
    [actions.invitePerson, { projectId: 'p', person: '@maya', operationId: 'handle-op' }],
  ])
    await assert.rejects(fn._handler(s.ctx, args));
});
test('pending email invitation is private, retry-safe, and redeemed only by verified identity', async t => {
  const s = setup(),
    oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json([]);
  t.after(() => {
    globalThis.fetch = oldFetch;
  });
  for (let i = 0; i < 2; i++)
    await actions.invitePerson._handler(s.ctx, {
      projectId: 'p',
      person: ' New@example.test ',
      operationId: 'email-op',
    });
  assert.equal(s.tables.projectInvites.size, 1);
  assert.equal((await people.pending._handler(s.ctx, { projectId: 'p' }))[0].email, 'new@example.test');
  assert.equal(s.tables.projectContributors.size, 0);
  s.ctx.auth.getUserIdentity = async () => ({
    subject: 'new',
    email: 'new@example.test',
    emailVerified: true,
  });
  await accounts.ensure._handler(s.ctx, {});
  assert.equal(s.tables.projectInvites.size, 1);
  assert.equal(s.tables.projectContributors.size, 0, 'sign-in leaves acceptance to the person');
});
test('cancelled invitations remain cancelled on retry and cannot be cancelled across projects', async () => {
  const s = setup();
  const input = {
    projectId: 'p',
    owner: 'owner',
    operationId: 'cancel-me',
    person: 'invite@example.test',
    email: 'invite@example.test',
  };
  await people.invite._handler(s.ctx, input);
  const id = [...s.tables.projectInvites.values()][0]._id;
  s.tables.hostedProjects.set('other', { _id: 'other', owner: 'owner', name: 'Other', key: 'other' });
  await assert.rejects(people.cancelInvite._handler(s.ctx, { projectId: 'other', id }));
  s.caller('stranger');
  await assert.rejects(people.pending._handler(s.ctx, { projectId: 'p' }));
  await assert.rejects(people.cancelInvite._handler(s.ctx, { projectId: 'p', id }));
  s.caller('owner');
  await people.cancelInvite._handler(s.ctx, { projectId: 'p', id });
  await people.cancelInvite._handler(s.ctx, { projectId: 'p', id });
  await people.invite._handler(s.ctx, input);
  assert.equal([...s.tables.projectInvites.values()][0].state, 'cancelled');
});
