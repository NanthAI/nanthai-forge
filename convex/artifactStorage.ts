// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  internalAction,
  type ActionCtx,
  type QueryCtx,
  type MutationCtx,
} from './server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { artifactBlobId } from './artifactBlobFields';
import { refundStored } from './discussionAttachmentStored';
import { cancelPendingTask } from './schedulerCancel';
import { r2Config, headObject, checksumOf, presignDelete, putExpiry } from './r2';
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
    // The caller signs an upload for an uncommitted binding; a removal keeps its delete open past that signature.
    if (!existing.committed) await ctx.db.patch(existing._id, { signedAt: Date.now() });
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
    if (!row) await refuseRemoved(ctx, ref);
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
    try {
      await ctx.runMutation(internal.artifactStorage.markCommitted, { ref });
    } catch (error) {
      await refuseRemoved(ctx, ref);
      throw error;
    }
    return null;
  },
});

/** The commit of an upload that started before its binding was removed (a purge, or the owner's cleanup): the bytes it
 * just put must not outlive the removal, so it deletes them before refusing, and arms the durable retry if that delete
 * fails. Returns when the binding is not removed (the caller's own refusal stands). */
async function refuseRemoved(ctx: Pick<ActionCtx, 'runQuery' | 'runMutation'>, ref: string) {
  const row: Doc<'artifactBlobs'> | null = await ctx.runQuery(internal.artifactStorage.removed, { ref });
  if (!row) return;
  const response = await exchangeFetch('R2 artifact cleanup', await presignDelete(r2Config(), row.r2Key), {
    method: 'DELETE',
  }).catch(() => null);
  if (!response || !(response.ok || response.status === 404))
    await ctx.runMutation(internal.artifactStorage.rearmDelete, { ref });
  invariant(false, 'INVALID_ARTIFACT', 'Original artifact binding is unavailable.');
}
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
/** An upload signed for a binding (at its reservation, or `signedAt` for a later one) can start until its signature
 * expires (convex/r2.ts putExpiry, plus a minute, as convex/projectLaneSnapshotDrop.ts) and, once started, run to the
 * ten-minute action limit. A removed binding is gone only after a delete that starts once this window has passed,
 * committed or not: a second create-only PUT can recreate the key after the first upload's bytes were deleted. */
const uploadWindowMs = (putExpiry + 60) * 1000 + 10 * 60_000;
const uploadEnds = (row: Doc<'artifactBlobs'>) =>
  Math.max(row._creationTime, row.signedAt ?? 0) + uploadWindowMs;
/** Retry delay after a failed or unconfirmed delete: one minute, doubling, at most six hours. */
export const deleteRetryMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, 6 * 3_600_000);

// Deletion follows the existing owning resource's explicit cleanup. A durable tombstone prevents an interrupted upload
// from resurrecting a removed artifact, and the row tracks its R2 delete until it succeeds: every attempt is scheduled
// from a mutation together with the retry that follows it unless the attempt confirms the delete, so a failed,
// crashed or lost attempt is retried with a bounded backoff. Nothing is scheduled once the bytes are gone, so idle
// costs no calls. `pendingDeletes` counts the rows still waiting.
export async function removeArtifact(
  { db, scheduler }: Pick<MutationCtx, 'db' | 'scheduler'>,
  row: Doc<'artifactBlobs'>,
) {
  if (row.removed) return;
  await refundStored({ db }, row);
  const after = uploadEnds(row);
  await armDelete({ db, scheduler }, row, 0, after > Date.now() ? after : undefined);
}

/** Schedule one delete attempt now and the retry after it (the row is removed in the same write). */
async function armDelete(
  { db, scheduler }: Pick<MutationCtx, 'db' | 'scheduler'>,
  row: Doc<'artifactBlobs'>,
  attempts: number,
  after: number | undefined,
) {
  const ref = `r2blob:${row._id}`;
  await scheduler.runAfter(0, internal.artifactStorage.deleteBytes, { ref, attempts });
  const delay = Math.max(deleteRetryMs(attempts), (after ?? 0) - Date.now());
  const task = await scheduler.runAfter(delay, internal.artifactStorage.retryDelete, { ref, attempts });
  await db.patch(row._id, { removed: true, deleteAttempts: attempts, deleteTask: task, deleteAfter: after });
}

