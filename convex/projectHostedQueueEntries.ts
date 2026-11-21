// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import type { QueueStatusKey } from '../src/hosted-queue-status';
import { QUEUE_VIEW_PAGES } from '../src/hosted-queue-view';

/** The bounded directory window shared by the queue and the review inbox. */
export async function queueViewKeys(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const pages = await ctx.db
    .query('projectHostedLandingQueueStatus')
    .withIndex('by_project_and_page', q => q.eq('projectId', projectId))
    .order('asc')
    .take(QUEUE_VIEW_PAGES);
  return pages
    .flatMap(page => JSON.parse(page.value) as QueueStatusKey[])
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
}

/** A resolution Lane shares its origin's Intent. Prefer the actual solo composition. */
export function queueComposeLanes(ctx: QueryCtx, projectId: Id<'hostedProjects'>, state: HostedLandingState) {
  const compose = state.request.finish?.composeOperationId;
  return compose
    ? ctx.db
        .query('projectHostedComposeSelections')
        .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
          q
            .eq('projectId', projectId)
            .eq('actor', state.actor)
            .eq('operationId', compose)
            .eq('kind', 'inputs'),
        )
        .take(2)
    : [];
}

export function queueIntentLanes(ctx: QueryCtx, projectId: Id<'hostedProjects'>, intentId: string | null) {
  return intentId
    ? ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_parent', q =>
          q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
        )
        .take(2)
    : [];
}
