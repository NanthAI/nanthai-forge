// SPDX-License-Identifier: Apache-2.0
'use node';
import { randomUUID } from 'node:crypto';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { projectBackupPreview } from './schema';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { report } from './errors';
import { backupItem } from './projectBackups';
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
  args: {
    key: v.string(),
    name: v.string(),
    operationId: v.string(),
    previous: v.union(v.id('projectBackups'), v.null()),
    digest: v.string(),
    size: v.number(),
    preview: projectBackupPreview,
  },
  returns: v.object({
    backup: backupItem,
    uploadUrl: v.optional(v.string()),
    contentType: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    input,
  ): Promise<{ backup: Owned['item']; uploadUrl?: string; contentType?: string }> => {
    try {
      const owner = await caller(ctx),
        uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      invariant(
        uuid.test(input.key) &&
          uuid.test(input.operationId) &&
          input.name.trim() &&
          /^[0-9a-f]{64}$/.test(input.digest) &&
          Number.isSafeInteger(input.size) &&
          input.size > 0,
        'BAD_ARGUMENT',
        'Select a named project and exact Forge archive size/digest.',
      );
      invariant(
        /^[0-9a-f]{64}$/.test(input.preview.manifestDigest) &&
          input.preview.head.length === (input.preview.format === 'sha1' ? 40 : 64) &&
          /^[0-9a-f]+$/.test(input.preview.head) &&
          [
            input.preview.revision,
            input.preview.intents,
            input.preview.lanes,
            input.preview.views,
            input.preview.runs,
            input.preview.files,
            input.preview.unavailable,
          ].every(value => Number.isSafeInteger(value) && value >= 0) &&
          input.preview.channels.every(
            pin => pin.name && pin.head.length === input.preview.head.length && /^[0-9a-f]+$/.test(pin.head),
          ),
        'BAD_ARGUMENT',
        'Archive source and Work preview fields are invalid.',
      );
      const args = { ...input, name: input.name.trim() },
        p = input.preview;
      const request = digest(
        JSON.stringify([
          args.key,
          args.name,
          args.operationId,
          args.previous,
          args.digest,
          args.size,
          p.manifestDigest,
          p.head,
          p.format,
          p.revision,
          p.intents,
          p.lanes,
          p.views,
          p.runs,
          p.files,
          p.unavailable,
          p.channels.map(pin => [pin.name, pin.head]),
        ]),
      );
      const id: Id<'projectBackups'> = await ctx.runMutation(internal.projectBackups.register, {
        ...args,
        owner,
        request,
        nonce: randomUUID(),
      });
      const backup: Owned['item'] = await reconcile(ctx, id, owner);
      if (backup.status === 'stored') return { backup };
      const original: Owned = await ctx.runQuery(internal.projectBackups.get, { id, owner });
      return {
        backup,
        uploadUrl: await ctx.runMutation(internal.projectBackups.uploadUrl, { id, owner }),
        contentType: `application/x-forge-backup-${original.backup.nonce}`,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const complete = action({
  args: { id: v.id('projectBackups'), storageId: v.id('_storage') },
  returns: backupItem,
  handler: async (ctx, { id, storageId }): Promise<Owned['item']> => {
    try {
      return await ctx.runMutation(internal.projectBackups.complete, {
        id,
        owner: await caller(ctx),
        storageId,
      });
    } catch (error) {
      try {
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
  returns: v.object({ data: v.bytes(), size: v.number(), digest: v.string(), filename: v.string() }),
  handler: async (
    ctx,
    { id, offset, digest },
  ): Promise<{ data: ArrayBuffer; size: number; digest: string; filename: string }> => {
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
        backup.status === 'stored' && backup.storageId && digest === backup.digest,
        'PROJECT_CHANGED',
        'Select the original stored archive and digest.',
      );
      invariant(
        Number.isSafeInteger(offset) && offset >= 0 && offset < backup.size,
        'BAD_ARGUMENT',
        'Invalid archive offset.',
      );
      const data = await projectArchivePart(ctx, backup.storageId, backup.size, backup.digest, offset, () =>
        ctx.runQuery(internal.projectBackups.get, { id, owner }),
      );
      await ctx.runQuery(internal.projectBackups.get, { id, owner });
      return {
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
