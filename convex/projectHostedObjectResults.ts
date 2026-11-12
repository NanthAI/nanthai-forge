// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { MutationCtx } from './_generated/server';
import type { LoadedHostedCheck } from './projectHostedCheckStore';
import { writeHostedCheck } from './projectHostedCheckStore';
import { objectReportTransport } from './projectHostedCheckReports';
import { recordHostedTestTimings } from './projectHostedTestTimings';
import { notifyActionsProgress } from './projectHostedActionsWake';
import { hostedCheckRunSchema, hostedCheckTerminal } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { directResultSchema } from '../src/hosted-actions-direct';
import { settleDirectActions } from './projectHostedActionsDirect';
import { completeFromResults, holdForConclusion } from './projectHostedActionsVerdict';
import { finalOutputTarget } from './projectHostedActionsOutput';
import { hostedCheckOutputSettled, providerVerdict } from '../src/hosted-check-verdict';
/** One collector fold supplies only bounded metadata, exact raw-result digests and timing arguments. */
export async function settleObjectBatch(
  ctx: MutationCtx,
  input: import('./projectHostedActionsBatchStore').BatchInput & {
    reportHeader?: string;
    reportDigests?: string;
    timings?: string;
    coveredShards?: number;
    timingFinal?: boolean;
    collectionToken?: string;
    conclusion?: string | null;
  },
  selected: LoadedHostedCheck,
  settleResult: typeof import('./projectHostedActionsResults').settleActionsResult,
  results: z.infer<typeof directResultSchema>[],
  envelopes: Record<string, import('../src/hosted-check-output').OutputChunk['envelope']>,
) {
  let run = selected.run;
  const transport = objectReportTransport(run)!;
  if (transport.collection) {
    invariant(
      input.collectionToken === transport.collection.token && transport.collection.fence === run.fence,
      'EVIDENCE_CHANGED',
      'Settle only the reserved report collection.',
    );
  }
  transport.collecting = true;
  input = {
    ...input,
    // null is an explicit completed/unknown provider result, not an absent event.
    conclusion:
      typeof transport.conclusion === 'string' && input.conclusion == null
        ? transport.conclusion
        : input.conclusion === undefined
          ? transport.conclusion
          : input.conclusion,
  };
  if (input.workflowSha && run.actions) {
    invariant(
      !run.actions.workflowSha || run.actions.workflowSha === input.workflowSha,
      'EVIDENCE_CHANGED',
      'Workflow revision changed.',
    );
    run.actions.workflowSha = input.workflowSha;
  }
  invariant(
    input.reportHeader && input.reportDigests,
    'CLI_UPGRADE_REQUIRED',
    'Collect with check-report-detail.',
  );
  const header = hostedCheckRunSchema
    .pick({ testFiles: true, reportSummary: true, reportPointer: true })
    .extend({ pending: z.array(z.string()), flakes: z.string() })
    .strict()
    .parse(JSON.parse(input.reportHeader));
  invariant(
    header.testFiles && header.reportSummary,
    'EVIDENCE_CHANGED',
    'Retain the complete folded header.',
  );
  const digests = z
    .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
    .parse(JSON.parse(input.reportDigests));
  invariant(
    results.every(result => !result.contractReports && digests[result.index]),
    'EVIDENCE_CHANGED',
    'Reports never enter result rows.',
  );
  if ((input.coveredShards ?? results.length) < run.counts.completed)
    return JSON.stringify({ run, final: null });
  invariant(
    !run.reportPointer || run.reportPointer.digest === header.reportPointer?.digest,
    'EVIDENCE_CHANGED',
    'Final check reports are immutable.',
  );
  const identical =
    run.reportPointer &&
    canonicalPayload(run.reportPointer) === canonicalPayload(header.reportPointer) &&
    (input.conclusion === undefined || input.conclusion === transport.conclusion) &&
    (hostedCheckTerminal(run) || run.actions?.verdictPending);
  if (
    identical &&
    (transport.timingComplete || typeof input.conclusion !== 'string' || input.conclusion === 'cancelled')
  ) {
    const final = hostedCheckOutputSettled(run) ? await finalOutputTarget(ctx, input, run) : null;
    return JSON.stringify({ run, final: final === undefined ? 'prepare' : final });
  }
  run.testFiles = header.testFiles;
  run.reportSummary = header.reportSummary;
  if (header.reportPointer) run.reportPointer = header.reportPointer;
  if (header.pending.length) run.poolPending = header.pending;
  else delete run.poolPending;
  transport.flakes = header.flakes;
  if (input.conclusion !== undefined && run.actions?.confirm) {
    await ctx.scheduler.cancel(run.actions.confirm as never);
    run.actions.confirm = null;
  }
  if (!hostedCheckTerminal(run)) {
    for (const result of results) {
      const prior = await ctx.db
        .query('projectHostedCheckShards')
        .withIndex('by_project_and_run_and_index', q =>
          q.eq('projectId', input.projectId).eq('runId', run.id).eq('index', result.index),
        )
        .unique();
      run = await settleResult(
        ctx,
        { ...input, claims: input.claims ?? '', result: JSON.stringify(result) },
        selected,
        undefined,
        envelopes[result.index],
        { digest: digests[result.index]!, prior },
      );
      selected.run = run;
    }
    const all = run.counts.completed === run.plan!.shardCount;
    const failed = run.counts.failed > 0 || run.testFiles!.counts.failed > 0;
    if (run.cancelRequested || input.conclusion === 'cancelled') {
      run = await settleDirectActions(ctx, selected, 'cancelled', 'Cancelled.', Date.now(), true);
    } else if (all && (failed || input.conclusion === 'success')) {
      run = await completeFromResults(ctx, selected, failed ? 'failed' : 'passed', true);
    } else if (input.conclusion !== undefined) {
      const verdict = providerVerdict(input.conclusion);
      run = await settleDirectActions(
        ctx,
        selected,
        failed ? 'failed' : 'runner-unavailable',
        all && 'reason' in verdict ? verdict.reason : 'Actions completed without complete job evidence.',
        Date.now(),
        true,
      );
    } else if (all && !run.actions?.verdictPending) run = await holdForConclusion(ctx, selected, true);
  }
  if (input.conclusion !== undefined) {
    const conclusion = input.conclusion;
    invariant(
      conclusion === null || transport.conclusion == null || transport.conclusion === conclusion,
      'EVIDENCE_CHANGED',
      'The provider conclusion is immutable.',
    );
    if (transport.conclusion == null) transport.conclusion = conclusion;
  }
  // A provider's final conclusion, not an early failed result, authorizes the timing sample.
  if (
    typeof input.conclusion === 'string' &&
    input.conclusion !== 'cancelled' &&
    ['passed', 'failed'].includes(run.status)
  ) {
    const durations = z
      .record(z.string(), z.number().finite().nonnegative())
      .parse(JSON.parse(input.timings ?? '{}'));
    await recordHostedTestTimings(ctx, input.projectId, run, durations, input.timingFinal !== false);
  }
  delete transport.collection;
  await writeHostedCheck(ctx, selected.row._id, run, run.status === 'passed');
  await notifyActionsProgress(ctx, run);
  const final = hostedCheckOutputSettled(run) ? await finalOutputTarget(ctx, input, run) : null;
  return JSON.stringify({
    run,
    timings:
      typeof input.conclusion === 'string' &&
      input.conclusion !== 'cancelled' &&
      ['passed', 'failed'].includes(run.status),
    final: final === undefined ? 'prepare' : final,
  });
}
