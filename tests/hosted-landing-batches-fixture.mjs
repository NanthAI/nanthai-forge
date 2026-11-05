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
const checkWorker = await import(moduleUrl('../convex/projectHostedCheckWorker.ts'));
export const states = f => [...f.tables.projectHostedLandingRequests.values()].map(r => JSON.parse(r.value));
export async function batchesFixture(
  t,
  {
    count = 4,
    memberMessages,
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
    concurrency,
    // Agent finishes name their check. Without owner provenance on the Lane the
    // entry is not batch-eligible, so its check starts at submission, in parallel
    // with every other arrival (the dogfood main queue on 2026-11-01).
    requestCheck = false,
    // Any configured runner (BYOCI). Same runtime and environment pins, other provider.
    runner,
  } = {},
) {
  const f = await finishFixture(t, { fileCount });
  {
    const policy = policyPreset('trusted');
    f.patch('hostedProjects', f.projectId, {
      // Fake time jumps to each scheduled task; alerts have their own tests (hosted-stall-alerts.test.mjs).
      autonomyPolicy: {
        ...policy,
        acceptance: {
          ...policy.acceptance,
          ...(batching === 'default' ? {} : { landing: batching ? 'batched' : 'serial' }),
          ...(batchMaxSize ? { batchMaxSize } : {}),
          // Queue-mechanics tests pin pre-queue checks off; 'default' leaves the policy default.
          ...(admissionCheck === 'default' ? {} : { admissionCheck }),
        },
        ...(concurrency ? { checks: { runner: 'github-actions', concurrency } } : {}),
        agentDefaults: { stallAlerts: { enabled: false } },
      },
    });
  }
  if (runner) {
    const configuration = { ...runner, runtime: f.rawChecks.runner.runtime };
    f.rawChecks.configuration = await f.rawChecks.configure(
      { kind: 'runner', configuration },
      f.rawChecks.configuration.digest,
    );
    f.rawChecks.runner = configuration;
    // A machine runner reports through its active registration.
    if (configuration.machineId) {
      const sessionId = randomUUID();
      await f.rawChecks.call('macRegister', checkWorker.register, {
        projectId: f.rawChecks.projectId,
        request: JSON.stringify({ operationId: sessionId, authorityEpoch: 1, configuration }),
      });
      f.rawChecks.claimAs(sessionId);
    }
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
    if (memberMessages?.[i] !== undefined) selection.request.message = memberMessages[i];
    // Seed the trusted owner provenance normally produced by start/save. The
    // generic compose fixture deliberately creates unverified arbitrary Lanes.
    for (const table of requestCheck ? [] : ['projectHostedRecords', 'projectHostedRecordHeads'])
      for (const row of f.tables[table].values())
        if (row.kind === 'lane' && row.key === lane.laneId) f.patch(table, row._id, { ownerOnly: true });
    const candidate = await compose(f.c, selection);
    const request = f.request({
      ...(governanceVersion ? { governanceVersion } : {}),
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      finish: { composeOperationId: selection.request.operationId, after: null },
      ...(requestCheck
        ? {
            check: {
              kind: 'request',
              checkId: f.rawChecks.checkId,
              expectedDefinition: f.rawChecks.definition.digest,
              expectedConfiguration: f.rawChecks.configuration.digest,
              expectedEnvironment: f.rawChecks.runner.environmentFingerprint,
            },
          }
        : {}),
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
    // A synthetic machine runner always claims and reports inside its lease; the
    // lease watchdog itself is covered by hosted-mac-runner.test.mjs.
    if (task.name === 'projectHostedCheckLease:expire') {
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
