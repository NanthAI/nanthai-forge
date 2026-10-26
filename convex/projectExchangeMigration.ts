// SPDX-License-Identifier: Apache-2.0
'use node';
import { deleteR2Object } from './r2Operations';
import { r2Config } from './r2';
import { portableCheckPath } from '../src/check-log-policy';
import { parseWorkBytes } from '../src/work-metadata';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { objectBytes } from './projectExchangeActions';
import { projectArchiveMetadata } from './projectArchiveMetadata';
import { nativeManifestSchema } from '../src/work-archive-metadata';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { report } from './errors';
export const migrate = action({
  args: {
    backupId: v.id('projectBackups'),
    operationId: v.string(),
    originalDigest: v.string(),
    manifestDigest: v.string(),
    manifestSize: v.number(),
  },
  returns: v.object({
    backupId: v.id('projectBackups'),
    manifestDigest: v.string(),
    originalArchiveDigest: v.string(),
    retired: v.boolean(),
  }),
  handler: async (
    ctx,
    input,
  ): Promise<{
    backupId: Id<'projectBackups'>;
    manifestDigest: string;
    originalArchiveDigest: string;
    retired: boolean;
  }> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to migrate your retained native archive.');
      const { backup, project } = await ctx.runQuery(internal.projectBackups.get, {
        id: input.backupId,
        owner: user.subject,
      });
      invariant(
        project.owner === user.subject &&
          backup.digest === input.originalDigest &&
          backup.status === 'stored' &&
          backup.preview.format === 'native' &&
          (backup.transport === 'objects' || backup.storageId),
        'INVALID_WORK_BACKUP',
        'Select your exact stored native archive.',
      );
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Retain the original migration UUID.',
      );
      const retire = async () => {
        const result = await ctx.runMutation(internal.projectExchange.retireArchive, {
          backupId: input.backupId,
          owner: user.subject,
          operationId: input.operationId,
        });
        const retained = (
          await ctx.runQuery(internal.projectBackups.get, { id: input.backupId, owner: user.subject })
        ).backup.archiveReceipt;
        if (result.retired && retained?.r2Key && retained.r2Committed) {
          await deleteR2Object(r2Config(), retained.r2Key);
          await ctx.runMutation(internal.projectExchange.retireArchiveR2, {
            backupId: input.backupId,
            owner: user.subject,
            operationId: input.operationId,
            key: retained.r2Key,
          });
        }
        return result;
      };
      if (backup.transport === 'objects') {
        invariant(
          backup.archiveReceipt?.operationId === input.operationId &&
            backup.objectManifest?.digest === input.manifestDigest &&
            backup.objectManifest.size === input.manifestSize,
          'WORK_OPERATION_CHANGED',
          'Reconcile the original completed archive migration.',
        );
        return retire();
      }
      const bytes = await objectBytes(ctx, project._id, user.subject, {
        sha256: input.manifestDigest,
        size: input.manifestSize,
      });
      const original = await projectArchiveMetadata(
        ctx,
        backup.storageId!,
        backup.size,
        backup.digest,
        () => ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: user.subject }),
        true,
        project.r2Writes ?? false,
      );
      invariant(
        digest(original.manifest) === input.manifestDigest && bytes.equals(Buffer.from(original.manifest)),
        'INVALID_WORK_BACKUP',
        'Migration must retain the exact original manifest bytes.',
      );
      const manifest = nativeManifestSchema.parse(JSON.parse(bytes.toString('utf8'))),
        file = manifest.files.find(file => file.path === 'work.json');
      invariant(
        file && digest(original.work) === file.sha256 && original.work.byteLength === file.size,
        'INVALID_WORK_BACKUP',
        'Original Work differs from its manifest.',
      );
      const data = parseWorkBytes(original.work);
      const unique = [
        ...new Map(
          manifest.files.filter(file => portableCheckPath(data, file.path)).map(file => [file.sha256, file]),
        ).values(),
      ];
      for (let offset = 0; offset < unique.length; offset += 100) {
        const pins = unique.slice(offset, offset + 100),
          rows: Doc<'projectObjects'>[] = await ctx.runQuery(internal.projectObjects.resolve, {
            projectId: project._id,
            actor: user.subject,
            digests: pins.map(file => file.sha256),
          });
        invariant(
          rows.every((row, index) => row.size === pins[index]!.size),
          'INVALID_WORK_BACKUP',
          'Migration omitted or changed an original logical member.',
        );
      }
      await ctx.runMutation(internal.projectExchange.migrateArchive, {
        ...input,
        owner: user.subject,
        originalStorageId: backup.storageId!,
      });
      return retire();
    } catch (error) {
      return report(error);
    }
  },
});
