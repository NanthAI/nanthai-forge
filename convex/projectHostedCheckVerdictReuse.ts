// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { HostedCheckRun } from '../src/hosted-check';
import { hostedCheckRunSchema } from '../src/hosted-check';
import { hostedVerdictKey } from '../src/hosted-check-evidence';
import { hostedWriteProject } from './projectHostedRecords';
import { canonicalPayload } from '../src/hosted-source-operation';
/** Indexed lookup, not a scan of old runs. Only provider conclusion handlers mark this index.
 * Reuse writes no check run, shard, callback verdict or dispatch; an alias is small provenance
 * when the same exact tree occurs in a different Candidate. */
export async function reusedHostedVerdict(ctx: MutationCtx, run: HostedCheckRun) {
  if (!['github-actions', 'ci-status'].includes(run.configuration.provider)) return null;
  const key = hostedVerdictKey(run);
  const row = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_verdict', q => q.eq('projectId', run.projectId as never).eq('verdictKey', key))
    .order('desc')
    .first();
  if (!row) return null;
  const prior = hostedCheckRunSchema.parse(JSON.parse(row.value));
  if (
    prior.status !== 'passed' ||
    !prior.terminalDigest ||
    !prior.plan ||
    prior.counts.passed !== prior.plan.shardCount ||
    prior.counts.failed ||
    prior.counts.completed !== prior.plan.shardCount ||
    prior.exitCode !== 0 ||
    hostedVerdictKey(prior) !== key
  )
    return null;
  await hostedWriteProject(ctx, row.projectId, prior.actor, prior.request.authorityEpoch);
  if (prior.request.candidateId !== run.request.candidateId) {
    const eventId = `reuse:${run.request.candidateId}`;
    const old = await ctx.db
      .query('projectHostedCheckCallbacks')
      .withIndex('by_project_and_run_and_event', q =>
        q.eq('projectId', row.projectId).eq('runId', prior.id).eq('eventId', eventId),
      )
      .unique();
    if (!old)
      await ctx.db.insert('projectHostedCheckCallbacks', {
        projectId: row.projectId,
        runId: prior.id,
        eventId,
        digest: key,
        value: canonicalPayload({ candidateId: run.request.candidateId, actor: run.actor }),
      });
  }
  return prior;
}
