// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture, code } from './hosted-landing-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';

const priority = await import(moduleUrl('../convex/projectHostedLandingPriority.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
// The owner's CLI login: a device credential, so its calls count as agents.
const ownerCli = { subject: 'owner', forgeCredential: 'device' };
const change = (f, submissionId, overrides = {}) => ({
  projectId: f.projectId,
  submissionId,
  operationId: randomUUID(),
  priority: 'urgent',
  authorityEpoch: 1,
  expectedVersion: 0,
  ...overrides,
});
const prioritize = (f, input, actor = ownerCli) => {
  if (actor === ownerCli && ![...f.tables.cliCredentials.values()].some(r => r.credentialId === 'device'))
    f.insert('cliCredentials', {
      credentialId: 'device',
      owner: 'owner',
      name: 'agent laptop',
      tokenHash: 'synthetic',
      issuedAt: Date.now(),
      scope: 'cli',
      expiresAt: Date.now() + 3_600_000,
      revoked: false,
    });
  return f.transaction('priorityChange', priority.prioritize, input, actor).then(JSON.parse);
};
const allowAgents = f => {
  const project = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId);
  const policy = project.autonomyPolicy ?? policyPreset('trusted');
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, agentDefaults: { urgentRoles: ['owner', 'agents'] } },
  });
};

test('an agent on the owner login asking for urgent stays normal and is told why', async () => {
  const f = await landingFixture();
  const state = await f.enqueue(f.request({ priority: 'urgent' }));
  assert.equal(state.priority, 'normal');
  assert.match(state.priorityReason, /^Normal: Urgent priority is limited to owner by/);
  assert.match(state.priorityReason, /urgentRoles/);
});

test('prioritize urgent from the owner CLI is refused with URGENT_NOT_ALLOWED unless asOwner says the owner asked', async () => {
  const f = await landingFixture();
  const state = await f.enqueue();
  await assert.rejects(
    prioritize(f, change(f, state.id)),
    error => code('URGENT_NOT_ALLOWED')(error) && /asOwner/.test(error.data?.message ?? error.message),
  );
  assert.equal(rowPriority(f, state.id), 'normal', 'a refusal writes nothing');
  const promoted = await prioritize(f, change(f, state.id, { asOwner: true }));
  assert.equal(promoted.priority, 'urgent');
  // Lowering priority is never restricted.
  const lowered = await prioritize(
    f,
    change(f, state.id, { priority: 'normal', expectedVersion: promoted.priorityVersion }),
  );
  assert.equal(lowered.priority, 'normal');
});

test('signed-in owner sessions may prioritize; urgentRoles agents restores agent urgency', async () => {
  const f = await landingFixture();
  const state = await f.enqueue();
  assert.equal((await prioritize(f, change(f, state.id), 'owner')).priority, 'urgent');
  allowAgents(f);
  const agent = await f.enqueue(f.request({ priority: 'urgent' }));
  assert.equal(agent.priority, 'urgent');
  const other = await f.enqueue();
  assert.equal((await prioritize(f, change(f, other.id))).priority, 'urgent');
});

const rowPriority = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id).priority;
