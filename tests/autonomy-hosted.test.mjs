// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { checkReturns } from './convex-args.mjs';
import { projectRow, state } from './hosted-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { dispatchHostedWork } from '../dist/hosted-work-client.js';
const devices = await import(moduleUrl('../convex/deviceStore.ts'));
const policies = await import(moduleUrl('../convex/projectAutonomy.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
// Policy and Channel authority run on the hosted project row alone; no Work archive is needed.
function hosted() {
  const s = state([]);
  s.tables.projectPolicyChanges = new Map();
  s.tables.projectSelfMetricReceipts = new Map();
  const projectId = 'project';
  s.tables.hostedProjects.set(
    projectId,
    projectRow({ _id: projectId, key: randomUUID(), autonomyPolicy: policyPreset('supervised') }),
  );
  const selection = () => ({
    projectId,
    operationId: randomUUID(),
    revision: 0,
    command: JSON.stringify({
      action: 'accept-hosted-channel',
      channel: 'main',
      viewId: randomUUID(),
      head: 'a'.repeat(64),
      previousId: null,
      archiveSha256: 'b'.repeat(64),
    }),
  });
  function device(scope) {
    s.tables.cliCredentials.set('device', {
      _id: 'device',
      credentialId: 'device',
      owner: 'owner',
      scope,
      expiresAt: Date.now() + 60000,
      revoked: false,
    });
    s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'device' });
    const run = s.ctx.runQuery;
    s.ctx.runQuery = (ref, args) =>
      getFunctionName(ref) === 'deviceStore:authorize'
        ? devices.authorize._handler(s.ctx, args)
        : run(ref, args);
  }
  return { ...s, projectId, selection, device };
}
const errorCode = code => error => error.data?.code === code;
test('new hosted project gets supervised; contributors cannot set policy', async () => {
  const s = hosted();
  assert.equal((await policies.read._handler(s.ctx, { projectId: s.projectId })).preset, 'supervised');
  s.tables.projectContributors.set('member', {
    _id: 'member',
    projectId: s.projectId,
    contributor: 'member',
    agentGuidanceMaintainer: true,
  });
  s.caller('member');
  assert.equal((await policies.read._handler(s.ctx, { projectId: s.projectId })).preset, 'supervised');
  await assert.rejects(
    policies.set._handler(s.ctx, {
      projectId: s.projectId,
      command: JSON.stringify({ action: 'set-policy', operationId: randomUUID(), preset: 'autonomous' }),
    }),
    errorCode('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    policies.set._handler(s.ctx, {
      projectId: s.projectId,
      command: JSON.stringify({
        action: 'set-policy',
        operationId: randomUUID(),
        checks: {
          runner: 'modal',
          credentialsRef: { kind: 'env', tokenId: 'PROJECT_ID', tokenSecret: 'PROJECT_SECRET' },
        },
      }),
    }),
    errorCode('PROJECT_UNAVAILABLE'),
  );

  s.caller(undefined);
  await assert.rejects(
    policies.read._handler(s.ctx, { projectId: s.projectId }),
    errorCode('PROJECT_UNAVAILABLE'),
  );
});

test('agentDefaults.stacking sets, reads back and clears through the real Convex shapes (bench c5e86d71)', async () => {
  const s = hosted();
  const set = async stacking => {
    const reply = await policies.set._handler(s.ctx, {
      projectId: s.projectId,
      command: JSON.stringify({
        action: 'set-policy',
        operationId: randomUUID(),
        agentDefaults: { stacking },
      }),
    });
    checkReturns(policies.set, reply, 'projectAutonomy:set');
    const read = await policies.read._handler(s.ctx, { projectId: s.projectId });
    checkReturns(policies.read, read, 'projectAutonomy:read');
    return { reply, read };
  };
  // The fixture's patch enforces convex/schema.ts, so a validator without the field fails here.
  const auto = await set('auto');
  assert.equal(auto.reply.policy.agentDefaults.stacking, 'auto');
  assert.equal(auto.read.agentDefaults.stacking, 'auto');
  assert.equal(s.tables.hostedProjects.get(s.projectId).autonomyPolicy.agentDefaults.stacking, 'auto');
  // Back to the documented default.
  const offer = await set('offer');
  assert.equal(offer.read.agentDefaults.stacking, 'offer');
  assert.equal(s.tables.projectPolicyChanges.size, 2);
});

