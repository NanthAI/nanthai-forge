// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, action } from './cliServer';
import { internal } from './_generated/api';
import { backupItem, item, registerBackup } from './projectBackups';
import { backupTransferArgs, backupTransferRequest } from './backupTransferRequest';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { archivePut, archiveTarget, reserveArchive, verifyArchiveUpload } from './archiveUpload';
import { presignGet, r2Config } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

/** R2 transfer control: prepare/sign are single transactions; only HEAD needs
 * an action. The legacy action API remains available for old in-flight clients. */
export const prepare = mutation({
  args: backupTransferArgs,
  returns: v.object({ backup: backupItem, target: v.optional(archivePut) }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project backups.');
      const owner = user.subject,
        { args, request } = backupTransferRequest(input);
      const id = await registerBackup(ctx, { ...args, owner, request, nonce: crypto.randomUUID() });
      const backup = (await ctx.db.get(id))!,
        project = await activeOwnedProject(ctx, backup.projectId, owner);
      if (backup.status === 'stored') return { backup: item(backup, project) };
      const artifact = await reserveArchive(ctx, backup),
        target = await archiveTarget(artifact);
      await ctx.db.patch(id, { location: 'r2', r2Key: artifact.r2Key });
      return { backup: item(backup, project), target };
    } catch (error) {
      return report(error);
    }
  },
});
export const complete = action({
  args: {
    id: v.id('projectBackups'),
    projectId: v.id('hostedProjects'),
    digest: v.string(),
    size: v.number(),
  },
  returns: backupItem,
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project backups.');
      invariant(
        /^[a-f0-9]{64}$/.test(input.digest) && Number.isSafeInteger(input.size) && input.size > 0,
        'BAD_ARGUMENT',
        'Use exact archive content pins.',
      );
      const key = `v1/p/${input.projectId}/archives/${input.id}/a/${input.digest}`;
      const original = await ctx.runQuery(internal.projectBackups.get, { id: input.id, owner: user.subject });
      invariant(
        original.backup.projectId === input.projectId &&
          original.backup.digest === input.digest &&
          original.backup.size === input.size &&
          original.backup.location === 'r2' &&
          original.backup.r2Key === key,
        'INVALID_WORK_BACKUP',
        'Original archive reservation changed.',
      );
      invariant(
        await verifyArchiveUpload({ ...input, r2Key: key }),
        'R2_OBJECT_MISSING',
        'Uploaded archive is missing.',
      );
      return await ctx.runMutation(internal.projectBackups.completeR2, {
        id: input.id,
        owner: user.subject,
        key,
        expected: { digest: input.digest, size: input.size },
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const sign = mutation({
  args: { id: v.id('projectBackups'), digest: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      data: v.bytes(),
      direct: v.literal(true),
      url: v.string(),
      size: v.number(),
      digest: v.string(),
      filename: v.string(),
    }),
  ),
  handler: async (ctx, { id, digest }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const backup = await ctx.db.get(id);
      invariant(backup, 'PROJECT_UNAVAILABLE', 'This Forge backup is unavailable.');
      await accessibleProject(ctx, backup.projectId, user.subject);
      invariant(
        backup.transport !== 'objects' && backup.status === 'stored' && backup.digest === digest,
        'PROJECT_CHANGED',
        'Select the original stored archive and digest.',
      );
      if (backup.location !== 'r2' || !backup.r2Committed || !backup.r2Key) return null;
      return {
        data: new ArrayBuffer(0),
        direct: true as const,
        url: await presignGet(r2Config(), backup.r2Key),
        size: backup.size,
        digest,
        filename: `forge-backup-${backup.operationId}.tar.gz`,
      };
    } catch (error) {
      return report(error);
    }
  },
});
