// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { ForgeError } from '../src/errors';
import { projectPrefix } from './r2Operations';
import { ATTACHMENT_LIMITS } from '../src/discussion-attachment-limits';

/** The R2 namespace of one comment's attachments; the download route resolves the same one. */
export const namespaceOf = (projectId: string, itemId: string, commentId: string) =>
  `${projectPrefix(projectId)}discussion/${itemId}/${commentId}`;

/** Bytes a project stores as discussion attachments, against the owner-approved 1 GB (Issue 9a3d6f5f, comment
 * ce9bcd01). One counter row per project in `gitWorkerUsage` (no new table), under a scope no daily row shares and a
 * day key no clean-up sweep reaches. A byte is counted when its binding is reserved and given back when the binding is
 * removed (convex/artifactStorage.ts removeArtifact), so an abandoned upload or a purge frees the room. */
const scopeOf = (projectId: string) => `attachments-stored:${projectId}`;
const day = 'total';
const row = (ctx: Pick<MutationCtx, 'db'>, projectId: string) =>
  ctx.db
    .query('gitWorkerUsage')
    .withIndex('by_scope_and_day', q => q.eq('scope', scopeOf(projectId)).eq('day', day))
    .unique();

export async function chargeStored(
  ctx: Pick<MutationCtx, 'db'>,
  projectId: Id<'hostedProjects'>,
  bytes: number,
) {
  const current = await row(ctx, projectId);
  if ((current?.bytes ?? 0) + bytes > ATTACHMENT_LIMITS.projectBytes)
    throw new ForgeError(
      'QUOTA_EXCEEDED',
      `This project stores at most ${ATTACHMENT_LIMITS.projectBytes / 1_000_000_000} GB of discussion attachments and has ${Math.max(0, ATTACHMENT_LIMITS.projectBytes - (current?.bytes ?? 0))} bytes left. Nothing was reserved.`,
    );
  if (current) await ctx.db.patch(current._id, { packs: current.packs + 1, bytes: current.bytes + bytes });
  else await ctx.db.insert('gitWorkerUsage', { scope: scopeOf(projectId), day, packs: 1, bytes });
}

/** Gives back the bytes of a removed discussion binding; any other namespace is not counted here. */
export async function refundStored(ctx: Pick<MutationCtx, 'db'>, binding: Doc<'artifactBlobs'>) {
  const owner = /^v1\/p\/([^/]+)\/discussion\//.exec(binding.namespace)?.[1];
  const projectId = owner ? ctx.db.normalizeId('hostedProjects', owner) : null;
  const current = projectId ? await row(ctx, projectId) : null;
  if (current)
    await ctx.db.patch(current._id, {
      packs: Math.max(0, current.packs - 1),
      bytes: Math.max(0, current.bytes - binding.size),
    });
}
