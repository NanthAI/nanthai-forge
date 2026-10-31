// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { finishFixture, compose, driver, records } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
export const batchAbandon = await import(moduleUrl('../convex/projectHostedBatchAbandon.ts'));
export const batchPublish = await import(moduleUrl('../convex/projectHostedLandingBatchPublish.ts'));
export const batchStore = await import(moduleUrl('../convex/projectHostedLandingBatchStore.ts'));
export const checkStore = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
export const states = f => [...f.tables.projectHostedLandingRequests.values()].map(r => JSON.parse(r.value));
export async function batchesFixture(
  t,
  {
    count = 4,
    fileCount = 3,
    conflict = false,
    governanceVersion = 1,
    memberContracts,
    memberPaths,
    memberFileCount = 1,
    batching = true,
    // Mechanics tests pin the earlier fixed cohort of eight; null selects auto sizing.
    batchMaxSize = 8,
    admissionCheck = false,
  } = {},
) {
  const f = await finishFixture(t, { fileCount });
  // Hosted batches are opt-in; these fixtures exercise them unless told not to.
  if (batching) {
    const policy = policyPreset('trusted');
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...policy,
        acceptance: {
          ...policy.acceptance,
          landing: 'batched',
          ...(batchMaxSize ? { batchMaxSize } : {}),
          ...(admissionCheck ? { admissionCheck } : {}),
        },
      },
    });
  }
  const entries = [];
  const add = async i => {
    const memberPath = memberPaths?.[i] ?? (conflict && i < 2 ? 'collision' : `member-${i}`);
    const pin = f.c.state(
      [
        ...JSON.parse(f.c.objects.get(f.c.baseline.sha256)).files,
        ...Array.from({ length: Math.max(0, fileCount - 2) }, (_, k) => f.c.file(`fixture/${k}`, 'shared')),
        ...Array.from({ length: memberFileCount }, (_, index) =>
          f.c.file(
            index ? `${memberPath}-additional-${index}` : memberPath,
            index ? `member ${i} additional ${index}` : `member ${i}`,
          ),
        ),
      ],
      [f.c.baseline.sha256],
    );
    let intentId = f.c.intentId;
    if (memberContracts) {
      intentId = randomUUID();
      const template = JSON.parse(
        (
          await f.c.run('readBatchTemplate', records.readHostedRecord, {
            ...f.c.auth,
            kind: 'intent',
            key: f.c.intentId,
          })
        ).value,
      );
      const tests = (memberContracts[i] ?? []).map(path => ({ path, durationMs: 1 }));
      await f.c.run('seedBatchIntent', records.writeHostedRecord, {
        ...f.c.auth,
        expectedVersion: null,
        record: {
          ...template,
          id: intentId,
          version: 0,
          outcome: String.fromCharCode(65 + i),
          ...(tests.length
            ? {
                testContracts: [
                  {
                    timingBasis: 'history',
                    version: 1,
                    operationId: randomUUID(),
                    request: 'a'.repeat(64),
                    candidateId: randomUUID(),
                    measuredOn: pin.sha256,
                    runId: randomUUID(),
                    at: template.at,
                    proposedTests: tests.map(t => t.path),
                    tests,
                    totalMs: tests.length,
                  },
                ],
              }
            : {}),
        },
      });
    }
    const lane = await f.c.lane(pin, { intentId }),
      selection = f.c.selection([lane]);
    selection.request.intentId = intentId;
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
    return state;
  };
  for (let i = 0; i < count; i++) await add(i);
  const publications = [],
    auditWakes = [];
  const execute = async (task, stop = null) => {
    // Scoped acceptance arms the main audit cadence wake (count or age); these
    // fixtures record it instead of running a deferred full audit.
    if (task.name === 'projectHostedMainAudit:start') {
      auditWakes.push(task.args[0]);
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
      return;
    }
    if (task.name === 'projectHostedBatchAbandon:reselect') {
      f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
      f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
      await f.transaction('batch-abandon-reselection', batchAbandon.reselect, task.args[0]);
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
      return;
    }
    if (task.name !== 'projectHostedFinishDriver:drive') return f.execute(task, stop);
    f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    try {
      await driver.drive._handler(
        {
          runAction: f.runReuseAction,
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
  return { ...f, entries, add, execute, drain, runs, fail, publications, auditWakes };
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
