// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import type { MutationCtx } from './_generated/server';
import { finalOutputTarget } from './projectHostedActionsOutput';
import { actionsSession, sessionArgs, type SessionInput } from './projectHostedActionsSession';
import {
  directOutput,
  directResultSchema,
  directLogSchema,
  directCallback,
  shardExecution,
  actionsExecutionCost,
} from '../src/hosted-actions-direct';
import { outputSigningKey } from './projectHostedOutputApi';
import { authorizeOutputWindow, commitHostedOutputWindow } from './projectHostedOutputStore';
import { presignPut, r2Config } from './r2';
import { outputKey } from '../src/hosted-check-output';
import { receiveHostedCheckCallback } from './projectHostedCheckCallbacks';
import { signHostedCheckCallback } from '../src/hosted-check-evidence';
import {
  checkPin,
  hostedCheckRunSchema,
  hostedCheckTerminal,
  type HostedCheckRun,
} from '../src/hosted-check';
import { semanticPayload } from '../src/semantic-payload';
import { writeHostedCheck } from './projectHostedCheckStore';
import { checkFileSummary } from '../src/check-file-summary';
import { invariant } from '../src/errors';
import { recordShardReports } from './projectHostedActionsReports';
export const output = internalMutation({
  // withRun: an inline-log result also needs the session run to verify the stored object.
  args: {
    ...sessionArgs,
    index: v.number(),
    log: v.string(),
    withRun: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, input) => {
    const selected = await actionsSession(ctx, input),
      { run } = selected,
      log = directLogSchema.parse(JSON.parse(input.log));
    const entries = directOutput(run, input.index, log, outputSigningKey(run.keyId));
    await authorizeOutputWindow(
      ctx,
      entries.map(entry => ({ ...entry, projectId: input.projectId })),
      outputSigningKey,
      selected,
    );
    const target = await presignPut(r2Config(), outputKey(input.projectId, run.id, log.object), {
      digest: log.object.sha256,
      size: log.object.size,
    });
    return input.withRun ? { target, run } : target;
  },
});
export const result = internalMutation({
  // withFinal: a terminal result also returns the final output target, so the HTTP action
  // skips the separate prepare call (Issue 75cb5074). 'prepare' asks it to run prepare as before.
  args: { ...sessionArgs, result: v.string(), withFinal: v.optional(v.boolean()) },
  returns: v.any(),
  handler: async (ctx, { withFinal, ...input }) => {
    const run = await settle(ctx, input);
    if (!withFinal) return run;
    const final = hostedCheckTerminal(run) ? await finalOutputTarget(ctx, input, run) : null;
    return { run, final: final === undefined ? 'prepare' : final };
  },
});
/** A run as loadHostedCheck would parse it back from the value writeHostedCheck stores. */
const storedHostedCheck = (run: HostedCheckRun) =>
  hostedCheckRunSchema.parse(JSON.parse(semanticPayload(hostedCheckRunSchema.parse(run), true)));
async function settle(ctx: MutationCtx, input: SessionInput & { result: string }) {
  const selected = await actionsSession(ctx, input);
  const row = selected.row;
  let run = selected.run;
  const result = directResultSchema.parse(JSON.parse(input.result));
  invariant(
    run.plan && result.index < run.plan.shardCount,
    'EVIDENCE_CHANGED',
    'Select an exact planned shard.',
  );
  const old = await ctx.db
    .query('projectHostedActionsResults')
    .withIndex('by_project_and_run_and_index', q =>
      q.eq('projectId', input.projectId).eq('runId', input.runId).eq('index', result.index),
    )
    .unique();
  const digest = checkPin(result);
  if (old) {
    invariant(old.digest === digest, 'WORK_OPERATION_CHANGED', 'Retry the original Actions job result.');
    return run;
  }
  invariant(!hostedCheckTerminal(run), 'EVIDENCE_CHANGED', 'The check result is already terminal.');
  if (result.log)
    await commitHostedOutputWindow(
      ctx,
      directOutput(run, result.index, result.log, outputSigningKey(run.keyId)).map(entry => ({
        ...entry,
        projectId: input.projectId,
      })),
      outputSigningKey,
      selected,
    );
  const execution = shardExecution(result.execution, run.at, Date.now());
  const callback = directCallback(run, {
    kind: 'shard',
    shard: {
      index: result.index,
      attempt: 0,
      executionId: `${run.executionId}/${result.index}`,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      output: result.log?.object ?? null,
      ...(execution ? { execution } : {}),
    },
  });
  // One run write per shard: the shard bookkeeping and this result's report fold share it.
  const record = async (current: HostedCheckRun) => {
    // Counted once per index: replays return before this point.
    if (execution)
      current.execution = {
        seconds: (current.execution?.seconds ?? 0) + execution.seconds,
        shards: (current.execution?.shards ?? 0) + 1,
      };
    if (result.pool) current.poolClaimed = true;
    // A file run by two shards (shard pool doubt run) counts once; a pass never hides a failure.
    current.testFiles = checkFileSummary(await recordShardReports(ctx, current, { ...result, digest }));
  };
  let recorded = false;
  run = await receiveHostedCheckCallback(
    ctx,
    {
      projectId: input.projectId,
      callback,
      signature: signHostedCheckCallback(callback, outputSigningKey(run.keyId)),
      beforeWrite: current => ((recorded = true), record(current)),
      loaded: selected,
    },
    outputSigningKey,
  );
  if (!recorded) {
    await record(run);
    await writeHostedCheck(ctx, row._id, run);
  }
  if (run.counts.completed === run.plan!.shardCount) {
    const failed = run.counts.failed > 0 || Object.values(run.contractReports!).some(report => report.failed);
    const complete = directCallback(run, {
      kind: 'complete',
      status: run.cancelRequested ? 'cancelled' : failed ? 'failed' : 'passed',
      exitCode: run.cancelRequested ? null : failed ? 1 : 0,
      output: null,
      cost: actionsExecutionCost(run, run.plan!.shardCount),
      contractReports: run.contractReports,
    });
    run = await receiveHostedCheckCallback(
      ctx,
      {
        projectId: input.projectId,
        callback: complete,
        signature: signHostedCheckCallback(complete, outputSigningKey(run.keyId)),
        // The row this transaction just wrote, exactly as a reload would parse it, without
        // reading its full reports back (Issue 75cb5074). actionsSession authorized the write.
        loaded: { row, run: storedHostedCheck(run) },
      },
      outputSigningKey,
    );
  }
  return run;
}
