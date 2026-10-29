// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { actionsSession, sessionArgs } from './projectHostedActionsSession';
import {
  directOutput,
  directResultSchema,
  directLogSchema,
  directCallback,
} from '../src/hosted-actions-direct';
import { outputSigningKey } from './projectHostedOutputApi';
import { authorizeOutputWindow, commitHostedOutputWindow } from './projectHostedOutputStore';
import { presignPut, r2Config } from './r2';
import { outputKey } from '../src/hosted-check-output';
import { receiveHostedCheckCallback } from './projectHostedCheckCallbacks';
import { signHostedCheckCallback } from '../src/hosted-check-evidence';
import { checkPin, hostedCheckTerminal } from '../src/hosted-check';
import { writeHostedCheck } from './projectHostedCheckStore';
import { invariant } from '../src/errors';
export const output = internalMutation({
  args: { ...sessionArgs, index: v.number(), log: v.string() },
  returns: v.any(),
  handler: async (ctx, input) => {
    const { run } = await actionsSession(ctx, input),
      log = directLogSchema.parse(JSON.parse(input.log));
    const entries = directOutput(run, input.index, log, outputSigningKey(run.keyId));
    await authorizeOutputWindow(
      ctx,
      entries.map(entry => ({ ...entry, projectId: input.projectId })),
      outputSigningKey,
    );
    return presignPut(r2Config(), outputKey(input.projectId, run.id, log.object), {
      digest: log.object.sha256,
      size: log.object.size,
    });
  },
});
export const result = internalMutation({
  args: { ...sessionArgs, result: v.string() },
  returns: v.any(),
  handler: async (ctx, input) => {
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
      );
    const callback = directCallback(run, {
      kind: 'shard',
      shard: {
        index: result.index,
        attempt: 0,
        executionId: `${run.executionId}/${result.index}`,
        status: result.exitCode === 0 ? 'passed' : 'failed',
        exitCode: result.exitCode,
        output: result.log?.object ?? null,
      },
    });
    run = await receiveHostedCheckCallback(
      ctx,
      {
        projectId: input.projectId,
        callback,
        signature: signHostedCheckCallback(callback, outputSigningKey(run.keyId)),
      },
      outputSigningKey,
    );
    run.contractReports = { ...run.contractReports, ...result.contractReports };
    await writeHostedCheck(ctx, row._id, run);
    await ctx.db.insert('projectHostedActionsResults', {
      projectId: input.projectId,
      runId: run.id,
      index: result.index,
      digest,
    });
    if (run.counts.completed === run.plan!.shardCount) {
      const complete = directCallback(run, {
        kind: 'complete',
        status: run.cancelRequested ? 'cancelled' : run.counts.failed ? 'failed' : 'passed',
        exitCode: run.cancelRequested ? null : run.counts.failed ? 1 : 0,
        output: null,
        cost: { status: 'unknown' },
        contractReports: run.contractReports,
      });
      run = await receiveHostedCheckCallback(
        ctx,
        {
          projectId: input.projectId,
          callback: complete,
          signature: signHostedCheckCallback(complete, outputSigningKey(run.keyId)),
        },
        outputSigningKey,
      );
    }
    return run;
  },
});
