// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { WorkService } from '../dist/work.js';
import { digest } from '../dist/hash.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { dispatchHostedWork } from '../dist/hosted-work-client.js';
const devices = await import(moduleUrl('../convex/deviceStore.ts'));
const policies = await import(moduleUrl('../convex/projectAutonomy.ts'));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const { previewWorkArchive } = await import(moduleUrl('../web/src/work-archive.ts'));
async function hosted(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-hosted-autonomy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Proposal' })).result;
  writeFileSync(join(lane.path, 'file.txt'), 'proposal\n');
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const finish = (
    await agent.dispatch({ action: 'finish', laneId: lane.laneId, message: 'Proposal', accept: true })
  ).result;
  assert.equal(finish.status, 'awaiting-review');
  const owner = new WorkService(root),
    archive = (await owner.dispatch({ action: 'export-work', archive: true }, owner.store.revision())).result
      .archive;
  const bytes = readFileSync(archive.path),
    preview = await previewWorkArchive(new File([bytes], 'proposal.tar.gz'));
  const s = state([]),
    native = s.ctx.runQuery;
  s.tables.projectPolicyChanges = new Map();
  s.ctx.runQuery = s.ctx.runMutation = (ref, input) => {
    const [module, name] = getFunctionName(ref).split(':');
    return (
      { projectWork: work, projectBackups: backups }[module]?.[name]?._handler(s.ctx, input) ??
      native(ref, input)
    );
  };
  const projectId = 'project',
    backupId = 'backup';
  s.tables.hostedProjects.set(projectId, {
    _id: projectId,
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Proposal',
    currentBackup: backupId,
    revision: 1,
    autonomyPolicy: policyPreset('supervised'),
  });
  s.tables.projectBackups.set(backupId, {
    _id: backupId,
    _creationTime: 1,
    projectId,
    operationId: randomUUID(),
    request: 'a'.repeat(64),
    nonce: randomUUID(),
    previous: null,
    digest: digest(bytes),
    size: bytes.length,
    preview,
    status: 'stored',
    storageId: 'source',
  });
  s.files.set('source', { blob: new Blob([bytes], { type: 'application/gzip' }) });
  await actions.initialize._handler(s.ctx, { projectId, backupId, operationId: randomUUID() });
  const selection = () => ({
    projectId,
    operationId: randomUUID(),
    revision:
      [...s.tables.projectWorkHeads.values()].find(h => h.projectId === projectId)?.revision ??
      s.tables.hostedProjects.get(projectId).work.revision,
    command: JSON.stringify({
      action: 'accept-hosted-channel',
      channel: 'main',
      viewId: finish.view.viewId,
      head: finish.view.head,
      previousId: null,
      archiveSha256: digest(bytes),
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
test('new hosted project gets supervised; contributors cannot set policy or accept', async t => {
  const s = await hosted(t);
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
    actions.acceptChannel._handler(s.ctx, s.selection()),
    errorCode('PROJECT_UNAVAILABLE'),
  );
  s.caller(undefined);
  await assert.rejects(
    policies.read._handler(s.ctx, { projectId: s.projectId }),
    errorCode('PROJECT_UNAVAILABLE'),
  );
});
test('supervised hosted CLI proposes; browser person accepts an unaccepted local View', async t => {
  const s = await hosted(t);
  s.device('cli');
  await assert.rejects(actions.acceptChannel._handler(s.ctx, s.selection()), errorCode('REVIEW_REQUIRED'));
  assert.equal(s.tables.projectWorkEvents.size, 0);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const op = s.selection(),
    accepted = await actions.acceptChannel._handler(s.ctx, op);
  assert.equal(JSON.parse(accepted.command).viewId, JSON.parse(op.command).viewId);
  assert.deepEqual(await actions.acceptChannel._handler(s.ctx, op), accepted);
});
test('CLI auto-on-pass uses exact-View check; actor allowlist and unavailable protected coverage force review', async t => {
  const s = await hosted(t);
  s.device('cli');
  const set = fields =>
    policies.set._handler(s.ctx, {
      projectId: s.projectId,
      command: JSON.stringify({ action: 'set-policy', operationId: randomUUID(), ...fields }),
    });
  await set({ preset: 'trusted', acceptance: { autoActors: ['other'] } });
  await assert.rejects(actions.acceptChannel._handler(s.ctx, s.selection()), errorCode('REVIEW_REQUIRED'));
  await set({ preset: 'autonomous', acceptance: { protectedPaths: ['**/file.txt'] } });
  await assert.rejects(actions.acceptChannel._handler(s.ctx, s.selection()), errorCode('REVIEW_REQUIRED'));
  await set({ preset: 'trusted' });
  const accepted = await actions.acceptChannel._handler(s.ctx, s.selection());
  assert.ok(accepted.automatic.runId);
  assert.equal(accepted.automatic.actor, 'owner');
  assert.match(accepted.automatic.undo, /compensating/);
});
test('coordination-only credentials cannot accept or set policy, even with owner subject', async t => {
  const s = await hosted(t);
  s.device('coordination');
  await assert.rejects(actions.acceptChannel._handler(s.ctx, s.selection()), errorCode('AUTH_SCOPE_DENIED'));
  await assert.rejects(
    policies.set._handler(s.ctx, {
      projectId: s.projectId,
      command: JSON.stringify({ action: 'set-policy', operationId: randomUUID(), preset: 'autonomous' }),
    }),
    errorCode('AUTH_SCOPE_DENIED'),
  );
});
test('hosted final mutation rechecks a policy changed after action evidence', async t => {
  const s = await hosted(t);
  s.device('cli');
  await policies.set._handler(s.ctx, {
    projectId: s.projectId,
    command: JSON.stringify({ action: 'set-policy', operationId: randomUUID(), preset: 'trusted' }),
  });
  const append = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectWork:append')
      s.tables.hostedProjects.get(s.projectId).autonomyPolicy = policyPreset('supervised');
    return append(ref, args);
  };
  await assert.rejects(actions.acceptChannel._handler(s.ctx, s.selection()), errorCode('POLICY_CHANGED'));
  assert.equal(s.tables.projectWorkEvents.size, 0);
});
test('hosted policy retries preserve later edits and need no Work index through CLI/MCP transport', async t => {
  const s = await hosted(t),
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

test('internal Channel mutation cannot substitute an owner argument for the authenticated participant', async t => {
  const s = await hosted(t),
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

test('final hosted Channel mutation rejects an automatic receipt without an exact passing run', async t => {
  const s = await hosted(t);
  s.device('cli');
  await policies.set._handler(s.ctx, {
    projectId: s.projectId,
    command: JSON.stringify({ action: 'set-policy', operationId: randomUUID(), preset: 'trusted' }),
  });
  const append = s.ctx.runMutation;
  s.ctx.runMutation = (ref, args) => {
    if (getFunctionName(ref) === 'projectWork:append')
      args.projection.acceptance.automatic.runId = randomUUID();
    return append(ref, args);
  };
  await assert.rejects(actions.acceptChannel._handler(s.ctx, s.selection()), errorCode('CHECK_REQUIRED'));
  assert.equal(s.tables.projectWorkEvents.size, 0);
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
