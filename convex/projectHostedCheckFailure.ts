import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { failingStep } from '../src/hosted-landing-suspect';
import { checkFailureDetail } from '../src/check-failure-detail';

type FailedRun = Parameters<typeof checkFailureDetail>[0] & {
  id: string;
  plan?: { shardCount?: number | undefined } | null | undefined;
};

/** The failing job step of a run that names no test file, from the bounded job
 * summaries Actions already sealed. Failure settlements only: one indexed read in
 * the settling mutation, no extra Convex call and nothing on the passing path. */
export async function checkFailureStep(ctx: MutationCtx, projectId: Id<'hostedProjects'>, run: FailedRun) {
  if (run.testFiles?.failed.length || Object.values(run.contractReports ?? {}).some(report => report.failed))
    return null;
  return failingStep(
    await ctx.db
      .query('projectHostedOutputStreams')
      .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', run.id))
      .take(64),
    run.plan?.shardCount,
  );
}

export async function describeCheckFailure(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  run: FailedRun,
) {
  return checkFailureDetail(run, await checkFailureStep(ctx, projectId, run));
}
