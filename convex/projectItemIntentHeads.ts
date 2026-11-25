// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';

export function intentBelongsToItem(head: Doc<'projectHostedRecordHeads'>, itemId: string) {
  return head.planningItemId === itemId;
}

/** Item ownership is on the head, and its creation time survives record version writes. */
export async function latestItemIntentHead(ctx: QueryCtx, projectId: Id<'hostedProjects'>, itemId: string) {
  const [linked] = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_item', q =>
      q.eq('projectId', projectId).eq('kind', 'intent').eq('planningItemId', itemId),
    )
    .order('desc')
    .take(1);
  return linked ?? null;
}