test('coordination-only credentials cannot set policy, even with owner subject', async () => {
  const s = hosted();
  s.device('coordination');

  await assert.rejects(
    policies.set._handler(s.ctx, {
      projectId: s.projectId,
      command: JSON.stringify({ action: 'set-policy', operationId: randomUUID(), preset: 'autonomous' }),
    }),
    errorCode('AUTH_SCOPE_DENIED'),
  );
});

test('hosted policy retries preserve later edits and need no Work index through CLI/MCP transport', async () => {
  const s = hosted(),
    op = { action: 'set-policy', operationId: randomUUID(), preset: 'trusted' };
  const client = {
    query: (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectAutonomy:read');
      return policies.read._handler(s.ctx, args);
    },
    mutation: (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectAutonomy:set');
      return policies.set._handler(s.ctx, args);
    },
    action: () => assert.fail('policy must not prepare a Work index'),
  };
  const initial = await dispatchHostedWork(client, s.projectId, op);
  await dispatchHostedWork(client, s.projectId, {
    action: 'set-policy',
    operationId: randomUUID(),
    notify: { awaySummary: false },
  });
  assert.deepEqual(await dispatchHostedWork(client, s.projectId, op), initial);
  assert.equal(
    (await dispatchHostedWork(client, s.projectId, { action: 'policy' })).notify.awaySummary,
    false,
  );
});

test('internal Channel mutation cannot substitute an owner argument for the authenticated participant', async () => {
  const s = hosted(),
    selection = s.selection();
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'not-owner' });
  await assert.rejects(
    work.append._handler(s.ctx, {
      projectId: s.projectId,
      owner: 'owner',
      operationId: selection.operationId,
      request: 'a'.repeat(64),
      previousRevision: selection.revision,
      command: selection.command,
    }),
    errorCode('PROJECT_UNAVAILABLE'),
  );
  assert.equal(s.tables.projectWorkEvents.size, 0);
});

test('hosted object import creation stores supervised and leaves an existing project policy alone', async () => {
  const s = state([]),
    key = randomUUID();
  const objects = await import(moduleUrl('../convex/projectBackupObjects.ts'));
  const projectId = await objects.open._handler(s.ctx, { key, name: 'New project' });
  assert.equal(s.tables.hostedProjects.get(projectId).autonomyPolicy.preset, 'supervised');
  s.tables.hostedProjects.get(projectId).autonomyPolicy = policyPreset('trusted');
  assert.equal(await objects.open._handler(s.ctx, { key, name: 'New project' }), projectId);
  assert.equal(s.tables.hostedProjects.get(projectId).autonomyPolicy.preset, 'trusted');
});

test('an account JWT can downscope to agent authority but cannot bypass supervised acceptance', async () => {
  const s = state([]);
  assert.equal((await policies.acceptanceActor(s.ctx)).kind, 'person');
  assert.equal((await policies.acceptanceActor(s.ctx, true)).kind, 'agent');
  const { hostedAcceptance } = await import(moduleUrl('../convex/projectAcceptance.ts'));
  await assert.rejects(
    hostedAcceptance(
      s.ctx,
      'project',
      { autonomyPolicy: policyPreset('supervised') },
      {
        action: 'accept-hosted-channel',
        agent: true,
        channel: 'main',
        viewId: randomUUID(),
        head: 'a'.repeat(64),
        previousId: null,
        archiveSha256: 'b'.repeat(64),
      },
    ),
    error => error.code === 'REVIEW_REQUIRED',
  );
});
