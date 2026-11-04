import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { isFinishReadReader } from './projectFinishReadReader';
import { hostedLandingAttemptSchema } from '../src/hosted-landing';
import { hostedCheckRunSchema, hostedCheckStatusSchema } from '../src/hosted-check';
import { hostedMainV2Schema } from '../src/hosted-main';
import { invariant } from '../src/errors';
const candidate = hostedLandingAttemptSchema.shape.candidate.pick({ head: true, inputs: true });
/** Leaf readers: no Store/Events imports (those writers maintain queue status). */
export async function finishReadAttempt(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; attemptId: string },
) {
  if (isFinishReadReader(ctx)) {
    const row = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_attempt', q =>
        q
          .eq('kind', 'projectHostedLandingAttempts')
          .eq('projectId', input.projectId)
          .eq('attemptId', input.attemptId),
      )
      .unique();
    if (row) return { candidate: candidate.parse(JSON.parse(JSON.parse(row.value).value).candidate) };
  }
  return loadLandingAttempt(ctx, input);
}
export async function finishReadCheck(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; runId: string },
) {
  if (isFinishReadReader(ctx)) {
    const row = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_run', q =>
        q.eq('kind', 'projectHostedCheckRuns').eq('projectId', input.projectId).eq('runId', input.runId),
      )
      .unique();
    if (row)
      return {
        run: { status: hostedCheckStatusSchema.parse(JSON.parse(JSON.parse(row.value).value).status) },
      };
  }
  const row = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
  return { run: row ? hostedCheckRunSchema.parse(JSON.parse(row.value)) : null };
}
export async function finishReadMain(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  if (isFinishReadReader(ctx)) {
    const row = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_channel', q =>
        q.eq('kind', 'projectHostedChannels').eq('projectId', projectId).eq('channel', 'main'),
      )
      .unique();
    if (row) return { head: JSON.parse(row.value).head as string };
  }
  const row = await ctx.db
    .query('projectHostedChannels')
    .withIndex('by_project_and_name', q => q.eq('projectId', projectId).eq('name', 'main'))
    .unique();
  invariant(row, 'SOURCE_UNAVAILABLE', 'Authoritative hosted main has not been seeded.');
  const main = hostedMainV2Schema.parse(JSON.parse(row.selection));
  invariant(main.projectId === projectId, 'SOURCE_UNAVAILABLE', 'Hosted main belongs to another project.');
  return main;
}

export async function finishReadPeer(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; submissionId: string },
) {
  if (isFinishReadReader(ctx)) {
    const row = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_submission', q =>
        q
          .eq('kind', 'projectHostedLandingPeers')
          .eq('projectId', input.projectId)
          .eq('submissionId', input.submissionId),
      )
      .unique();
    if (row)
      return JSON.parse(row.value) as {
        projectId: string;
        submissionId: string;
        attemptId: string;
        phase: string;
        runId: string | null;
        value: string;
      };
  }
  return ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
}

export async function finishReadAheadQueue(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; channel: 'main' },
) {
  if (isFinishReadReader(ctx)) {
    const row = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_channel', q =>
        q
          .eq('kind', 'projectHostedAheadQueues')
          .eq('projectId', input.projectId)
          .eq('channel', input.channel),
      )
      .unique();
    if (row) return JSON.parse(row.value) as { status: { horizon: string[]; total: number } | null };
  }
  return ctx.db
    .query('projectHostedLandingQueues')
    .withIndex('by_project_and_channel', q => q.eq('projectId', input.projectId).eq('channel', input.channel))
    .unique();
}
