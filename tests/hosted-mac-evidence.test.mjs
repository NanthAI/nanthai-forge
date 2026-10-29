// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceFixture, records } from './hosted-acceptance-fixture.mjs';
import { code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { checkPin } from '../dist/hosted-check.js';
import { policyPreset } from '../dist/autonomy-policy.js';
const worker = await import(moduleUrl('../convex/projectHostedCheckWorker.ts'));
const machines = await import(moduleUrl('../convex/projectHostedCheckMachines.ts'));
const secret = 'synthetic-mac-evidence';
const previous = new Map();
test.before(() => {
  for (const [key, value] of Object.entries({
    FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
    FORGE_HOSTED_CHECK_KEY_SYNTHETIC: secret,
  })) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
});
test.after(() => {
  for (const [key, value] of previous)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

async function fixture(preset = 'trusted', provider = 'mac') {
  const f = await acceptanceFixture();
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset(preset) });
  const c = f.rawChecks;
  const configuration = {
    provider,
    ...(provider === 'self-hosted' ? { platform: { os: 'linux', arch: 'x64' }, labels: ['build'] } : {}),
    machineId: randomUUID(),
    runtime: c.runner.runtime,
    environmentFingerprint: c.runner.environmentFingerprint,
  };
  const configured = await c.configure({ kind: 'runner', configuration }, c.configuration.digest);
  const sessionId = randomUUID();
  const register = (operationId = sessionId, actor = 'owner') =>
    c
      .call(
        'macRegister',
        worker.register,
        {
          projectId: f.projectId,
          request: JSON.stringify({ operationId, authorityEpoch: 1, configuration }),
        },
        actor,
      )
      .then(JSON.parse);
  await register();
  const revokeRequest = { operationId: randomUUID(), authorityEpoch: 1, machineId: configuration.machineId };
  const revoke = (request = revokeRequest, actor = 'owner') =>
    c
      .call(
        'macRevoke',
        machines.revoke,
        {
          projectId: f.projectId,
          request: JSON.stringify(request),
        },
        actor,
      )
      .then(JSON.parse);
  const pass = async (item, actor = 'owner') => {
    const queued = await c.enqueue(
      c.selection({
        candidateId: item.candidate.id,
        expectedHead: item.candidate.result.head,
        expectedConfiguration: configured.digest,
      }),
      actor,
    );
    const control = command =>
      c
        .call('macControl', worker.control, {
          projectId: f.projectId,
          machineId: configuration.machineId,
          sessionId,
          runId: queued.id,
          command: JSON.stringify({ owner: sessionId, ...command }),
        })
        .then(JSON.parse);
    const claimed = await control({ kind: 'claim', leaseMs: 60000 });
    const token = claimed.run.lease.token;
    await control({
      kind: 'prepare',
      token,
      plan: {
        head: queued.request.expectedHead,
        definition: queued.check.definition,
        runtime: configuration.runtime,
        environmentFingerprint: configuration.environmentFingerprint,
        lockfile: 'a'.repeat(64),
        selection: c.put('synthetic-selection'),
        manifest: c.put('synthetic-plan'),
        shardCount: 1,
      },
    });
    await control({ kind: 'reserve', token });
    const run = (
      await control({
        kind: 'observe',
        token,
        result: { status: 'accepted', executionId: `mac-${queued.id}` },
      })
    ).run;
    await c.callback({ ...c.shard(run, 0, 'passed', { attempt: run.fence }), provider });
    return c.callback({ ...c.complete(run), provider });
  };
  const submit = async (item, run, actor = 'owner', agent = true) => {
    const state = await f.enqueue(
      f.request({
        candidateId: item.candidate.id,
        expectedHead: item.candidate.result.head,
        agent,
        check: { kind: 'run', runId: run.id },
      }),
      actor,
    );
    await f.drain();
    const result = (await f.status(state.id, actor)).request;
    if (result.phase === 'ready') await f.stageAcceptance(result, item.pages);
    return result;
  };
  return { ...f, configuration, sessionId, register, revoke, passMac: pass, submit };
}

for (const provider of ['mac', 'self-hosted'])
  for (const preset of ['trusted', 'autonomous'])
    test(`${preset} owner work lands with a completed ${provider} receipt and no additional idle work`, async () => {
      const f = await fixture(preset, provider),
        item = await f.makeCandidate([], [], {
          governance: { version: 1, paths: ['src/leaf.ts'], ownerInputs: false },
        });
      const run = await f.passMac(item);
      assert.deepEqual(run.macEvidence, {
        provider: 'mac',
        machineId: f.configuration.machineId,
        machineOwner: 'owner',
        registrationId: f.sessionId,
        reuseKey: null,
        runnerFingerprint: checkPin({
          runtime: f.configuration.runtime,
          environmentFingerprint: f.configuration.environmentFingerprint,
        }),
      });
      const state = await f.submit(item, run);
      assert.equal(state.phase, 'ready');
      const accepted = await f.accept(state);
      assert.equal(accepted.status, 'landed');
      assert.deepEqual(accepted.receipt.check.macEvidence, run.macEvidence);
      await f.drain();
      const before = f.metrics.scheduled;
      await f.rawChecks.evidence(run);
      await f.rawChecks.status(run.id);
      await f.status(state.id);
      assert.equal(f.metrics.scheduled, before);
      assert.equal(f.pendingTasks().length, 0);
    });

test('supervised Mac-only evidence is refused even for a person acceptance request', async () => {
  const f = await fixture('supervised'),
    item = await f.makeCandidate();
  const state = await f.submit(item, await f.passMac(item), 'owner', false);
  assert.equal(state.phase, 'terminal-failed');
  assert.equal(state.error.code, 'HOSTED_RUNNER_REQUIRED');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.currentMain().sourceRevision, 0);
  // Existing unchecked person review is still available.
  assert.equal((await f.accept((await f.ready(item)).state)).status, 'landed');
});

