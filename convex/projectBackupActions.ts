// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
async function reconcile(ctx: ActionCtx, id: Id<'projectBackups'>, owner: string): Promise<Owned['item']> {
  const original: Owned = await ctx.runQuery(internal.projectBackups.get, { id, owner });
  const { backup } = original;
  if (backup.transport === 'objects' || backup.location !== 'r2' || backup.status === 'stored')
    return original.item;
  if (await verifyArchiveUpload(backup))
    return ctx.runMutation(internal.projectBackups.completeR2, { id, owner, key: backup.r2Key! });
  return original.item;
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
  args: { id: v.id('projectBackups') },
  returns: backupItem,
  handler: async (ctx, { id }): Promise<Owned['item']> => {
    try {
      const owner = await caller(ctx),
        original: Owned = await ctx.runQuery(internal.projectBackups.get, { id, owner });
      invariant(original.backup.location === 'r2', 'R2_REQUIRED', 'Backups upload to R2 only.');
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
    } catch (error) {
      return report(error);
    }
  },
});
export const reconcileUpload = action({
  args: { id: v.id('projectBackups') },
  returns: backupItem,
  handler: async (ctx, { id }): Promise<Owned['item']> => {
    try {
      return await reconcile(ctx, id, await caller(ctx));
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
          backup.location === 'r2' &&
          backup.r2Committed &&
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
      invariant(direct, 'R2_OBJECT_UNAVAILABLE', 'The stored archive is unavailable.');
      const data = direct.data;
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
