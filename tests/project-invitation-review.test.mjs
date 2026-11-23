// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { invitationFixture, contributors, access, mail, refusal, values } from './invitation-fixture.mjs';
const account = await import(moduleUrl('../convex/accountActions.ts'));
const data = await import(moduleUrl('../convex/accountData.ts'));
const actions = await import(moduleUrl('../convex/projectContributorActions.ts'));
const formerKey = 'invitation-generation';
const member = s => s.ctx.db.insert('projectContributors', { projectId: 'project', contributor: 'guest' });
async function createCounter(s) {
  await s.ctx.db.insert('projectContributors', { projectId: 'project', contributor: 'other' });
  s.caller('owner');
  await contributors.remove._handler(s.ctx, { projectId: 'project', contributor: 'other' });
}
async function leaveProject(s) {
  s.caller();
  const operationId = randomUUID();
  // The review's token first (accountData.review, then accountData.shared), as the page reads it.
  const { token: start } = await data.review._handler(s.ctx, { review: randomUUID() });
  const { token: incoming } = await data.shared._handler(s.ctx, {
    kind: 'projects',
    cursor: null,
    token: start,
  });
  await account.begin._handler(s.ctx, { operationId, selection: [], leave: ['projects'], incoming });
  let cursor = null;
  for (;;) {
    const page = await account.advance._handler(s.ctx, { operationId, cursor });
    if (page.isDone) break;
    cursor = page.cursor;
  }
}
for (const writer of ['invitation', 'resend', 'owner removal'])
  test(`the ${writer} operation can use the former counter key without colliding with the counter`, async t => {
    const s = invitationFixture(t);
    delete process.env.FORGE_INVITATION_EMAIL;
    await member(s);
    await createCounter(s);
    if (writer === 'invitation') {
      await s.invite('@wren', { operationId: formerKey });
    } else if (writer === 'resend') {
      const row = await s.invite();
      await mail.resend._handler(s.ctx, {
        projectId: 'project',
        operationId: row.operationId,
        resendId: formerKey,
      });
    } else {
      await access.setRole._handler(s.ctx, {
        projectId: 'project',
        person: 'guest',
        role: 'none',
        operationId: formerKey,
      });
      assert.equal(
        values(s, 'projectContributors').some(row => row.contributor === 'guest'),
        false,
      );
    }
    const rows = values(s, 'projectAccessOperations');
    assert.equal(rows.filter(row => row.operationId === formerKey).length, 1);
    const counters = rows.filter(row => row.operationId === undefined);
    assert.equal(counters.length, 1);
    assert.equal(counters[0].invitationEpoch, writer === 'owner removal' ? 2 : 1);
  });

test('member leave keeps a caller operation with the former counter key immutable and ends older invitations', async t => {
  const s = invitationFixture(t);
  await member(s);
  const old = await s.invite('@wren', { operationId: formerKey });
  const operation = structuredClone(
    values(s, 'projectAccessOperations').find(row => row.operationId === formerKey),
  );
  await leaveProject(s);
  assert.equal(
    values(s, 'projectContributors').some(row => row.contributor === 'guest'),
    false,
  );
  assert.deepEqual(s.tables.projectAccessOperations.get(operation._id), operation);
  assert.equal(
    values(s, 'projectAccessOperations').find(row => row.operationId === undefined)?.invitationEpoch,
    1,
  );
  await assert.rejects(s.answer(old), refusal('BAD_ARGUMENT'));
});