test('an outside check requester cannot supply Mac evidence for trusted owner work', async () => {
  const f = await fixture(),
    item = await f.makeCandidate();
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'outside' });
  const run = await f.passMac(item, 'outside');
  const state = await f.submit(item, run);
  assert.equal(state.error.code, 'HOSTED_RUNNER_REQUIRED');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('outside Candidate provenance cannot be laundered through an owner-requested check', async () => {
  const f = await fixture(),
    item = await f.makeCandidate();
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'outside' });
  item.candidate = { ...item.candidate, id: randomUUID() };
  await f.transaction(
    'outsideCandidate',
    { _handler: records.writeHostedRecord },
    {
      ...f.auth,
      actor: 'outside',
      expectedVersion: null,
      record: item.candidate,
    },
    'outside',
  );
  const run = await f.passMac(item);
  const state = await f.submit(item, run);
  assert.equal(state.error.code, 'HOSTED_RUNNER_REQUIRED');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('an outside accepting actor still needs hosted-runner evidence', async () => {
  const f = await fixture(),
    item = await f.makeCandidate();
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'outside' });
  const state = await f.submit(item, await f.passMac(item), 'outside', false);
  assert.equal(state.error.code, 'HOSTED_RUNNER_REQUIRED');
});

for (const provider of ['mac', 'self-hosted'])
  test(`revocation after ready is checked again at publication and names the machine (${provider})`, async () => {
    const f = await fixture('trusted', provider),
      item = await f.makeCandidate();
    const run = await f.passMac(item),
      state = await f.submit(item, run);
    const claim = await f.claimAcceptance(state),
      main = f.currentMain();
    const revoked = await f.revoke();
    assert.deepEqual(await f.revoke(), revoked, 'same-operation retry retains the original outcome');
    await assert.rejects(f.commit(claim), error => {
      assert.equal(error.code, 'MAC_MACHINE_REVOKED');
      assert(error.message.includes(f.configuration.machineId));
      return true;
    });
    await assert.rejects(f.rawChecks.evidence(run), code('MAC_MACHINE_REVOKED'));
    await assert.rejects(f.register(randomUUID()), code('MAC_MACHINE_REVOKED'));
    assert.deepEqual(f.currentMain(), main);
    assert.equal(f.tables.projectHostedAcceptances.size, 0);
  });

test('only the owner revokes a machine; revocation does not rewrite an accepted receipt', async () => {
  const f = await fixture(),
    item = await f.makeCandidate([], [], {
      governance: { version: 1, paths: ['src/leaf.ts'], ownerInputs: false },
    });
  const state = await f.submit(item, await f.passMac(item));
  const accepted = await f.accept(state);
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'outside' });
  await assert.rejects(f.revoke(undefined, 'outside'), code('PROJECT_UNAVAILABLE'));
  await f.revoke();
  assert.deepEqual(await f.accept(state), accepted);
});

for (const provider of ['modal', 'github-actions'])
  test(`${provider} evidence still permits person-reviewed supervised and outside work`, async () => {
    const f = await acceptanceFixture();
    f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('supervised') });
    f.insert('projectContributors', { projectId: f.projectId, contributor: 'outside' });
    const c = f.rawChecks,
      item = await f.makeCandidate();
    let configuration = c.configuration.digest;
    if (provider === 'github-actions') {
      const { app, function: ignored, ...common } = c.runner;
      configuration = (
        await c.configure(
          {
            kind: 'runner',
            configuration: {
              ...common,
              provider,
              repository: 'synthetic/checks',
              installationId: 'synthetic',
              runsOn: 'ubuntu-latest',
            },
          },
          configuration,
        )
      ).digest;
    }
    const queued = await c.enqueue(
      c.selection({
        candidateId: item.candidate.id,
        expectedHead: item.candidate.result.head,
        expectedConfiguration: configuration,
      }),
      'outside',
    );
    const run = await c.activate(queued.id);
    for (let i = 0; i < run.plan.shardCount; i++) await c.callback({ ...c.shard(run, i), provider });
    await c.callback({ ...c.complete(run), provider });
    const { state } = await f.ready(item, { check: { kind: 'run', runId: run.id } });
    const result = await f.accept(state);
    assert.equal(result.status, 'landed');
    assert.equal(result.receipt.check.macEvidence, undefined);
  });

test('Linux self-hosted evidence preserves the existing supervised acceptance policy', async () => {
  const f = await fixture('supervised', 'self-hosted');
  const item = await f.makeCandidate();
  const run = await f.passMac(item);
  assert.equal(run.configuration.platform.os, 'linux');
  const state = await f.submit(item, run, 'owner', false);
  assert.equal(state.phase, 'terminal-failed');
  assert.equal(state.error.code, 'HOSTED_RUNNER_REQUIRED');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});
