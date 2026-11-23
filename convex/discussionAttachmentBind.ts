// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { namespaceOf } from './discussionAttachmentStored';
import { invariant } from '../src/errors';
import {
  attachmentByteLimit,
  attachmentName,
  type PlanningAttachment,
} from '../src/discussion-attachment-limits';

/** What a comment may record about its files: only committed bindings made for this exact project, Item and comment.
 * Size and media type come from the binding, never from the client; the name is cleaned. A claim the binding does not
 * back refuses the whole comment (nothing is written), so a comment never names a file that cannot be downloaded. */
export async function boundAttachments(
  ctx: Pick<MutationCtx, 'db'>,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  commentId: string,
  claimed: readonly PlanningAttachment[],
): Promise<PlanningAttachment[]> {
  const namespace = namespaceOf(projectId, itemId, commentId);
  const seen = new Set<string>();
  const bound: PlanningAttachment[] = [];
  for (const claim of claimed) {
    const id = ctx.db.normalizeId('artifactBlobs', claim.id);
    const row = id ? await ctx.db.get(id) : null;
    invariant(
      id && !seen.has(id) && row?.committed && !row.removed && row.namespace === namespace,
      'BAD_ARGUMENT',
      'Attach only files uploaded and committed for this comment.',
    );
    seen.add(id);
    invariant(
      row.size <= attachmentByteLimit(row.contentType),
      'QUOTA_EXCEEDED',
      'This file is over the size limit for its type.',
    );
    bound.push({ id, name: attachmentName(claim.name), size: row.size, contentType: row.contentType });
  }
  return bound;
}
