import { isMachineRunner } from '../src/hosted-machine-runner';
import { checkFileSummary } from '../src/check-file-summary';
import { capCheckReports } from '../src/check-report-cap';
// SPDX-License-Identifier: Apache-2.0
import { notifyActionsProgress } from './projectHostedActionsWake';
import { requireMacMachine } from './projectHostedCheckMachines';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  assertHostedCheckActive,
  writableHostedCheck,
  writeHostedCheck,
  completeHostedCheck,
} from './projectHostedCheckStore';
import {
  hostedCheckCallbackSchema,
  hostedCheckShardSchema,
  verifyHostedCheckCallback,
} from '../src/hosted-check-evidence';
import { hostedCheckTerminal, checkPin } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { recordHostedTestTimings } from './projectHostedTestTimings';

/** Only fixed trusted collection code holds the signing key. Project-code
 * stdout, display records and source-job callbacks cannot supply this evidence.
 * The key resolver is backend-owned, never a callback or client argument. */
export async function receiveHostedCheckCallback(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    callback: unknown;
    signature: string;
  },
  key: (keyId: string) => string,
  now = Date.now(),
) {
  const callback = hostedCheckCallbackSchema.parse(input.callback);
  invariant(callback.projectId === input.projectId, 'EVIDENCE_CHANGED', 'Callback project differs.');
  const { row, run } = await writableHostedCheck(ctx, { projectId: input.projectId, runId: callback.runId });
  verifyHostedCheckCallback(callback, input.signature, key(run.keyId));
  assertHostedCheckActive(run);
  const plan = run.plan,
    r = run.request;
  invariant(
    plan &&
      run.dispatchStarted &&
      callback.operationId === r.operationId &&
      callback.authorityEpoch === r.authorityEpoch &&
      callback.fence === run.fence &&
      callback.provider === run.configuration.provider &&
      (!run.executionId || callback.executionId === run.executionId) &&
      callback.head === r.expectedHead &&
      callback.definition === r.expectedDefinition &&
      callback.configuration === r.expectedConfiguration &&
      callback.environmentFingerprint === r.expectedEnvironment &&
      callback.runtime === plan.runtime &&
      callback.planDigest === run.planDigest &&
      callback.lockfile === plan.lockfile &&
      canonicalPayload(callback.selection) === canonicalPayload(plan.selection),
    'EVIDENCE_CHANGED',
    'Provider evidence differs from the original execution, source or plan.',
  );
  const machine = isMachineRunner(run.configuration)
    ? await requireMacMachine(ctx, input.projectId, run.configuration.machineId)
    : null;
  if (machine)
    invariant(
      machine.sessionId === run.lease?.owner &&
        machine.configuration === run.request.expectedConfiguration &&
        machine.keyId === run.keyId,
      'EVIDENCE_CHANGED',
      'Machine evidence must come from its registered execution owner.',
    );
  const digest = checkPin(callback);
  const old = await ctx.db
    .query('projectHostedCheckCallbacks')
    .withIndex('by_project_and_run_and_event', q =>
      q.eq('projectId', input.projectId).eq('runId', run.id).eq('eventId', callback.eventId),
    )
    .unique();
  if (old) {
    invariant(old.digest === digest, 'WORK_OPERATION_CHANGED', 'Retry the original provider event.');
    return run;
  }
  invariant(!hostedCheckTerminal(run), 'EVIDENCE_CHANGED', 'The original terminal result is immutable.');
  if (isMachineRunner(run.configuration))
    invariant(
      run.lease && run.lease.until > now && !run.cancelRequested,
      'WORK_STALE',
      'The machine execution no longer has a live owner.',
    );
  run.executionId = callback.executionId;
  const result = callback.result;
  if (result.kind === 'shard') {
    const shard = result.shard;
    invariant(
      shard.index < plan.shardCount &&
        (!isMachineRunner(run.configuration) || shard.attempt === run.fence) &&
        (shard.status !== 'passed' || shard.exitCode === 0) &&
        (shard.status !== 'failed' || (shard.exitCode !== null && shard.exitCode !== 0)),
      'EVIDENCE_CHANGED',
      'Shard membership or exit evidence differs from the plan.',
    );
    const prior = await ctx.db
      .query('projectHostedCheckShards')
      .withIndex('by_project_and_run_and_index', q =>
        q.eq('projectId', input.projectId).eq('runId', run.id).eq('index', shard.index),
      )
      .unique();
    const previous = prior ? hostedCheckShardSchema.parse(JSON.parse(prior.value)) : null;
    const shardDigest = checkPin(shard);
    invariant(
      !previous || shard.attempt !== previous.attempt || shard.executionId === previous.executionId,
      'EVIDENCE_CHANGED',
      'The retained shard execution identity changed.',
    );
    invariant(
      !previous
        ? shard.attempt === (isMachineRunner(run.configuration) ? run.fence : 0)
        : (shard.attempt === previous.attempt &&
            (prior!.digest === shardDigest || previous.status === 'running')) ||
            shard.attempt === previous.attempt + 1,
      'EVIDENCE_CHANGED',
      'Retain terminal shard evidence and ordered attempt identities.',
    );
    const count = (item: typeof previous, sign: number) => {
      if (!item || item.status === 'running') return;
      run.counts.completed += sign;
      if (item.status === 'passed') run.counts.passed += sign;
      if (item.status === 'failed') run.counts.failed += sign;
    };
    if (!isMachineRunner(run.configuration) || previous?.attempt === run.fence) count(previous, -1);
    count(shard, 1);
    const saved = {
      projectId: input.projectId,
      runId: run.id,
      index: shard.index,
      attempt: shard.attempt,
      digest: shardDigest,
      value: canonicalPayload(shard),
    };
    if (prior) await ctx.db.replace(prior._id, saved);
    else await ctx.db.insert('projectHostedCheckShards', saved);
    run.status = 'running';
  } else {
    invariant(
      result.status !== 'passed' || result.exitCode === 0,
      'EVIDENCE_CHANGED',
      'A passing verdict requires exit zero.',
    );
    invariant(
      result.status !== 'failed' || (result.exitCode !== null && result.exitCode !== 0),
      'EVIDENCE_CHANGED',
      'A failed verdict requires failure exit evidence.',
    );
    // A provider's overall "completed/success" is not sufficient: its job list
    // can lag. Keep the same execution recoverable until ALL selected jobs settle.
    const allPassed =
      run.counts.completed === plan.shardCount &&
      run.counts.passed === plan.shardCount &&
      run.counts.failed === 0;
    run.status = result.status === 'passed' && !allPassed ? 'unknown' : result.status;
    if (hostedCheckTerminal(run)) {
      run.terminalDigest = digest;
      run.endedAt = new Date(now).toISOString();
      run.exitCode = result.exitCode;
      run.output = result.output;
      run.cost = result.cost;
      if (result.contractReports) {
        run.contractReports = capCheckReports(result.contractReports).reports;
        run.testFiles = checkFileSummary(result.contractReports);
      }
      if (machine)
        run.macEvidence = {
          provider: 'mac',
          machineId: machine.machineId,
          machineOwner: machine.actor,
          registrationId: machine.sessionId,
          reuseKey: null,
          runnerFingerprint: checkPin({
            runtime: run.configuration.runtime,
            environmentFingerprint: run.configuration.environmentFingerprint,
          }),
        };
      await completeHostedCheck(ctx, run);
      await recordHostedTestTimings(ctx, input.projectId, run);
    }
  }
  await ctx.db.insert('projectHostedCheckCallbacks', {
    projectId: input.projectId,
    runId: run.id,
    eventId: callback.eventId,
    digest,
    value: canonicalPayload(callback),
  });
  await writeHostedCheck(ctx, row._id, run);
  await notifyActionsProgress(ctx, run, now);
  return run;
}
