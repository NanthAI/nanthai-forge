// SPDX-License-Identifier: Apache-2.0
// Item 5ba7c7f9 (docs/access.md#what-leaves-convex): a signed-in stranger on a public project reads the project, but
// no owner-only or personal field of it. The row carries one marker value per such field; no project read may return
// any of them to the stranger, and the owner still reads them all. Policy copies inside other reads (workspace, pinned
// landing attempts, capsules, briefings) pass the same public boundary (convex/publicPeople.ts), checked directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { state, backupRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const projectWork = await import(moduleUrl('../convex/projectWork.ts'));
const projectAutonomy = await import(moduleUrl('../convex/projectAutonomy.ts'));
const unchecked = await import(moduleUrl('../convex/projectUncheckedLandingSettings.ts'));
const agent = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const { policyPreset } = await import(moduleUrl('../src/autonomy-policy.ts'));
const { publicPeople } = await import(moduleUrl('../convex/publicPeople.ts'));

const secret = {
  email: 'stall-alerts@example.invalid',
  credentials: 'SYNTHETIC_CREDENTIAL_SECRET_NAME',
  purgedItem: 'purged-item-marker',
  guidance: 'owner-guidance-marker',
  request: 'owner-hosting-request-marker',
  generation: 'work-generation-marker',
};
function setup() {
  const s = state([]);
  const policy = policyPreset('supervised');
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'synthetic',
    name: 'Viewer fields project',
    visibility: 'public',
    planVisibility: 'members',
    currentBackup: 'backup',
    revision: 1,
    work: {
      backupId: 'backup',
      operationId: 'work-operation',
      initialRevision: 0,
      revision: 1,
      generationId: secret.generation,
    },
    hostingRequest: JSON.stringify([secret.request, 'public']),
    agentGuidance: secret.guidance,
    itemPurges: [
      {
        operationId: 'purge',
        itemId: secret.purgedItem,
        ids: [],
        version: 1,
        decisions: [],
        rows: 0,
        startedAt: 1,
      },
    ],
    autonomyPolicy: {
      ...policy,
      checks: {
        runner: 'github-actions',
        credentialsRef: { kind: 'env', tokenId: secret.credentials, tokenSecret: secret.credentials },
      },
      agentDefaults: { stallAlerts: { enabled: true, email: [secret.email] } },
    },
  });
  s.tables.projectBackups.set(
    'backup',
    backupRow({ _id: 'backup', projectId: 'project', digest: 'a'.repeat(64) }),
  );
  return s;
}
const reads = {
  'projectWork.state': s => projectWork.state._handler(s.ctx, { projectId: 'project' }),
  'projectAutonomy.read': s => projectAutonomy.read._handler(s.ctx, { projectId: 'project' }),
  'projectUncheckedLandingSettings.read': s => unchecked.read._handler(s.ctx, { projectId: 'project' }),
  'projectHostedAgent.capabilities': async s =>
    JSON.parse(await agent.capabilities._handler(s.ctx, { projectId: 'project', defaultsVersion: 1 })),
};
const leaked = reply => Object.values(secret).filter(value => JSON.stringify(reply).includes(value));

test('a signed-in stranger on a public project gets no owner-only or personal field from any project read', async () => {
  for (const [name, read] of Object.entries(reads)) {
    const s = setup();
    s.caller('stranger');
    const reply = await read(s);
    assert.deepEqual(leaked(reply), [], name);
  }
  const s = setup();
  s.caller('stranger');
  const view = await reads['projectWork.state'](s);
  // The screens still get what they read: identity, name, visibility, plan setting, selected source and revision.
  assert.deepEqual(Object.keys(view).sort(), [
    '_creationTime',
    '_id',
    'currentBackup',
    'key',
    'name',
    'owner',
    'planVisibility',
    'revision',
    'visibility',
    'work',
  ]);
  assert.deepEqual(view.work, {
    backupId: 'backup',
    operationId: 'work-operation',
    initialRevision: 0,
    revision: 1,
  });
});

test('a pinned policy inside any read loses its alert addresses and check credentials for a stranger only', async () => {
  // The shape a landing attempt or workspace reply carries: canonical JSON with the policy nested inside.
  const s = setup();
  const policy = s.tables.hostedProjects.get('project').autonomyPolicy;
  const reply = JSON.stringify({ attempt: { attemptId: 'a', policy } });
  s.caller('stranger');
  assert.deepEqual(leaked(await publicPeople(s.ctx, { projectId: 'project' }, reply)), []);
  s.caller('owner');
  const own = await publicPeople(s.ctx, { projectId: 'project' }, reply);
  assert.deepEqual(leaked(own).sort(), [secret.credentials, secret.email].sort());
});

test('the owner still reads the stall-alert recipients and check credentials of their own project', async () => {
  const s = setup();
  s.caller('owner');
  const project = await reads['projectWork.state'](s);
  assert.equal(project.agentGuidance, secret.guidance);
  const policy = await reads['projectAutonomy.read'](s);
  assert.deepEqual(policy.agentDefaults.stallAlerts.email, [secret.email]);
  assert.equal(policy.checks.credentialsRef.tokenId, secret.credentials);
  const capabilities = await reads['projectHostedAgent.capabilities'](s);
  assert.deepEqual(capabilities.agentDefaults.stallAlerts.email, [secret.email]);
});

test('the empty-hosted-project marker still reaches a viewer, so the web opens its first channel', async () => {
  const s = setup();
  s.tables.hostedProjects.get('project').hostingRequest = JSON.stringify([
    'empty-hosted-project',
    'Viewer fields project',
  ]);
  s.caller('stranger');
  const view = await reads['projectWork.state'](s);
  assert.equal(view.hostingRequest, '["empty-hosted-project","Viewer fields project"]');
});