export const remove = internalMutation({
  args: { ref: v.string() },
  returns: v.null(),
  handler: async (ctx, { ref }) => {
    const id = artifactBlobId(ref),
      row = id ? await ctx.db.get(id) : null;
    if (row) await removeArtifact(ctx, row);
    return null;
  },
});
/** The retry: a no-op once the delete it follows was confirmed (or a newer retry replaced it). */
export const retryDelete = internalMutation({
  args: { ref: v.string(), attempts: v.number() },
  returns: v.null(),
  handler: async (ctx, { ref, attempts }) => {
    const id = artifactBlobId(ref),
      row = id ? await ctx.db.get(id) : null;
    if (row?.removed && row.deleteAttempts === attempts)
      await armDelete(ctx, row, attempts + 1, row.deleteAfter);
    return null;
  },
});
/** A refused commit whose own delete failed (its bytes landed now), or a delivery scheduled before deletes were
 * tracked: only a delete that starts after now, and after the upload window, is final. */
export const rearmDelete = internalMutation({
  args: { ref: v.string() },
  returns: v.null(),
  handler: async (ctx, { ref }) => {
    const id = artifactBlobId(ref),
      row = id ? await ctx.db.get(id) : null;
    if (!row?.removed) return null;
    await cancelPendingTask(ctx, row.deleteTask);
    await armDelete(ctx, row, 0, Math.max(row.deleteAfter ?? 0, uploadEnds(row), Date.now()));
    return null;
  },
});
/** A confirmed delete that started at `startedAt` ends the tracking, unless an upload could still land after it. */
export const deleted = internalMutation({
  args: { ref: v.string(), startedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { ref, startedAt }) => {
    const id = artifactBlobId(ref),
      row = id ? await ctx.db.get(id) : null;
    if (!row || row.deleteAttempts === undefined || (row.deleteAfter ?? 0) > startedAt) return null;
    // The project-prefix purge owns the bytes now; the retry stays armed (at its backoff) until that purge removes
    // this row, so a blocked or abandoned project purge still leaves it counted.
    if (await projectRemoving(ctx, row)) return null;
    await cancelPendingTask(ctx, row.deleteTask);
    await ctx.db.patch(row._id, { deleteAttempts: undefined, deleteTask: undefined, deleteAfter: undefined });
    return null;
  },
});
export const deleteBytes = internalAction({
  // `attempts` is absent on a delivery scheduled before deletes were tracked.
  args: { ref: v.string(), attempts: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { ref, attempts }): Promise<null> => {
    const startedAt = Date.now();
    const row: Doc<'artifactBlobs'> | null = await ctx.runQuery(internal.artifactStorage.removed, { ref });
    // An untracked delivery tracks the row first; the attempt that schedules does the delete, with its retry armed.
    if (row && attempts === undefined && row.deleteAttempts === undefined) {
      await ctx.runMutation(internal.artifactStorage.rearmDelete, { ref });
      return null;
    }
    // A failed delete throws; the retry scheduled with this attempt runs it again.
    if (row) {
      const response = await exchangeFetch(
        'R2 artifact cleanup',
        await presignDelete(r2Config(), row.r2Key),
        {
          method: 'DELETE',
        },
      );
      invariant(
        response.ok || response.status === 404,
        'R2_DELETE_FAILED',
        'Object storage could not remove the artifact.',
      );
    }
    // Also when the project-prefix purge owns the bytes (`removed` defers to it): `deleted` keeps the row tracked.
    await ctx.runMutation(internal.artifactStorage.deleted, { ref, startedAt });
    return null;
  },
});
/** Removed bindings whose R2 delete is not yet confirmed, for the operator: how many (at most 1,000 counted), and the
 * most retries any of them has had. One bounded index read, only when asked. */
export const pendingDeletes = internalQuery({
  args: {},
  returns: v.object({ pending: v.number(), more: v.boolean(), mostAttempts: v.number() }),
  handler: async ctx => {
    const rows = await ctx.db
      .query('artifactBlobs')
      .withIndex('by_delete_attempts', q => q.gte('deleteAttempts', 0))
      .order('desc')
      .take(1_001);
    return {
      pending: Math.min(rows.length, 1_000),
      more: rows.length > 1_000,
      mostAttempts: rows[0]?.deleteAttempts ?? 0,
    };
  },
});
/** The binding's project is being deleted: its guarded project-prefix purge owns the bytes. */
async function projectRemoving(ctx: Pick<QueryCtx, 'db'>, row: Doc<'artifactBlobs'>) {
  const owner = /^v1\/p\/([^/]+)\//.exec(row.namespace)?.[1];
  const projectId = owner ? ctx.db.normalizeId('hostedProjects', owner) : null;
  const removal = projectId ? (await ctx.db.get(projectId))?.removal : undefined;
  return removal === 'deleting' || removal === 'deleted';
}
export const removed = internalQuery({
  args: { ref: v.string() },
  returns: v.any(),
  handler: async (ctx, { ref }) => {
    const id = artifactBlobId(ref),
      row = id ? await ctx.db.get(id) : null;
    if (!row?.removed) return null;
    // Old per-archive cleanup tasks must defer to the guarded project-prefix purge.
    return (await projectRemoving(ctx, row)) ? null : row;
  },
});
