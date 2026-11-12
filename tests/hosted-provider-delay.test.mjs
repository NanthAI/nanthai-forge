// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, desired, api } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { waitEventLine } from '../dist/hosted-wait-line.js';
const checks = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
const wakes = await import(moduleUrl('../convex/projectHostedLandingCheckWake.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
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

for (const admission of [false, true])
  test(`provider-delayed status and land wait carry the reason for ${admission ? 'pre-queue admission' : 'queue'} checks`, async t => {
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
    const [row] = f.tables.projectHostedCheckRuns.values();
    const run = JSON.parse(row.value);
    await f.rawChecks.activate(run.id);
    const reason =
      'provider-delayed: waiting on synthetic CI since 2026-11-11T20:19:00Z; next fixed provider read at +60 minutes.';
    await f.tx(
      'delayCheck',
      {
        _handler: async ctx => {
          const selected = await checks.writableHostedCheck(ctx, { projectId: f.projectId, runId: run.id });
          selected.run.failureReason = reason;
          await checks.writeHostedCheck(ctx, selected.row._id, selected.run);
        },
      },
      {},
    );
    let state;
    for (let n = 0; n < 30; n++) {
      state = JSON.parse(
        [...f.tables.projectHostedLandingRequests.values()].find(
          row => row.operationId === command.operationId,
        ).value,
      );
      if (state.observation.pendingReason === 'pending-infra') break;
      assert(f.pending().length, 'a delay event owns its bounded wake');
      await f.execute();
    }
    assert.equal(state.observation.pendingReason, 'pending-infra');
    const status = JSON.parse(
      await f.tx('finishDelayStatus', api.status, { projectId: f.projectId, submissionId: state.id }),
    );
    assert.equal(status.providerDelay, reason);
    const page = JSON.parse(
      await f.tx('finishDelayPage', observe.page, {
        projectId: f.projectId,
        operationId: command.operationId,
        nextVersion: state.version,
      }),
    );
    assert.equal(page.providerDelay, reason);
    assert.equal(
      waitEventLine({
        type: 'submission',
        operationId: command.operationId,
        submission: page.submission,
        providerDelay: page.providerDelay,
      }).line.providerDelay,
      reason,
    );
    assert.equal(page.events.at(-1).providerDelay, reason);
    await f.tx(
      'providerRecovered',
      {
        _handler: async ctx => {
          const selected = await checks.writableHostedCheck(ctx, { projectId: f.projectId, runId: run.id });
          delete selected.run.failureReason;
          await checks.writeHostedCheck(ctx, selected.row._id, selected.run);
          // The direct session's existing write sends this hint when it clears its reason.
          await wakes.notifyLandingCheck(ctx, {
            projectId: f.projectId,
            runId: run.id,
            terminal: false,
            providerDelayed: true,
          });
        },
      },
      {},
    );
    for (let n = 0; n < 30; n++) {
      const current = JSON.parse(
        [...f.tables.projectHostedLandingRequests.values()].find(
          row => row.operationId === command.operationId,
        ).value,
      );
      if (current.observation.pendingReason === 'checking') break;
      assert(f.pending().length);
      await f.execute();
    }
    const recovered = JSON.parse(
      [...f.tables.projectHostedLandingRequests.values()].find(row => row.operationId === command.operationId)
        .value,
    );
    assert.equal(recovered.observation.pendingReason, 'checking');
  });

const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
for (const admission of [false, true])
  test(`startup provider-outage reason survives the existing ${admission ? 'admission' : 'queue'} platform retry`, async t => {
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
    const [first] = f.tables.projectHostedCheckRuns.values();
    const run = JSON.parse(first.value);
    await f.rawChecks.activate(run.id);
    await f.tx(
      'startupOutage',
      {
        _handler: async ctx => {
          const selected = await checks.writableHostedCheck(ctx, { projectId: f.projectId, runId: run.id });
          await direct.settleDirectActions(
            ctx,
            selected,
            'runner-unavailable',
            'Provider outage: synthetic CI concluded startup_failure before any runner acknowledged the check; one lookup after 5 minutes. Forge checks again.',
          );
        },
      },
      {},
    );
    for (let n = 0; f.tables.projectHostedCheckRuns.size < 2; n++) {
      assert(n < 30);
      await f.execute();
    }
    const replacement = [...f.tables.projectHostedCheckRuns.values()]
      .map(row => JSON.parse(row.value))
      .find(next => next.id !== run.id);
    assert.match(replacement.failureReason, /^provider-delayed: retrying after Provider outage:/);
    const row = [...f.tables.projectHostedLandingRequests.values()].find(
      row => row.operationId === command.operationId,
    );
    const state = JSON.parse(row.value);
    const status = JSON.parse(
      await f.tx('retryOutageStatus', api.status, { projectId: f.projectId, submissionId: state.id }),
    );
    assert.match(status.providerDelay, /startup_failure/);
    assert.equal(
      f.tables.projectHostedCheckRuns.size,
      2,
      'one existing platform retry, no duplicate dispatch',
    );
    await f.passChecks();
    await f.drain();
    const landed = JSON.parse(
      [...f.tables.projectHostedLandingRequests.values()].find(row => row.operationId === command.operationId)
        .value,
    );
    assert.equal(landed.phase, 'landed');
  });
