// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset, policyReadView, samePolicy } from '../dist/autonomy-policy.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedAgentActions, hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';

const autonomy = await import(moduleUrl('../convex/projectAutonomy.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;

/** The real CLI transport routed to the real Convex policy handlers on the fake store. */
function cli(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-hosted-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
    autonomyPolicy: policyPreset('supervised'),
  });
  s.insert('projectContributors', { projectId, contributor: 'peer' });
  const handlers = { 'projectAutonomy:read': autonomy.read, 'projectAutonomy:set': autonomy.set };
  const state = { actor: 'owner', calls: [] };
  const route = async (ref, args) => {
    const name = getFunctionName(ref);
    state.calls.push(name);
    assert(handlers[name], `unexpected Convex call ${name}`);
    return s.call(name, handlers[name], args, state.actor);
  };
  const transport = new HostedAgentTransport(
    join(directory, 'root'),
    { url: 'https://fixture.invalid', projectId },
    { projectId, client: { query: route, mutation: route, action: route } },
  );
  const run = async (action, input = {}) => {
    state.calls = [];
    return await transport.dispatch(action, input);
  };
  return { s, state, run };
}

test('policy reads the effective policy with one query and nothing else', async t => {
  const { s, state, run } = cli(t);
  assert.deepEqual(state.calls, [], 'an idle transport makes no calls');
  const read = await run('policy');
  assert.deepEqual(state.calls, ['projectAutonomy:read']);
  assert.equal(read.action, 'policy');
  assert.equal(read.operationId, null);
  assert.equal(read.result.preset, 'supervised');
  assert.equal(read.result.acceptance.gate, 'full');
  assert.equal(read.result.trust, undefined);
  assert.doesNotMatch(JSON.stringify(read.result), /secret|token|credential|private/i);
  assert.equal(s.counts.at(-1).writes, 0, 'a read writes nothing');
  state.actor = 'peer';
  assert.equal((await run('policy')).result.preset, 'supervised', 'contributors can read');
  state.actor = 'stranger';
  await assert.rejects(run('policy'), code('PROJECT_UNAVAILABLE'));
});

test('set-policy merges fields in one mutation and an operationId replay changes nothing', async t => {
  const { s, state, run } = cli(t);
  const before = (await run('policy')).result;
  const operationId = randomUUID();
  const first = await run('set-policy', { operationId, acceptance: { gate: 'contract' } });
  assert.deepEqual(state.calls, ['projectAutonomy:set']);
  assert.equal(first.action, 'set-policy');
  assert.equal(first.operationId, operationId);
  assert.equal(first.result.operationId, operationId);
  // Merge: the edited field changes, the rest of acceptance and the other sections stay.
  assert.equal(first.result.policy.acceptance.gate, 'contract');
  assert.equal(first.result.policy.preset, 'custom');
  assert.equal(first.result.policy.acceptance.mode, before.acceptance.mode);
  assert.deepEqual(first.result.policy.checks, before.checks);
  assert.equal((await run('policy')).result.acceptance.gate, 'contract');
  assert.equal(s.tables.projectPolicyChanges.size, 1);

  // Someone changes the gate back; replaying the first operation returns its record, not a new edit.
  await run('set-policy', { operationId: randomUUID(), acceptance: { gate: 'full' } });
  assert.equal(s.tables.projectPolicyChanges.size, 2);
  const replay = await run('set-policy', { operationId, acceptance: { gate: 'contract' } });
  assert.deepEqual(state.calls, ['projectAutonomy:set']);
  assert.equal(s.counts.at(-1).writes, 0, 'a replay writes nothing');
  assert.equal(replay.result.policy.acceptance.gate, 'contract');
  assert.equal(s.tables.projectPolicyChanges.size, 2);
  assert.equal((await run('policy')).result.acceptance.gate, 'full', 'the replay did not re-apply');
  await assert.rejects(
    run('set-policy', { operationId, acceptance: { gate: 'full' } }),
    code('WORK_OPERATION_CHANGED'),
  );

  // Without an operationId one is generated and returned for a later replay.
  const generated = await run('set-policy', { acceptance: { gate: 'contract' } });
  assert.match(generated.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(generated.result.operationId, generated.operationId);
});

test('set-policy honours expectedPolicy, owner authority and local validation', async t => {
  const { s, state, run } = cli(t);
  const current = (await run('policy')).result;
  await run('set-policy', { operationId: randomUUID(), acceptance: { gate: 'contract' } });
  await assert.rejects(
    run('set-policy', { operationId: randomUUID(), expectedPolicy: current, acceptance: { gate: 'full' } }),
    error =>
      code('POLICY_CHANGED')(error) &&
      /Refresh it before editing\.$/.test(error.message) &&
      !/Retry the original/.test(error.message),
  );
  const fresh = (await run('policy')).result;
  const applied = await run('set-policy', {
    operationId: randomUUID(),
    expectedPolicy: fresh,
    acceptance: { gate: 'full' },
  });
  assert.equal(applied.result.policy.acceptance.gate, 'full');

  state.actor = 'peer';
  await assert.rejects(
    run('set-policy', { operationId: randomUUID(), acceptance: { gate: 'contract' } }),
    code('PROJECT_UNAVAILABLE'),
  );
  state.actor = 'owner';
  const changes = s.tables.projectPolicyChanges.size;
  // Bad input never leaves the machine.
  for (const input of [
    { operationId: randomUUID(), unknownField: true },
    { operationId: 'not-a-uuid', acceptance: { gate: 'full' } },
    { operationId: randomUUID(), acceptance: { ownerApprovalPaths: ['src/'] } },
  ]) {
    await assert.rejects(run('set-policy', input), code('BAD_ARGUMENT'));
    assert.deepEqual(state.calls, []);
  }
  assert.equal(s.tables.projectPolicyChanges.size, changes);
});

test('policy actions are not advertised and their schemas are strict', () => {
  assert(!hostedAgentActions.some(action => ['policy', 'set-policy'].includes(action)));
  assert(hostedAgentCommandSchemas.policy.safeParse({}).success);
  assert(!hostedAgentCommandSchemas.policy.safeParse({ extra: 1 }).success);
  assert(hostedAgentCommandSchemas['set-policy'].safeParse({ preset: 'trusted' }).success);
  assert(!hostedAgentCommandSchemas['set-policy'].safeParse({ action: 'set-policy' }).success);
});

test('the expectedPolicy compare ignores key order, so a policy copied from a read matches', () => {
  const stored = policyPreset('supervised');
  const view = policyReadView(stored);
  const reordered = Object.fromEntries(Object.entries(view).reverse());
  assert(samePolicy(reordered, stored));
  assert(!samePolicy({ ...reordered, preset: 'custom' }, stored));
});
