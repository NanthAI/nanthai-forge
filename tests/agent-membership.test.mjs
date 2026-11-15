// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { projectRow, state, providers } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const modules = Object.fromEntries(
  await Promise.all(
    [
      'projectContributorActions',
      'projectReaderActions',
      'projectMemberApprovals',
      'projectContributors',
      'projectReaders',
      'projectHostedApprovals',
      'projectWork',
    ].map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))]),
  ),
);
function fixture(t) {
  const previousFeature = process.env.FORGE_MEMBER_APPROVAL_REQUESTS;
  process.env.FORGE_MEMBER_APPROVAL_REQUESTS = '1';
  t.after(() => {
    if (previousFeature === undefined) delete process.env.FORGE_MEMBER_APPROVAL_REQUESTS;
    else process.env.FORGE_MEMBER_APPROVAL_REQUESTS = previousFeature;
  });
  const s = state([]),
    native = s.ctx.runQuery;
  t.after(providers());
  s.ctx.runQuery = s.ctx.runMutation = (ref, input) => {
    const [module, name] = getFunctionName(ref).split(':');
    return modules[module]?.[name]?._handler(s.ctx, input) ?? native(ref, input);
  };
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project' }));
  s.tables.forgeAccounts.set('account', {
    _id: 'account',
    _creationTime: 1,
    owner: 'target',
    handle: 'target',
  });
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    _creationTime: 1,
    owner: 'owner',
    credentialId: 'synthetic-member-device',
    name: 'test',
    scope: 'cli',
    tokenHash: 'synthetic',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600000,
    revoked: false,
  });
  let device = true;
  s.ctx.auth.getUserIdentity = async () => ({
    subject: 'owner',
    ...(device ? { forgeCredential: 'synthetic-member-device' } : {}),
  });
  return {
    ...s,
    person: () => {
      device = false;
    },
    device: () => {
      device = true;
    },
  };
}
const cases = [
  ['projectContributorActions', 'add', { contributor: 'target' }],
  ['projectContributorActions', 'addByEmail', { email: 'target@example.test' }],
  ['projectContributorActions', 'invitePerson', { person: '@target', operationId: randomUUID() }],
  ['projectReaderActions', 'set', { reader: 'target', present: true, operationId: randomUUID() }],
];
for (const [module, name, fields] of cases)
  test(`owner device ${name} waits for an exact person grant, including project bootstrap`, async t => {
    const s = fixture(t),
      oldFetch = globalThis.fetch;
    globalThis.fetch = async url =>
      String(url).includes('api.clerk.com')
        ? Response.json(
            String(url).includes('?')
              ? [
                  {
                    id: 'target',
                    email_addresses: [
                      { email_address: 'target@example.test', verification: { status: 'verified' } },
                    ],
                  },
                ]
              : { id: 'target' },
          )
        : oldFetch(url);
    t.after(() => {
      globalThis.fetch = oldFetch;
    });
    const input = { projectId: 'project', ...fields };
    const call = () => modules[module][name]._handler(s.ctx, input);
    await assert.rejects(
      call(),
      e => e.data?.code === 'PROJECT_UNAVAILABLE' && /Approval request/.test(e.data.message),
    );
    assert.equal(s.tables.projectReaders.size + s.tables.projectContributors.size, 0);
    const row = [...s.tables.projectHostedApprovals.values()][0];
    assert(row, 'the committed request survives the action refusal');
    await assert.rejects(call());
    assert.equal(s.tables.projectHostedApprovals.size, 1);
    const decision = {
      projectId: 'project',
      laneId: row.laneId,
      head: row.head,
      decision: 'grant',
      operationId: randomUUID(),
    };
    await assert.rejects(
      modules.projectHostedApprovals.decide._handler(s.ctx, decision),
      e => e.data?.code === 'PROJECT_UNAVAILABLE',
    );
    s.person();
    await modules.projectHostedApprovals.decide._handler(s.ctx, decision);
    assert.equal(s.tables.projectReaders.size + s.tables.projectContributors.size, 1);
    s.device();
    await call();
    assert.equal(s.tables.projectReaders.size + s.tables.projectContributors.size, 1);
  });

test('membership writer rollout is default-off and never falls through to an unapproved grant', async t => {
  const s = fixture(t);
  delete process.env.FORGE_MEMBER_APPROVAL_REQUESTS;
  await assert.rejects(
    modules.projectContributorActions.invitePerson._handler(s.ctx, {
      projectId: 'project',
      person: '@target',
      operationId: randomUUID(),
    }),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(s.tables.projectHostedApprovals.size, 0);
  assert.equal(s.tables.projectContributors.size, 0);
});
