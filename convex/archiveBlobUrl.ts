// SPDX-License-Identifier: Apache-2.0
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { makeFunctionReference } from 'convex/server';
import { blobStore } from './blobStore';
/** Current archive access is checked by the caller before and after reading. */
export async function archiveBlobUrl(ctx: ActionCtx, storageId: Id<'_storage'>) {
  const user = await ctx.auth.getUserIdentity();
  if (user) {
    const url: string | null = await ctx.runQuery(
      makeFunctionReference<'query'>('projectR2Backfill:archiveUrl'),
      {
        storageId,
        actor: user.subject,
      },
    );
    if (url) return url;
  }
  return blobStore(ctx).getUrl(storageId);
}
