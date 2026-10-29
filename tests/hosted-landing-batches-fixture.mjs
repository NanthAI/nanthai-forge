// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { finishFixture, compose, driver } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
export const batchPublish = await import(moduleUrl('../convex/projectHostedLandingBatchPublish.ts'));
export const batchStore = await import(moduleUrl('../convex/projectHostedLandingBatchStore.ts'));
export const checkStore = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
export const states = f => [...f.tables.projectHostedLandingRequests.values()].map(r => JSON.parse(r.value));
export async function batchesFixture(
  t,
  { count = 4, fileCount = 3, conflict = false, governanceVersion = 1 } = {},
) {
  const f = await finishFixture(t, { fileCount });
  const entries = [];
  for (let i = 0; i < count; i++) {
    const pin = f.c.state(
      [
        ...JSON.parse(f.c.objects.get(f.c.baseline.sha256)).files,
        ...Array.from({ length: Math.max(0, fileCount - 2) }, (_, k) => f.c.file(`fixture/${k}`, 'shared')),
        f.c.file(conflict && i < 2 ? 'collision' : `member-${i}`, `member ${i}`),
      ],
      [f.c.baseline.sha256],
    );
    const lane = await f.c.lane(pin),
      selection = f.c.selection([lane]);
    // Seed the trusted owner provenance normally produced by start/save. The
    // generic compose fixture deliberately creates unverified arbitrary Lanes.
    for (const table of ['projectHostedRecords', 'projectHostedRecordHeads'])
      for (const row of f.tables[table].values())
        if (row.kind === 'lane' && row.key === lane.laneId) f.patch(table, row._id, { ownerOnly: true });
    const candidate = await compose(f.c, selection);
    const request = f.request({
      ...(governanceVersion ? { governanceVersion } : {}),
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      finish: { composeOperationId: selection.request.operationId, after: null },
    });
    const state = await f.enqueue(request);
    entries.push({ lane, selection, candidate, request, state });
  }
  const publications = [];
  const execute = async (task, stop = null) => {
    if (task.name !== 'projectHostedFinishDriver:drive') return f.execute(task);
    f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    try {
      await driver.drive._handler(
        {
          runMutation: (ref, args) => {
            const name = getFunctionName(ref).split(':')[1];
            if (name === 'resume' && stop === 'before-resume')
              throw new Error('synthetic crash after upload');
            const before = f.tables.projectHostedAcceptances.size,
              mainBefore = f.currentMain().receipt.id;
            return f.transaction(`batch-${name}`, driver[name], args).then(value => {
              const receipts = f.tables.projectHostedAcceptances.size - before;
              const mainMoves = Number(f.currentMain().receipt.id !== mainBefore);
              if (receipts || mainMoves)
                publications.push({
                  receipts,
                  mainMoves,
                  landed: states(f).filter(s => s.phase === 'landed').length,
                });
              return value;
            });
          },
        },
        task.args[0],
      );
    } catch (error) {
      f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
      throw error;
    }
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  };
  const drain = async () => {
    let ticks = 0;
    while (f.pending().length) {
      assert(
        ++ticks < 300,
        JSON.stringify({
          task: f.pending()[0]?.name,
          states: states(f).map(s => ({ phase: s.phase, error: s.error })),
          batch: [...f.tables.projectHostedLandingBatches.values()].map(r => ({
            phase: JSON.parse(r.value).phase,
            uploadIndex: JSON.parse(r.value).uploadIndex,
          })),
          steps: f.metrics.convexSourceCalls.slice(-8),
        }),
      );
      try {
        await execute(f.pending()[0]);
      } catch (error) {
        error.message += JSON.stringify(
          [...f.tables.projectHostedRecordBodies.values()]
            .map(r => JSON.parse(r.value))
            .filter(r => r.kind === 'job')
            .map(r => ({ status: r.status, failure: r.control?.failureCode })),
        );
        throw error;
      }
    }
    return ticks;
  };
  const runs = () => [...f.tables.projectHostedCheckRuns.values()].map(r => JSON.parse(r.value));
  const fail = async (runId, file = 'tests/member-1.test.mjs') => {
    const activated = await f.rawChecks.activate(runId);
    await f.rawChecks.callback(f.rawChecks.shard(activated, 0, 'failed'));
    await f.rawChecks.callback(
      f.rawChecks.complete(activated, 'failed', {
        contractReports: {
          [file]: { failed: true, durationMs: 1, firstError: `${file}: synthetic failure` },
        },
      }),
    );
  };
  return { ...f, entries, execute, drain, runs, fail, publications };
}
export const synthetic = {
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
