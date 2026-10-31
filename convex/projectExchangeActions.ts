// SPDX-License-Identifier: Apache-2.0
'use node';

import { ConvexError, v } from 'convex/values';
import { storeProjectArtifact } from './projectArtifactActions';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Id, Doc } from './_generated/dataModel';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';

import { projectArchivePart } from './projectArchivePart';
import { isStored, isR2Object } from './projectObjectFields';
import { report } from './errors';
import { exchangeObjectReader, bytesFromRow, type ExchangeObjectReader } from './projectExchangeReader';
import { resolveExchangeRoot, isExchangeRoot } from '../src/native-exchange-tree';

import { CUTOVER_UPGRADE } from '../src/cutover-version';
import type { ObjectView } from './projectObjectFind';

async function caller(ctx: ActionCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
  return user.subject;
}
export async function objectBytes(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  pin: { sha256: string; size: number },
  reader = exchangeObjectReader(ctx, true),
) {
  const [bytes] = await reader.read(projectId, actor, [pin]);
  return bytes!;
}
const downloadReply = v.union(
  v.object({ data: v.bytes(), digest: v.string(), size: v.number() }),
  v.object({ direct: v.literal(true), digest: v.string(), size: v.number() }),
);
type DownloadReply = { digest: string; size: number } & ({ data: ArrayBuffer } | { direct: true });
const directReply = (row: ObjectView): DownloadReply => ({
  direct: true,
  digest: row.digest,
  size: row.size,
});
export const downloadBatch = action({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.array(downloadReply),
  handler: async (ctx, { projectId, digests }): Promise<DownloadReply[]> => {
    try {
      const actor = await caller(ctx);
      invariant(
        digests.length <= 8,
        'BAD_ARGUMENT',
        'Read small content in batches of at most eight; larger content uses ranged downloads.',
      );
      const rows: ObjectView[] = await ctx.runQuery(internal.projectObjects.resolve, {
        projectId,
        actor,
        digests,
      });
      invariant(
        rows.reduce((sum, row) => sum + row.size, 0) <= 2 * 1024 * 1024,
        'BAD_ARGUMENT',
        'Use ranged downloads for content larger than the small-content batch.',
      );
      const result = await Promise.all(
        rows.map(async row => {
          if (isR2Object(row) || !row.storageId) return directReply(row);
          return {
            data: new Uint8Array(await bytesFromRow(ctx, row, { sha256: row.digest, size: row.size }, actor))
              .buffer,
            digest: row.digest,
            size: row.size,
          };
        }),
      );
      await ctx.runQuery(internal.projectObjects.resolve, { projectId, actor, digests });
      return result;
    } catch (error) {
      return report(error);
    }
  },
});

