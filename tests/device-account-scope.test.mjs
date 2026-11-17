// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { v } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const api = await import(moduleUrl('../convex/cliServer.ts'));
const teams = await import(moduleUrl('../convex/teams.ts'));
const actions = await import(moduleUrl('../convex/teamActions.ts'));
const handles = await import(moduleUrl('../convex/urlAccounts.ts'));
const hosting = await import(moduleUrl('../convex/projectBackupObjects.ts'));
const devices = await import(moduleUrl('../convex/deviceStore.ts'));
const cleanup = await import(moduleUrl('../convex/projectDeleteRequests.ts'));
const guidance = await import(moduleUrl('../convex/agentGuidance.ts'));
const invitations = await import(moduleUrl('../convex/projectInvitationAnswers.ts'));
const refused = e => (e.data?.code ?? e.code) === 'AUTH_SCOPE_DENIED';
function credential(s, settings, scope = 'cli') {
  const credentialId = randomUUID();
  s.tables.cliCredentials.set(credentialId, {
    _id: credentialId,
    _creationTime: 1,
    owner: 'owner',
    credentialId,
    scope,
    issuedAt: 1,
    expiresAt: Date.now() + 600000,
    tokenHash: 'synthetic',
    revoked: false,
    name: 'Synthetic',
    settings,
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
  const run = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) =>
    getFunctionName(ref) === 'deviceStore:authorize'
      ? devices.authorize._handler(s.ctx, args)
      : run(ref, args);
}

test('SI-03: selected-project and read-only devices cannot change handles, teams or create projects; browsers retain those writes', async () => {
  for (const settings of [
    { source: 'write', projects: { kind: 'project', projectId: 'selected' } },
    { source: 'read', projects: { kind: 'all' } },
  ]) {
    const s = state();
    credential(s, settings);
    for (const work of [
      () => handles.set._handler(s.ctx, { handle: 'new-handle', operationId: randomUUID() }),
      () => handles.ensure._handler(s.ctx, { username: 'new-handle' }),
      () => teams.create._handler(s.ctx, { name: 'Team', operationId: randomUUID() }),
      () => teams.removeMember._handler(s.ctx, { id: 'not-a-team', member: 'other' }),
      () => hosting.open._handler(s.ctx, { name: 'Project', key: randomUUID() }),
      () => cleanup.prepare._handler(s.ctx, { operationId: randomUUID(), select: { trash: true } }),
      () => cleanup.withdraw._handler(s.ctx, { requestId: 'not-a-request' }),
    ])
      await assert.rejects(work(), refused);
    assert.equal(s.tables.teams.size, 0);
    assert.equal(s.tables.hostedProjects.size, 0);
  }
  const s = state();
  assert.equal(
    typeof (await teams.create._handler(s.ctx, { name: 'Team', operationId: randomUUID() })),
    'string',
  );
});

test('SI-03: every device scope gets the web handle message; unrestricted devices cannot grant team membership by handle, email or internal grant', async () => {
  const s = state();
  credential(s, { source: 'write', projects: { kind: 'all' } });
  for (const scope of ['cli', 'coordination']) {
    const account = state();
    credential(
      account,
      { source: scope === 'cli' ? 'write' : 'coordination', projects: { kind: 'all' } },
      scope,
    );
    for (const work of [
      () => handles.set._handler(account.ctx, { handle: 'new-handle', operationId: randomUUID() }),
      () => handles.ensure._handler(account.ctx, { username: 'new-handle' }),
    ])
      await assert.rejects(
        work(),
        e =>
          refused(e) &&
          (e.data?.message ?? e.message) === 'Change your handle on the web: Settings → Account',
      );
  }
  for (const work of [
    () => actions.addMember._handler(s.ctx, { id: 'team', member: 'other' }),
    () => actions.addByEmail._handler(s.ctx, { id: 'team', email: 'synthetic@example.com' }),
    () => teams.add._handler(s.ctx, { id: 'team', owner: 'owner', member: 'other' }),
  ])
    await assert.rejects(work(), refused);
  assert.equal(s.tables.teamMembers.size, 0);
});

test('SI-03: registering an account mutation without a device decision fails; explicit account and project registrations remain usable', () => {
  const definition = { args: {}, returns: v.null(), handler: () => null };
  assert.throws(() => api.mutation(definition), /must declare device access/);
  assert(api.accountMutation('write')(definition));
  assert(api.mutation({ ...definition, args: { projectId: v.id('hostedProjects') } }));
  assert.throws(
    () => api.mutation({ ...definition, args: { id: v.id('teams') } }),
    /must declare device access/,
  );
  assert.throws(() => api.coordinationMutation(definition), /must declare device access/);
  assert.throws(() => api.receiptMutation(definition), /must declare device access/);
});

test('SI-03 incident: invitation answers and unblock refuse even unrestricted device and agent credentials before account writes', async () => {
  for (const scope of ['cli', 'coordination']) {
    const s = state();
    credential(s, { source: 'write', projects: { kind: 'all' } }, scope);
    for (const work of [
      () =>
        invitations.answer._handler(s.ctx, {
          invitationId: 'invitation',
          operationId: randomUUID(),
          choice: 'accept',
        }),
      () =>
        invitations.unblock._handler(s.ctx, {
          id: 'block',
          operationId: randomUUID(),
          expectedVersion: 1,
        }),
    ])
      await assert.rejects(work(), refused);
    assert.equal(s.tables.projectContributors.size, 0);
    assert.equal(s.tables.projectReaders.size, 0);
    assert.equal(s.tables.invitationBlocks.size, 0);
  }
});

test('SI-03 review: a read-only one-project device cannot write personal guidance with an absent or unused project selector', async () => {
  for (const projectId of [undefined, 'selected']) {
    const s = state();
    credential(s, { source: 'read', projects: { kind: 'project', projectId: 'selected' } });
    s.tables.agentUserSettings = new Map([
      ['personal', { _id: 'personal', _creationTime: 1, actor: 'owner', agentGuidance: 'Keep this' }],
    ]);
    s.tables.agentGuidanceOperations = new Map();
    await assert.rejects(
      guidance.set._handler(s.ctx, {
        operationId: randomUUID(),
        scope: 'personal',
        agentGuidance: 'Changed',
        ...(projectId ? { projectId } : {}),
      }),
      refused,
    );
    assert.equal(s.tables.agentUserSettings.get('personal').agentGuidance, 'Keep this');
    assert.equal(s.tables.agentGuidanceOperations.size, 0);
  }
  const s = state();
  credential(s, { source: 'write', projects: { kind: 'all' } });
  s.tables.agentUserSettings = new Map();
  s.tables.agentGuidanceOperations = new Map();
  const result = await guidance.set._handler(s.ctx, {
    operationId: randomUUID(),
    scope: 'personal',
    agentGuidance: 'Allowed',
  });
  assert.equal(result.agentGuidance, 'Allowed');
});
