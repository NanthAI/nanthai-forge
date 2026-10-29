// SPDX-License-Identifier: Apache-2.0
'use node';
import { archivePut, verifyArchiveUpload } from './archiveUpload';
import type { R2PutTarget } from './r2';
import { randomUUID } from 'node:crypto';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { backupTransferArgs, backupTransferRequest } from './backupTransferRequest';
import { invariant } from '../src/errors';
import { report } from './errors';
import { backupItem } from './projectBackups';
import { archiveDownload, directDownloadFields, type DirectDownload } from './archiveDownload';
import { projectArchivePart } from './projectArchivePart';

async function caller(ctx: ActionCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project backups.');
  return user.subject;
}
type Owned = {
  backup: Doc<'projectBackups'>;
  project: Doc<'hostedProjects'>;
  item: {
    id: Id<'projectBackups'>;
    operationId: string;
    projectId: Id<'hostedProjects'>;
    name: string;
    status: 'uploading' | 'stored';
    digest: string;
    size: number;
    preview: Doc<'projectBackups'>['preview'];
    previous: Id<'projectBackups'> | null;
    current: boolean;
    at: number;
  };
};
async function reconcile(
  ctx: ActionCtx,
  id: Id<'projectBackups'>,
  owner: string,
  cleanupStored = false,
): Promise<Owned['item']> {
  const original: Owned = await ctx.runQuery(internal.projectBackups.get, { id, owner });
  if (original.backup.transport === 'objects') return original.item;
  if (original.backup.location === 'r2') {
    if (original.backup.status === 'stored') return original.item;
    if (await verifyArchiveUpload(original.backup))
      return ctx.runMutation(internal.projectBackups.completeR2, { id, owner, key: original.backup.r2Key! });
    return original.item;
  }
  if (original.backup.status === 'stored') {
    if (!cleanupStored) return original.item;
    let cleanupCursor: string | null = null;
    while (true) {
      const observed: { cursor: string; isDone: boolean } = await ctx.runMutation(
        internal.projectBackups.reconcileDuplicates,
        { id, owner, cursor: cleanupCursor },
      );
      if (observed.isDone) break;
      cleanupCursor = observed.cursor;
    }
    return original.item;
  }
  let cursor: string | null = null;
  while (true) {
    const page: { id: Id<'_storage'> | null; isDone: boolean; cursor: string } = await ctx.runQuery(
      internal.projectBackups.findUpload,
      { id, owner, cursor },
    );
    if (page.id) return ctx.runMutation(internal.projectBackups.complete, { id, owner, storageId: page.id });
    if (page.isDone) return original.item;
    cursor = page.cursor;
  }
}
export const prepare = action({
  args: backupTransferArgs,
  returns: v.object({
    backup: backupItem,
    uploadUrl: v.optional(v.string()),
    target: v.optional(archivePut),
    contentType: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    input,
  ): Promise<{ backup: Owned['item']; uploadUrl?: string; target?: R2PutTarget; contentType?: string }> => {
    try {
      const owner = await caller(ctx),
        { args, request } = backupTransferRequest(input);
      const id: Id<'projectBackups'> = await ctx.runMutation(internal.projectBackups.register, {
        ...args,
        owner,
        request,
        nonce: randomUUID(),
      });
      const original: Owned = await ctx.runQuery(internal.projectBackups.get, { id, owner }),
        backup = original.item;
      if (backup.status === 'stored') return { backup };
      const target = await ctx.runMutation(internal.projectBackups.uploadUrl, { id, owner });
      return {
        backup,
        ...(typeof target === 'string' ? { uploadUrl: target } : { target }),
        contentType: `application/x-forge-backup-${original.backup.nonce}`,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const complete = action({
  args: { id: v.id('projectBackups'), storageId: v.optional(v.id('_storage')) },
  returns: backupItem,
  handler: async (ctx, { id, storageId }): Promise<Owned['item']> => {
    try {
      const owner = await caller(ctx),
        original: Owned = await ctx.runQuery(internal.projectBackups.get, { id, owner });
      if (original.backup.location === 'r2') {
        invariant(
          await verifyArchiveUpload(original.backup),
          'R2_OBJECT_MISSING',
          'Uploaded archive is missing.',
        );
        return await ctx.runMutation(internal.projectBackups.completeR2, {
          id,
          owner,
          key: original.backup.r2Key!,
        });
      }
      invariant(storageId, 'INVALID_WORK_BACKUP', 'Select the original legacy upload.');
      return await ctx.runMutation(internal.projectBackups.complete, {
        id,
        owner: await caller(ctx),
        storageId,
      });
    } catch (error) {
      try {
        if (storageId)
          await ctx.runMutation(internal.projectLifecycle.cleanupUpload, {
            uploadId: id,
            actor: await caller(ctx),
            storageId,
          });
      } catch {
        /* Foreign/unattributable files remain untouched. */
      }
      return report(error);
    }
  },
});
export const reconcileUpload = action({
  args: { id: v.id('projectBackups') },
  returns: backupItem,
  handler: async (ctx, { id }): Promise<Owned['item']> => {
    try {
      return await reconcile(ctx, id, await caller(ctx), true);
    } catch (error) {
      return report(error);
    }
  },
});
export const downloadPart = action({
  args: { id: v.id('projectBackups'), offset: v.number(), digest: v.string() },
  returns: v.object({
    ...directDownloadFields,
    data: v.bytes(),
    size: v.number(),
    digest: v.string(),
    filename: v.string(),
  }),
  handler: async (
    ctx,
    { id, offset, digest },
  ): Promise<DirectDownload & { size: number; digest: string; filename: string }> => {
    try {
      const owner = await caller(ctx),
        original: Owned = await ctx.runQuery(internal.projectBackups.get, { id, owner }),
        backup = original.backup;
      invariant(
        backup.transport !== 'objects',
        'EXCHANGE_CHECKPOINT',
        'Use incremental exchange pull for this checkpoint; a full recovery archive can be exported locally.',
      );
      invariant(
        backup.status === 'stored' &&
          (backup.storageId || (backup.location === 'r2' && backup.r2Committed)) &&
          digest === backup.digest,
        'PROJECT_CHANGED',
        'Select the original stored archive and digest.',
      );
      invariant(
        Number.isSafeInteger(offset) && offset >= 0 && offset < backup.size,
        'BAD_ARGUMENT',
        'Invalid archive offset.',
      );
      const direct = await archiveDownload(ctx, backup);
      const data = direct
        ? direct.data
        : await projectArchivePart(ctx, backup.storageId!, backup.size, backup.digest, offset, () =>
            ctx.runQuery(internal.projectBackups.get, { id, owner }),
          );
      await ctx.runQuery(internal.projectBackups.get, { id, owner });
      return {
        ...direct,
        data,
        size: backup.size,
        digest: backup.digest,
        filename: `forge-backup-${backup.operationId}.tar.gz`,
      };
    } catch (error) {
      return report(error);
    }
  },
});
