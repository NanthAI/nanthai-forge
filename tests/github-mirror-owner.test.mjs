// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mirrorControlsFixture as fixture } from './github-mirror-controls-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { job } from './hosted-fixture.mjs';
import { digest } from '../dist/hash.js';
const grants = await import(moduleUrl('../convex/agentGrants.ts'));
const agentActions = await import(moduleUrl('../convex/agentActions.ts'));
const policies = await import(moduleUrl('../convex/projectAutonomy.ts'));
const binding = await import(moduleUrl('../convex/githubBindingStore.ts'));
const resume = await import(moduleUrl('../convex/projectGithubMirrorResume.ts'));

test('a valid scoped agent grant cannot authenticate as its owner to pause, un-pause, disconnect or recover the mirror', async () => {
  const f = fixture();
  const { _id, _creationTime, ...source } = job();
  const importId = f.insert('imports', source);
  const token = `fga_${randomBytes(32).toString('base64url')}`,
    tokenHash = digest(token);
  const id = f.insert('agentGrants', {
    owner: 'owner',
    name: 'Synthetic read agent',
    operationId: randomUUID(),
    request: 'synthetic',
    importId,
    artifactKey: source.artifactKey,
    sourceId: 'a'.repeat(64),
    gitHead: 'a'.repeat(40),
    files: ['one.txt'],
    tools: ['status'],
    expiresAt: Date.now() + 600000,
    revoked: false,
    tokenHash,
    sealed: { keyId: 'synthetic', nonce: 'synthetic', tag: 'synthetic', ciphertext: 'synthetic' },
  });
  assert.equal(
    (await f.call('authorize-grant', grants.authorize, { tokenHash, tool: 'status' }, null))._id,
    id,
  );
  const agentContext = {
    auth: { getUserIdentity: async () => null },
    runMutation: (_ref, args) => f.call('agent-bearer', grants.authorize, args, null),
  };
  for (const endpoint of [
    'projectAutonomy:set',
    'githubBindingStore:remove',
    'projectGithubMirrorResume:resume',
  ])
    await assert.rejects(
      agentActions.read._handler(agentContext, { token, endpoint }),
      e => e.data?.code === 'AGENT_TOOL_DENIED',
    );
  // An fga_ grant is a scoped bearer, not a person/device JWT. A valid grant supplies no signed-in owner identity.
  for (const [name, fn, args] of [
    ['pause', policies.set, f.change(false)],
    ['unpause', policies.set, f.change(true)],
    ['disconnect', binding.remove, { projectId: f.projectId, operationId: randomUUID(), repoId: 42 }],
    ['recover', resume.resume, { projectId: f.projectId }],
  ])
    await assert.rejects(f.call(name, fn, args, null), e => e.data?.code === 'PROJECT_UNAVAILABLE');
  assert.equal(
    f.tables.cliCredentials.size,
    0,
    'the grant was not substituted by an owner device credential',
  );
});

for (const inbound of [false, true])
  test(`a pre-P8 off mirror keeps its ${inbound ? 'two-way' : 'one-way'} direction after unrelated edits`, async () => {
    const f = fixture(inbound),
      before = structuredClone(f.tables.hostedProjects.get(f.projectId).autonomyPolicy);
    const disabled = { ...before, githubMirror: { ...before.githubMirror, autoPush: false, inbound: false } };
    f.patch('hostedProjects', f.projectId, { autonomyPolicy: disabled });
    f.insert('projectPolicyChanges', {
      projectId: f.projectId,
      operationId: randomUUID(),
      actor: 'owner',
      request: 'synthetic-off',
      at: '2026-01-01T00:00:00.000Z',
      previous: before,
      policy: disabled,
    });
    for (let i = 0; i < 200; i++)
      f.insert('projectPolicyChanges', {
        projectId: f.projectId,
        operationId: randomUUID(),
        actor: 'owner',
        request: 'unrelated',
        at: '2026-01-02T00:00:00.000Z',
        previous: disabled,
        policy: disabled,
      });
    const off = await f.read();
    assert.equal(off.state, 'off', 'only an explicit Pause marker reads as paused');
    assert.equal(off.inbound, inbound);
    assert.equal(
      f.counts.at(-1).readDocumentsByTable.projectPolicyChanges,
      1,
      'history direction is an indexed selected row',
    );
    const command = JSON.parse(f.change(true).command);
    command.githubMirror.inbound = off.inbound;
    await f.call('resume-previous-direction', policies.set, {
      projectId: f.projectId,
      command: JSON.stringify(command),
    });
    assert.equal((await f.read()).direction, inbound ? 'two-way' : 'one-way');
  });
