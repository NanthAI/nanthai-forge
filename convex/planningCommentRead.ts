// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { recordHead } from './projectHostedRecords';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';

/** A stored planning comment's exact parent. Synthetic landing notes have no comment record. */
export async function commentOnItem(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  itemId: string,
  commentId: string,
) {
  if (project.workStore === 'records') {
    const head = await recordHead(ctx, project._id, 'comment', commentId);
    return head?.status === 'comment' && head.parent === itemId;
  }
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return false;
  const row = await record(ctx, recordPartition(generation), 'planningComments', commentId);
  return row?.parent === itemId;
}
