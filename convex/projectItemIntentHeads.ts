// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { recordHead } from './projectHostedRecords';
import { intentFinished, maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';

/** The pre-cutover reconciliation and open-Lane selection for projects awaiting repair. */
export async function legacyItemIntentHead(ctx: QueryCtx, projectId: Id<'hostedProjects'>, itemId: string) {
  let head = await recordHead(ctx, projectId, 'intent', itemId);
  for (
    let hop = 0;
    head && intentFinished(head.status.replace(/^journal:/, '')) && hop < maxIntentChain;
    hop++
  ) {
    const next = await recordHead(ctx, projectId, 'intent', successorIntentId(head.key));
    if (!next) break;
    head = next;
  }
  return head;
}

export function intentBelongsToItem(head: Doc<'projectHostedRecordHeads'>, itemId: string) {
  // A same-id Work-store Intent can carry the standalone marker when the Item was born
  // from that Intent; it shares the Item's words even when it isn't used for planned start.
  return head.planningItemId === itemId || (!head.planningItemId && head.key === itemId);
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
  if (linked) return linked;
  // A direct same-ID Work root may not have been pinned to execution yet. This is not a successor lookup.
  const root = await recordHead(ctx, projectId, 'intent', itemId);
  return root && intentBelongsToItem(root, itemId) ? root : null;
}