export async function objectByteBatch(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  pins: { sha256: string; size: number }[],
  reader = exchangeObjectReader(ctx, true),
) {
  return reader.read(projectId, actor, pins);
}
export async function exchangeMetadata(
  ctx: ActionCtx,
  backup: Doc<'projectBackups'>,
  actor: string,
  reader: ExchangeObjectReader = exchangeObjectReader(ctx, true),
) {
  const root = await objectBytes(
    ctx,
    backup.projectId,
    actor,
    {
      sha256: backup.objectManifest?.digest ?? backup.digest,
      size: backup.objectManifest?.size ?? backup.size,
    },
    reader,
  );
  return resolveExchangeRoot(root, pins => reader.read(backup.projectId, actor, pins), { batchSize: 100 });
}
async function cacheLogicalMetadata(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  bytes: Buffer,
) {
  await storeProjectArtifact(ctx, projectId, actor, bytes);
}
const publicationFields = {
  authorityEpoch: v.optional(v.number()),
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  previous: v.union(v.id('projectBackups'), v.null()),
  digest: v.string(),
  size: v.number(),
  deferHistory: v.optional(v.boolean()),
  retainCandidate: v.optional(v.boolean()),
};
// Compatibility endpoints perform no source, metadata or storage IO.
export const published = action({
  args: publicationFields,
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const publish = action({
  args: {
    ...publicationFields,
    continuation: v.optional(v.boolean()),
    metadataOnly: v.optional(v.literal(1)),
    displayProtocol: v.optional(v.number()),
    ownerDerived: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
const checkpointReply = v.object({
  json: v.string(),
  digest: v.string(),
  size: v.number(),
  sourceDigest: v.string(),
});
async function checkpointBytes(ctx: ActionCtx, backupId: Id<'projectBackups'>) {
  const actor = await caller(ctx),
    { backup } = await ctx.runQuery(internal.projectBackups.get, { id: backupId, owner: actor });
  invariant(
    backup.transport === 'objects',
    'BAD_ARGUMENT',
    'This checkpoint uses a legacy archive; use its existing download command.',
  );
  const bytes = await objectBytes(ctx, backup.projectId, actor, {
    sha256: backup.objectManifest?.digest ?? backup.digest,
    size: backup.objectManifest?.size ?? backup.size,
  });
  return { actor, backup, bytes };
}
export const checkpoint = action({
  args: { backupId: v.id('projectBackups') },
  returns: checkpointReply,
  handler: async (
    ctx,
    { backupId },
  ): Promise<{ json: string; digest: string; size: number; sourceDigest: string }> => {
    try {
      const { backup, bytes } = await checkpointBytes(ctx, backupId);
      return {
        json: bytes.toString('utf8'),
        digest: digest(bytes),
        size: bytes.length,
        sourceDigest: backup.digest,
      };
    } catch (error) {
      return report(error);
    }
  },
});
// Existing clients explicitly requesting the old endpoint receive the original
// logical files. Full metadata objects are cached only for this compatibility path.
export const manifest = action({
  args: { backupId: v.id('projectBackups') },
  returns: checkpointReply,
  handler: async (
    ctx,
    { backupId },
  ): Promise<{ json: string; digest: string; size: number; sourceDigest: string }> => {
    try {
      const { actor, backup, bytes } = await checkpointBytes(ctx, backupId);
      if (!isExchangeRoot(JSON.parse(bytes.toString('utf8'))))
        return {
          json: bytes.toString('utf8'),
          digest: digest(bytes),
          size: bytes.length,
          sourceDigest: backup.digest,
        };
      const logical = await resolveExchangeRoot(
        bytes,
        pins => objectByteBatch(ctx, backup.projectId, actor, pins),
        { batchSize: 100 },
      );
      await cacheLogicalMetadata(ctx, backup.projectId, actor, logical.work);
      await cacheLogicalMetadata(ctx, backup.projectId, actor, logical.manifest);
      await ctx.runQuery(internal.projectBackups.get, { id: backupId, owner: actor });
      return {
        json: logical.manifest.toString('utf8'),
        digest: digest(logical.manifest),
        size: logical.manifest.length,
        sourceDigest: backup.digest,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const downloadPart = action({
  args: { projectId: v.id('hostedProjects'), digest: v.string(), offset: v.number() },
  returns: downloadReply,
  handler: async (ctx, { projectId, digest, offset }): Promise<DownloadReply> => {
    try {
      const actor = await caller(ctx),
        rows: ObjectView[] = await ctx.runQuery(internal.projectObjects.resolve, {
          projectId,
          actor,
          digests: [digest],
        });
      const row = rows[0]!;
      invariant(
        isStored(row) &&
          Number.isSafeInteger(offset) &&
          offset >= 0 &&
          (offset < row.size || (offset === 0 && row.size === 0)),
        'BAD_ARGUMENT',
        'Use an offset inside the selected content.',
      );
      // Recipes can contain mixed Convex/R2 leaves: resolve them in the client, too.
      if (isR2Object(row) || !row.storageId) return directReply(row);
      const data =
        row.size === 0
          ? new ArrayBuffer(0)
          : await projectArchivePart(ctx, row.storageId, row.size, digest, offset, () =>
              ctx.runQuery(internal.projectObjects.resolve, { projectId, actor, digests: [digest] }),
            );
      await ctx.runQuery(internal.projectObjects.resolve, { projectId, actor, digests: [digest] });
      return { data, digest, size: row.size };
    } catch (error) {
      return report(error);
    }
  },
});

/** Completion validates the same immutable manifest; it never moves hosted Work,
 * overwrites hosted edits, changes the source generation or rewinds a newer push. */
export const completeHistory = action({
  args: { backupId: v.id('projectBackups') },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
