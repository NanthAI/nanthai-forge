// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import {
  internalQuery,
  internalMutation,
  internalAction,
  type QueryCtx,
  type MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { artifactBlobId } from './artifactBlobFields';
import { r2Config, headObject, checksumOf, presignDelete } from './r2';
import { invariant } from '../src/errors';
import { exchangeFetch } from '../src/exchange-request';

/** Trusted committed metadata for internal derivation/cleanup transactions. Access
 * remains the owning action's responsibility, just as for legacy storage IDs. */
export async function artifactMetadata(ctx: Pick<QueryCtx, 'db'>, ref: string) {
  const id = artifactBlobId(ref);
  if (!id) return ctx.db.system.get(ref as Id<'_storage'>);
  const row = await ctx.db.get(id);
  return row && row.committed && !row.removed
    ? {
        _id: ref,
        _creationTime: row._creationTime,
        size: row.size,
        sha256: row.digest,
        contentType: row.contentType,
      }
    : null;
}
export const get = internalQuery({
  args: { ref: v.string() },
  returns: v.any(),
  handler: async (ctx, { ref }) => {
    const id = artifactBlobId(ref);
    if (!id) return null;
    const row = await ctx.db.get(id);
    return row && !row.removed ? row : null;
  },
});
/** Shared reservation for atomic owning transactions; metadata only. */
export async function reserveArtifact(
  ctx: MutationCtx,
  input: { namespace: string; digest: string; size: number; contentType: string },
) {
  invariant(
    /^[a-f0-9]{64}$/.test(input.digest) && Number.isSafeInteger(input.size) && input.size >= 0,
    'INVALID_ARTIFACT',
    'Use exact artifact content pins.',
  );
  const existing = await ctx.db
    .query('artifactBlobs')
    .withIndex('by_namespace_and_digest', q => q.eq('namespace', input.namespace).eq('digest', input.digest))
    .unique();
  if (existing) {
    invariant(
      !existing.removed && existing.size === input.size && existing.contentType === input.contentType,
      'INVALID_ARTIFACT',
      'Artifact differs from its original binding.',
    );
    return existing;
  }
  const id = await ctx.db.insert('artifactBlobs', {
    ...input,
    r2Key: `${input.namespace}/a/${input.digest}`,
    committed: false,
    removed: false,
  });
  return (await ctx.db.get(id))!;
}
export const reserve = internalMutation({
  args: { namespace: v.string(), digest: v.string(), size: v.number(), contentType: v.string() },
  returns: v.any(),
  handler: (ctx, input) => reserveArtifact(ctx, input),
});
export const commit = internalAction({
  args: { ref: v.string() },
  returns: v.null(),
  handler: async (ctx, { ref }): Promise<null> => {
    const row = await ctx.runQuery(internal.artifactStorage.get, { ref });
    invariant(row, 'INVALID_ARTIFACT', 'Original artifact binding is unavailable.');
    if (row.committed) return null;
    const head = await headObject(r2Config(), row.r2Key);
    invariant(head.status !== 'missing', 'R2_OBJECT_MISSING', 'Uploaded artifact is missing.');
    invariant(head.status === 'ok', 'R2_VERIFY_FAILED', 'Object storage could not confirm the artifact.');
    invariant(head.size === row.size, 'R2_OBJECT_SIZE_MISMATCH', 'Uploaded artifact size differs.');
    invariant(
      !head.checksum || head.checksum === checksumOf(row.digest),
      'R2_OBJECT_CHECKSUM_MISMATCH',
      'Uploaded artifact checksum differs.',
    );
    await ctx.runMutation(internal.artifactStorage.markCommitted, { ref });
    return null;
  },
});
export const markCommitted = internalMutation({
  args: { ref: v.string() },
  returns: v.null(),
  handler: async (ctx, { ref }) => {
    const id = artifactBlobId(ref),
      row = id ? await ctx.db.get(id) : null;
    invariant(row && !row.removed, 'INVALID_ARTIFACT', 'Original artifact binding is unavailable.');
    if (!row.committed) await ctx.db.patch(row._id, { committed: true });
    return null;
  },
});
// Deletion follows the existing owning resource's explicit cleanup. A durable
// tombstone prevents an interrupted upload from resurrecting a removed artifact.
export const remove = internalMutation({
  args: { ref: v.string() },
  returns: v.null(),
  handler: async (ctx, { ref }) => {
    const id = artifactBlobId(ref),
      row = id ? await ctx.db.get(id) : null;
    if (row && !row.removed) {
      await ctx.db.patch(row._id, { removed: true });
      await ctx.scheduler.runAfter(0, internal.artifactStorage.deleteBytes, { ref });
    }
    return null;
  },
});
export const deleteBytes = internalAction({
  args: { ref: v.string() },
  returns: v.null(),
  handler: async (ctx, { ref }): Promise<null> => {
    const row = await ctx.runQuery(internal.artifactStorage.removed, { ref });
    if (!row) return null;
    const response = await exchangeFetch('R2 artifact cleanup', await presignDelete(r2Config(), row.r2Key), {
      method: 'DELETE',
    });
    invariant(
      response.ok || response.status === 404,
      'R2_DELETE_FAILED',
      'Object storage could not remove the artifact.',
    );
    return null;
  },
});
export const removed = internalQuery({
  args: { ref: v.string() },
  returns: v.any(),
  handler: async (ctx, { ref }) => {
    const id = artifactBlobId(ref),
      row = id ? await ctx.db.get(id) : null;
    return row?.removed ? row : null;
  },
});
