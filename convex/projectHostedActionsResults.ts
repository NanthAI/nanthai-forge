// SPDX-License-Identifier: Apache-2.0
import { inheritCheckReports, objectReportTransport } from './projectHostedCheckReports';
import type { Doc } from './_generated/dataModel';

import { settleObjectBatch } from './projectHostedObjectResults';
import { batchArgs, batchSession } from './projectHostedActionsBatchStore';
import { z } from 'zod';
import { resultPageBytes } from '../src/hosted-actions-result-batch';
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
import { type LoadedHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { checkFileSummary } from '../src/check-file-summary';
import { invariant } from '../src/errors';
import {
  restoreShardReports,
  recordShardReports,
  createShardReportBatch,
  flushShardReportBatch,
  type ShardReportBatch,
} from './projectHostedActionsReports';
import { settleDirectActions } from './projectHostedActionsDirect';
import { applyConclusion, completeFromResults, holdForConclusion } from './projectHostedActionsVerdict';
import { hostedCheckOutputSettled } from '../src/hosted-check-verdict';
export const output = internalMutation({
  // withRun: an inline-log result also needs the session run to verify the stored object.
  args: {
    ...sessionArgs,
    index: v.number(),
    log: v.string(),
    withRun: v.optional(v.boolean()),
  },
  // JSON text: a run can hold one report per test file, beyond Convex's 1024-field object limit.
  returns: v.string(),
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
    return JSON.stringify(input.withRun ? { target, run } : target);
  },
});
export const result = internalMutation({
  // withFinal: a terminal result also returns the final output target, so the HTTP action
  // skips the separate prepare call (Issue 75cb5074). 'prepare' asks it to run prepare as before.
  args: { ...sessionArgs, result: v.string(), withFinal: v.optional(v.boolean()) },
  // JSON text (Issue 0c457ae4): the settled run's reports are keyed by test file.
  returns: v.string(),
  handler: async (ctx, { withFinal, ...input }) => {
    const run = await settleActionsResult(ctx, input);
    if (!withFinal) return JSON.stringify(run);
    const final = hostedCheckOutputSettled(run) ? await finalOutputTarget(ctx, input, run) : null;
    return JSON.stringify({ run, final: final === undefined ? 'prepare' : final });
  },
});
/** A run as loadHostedCheck would parse it back from the value writeHostedCheck stores. */
const storedHostedCheck = (run: HostedCheckRun) =>
  inheritCheckReports(
    run,
    hostedCheckRunSchema.parse(JSON.parse(semanticPayload(hostedCheckRunSchema.parse(run), true))),
  );
