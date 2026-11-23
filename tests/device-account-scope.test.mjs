// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { v } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { job, providers, state } from './hosted-fixture.mjs';
const api = await import(moduleUrl('../convex/cliServer.ts'));
const teams = await import(moduleUrl('../convex/teams.ts'));
const actions = await import(moduleUrl('../convex/teamActions.ts'));
const handles = await import(moduleUrl('../convex/urlAccounts.ts'));
const hosting = await import(moduleUrl('../convex/projectBackupObjects.ts'));
const devices = await import(moduleUrl('../convex/deviceStore.ts'));
const cleanup = await import(moduleUrl('../convex/projectDeleteRequests.ts'));
const guidance = await import(moduleUrl('../convex/agentGuidance.ts'));
const invitations = await import(moduleUrl('../convex/projectInvitationAnswers.ts'));
const hosted = await import(moduleUrl('../convex/hosted.ts'));
const projectImport = await import(moduleUrl('../convex/projectGithubImport.ts'));
const viewActions = await import(moduleUrl('../convex/savedViewActions.ts'));
const views = await import(moduleUrl('../convex/savedViews.ts'));
const secretActions = await import(moduleUrl('../convex/secretActions.ts'));
const secrets = await import(moduleUrl('../convex/secrets.ts'));
const secretLifecycle = await import(moduleUrl('../convex/secretLifecycle.ts'));
const refused = e => (e.data?.code ?? e.code) === 'AUTH_SCOPE_DENIED';
const restricted = [
  { source: 'write', projects: { kind: 'project', projectId: 'selected' } },
  { source: 'read', projects: { kind: 'all' } },
];
const unrestricted = { source: 'write', projects: { kind: 'all' } };

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
const actionContext = ({ ctx }) => ({
  auth: ctx.auth,
  runQuery: ctx.runQuery,
  runMutation: ctx.runMutation,
});

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

test('public actions require an account device decision or a declared resource selector', async () => {
  const definition = { args: {}, returns: v.string(), handler: () => 'allowed' };
  const project = { ...definition, args: { projectId: v.id('hostedProjects') } };
  const mapped = api.actionWithMappedResult(value => value);
  for (const register of [api.action, api.coordinationAction, mapped]) {
    assert.throws(() => register(definition), /must declare device access with accountAction/);
    assert(register(project));
  }
  const s = state();
  credential(s, restricted[1]);
  const ctx = actionContext(s);
  assert.equal(await api.accountAction('same')(definition)._handler(ctx, {}), 'allowed');
  await assert.rejects(
    api.accountAction('write')(definition)._handler(ctx, {}),
    error => error.data?.code === 'AUTH_SCOPE_DENIED',
  );
  assert.equal(await api.action(project)._handler(ctx, { projectId: 'selected' }), 'allowed');
});

test('device account write policy gates import starts and refreshes while public and unrestricted imports still start', async t => {
  t.after(providers(() => false, false));
  const url = 'https://github.com/example/project';
  for (const settings of restricted) {
    const s = state([{ ...job(), visibility: 'public', owner: '', scope: 'public' }]);
    credential(s, settings);
    const ctx = actionContext(s);
    const before = structuredClone(s.tables.imports);
    await assert.rejects(hosted.start._handler(ctx, { url }), refused);
    await assert.rejects(hosted.refresh._handler(ctx, { id: 'own' }), refused);
    await assert.rejects(projectImport.start._handler(ctx, { url, operationId: randomUUID() }), refused);
    assert.deepEqual(s.tables.imports, before);
    assert.equal(s.scheduled.length, 0);
  }
  const browser = state();
  browser.caller(undefined);
  const publicId = await hosted.start._handler(actionContext(browser), { url });
  assert.equal(browser.tables.imports.get(publicId).owner, '');

  const s = state();
  credential(s, unrestricted);
  const ctx = actionContext(s);
  const id = await hosted.start._handler(ctx, { url });
  assert.equal(s.tables.imports.get(id).phase, 'queued');
  // A refresh starts the next generation once the original import settled.
  s.tables.imports.get(id).phase = 'ready';
  assert.equal(await hosted.refresh._handler(ctx, { id }), id);
  assert.equal(s.tables.imports.get(id).generation, 2);
});

test('restricted devices cannot save, rename or remove saved views; unrestricted devices can still replay, rename and remove', async () => {
  const input = {
    importId: 'own',
    operationId: randomUUID(),
    name: 'Saved source',
    route: { view: 'source', state: 'a'.repeat(64), file: 'a.ts', line: 1 },
  };
  for (const settings of [...restricted, unrestricted]) {
    const s = state([job()]);
    const id = await views.put._handler(s.ctx, input);
    credential(s, settings);
    if (settings !== unrestricted) {
      await assert.rejects(viewActions.save._handler(actionContext(s), input), refused);
      await assert.rejects(views.rename._handler(s.ctx, { id, name: 'Denied rename' }), refused);
      await assert.rejects(views.remove._handler(s.ctx, { id }), refused);
      assert.equal(s.tables.savedViews.get(id).name, input.name);
    } else {
      assert.equal(await viewActions.save._handler(actionContext(s), input), id);
      await views.rename._handler(s.ctx, { id, name: 'Allowed rename' });
      assert.equal(s.tables.savedViews.get(id).name, 'Allowed rename');
      await views.remove._handler(s.ctx, { id });
      assert.equal(s.tables.savedViews.has(id), false);
    }
  }
});

