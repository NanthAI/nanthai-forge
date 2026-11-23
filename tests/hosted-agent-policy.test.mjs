// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset, policyReadView, samePolicy } from '../dist/autonomy-policy.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedAgentActions, hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { printedReceipt } from '../dist/receipt-slim.js';

const autonomy = await import(moduleUrl('../convex/projectAutonomy.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;

/** The real CLI transport routed to the real Convex policy handlers on the fake store. */
function cli(t, fixture) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-hosted-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const s = fixture ?? lanesFixture();
  const projectId =
    fixture?.projectId ??
    s.insert('hostedProjects', {
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
  return { s, state, run, projectId };
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
  assert.deepEqual(read.retiredPolicyFields, ['agentDefaults.overlapGate']);
  assert.equal(read.result.agentDefaults.overlapGate, 'off');
  assert.doesNotMatch(JSON.stringify(read.result), /secret|token|credential|private/i);
  assert.equal(s.counts.at(-1).documents, 1);
  assert.equal(s.counts.at(-1).writes, 0, 'a read writes nothing');
  state.actor = 'peer';
  assert.equal((await run('policy')).result.preset, 'supervised', 'contributors can read');
  state.actor = 'stranger';
  await assert.rejects(run('policy'), code('PROJECT_UNAVAILABLE'));
});

test('policy labels the retired field in both CLI outputs and preserves the full legacy policy result', async t => {
  const { s, state, run, projectId } = cli(t);
  const preset = policyPreset('trusted');
  const stored = {
    ...preset,
    autoExchange: { enabled: true, debounceMs: 40_000, maxPendingAgeMs: 120_000 },
    agentDefaults: { overlapGate: 'block', preflight: 'require' },
    acceptance: {
      ...preset.acceptance,
      disjointFastPath: true,
      hostedCrossHeadReuse: false,
      landingMode: 'fast',
    },
    ownerRootUpdates: true,
  };
  s.patch('hostedProjects', projectId, { autonomyPolicy: stored });
  assert.deepEqual(state.calls, []);
  const reply = await run('policy');
  assert.deepEqual(state.calls, ['projectAutonomy:read']);
  assert.equal(s.counts.at(-1).documents, 1);
  assert.equal(s.counts.at(-1).writes, 0);
  for (const detail of [false, true]) {
    const output = printedReceipt(reply, { agent: true, detail, landChild: false });
    assert.deepEqual(output.retiredPolicyFields, ['agentDefaults.overlapGate']);
    assert.deepEqual(output.result, policyReadView(stored));
    assert.equal(output.result.agentDefaults.overlapGate, 'off');
  }
  assert.deepEqual(s.tables.hostedProjects.get(projectId).autonomyPolicy, stored);
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
  // The receipt is the same full policy a following read shows, agent defaults included (49760b39).
  const after = (await run('policy')).result;
  assert(after.agentDefaults && Object.keys(after.agentDefaults).length > 0, 'the read fills agentDefaults');
  assert.deepEqual(first.result.policy, after);
  const again = await run('set-policy', { operationId, acceptance: { gate: 'contract' } });
  assert.deepEqual(again.result.policy, after, 'a replay receipt has the same shape');

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

test('set-policy previews an edit through the CLI without writing or reserving its operation ID', async t => {
  const { s, state, run } = cli(t);
  const before = (await run('policy')).result;
  const edit = fields => run('set-policy', { operationId: randomUUID(), ...fields });
  const fields = { acceptance: { gate: 'contract' } };
  const { result: preview } = await edit({ ...fields, dryRun: true });
  assert.deepEqual(state.calls, ['projectAutonomy:set']);
  assert.equal(s.counts.at(-1).writes, 0);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.policy.acceptance.gate, 'contract');
  assert.equal(preview.invalidatedLandings, 0);
  assert.deepEqual(preview.invalidatedSubmissionIds, []);
  assert.deepEqual((await run('policy')).result, before);
  const { dryRun, impactAt, impactMessage, ...predicted } = preview;
  assert.match(impactAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(impactMessage, /Would invalidate 0 in-flight landings as of this read/);
  const { result: applied } = await run('set-policy', { operationId: preview.operationId, ...fields });
  assert.match(applied.impactMessage, /Invalidated 0 in-flight landings at commit/);
  assert.deepEqual({ ...applied, impactMessage: undefined }, { ...predicted, impactMessage: undefined });
  state.actor = 'peer';
  await assert.rejects(edit({ ...fields, dryRun: true }), code('PROJECT_UNAVAILABLE'));
});

test('set-policy can apply and replay an edit when transaction headroom cannot support an exact impact receipt', async t => {
  const f = await acceptanceFixture();
  const { state: queued } = await f.ready();
  const { state: ready } = await f.ready();
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === queued.id);
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'queued',
    value: JSON.stringify({ ...queued, phase: 'queued' }),
  });
  const { s, run } = cli(t, f);
  s.extendContext(ctx => {
    const metrics = ctx.meta.getTransactionMetrics.bind(ctx.meta);
    ctx.meta.getTransactionMetrics = async () => {
      const read = await metrics();
      // Budget enough to classify the ready pin first and then fall back to the queue directory.
      return {
        ...read,
        databaseQueries: { used: read.databaseQueries.used, remaining: 87 - read.databaseQueries.used },
      };
    };
  });
  const gate = (await run('policy')).result.acceptance.gate === 'full' ? 'contract' : 'full';
  const edit = { operationId: randomUUID(), acceptance: { gate } };
  const { result: preview } = await run('set-policy', { ...edit, dryRun: true });
  assert.equal(preview.impactComplete, false);
  assert.equal(preview.invalidatedLandings + preview.impactUnexamined, 2);
  assert.deepEqual(preview.invalidatedSubmissionIds, [ready.id]);
  assert.deepEqual(preview.invalidatedByPhase, { ready: 1, checking: 0, queued: 0 });
  assert.match(preview.impactMessage, /Would invalidate at least 1 .* between 1 and 2/);
  assert.equal(s.counts.at(-1).writes, 0);
  const { result: applied } = await run('set-policy', edit);
  assert.equal(applied.impactComplete, false);
  assert.equal(applied.invalidatedLandings + applied.impactUnexamined, 2);
  assert.deepEqual(applied.invalidatedSubmissionIds, [ready.id]);
  assert.match(applied.impactMessage, /Invalidated at least 1 .* between 1 and 2/);
  assert.equal((await run('policy')).result.acceptance.gate, gate);
  assert.deepEqual((await run('set-policy', edit)).result, applied);
});
