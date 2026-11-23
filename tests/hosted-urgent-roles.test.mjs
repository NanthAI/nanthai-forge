// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
    autonomyPolicy: { ...policy, agentDefaults: { urgentRoles: ['owner', 'agents'], preflight: 'advise' } },
  });
};

test('an agent on the owner login asking for urgent stays normal and is told why', async () => {
  const f = await landingFixture();
  const state = await f.enqueue(f.request({ priority: 'urgent' }));
  assert.equal(state.priority, 'normal');
  assert.match(state.priorityReason, /^Normal: Urgent priority is limited to owner by/);
  assert.match(state.priorityReason, /urgentRoles/);
});

test('596b75a3: an urgent request queued at normal says so on land, observe and queue', async () => {
  const { urgentNotApplied, slimReceipt } = await import('../dist/receipt-slim.js');
  const { landAnnouncement } = await import('../dist/hosted-land-wait.js');
  const view = await import(moduleUrl('../convex/projectHostedQueueView.ts'));
  const f = await landingFixture();
  const state = await f.enqueue(f.request({ priority: 'urgent' }));
  const line = urgentNotApplied(state);
  assert.match(
    line,
    /^Urgent not applied; landing at normal priority\. Urgent priority is limited to owner by/,
  );
  assert.match(
    line,
    /asOwner:true, or change agentDefaults\.urgentRoles with set-policy/,
    'names how the owner grants it',
  );
  // Arrival order and an owner's prioritize are not downgrades.
  assert.equal(urgentNotApplied((await f.enqueue()) ?? {}), undefined);
  assert.equal(
    urgentNotApplied({
      priority: 'normal',
      priorityReason: 'Priority changed to normal by the project owner',
    }),
    undefined,
  );
  const operationId = randomUUID();
  const land = {
    schema: 1,
    transport: 'hosted',
    action: 'land',
    operationId,
    result: { submission: state, inProgress: true, waitCommand: 'nforge wait x' },
  };
  assert.equal(slimReceipt(structuredClone(land)).result.urgentNotApplied, line, 'land JSON');
  assert(landAnnouncement('/synthetic', {}, land).includes(line), 'land stderr');
  const observed = slimReceipt({
    schema: 1,
    transport: 'hosted',
    action: 'observe',
    operationId: null,
    result: { status: 'timeout', inProgress: true, submissions: [{ submission: state }] },
  });
  assert.equal(observed.result.urgentNotApplied, line, 'observe/wait');
  const queue = JSON.parse(await f.call('queueView', view.read, { projectId: f.projectId }));
  const entry = queue.entries.find(item => item.submissionId === state.id);
  assert.equal(entry.urgentNotApplied, line, 'queue');
  assert.equal(queue.entries.filter(item => item.urgentNotApplied).length, 1);
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
