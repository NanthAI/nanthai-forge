// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { completeHostedCheck, writableHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { checkPin, hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';
import { requireStoredRepositoryBinding, type RunnerScope } from './githubBindingAccess';
import { ForgeError } from '../src/errors';

/** The project role of one account: anyone who is neither the owner nor a contributor is outside. */
export async function roleOf(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  actor: string,
) {
  if (actor && actor === owner) return 'owner' as const;
  const contributor = actor
    ? await ctx.db
        .query('projectContributors')
        .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', actor))
        .unique()
    : null;
  return contributor ? ('contributor' as const) : ('outside' as const);
}

/** Settles a ci-status run once: the provider's verdict, or why Forge could not run it. */
export async function settleCiStatus(
  ctx: MutationCtx,
  selected: Awaited<ReturnType<typeof writableHostedCheck>>,
  status: 'passed' | 'failed' | 'cancelled' | 'runner-unavailable',
  reason: string,
  now = Date.now(),
) {
  const { row, run } = selected;
  if (hostedCheckTerminal(run)) return;
  run.status = status;
  // One fixed shard: the provider run is the whole check (acceptance evidence counts shards).
  run.counts =
    status === 'passed' ? { completed: 1, passed: 1, failed: 0 } : { completed: 0, passed: 0, failed: 0 };
  run.exitCode = status === 'passed' ? 0 : status === 'failed' ? 1 : null;
  if (status !== 'passed') run.failureReason = reason.slice(0, 500);
  run.endedAt = new Date(now).toISOString();
  run.terminalDigest = checkPin({
    runId: run.id,
    fence: run.fence,
    executionId: run.executionId,
    status,
    reason,
  });
  await completeHostedCheck(ctx, run);
  await writeHostedCheck(ctx, row._id, run, status === 'passed');
}

/** Private IO instruction returned to the signed webhook action, never to a Candidate job. */
export type CiBranchCleanup = {
  projectId: Id<'hostedProjects'>;
  runId: string;
  repository: string;
  commit: string;
  scope: RunnerScope | null;
};
export async function ciBranchCleanup(
  ctx: MutationCtx,
  run: HostedCheckRun,
): Promise<true | CiBranchCleanup> {
  const ci = run.configuration;
  if (ci.provider !== 'ci-status' || ci.ci.adapter !== 'github-actions' || !run.ci?.commit) return true;
  try {
    const scope = await requireStoredRepositoryBinding(
      ctx,
      run.projectId as Id<'hostedProjects'>,
      ci.ci.repository,
    );
    return {
      projectId: run.projectId as Id<'hostedProjects'>,
      runId: run.id,
      repository: ci.ci.repository,
      commit: run.ci.commit,
      scope,
    };
  } catch (error) {
    // A revoked mirror binding prevents cleanup IO, never changes the provider's check verdict.
    if (!(error instanceof ForgeError) || error.code !== 'GITHUB_REPOSITORY_UNBOUND') throw error;
    console.log(`FORGE_CI_CLEANUP_UNAVAILABLE ${JSON.stringify({ runId: run.id, code: error.code })}`);
    return true;
  }
}
