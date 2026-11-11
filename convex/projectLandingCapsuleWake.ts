// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
export const landingCapsuleGraceMs = 7 * 86_400_000;
export async function wakeLandingCapsule(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    submissionId: string;
    dueAt: number;
  },
) {
  if (process.env.FORGE_LANDING_CAPSULES !== '1') return;
  await ctx.scheduler.runAfter(
    Math.max(0, input.dueAt - Date.now()),
    makeFunctionReference<'action'>('projectLandingCapsuleRun:pack'),
    input,
  );
}

export const capsuleWaitKind = 'projectLandingCapsuleWaits';
export async function deferCapsuleCheck(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    submissionId: string;
    runId: string;
    dueAt: number;
  },
) {
  const sourceId = `${input.projectId}:${input.runId}:${input.submissionId}`;
  const old = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q => q.eq('kind', capsuleWaitKind).eq('sourceId', sourceId))
    .unique();
  if (!old)
    await ctx.db.insert('projectFinishReadRows', {
      kind: capsuleWaitKind,
      sourceId,
      projectId: input.projectId,
      submissionId: input.submissionId,
      runId: input.runId,
      value: JSON.stringify({ dueAt: input.dueAt }),
    });
}
export async function settleCapsuleCheck(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; runId: string },
) {
  if (process.env.FORGE_LANDING_CAPSULES !== '1') return;
  const waiting = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_run', q =>
      q.eq('kind', capsuleWaitKind).eq('projectId', input.projectId).eq('runId', input.runId),
    )
    .first();
  if (waiting)
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectLandingCapsuleRefs:wakeChecks'),
      input,
    );
}
