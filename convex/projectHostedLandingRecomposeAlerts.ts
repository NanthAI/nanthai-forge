// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export async function recordRecomposeAlert(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  groupId: string,
  submissionId: string,
  message: string,
  selection?: { actor: string; operationId: string },
) {
  const prior = await ctx.db
    .query('projectHostedRecomposeAlerts')
    .withIndex('by_project_and_group', q => q.eq('projectId', projectId).eq('groupId', groupId))
    .unique();
  if (prior) return;
  const [lane] = selection
    ? await ctx.db
        .query('projectHostedComposeSelections')
        .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
          q
            .eq('projectId', projectId)
            .eq('actor', selection.actor)
            .eq('operationId', selection.operationId)
            .eq('kind', 'inputs'),
        )
        .take(1)
    : [];
  await ctx.db.insert('projectHostedRecomposeAlerts', {
    projectId,
    groupId,
    submissionId,
    ...(lane ? { laneId: lane.key } : {}),
    summary: message.replace(/\s+/g, ' ').slice(0, 240),
  });
}

export function recentRecomposeAlerts(ctx: QueryCtx, projectId: Id<'hostedProjects'>, limit: number) {
  return ctx.db
    .query('projectHostedRecomposeAlerts')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .order('desc')
    .take(limit);
}
