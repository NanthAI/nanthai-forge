// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { recordHead } from './projectHostedRecords';

/** A stored planning comment's exact parent. Synthetic landing notes have no comment record. */
export async function commentOnItem(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  itemId: string,
  commentId: string,
) {
  const head = await recordHead(ctx, project._id, 'comment', commentId);
  return head?.status === 'comment' && head.parent === itemId;
}
