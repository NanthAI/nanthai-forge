// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 0d8a85a3: on 2026-11-20 05:27-06:37Z Forge's own job API hung. Every check failed after
// ~3.5 min without a failing test, settled as "Actions completed (failure) without complete job
// evidence" (runner-unavailable), and its platform retries showed CHECKING, as if the code ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { finishFixture, desired, api } from './hosted-finish-fixture.mjs';

const { providerRetryDelay, jobApiReason, infraWaitSince } = await import(
  moduleUrl('../src/ci-provider-recovery.ts')
);
const { landingStateOf } = await import(moduleUrl('../src/landing-state.ts'));
const checks = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));

test('every platform retry waits for check infrastructure, a provider outage keeps its own words', () => {
  assert.equal(
    providerRetryDelay(jobApiReason('failure'), Date.parse('2026-11-20T05:27:40Z')),
    "provider-delayed: waiting for check infrastructure since 05:27Z; retrying after Check infrastructure: the runner ended (failure) before Forge recorded its plan (runner setup, OIDC or Forge's job API); the code was not judged.",
  );
  // A later retry keeps the first wait's start, carried by the failed retry's reason.
  assert.match(
    providerRetryDelay(jobApiReason('failure', '05:27Z'), Date.parse('2026-11-20T05:35:00Z')),
    /^provider-delayed: waiting for check infrastructure since 05:27Z;/,
  );
  assert.equal(
    providerRetryDelay('Provider outage: GitHub has no run for the accepted dispatch'),
    'provider-delayed: retrying after Provider outage: GitHub has no run for the accepted dispatch',
  );
  assert.ok(providerRetryDelay('x'.repeat(400)).length <= 300, 'bounded like every stored reason');
});

test('the landing word says since when it waits for check infrastructure, as landing, status and Lanes page read it', () => {
  const view = landingStateOf({
    observation: { state: 'pending', pendingReason: 'pending-infra' },
    providerDelay: providerRetryDelay('Actions completed (failure)', Date.parse('2026-11-20T05:55:12Z')),
  });
  assert.deepEqual(
    [view.state, view.label],
    ['waiting-for-runner', 'Waiting for check infrastructure since 05:55Z'],
  );
  // A CI-down hold reads the hold's own start from its message.
  assert.equal(
    infraWaitSince(
      'CI is failing for every check: the last 3 landing checks ended without a verdict (latest: runner-unavailable) since 2026-11-20T05:27:41.000Z. Not this change.',
    ),
    '05:27Z',
  );
  // A provider outage's own reason, or no reason in hand, names the wait without a made-up time.
  assert.equal(
    landingStateOf({
      observation: { state: 'pending', pendingReason: 'pending-infra' },
      providerDelay: 'provider-delayed: retrying after Provider outage: GitHub has no run',
    }).label,
    'Waiting for check infrastructure',
  );
  assert.equal(
    landingStateOf({ state: 'pending', pendingReason: 'pending-infra' }).label,
    'Waiting for check infrastructure',
  );
});

test('the Lanes page row says since when its check waits for check infrastructure', async () => {
  const lanes = await import(moduleUrl('../web/src/app/lane-state.ts'));
  const { landingStateField } = await import(moduleUrl('../src/landing-state.ts'));
  const landing = lanes.landingOf({
    landingState: landingStateField({
      observation: { state: 'pending', pendingReason: 'pending-infra' },
      providerDelay: providerRetryDelay('Actions completed (failure)', Date.parse('2026-11-20T05:55:12Z')),
    }),
  });
  const row = lanes.laneState(
    { laneId: 'l1', stage: 'checking', held: false, overlap: false, changedAt: Date.now() },
    landing,
  );
  assert.equal(row.why, 'waiting for check infrastructure since 05:55Z');
});

const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const runs = f => [...f.tables.projectHostedCheckRuns.values()].map(row => JSON.parse(row.value));
for (const admission of [false, true])
  test(`incident replay 0d8a85a3: a job-API timeout settles under its own reason and its ${admission ? 'pre-queue admission' : 'queue'} retry shows the infrastructure wait`, async t => {
    const f = await finishFixture(t, { admission });
    const command = {
      operationId: randomUUID(),
      authorityEpoch: 1,
      composeOperationId: f.selection.request.operationId,
      after: null,
      check: f.request().check,
    };
    await f.tx('desiredSubmit', desired.submit, { projectId: f.projectId, request: JSON.stringify(command) });
    for (let n = 0; !f.tables.projectHostedCheckRuns.size; n++) {
      assert(n < 30);
      await f.execute();
    }
    const [first] = runs(f);
    await f.rawChecks.activate(first.id);
    await f.tx(
      'jobApiTimeout',
      {
        _handler: async ctx => {
          const selected = await checks.writableHostedCheck(ctx, { projectId: f.projectId, runId: first.id });
          await direct.settleDirectActions(ctx, selected, 'runner-unavailable', jobApiReason('failure'));
        },
      },
      {},
    );
    for (let n = 0; f.tables.projectHostedCheckRuns.size < 2; n++) {
      assert(n < 30);
      await f.execute();
    }
    const replacement = runs(f).find(run => run.id !== first.id);
    assert.match(
      replacement.failureReason,
      /^provider-delayed: waiting for check infrastructure since \d\d:\d\dZ; retrying after Check infrastructure: the runner ended \(failure\)/,
    );
    const row = [...f.tables.projectHostedLandingRequests.values()].find(
      row => row.operationId === command.operationId,
    );
    const state = JSON.parse(row.value);
    // Today this read CHECKING: the retry looked like the code was being judged.
    assert.equal(state.observation.pendingReason, 'pending-infra');
    const status = JSON.parse(
      await f.tx('jobApiStatus', api.status, { projectId: f.projectId, submissionId: state.id }),
    );
    assert.match(
      status.providerDelay,
      /^provider-delayed: waiting for check infrastructure since \d\d:\d\dZ; retrying after Check infrastructure/,
    );
    // The landing word the land reply, status and Lane page show, read from that reply.
    assert.match(
      landingStateOf({ ...status.submission, providerDelay: status.providerDelay }).label,
      /^Waiting for check infrastructure since \d\d:\d\dZ$/,
    );
    assert.equal(runs(f).length, 2, 'one platform retry, no duplicate dispatch');
    await f.passChecks();
    await f.drain();
    const landed = JSON.parse(
      [...f.tables.projectHostedLandingRequests.values()].find(row => row.operationId === command.operationId)
        .value,
    );
    assert.equal(landed.phase, 'landed');
  });
