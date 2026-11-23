// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { ActionCtx } from './_generated/server';
import { artifactBlobId } from './artifactBlobFields';
import { makeFunctionReference } from 'convex/server';
import { blobStore } from './blobStore';
/** Current archive access is checked by the caller before and after reading. */
export async function archiveBlobUrl(ctx: ActionCtx, storageId: string) {
  if (artifactBlobId(storageId)) return blobStore(ctx).getUrl(storageId);
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