test('only unrestricted devices can create, rotate, grant, disable or trash Secret Objects', async t => {
  t.after(providers());
  const previous = process.env.FORGE_SECRET_KEYS;
  process.env.FORGE_SECRET_KEYS = JSON.stringify({
    active: 'fixture',
    keys: { fixture: randomBytes(32).toString('base64') },
  });
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_SECRET_KEYS;
    else process.env.FORGE_SECRET_KEYS = previous;
  });
  const create = {
    name: 'FIXTURE',
    repository: 'example/project',
    ref: 'main',
    value: 'synthetic',
    operationId: randomUUID(),
  };
  for (const settings of [...restricted, unrestricted]) {
    const s = state();
    const id = await secretActions.create._handler(actionContext(s), create);
    credential(s, settings);
    const ctx = actionContext(s);
    const envInput = {
      env: 'FIXTURE=synthetic',
      variable: 'FIXTURE',
      repository: create.repository,
      ref: 'other',
      operationId: randomUUID(),
    };
    const rotate = { id, value: 'rotated', expectedVersion: 1, operationId: randomUUID() };
    const grant = {
      id,
      principal: 'synthetic-reader',
      capabilities: ['use'],
      expectedPolicyRevision: 1,
      operationId: randomUUID(),
    };
    const disable = { id, enabled: false, expectedPolicyRevision: 2, operationId: randomUUID() };
    const trash = { id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() };
    if (settings !== unrestricted) {
      await assert.rejects(secretActions.create._handler(ctx, create), refused);
      await assert.rejects(secretActions.createFromEnv._handler(ctx, envInput), refused);
      await assert.rejects(secretActions.rotate._handler(ctx, rotate), refused);
      await assert.rejects(secretActions.grant._handler(ctx, grant), refused);
      await assert.rejects(secrets.enabled._handler(s.ctx, disable), refused);
      await assert.rejects(secrets.archive._handler(s.ctx, trash), refused);
      assert.equal(s.tables.secretVersions.size, 1);
      assert.equal(s.tables.secretEvents.size, 1);
      assert.equal(s.tables.secretGrants.size, 1);
      assert.equal(s.tables.secretObjects.get(id).disabled, false);
      assert.equal(s.tables.secretObjects.get(id).archived, undefined);
      continue;
    }
    assert.equal(
      typeof (await secretActions.create._handler(ctx, { ...create, operationId: randomUUID() })),
      'string',
    );
    assert.equal(typeof (await secretActions.createFromEnv._handler(ctx, envInput)).id, 'string');
    assert.equal(await secretActions.rotate._handler(ctx, rotate), 2);
    await secretActions.grant._handler(ctx, grant);
    assert.deepEqual(
      [...s.tables.secretGrants.values()].find(
        row => row.secretId === id && row.principal === grant.principal,
      )?.capabilities,
      grant.capabilities,
    );
    await secrets.enabled._handler(s.ctx, disable);
    assert.equal(s.tables.secretObjects.get(id).disabled, true);
    await secrets.archive._handler(s.ctx, trash);
    assert.equal(s.tables.secretObjects.get(id).archived, true);

    credential(s, restricted[1]);
    await secrets.enabled._handler(s.ctx, {
      ...disable,
      enabled: true,
      expectedPolicyRevision: 3,
      operationId: randomUUID(),
    });
    await secrets.archive._handler(s.ctx, {
      ...trash,
      archived: false,
      expectedArchiveRevision: 1,
      operationId: randomUUID(),
    });
    assert.equal(s.tables.secretObjects.get(id).disabled, false);
    assert.equal(s.tables.secretObjects.get(id).archived, false);
    await secretActions.grant._handler(actionContext(s), {
      ...grant,
      capabilities: [],
      expectedPolicyRevision: 4,
      operationId: randomUUID(),
    });
    assert.equal(
      [...s.tables.secretGrants.values()].some(
        row => row.secretId === id && row.principal === grant.principal,
      ),
      false,
    );
  }
});

test('permanent Secret Object deletion refuses even an unrestricted device and the browser owner can delete and replay', async () => {
  const s = state();
  const person = s.ctx.auth.getUserIdentity;
  const id = await s.ctx.db.insert('secretObjects', {
    owner: 'owner',
    name: 'Fixture',
    operationId: randomUUID(),
    repository: 'example/project',
    ref: 'main',
    version: 1,
    disabled: false,
    policyRevision: 1,
  });
  const input = { id, operationId: randomUUID(), version: 1, policyRevision: 1, archiveRevision: 0 };
  credential(s, unrestricted);
  await assert.rejects(secretLifecycle.permanentlyDelete._handler(s.ctx, input), refused);
  assert.equal(s.tables.secretDeletions.size, 0);
  assert.equal(s.tables.secretObjects.get(id).deleting, undefined);
  s.ctx.auth.getUserIdentity = person;
  const receipt = await secretLifecycle.permanentlyDelete._handler(s.ctx, input);
  assert.equal(receipt.status, 'deleting');
  assert.deepEqual(await secretLifecycle.permanentlyDelete._handler(s.ctx, input), receipt);
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