export async function settleActionsResult(
  ctx: MutationCtx,
  input: SessionInput & { result: string },
  batch?: LoadedHostedCheck,
  reports?: ShardReportBatch,
  envelope?: import('../src/hosted-check-output').OutputChunk['envelope'],
  objectBatch?: { digest: string; prior: Doc<'projectHostedCheckShards'> | null },
) {
  const selected = batch ?? (await actionsSession(ctx, input));
  const row = selected.row;
  let run = selected.run;
  const result = directResultSchema.parse(JSON.parse(input.result));
  invariant(
    run.plan && result.index < run.plan.shardCount,
    'EVIDENCE_CHANGED',
    'Select an exact planned shard.',
  );
  const transport = objectReportTransport(run);
  invariant(
    !transport || objectBatch,
    'CLI_UPGRADE_REQUIRED',
    'Use a runner with check-report-detail result batches.',
  );
  const old = objectBatch
    ? objectBatch.prior
    : await ctx.db
        .query('projectHostedActionsResults')
        .withIndex('by_project_and_run_and_index', q =>
          q.eq('projectId', input.projectId).eq('runId', input.runId).eq('index', result.index),
        )
        .unique();
  const digest = objectBatch?.digest ?? checkPin(result);
  if (old) {
    invariant(
      (objectBatch ? ('resultDigest' in old ? old.resultDigest : undefined) : old.digest) === digest,
      'WORK_OPERATION_CHANGED',
      'Retry the original Actions job result.',
    );
    return run;
  }
  invariant(!hostedCheckTerminal(run), 'EVIDENCE_CHANGED', 'The check result is already terminal.');
  if (result.log)
    await commitHostedOutputWindow(
      ctx,
      directOutput(run, result.index, result.log, outputSigningKey(run.keyId), envelope).map(entry => ({
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
    // Run evidence keeps the weakest isolation any shard reported (Issue 3b67363d).
    if (result.isolation && current.actions)
      current.actions.isolation = current.actions.isolation === 'shared' ? 'shared' : result.isolation;
    // A file run by two shards (shard pool doubt run) counts once; a pass never hides a failure.
    if (objectBatch) return;
    current.testFiles = checkFileSummary(
      await recordShardReports(ctx, current, { ...result, digest }, reports),
    );
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
      ...(objectBatch ? { priorShard: objectBatch.prior, resultDigest: digest } : {}),
      ...(batch ? { deferWrite: true } : {}),
    },
    outputSigningKey,
  );
  if (!recorded) {
    await record(run);
    if (!batch) await writeHostedCheck(ctx, row._id, run);
  }
  if (!objectBatch && run.counts.completed === run.plan!.shardCount) {
    const failed = run.counts.failed > 0 || Object.values(run.contractReports!).some(report => report.failed);
    // The row this transaction just wrote, exactly as a reload would parse it, without reading its
    // full reports back (Issue 75cb5074). actionsSession authorized the write.
    const loaded = { row, run: storedHostedCheck(run), project: selected.project };
    // A failure or cancellation settles now; a pass also needs the provider's own conclusion,
    // which the job that ran the Candidate cannot write (Issue 432164bf).
    run =
      run.cancelRequested || failed
        ? await completeFromResults(ctx, loaded, run.cancelRequested ? 'cancelled' : 'failed')
        : await holdForConclusion(ctx, loaded);
  }
  return run;
}

/** One mutation per bounded page, one run write after folding all new shard results. The legacy
 * result entry remains for already running or older supervisors. Only the collector calls this. */
export const batch = internalMutation({
  args: {
    ...batchArgs,
    results: v.string(),
    envelopes: v.optional(v.string()),
    conclusion: v.optional(v.union(v.string(), v.null())),
    reportHeader: v.optional(v.string()),
    reportDigests: v.optional(v.string()),
    timings: v.optional(v.string()),
    coveredShards: v.optional(v.number()),
    timingFinal: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    invariant(
      new TextEncoder().encode(input.results).length <= resultPageBytes,
      'BAD_ARGUMENT',
      'Page the result metadata.',
    );
    const selected = await batchSession(ctx, input);
    const envelopes = z
      .record(
        z.string(),
        z
          .object({
            object: z.object({
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              size: z.number().int().nonnegative(),
            }),
            fence: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .parse(JSON.parse(input.envelopes ?? '{}'));
    const results = z.array(directResultSchema).parse(JSON.parse(input.results));
    invariant(
      new Set(results.map(r => r.index)).size === results.length,
      'EVIDENCE_CHANGED',
      'Each shard belongs to a batch page once.',
    );
    if (objectReportTransport(selected.run))
      return settleObjectBatch(ctx, input, selected, settleActionsResult, results, envelopes);
    let run = selected.run;
    const before = run.counts.completed;
    const reports = createShardReportBatch();
    for (const result of results) {
      run = await settleActionsResult(
        ctx,
        { ...input, claims: input.claims ?? '', result: JSON.stringify(result) },
        selected,
        reports,
        envelopes[result.index],
      );
      selected.run = run;
    }
    await flushShardReportBatch(ctx, run, reports);
    if (run.counts.completed !== before && run.counts.completed < run.plan!.shardCount)
      await writeHostedCheck(ctx, selected.row._id, run);
    if (!hostedCheckTerminal(run) && input.conclusion !== undefined) {
      if (run.actions?.verdictPending) run = await applyConclusion(ctx, selected, input.conclusion);
      else {
        await restoreShardReports(ctx, run, true);
        if (run.contractReports) run.testFiles = checkFileSummary(run.contractReports);
        run = await settleDirectActions(
          ctx,
          selected,
          input.conclusion === 'cancelled'
            ? 'cancelled'
            : run.counts.failed || run.testFiles?.counts.failed
              ? 'failed'
              : 'runner-unavailable',
          'Actions completed without complete job evidence.',
        );
      }
    }
    const final = hostedCheckOutputSettled(run) ? await finalOutputTarget(ctx, input, run) : null;
    const head = { ...run };
    delete head.contractReports;
    return JSON.stringify({ run: head, final: final === undefined ? 'prepare' : final });
  },
});