for (const kind of ['handle', 'email', 'legacy-email-add'])
  test(`a ${kind} target over 254 characters refuses before any database read or write`, async t => {
    const s = invitationFixture(t),
      before = JSON.stringify(
        Object.fromEntries(Object.entries(s.tables).map(([key, rows]) => [key, [...rows]])),
      );
    let reads = 0;
    s.ctx.db = new Proxy(s.ctx.db, {
      get(target, key) {
        if (key === 'get' || key === 'query')
          return () => {
            reads++;
            throw Error('Target validation performed a read');
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const person = kind === 'handle' ? '@' + 'a'.repeat(254) : 'a'.repeat(242) + '@example.test';
    assert.equal(person.length, 255);
    await assert.rejects(
      kind === 'legacy-email-add'
        ? contributors.add._handler(s.ctx, {
            projectId: 'project',
            owner: 'owner',
            contributor: 'guest',
            legacyEmail: person,
          })
        : s.invite(person),
      refusal('BAD_ARGUMENT'),
    );
    assert.equal(reads, 0);
    assert.equal(
      JSON.stringify(Object.fromEntries(Object.entries(s.tables).map(([key, rows]) => [key, [...rows]]))),
      before,
    );
    assert.equal(s.scheduled.length, 0);
  });
test('a 254-character invitation target remains valid', async t => {
  const s = invitationFixture(t);
  delete process.env.FORGE_INVITATION_EMAIL;
  const person = 'a'.repeat(241) + '@example.test';
  assert.equal(person.length, 254);
  assert.equal((await s.invite(person)).email, person);
});
for (const action of ['addByEmail', 'invitePerson'])
  test(`public ${action} refuses an oversized target before owner reads or held-request writes`, async t => {
    const s = invitationFixture(t);
    s.caller('owner');
    let calls = 0;
    s.ctx.runQuery = s.ctx.runMutation = async () => {
      calls++;
      throw Error('Oversized target reached a backend call');
    };
    const fields =
      action === 'addByEmail'
        ? { email: 'a'.repeat(242) + '@example.test' }
        : { person: '@' + 'a'.repeat(254), operationId: randomUUID() };
    await assert.rejects(
      actions[action]._handler(s.ctx, { projectId: 'project', ...fields }),
      refusal('BAD_ARGUMENT'),
    );
    assert.equal(calls, 0);
    assert.equal(s.tables.projectHostedApprovals.size, 0);
  });

for (const kind of ['handle', 'email'])
  test(`lowering a member to read ends their older ${kind} invitation so it cannot restore write`, async t => {
    const s = invitationFixture(t);
    t.mock.timers.enable({ apis: ['Date'], now: 1_900_000_000_000 });
    await member(s);
    const person = kind === 'handle' ? '@wren' : 'guest@example.test';
    const old = await s.invite(person, { role: 'write' });
    await access.setRole._handler(s.ctx, {
      projectId: 'project',
      person: 'guest',
      role: 'read',
      operationId: randomUUID(),
    });
    s.caller();
    await assert.rejects(s.answer(old), refusal('BAD_ARGUMENT'));
    assert.equal(s.tables.projectContributors.size, 0);
    assert.equal(values(s, 'projectReaders')[0].reader, 'guest');
    const fresh = await s.invite(person, { role: 'write' });
    s.caller();
    await s.answer(fresh);
    assert.equal(values(s, 'projectContributors')[0].contributor, 'guest');
    assert.equal(s.tables.projectReaders.size, 0);
  });

test('mail details project no email when a pre-change operation belongs to the former project owner', async t => {
  const s = invitationFixture(t),
    invite = await s.invite();
  await s.ctx.db.patch(invite._id, { inviter: undefined });
  await s.ctx.db.patch('project', { owner: 'new-owner' });
  assert.equal(
    await mail.details._handler(s.ctx, { projectId: 'project', operationId: invite.operationId }),
    null,
  );
});
test('People projects an ended bound handle invitation as cancelled after removal', async t => {
  const s = invitationFixture(t);
  await member(s);
  const old = await s.invite('@wren');
  await access.setRole._handler(s.ctx, {
    projectId: 'project',
    person: 'guest',
    role: 'none',
    operationId: randomUUID(),
  });
  const page = await access.people._handler(s.ctx, { projectId: 'project' });
  assert.equal(page.invited.find(row => row.id === old._id).state, 'cancelled');
});
test('the legacy pending projection excludes a bound handle invitation ended by removal', async t => {
  const s = invitationFixture(t);
  await member(s);
  const old = await s.invite('@wren');
  assert.ok(
    (await contributors.pending._handler(s.ctx, { projectId: 'project' })).some(row => row.id === old._id),
  );
  await access.setRole._handler(s.ctx, {
    projectId: 'project',
    person: 'guest',
    role: 'none',
    operationId: randomUUID(),
  });
  assert.deepEqual(await contributors.pending._handler(s.ctx, { projectId: 'project' }), []);
});
