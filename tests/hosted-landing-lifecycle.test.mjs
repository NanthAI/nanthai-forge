// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, desired } from './hosted-finish-fixture.mjs';
import { deliverMacCallback } from '../dist/hosted-mac-delivery.js';

for (const [scenario, offlineMs] of [
  ['sleep', 30 * 60_000],
  ['network-loss', 10 * 60_000],
]) {
  test(`lifecycle drill: ${scenario} preserves a remote check and delivers the original landing`, async t => {
    const started = performance.now();
    const synthetic = {
      FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
      FORGE_SOURCE_WORKER: 'fixed-worker',
      FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
      FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
      R2_ACCOUNT_ID: 'synthetic',
      R2_BUCKET: 'synthetic',
      R2_ACCESS_KEY_ID: 'synthetic',
      R2_SECRET_ACCESS_KEY: 'synthetic',
    };
    const previous = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
    Object.assign(process.env, synthetic);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const f = await finishFixture(t),
      command = {
        operationId: randomUUID(),
        authorityEpoch: 1,
        composeOperationId: f.selection.request.operationId,
        after: null,
        check: f.request().check,
      };
    const state = JSON.parse(
      await f.tx('lifecycleSubmit', desired.submit, {
        projectId: f.projectId,
        request: JSON.stringify(command),
      }),
    );
    await f.drain();
    assert.equal((await f.current(state.id)).submission.phase, 'checking');
    const queued = JSON.parse([...f.tables.projectHostedCheckRuns.values()][0].value),
      run = await f.rawChecks.activate(queued.id);
    // The hosted provider keeps executing while the requesting machine sleeps
    // or loses Wi-Fi. Retain one passed shard before the lifecycle boundary.
    await f.rawChecks.callback(f.rawChecks.shard(run, 0));
    const passed = [...f.tables.projectHostedCheckShards.values()].map(row => structuredClone(row));
    assert.equal(passed.length, 1);
    const completion = f.rawChecks.complete(run);
    let deliveryAttempts = 0;
    if (scenario === 'network-loss') {
      // Exercise the production unknown-reply retry with the SAME signed event.
      await deliverMacCallback(async () => {
        deliveryAttempts++;
        if (deliveryAttempts === 1) {
          f.advanceClock(offlineMs);
          throw new TypeError('Synthetic ten-minute disconnected transport');
        }
        await f.rawChecks.callback(f.rawChecks.shard(run, 1));
        return f.rawChecks.callback(completion);
      });
      assert.equal(deliveryAttempts, 2);
    } else {
      f.advanceClock(offlineMs);
      await f.rawChecks.callback(f.rawChecks.shard(run, 1));
      await f.rawChecks.callback(completion);
    }
    await f.drain();
    const landed = (await f.current(state.id)).submission;
    assert.equal(landed.phase, 'landed', JSON.stringify(landed.error));
    assert.equal(landed.id, state.id);
    assert.equal(landed.firstAttemptId, state.firstAttemptId);
    assert.equal(
      f.tables.projectHostedCheckRuns.size,
      1,
      'original remote check, no dispatch after reconnection',
    );
    assert.equal(f.tables.projectHostedAcceptances.size, 1);
    assert.equal(f.pending().length, 0);
    for (const row of passed)
      assert.deepEqual(
        f.tables.projectHostedCheckShards.get(row._id),
        row,
        'passed shard is retained, not re-executed',
      );
    const terminalRun = await f.rawChecks.status(run.id);
    assert.equal(terminalRun.fence, run.fence, 'no new remote execution fence');
    assert.equal(terminalRun.status, 'passed');
    // Observation and original-operation replay cannot start another run.
    assert.equal(
      JSON.parse(
        await f.tx('lifecycleReplay', desired.submit, {
          projectId: f.projectId,
          request: JSON.stringify(command),
        }),
      ).id,
      state.id,
    );
    assert.equal(f.tables.projectHostedCheckRuns.size, 1);
    t.diagnostic(
      JSON.stringify({
        scenario,
        simulatedOfflineMs: offlineMs,
        elapsedMs: Math.round(performance.now() - started),
        passedCheckReruns: 0,
        strandedEntries: 0,
        droppedLandings: 0,
        operatorMutationsToSettle: 0,
        phase: landed.phase,
      }),
    );
  });
}
