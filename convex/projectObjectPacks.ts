// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { isStored } from './projectObjectFields';
import { findObject } from './projectObjectFind';
import { invariant } from '../src/errors';
import { r2Key, presignPut, type R2Config, type R2PutTarget } from './r2';
import { checkObjectSize } from './abuseLimits';
import { uploadPackLayout, type UploadPackProposal } from '../src/object-pack-upload';

export const uploadPackProposal = v.object({
  digest: v.string(),
  size: v.number(),
  members: v.array(v.number()),
});
export type PackedObject = {
  id: Id<'projectObjects'>;
  stored: false;
  created: boolean;
  contentType: string;
  pack: { digest: string; size: number; offset: number };
};
/** Prepare one upload pack (feature upload-packs). Eligible only when every member is new (no row)
 * or a pending upload, and the pack itself is new or pending: then one pending pack row holds the
 * member list and one create-only, checksum-bound PUT target, and no member row is written. A
 * stored member (its bytes would be kept twice) or a stored pack returns null, and the caller
 * prepares each object as before. Member rows are written by the commit after it read the pack and
 * checked each member digest (`bindPackMembers`), so an unverified member never dedupes. */
export async function preparePack(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  objects: readonly { digest: string; size: number }[],
  proposal: UploadPackProposal,
  r2: R2Config,
): Promise<{ byDigest: Map<string, PackedObject>; target: R2PutTarget; reserved: number[] } | null> {
  const layout = uploadPackLayout(objects, proposal),
    reserved: number[] = [],
    fresh = new Set<string>();
  for (const member of layout) {
    const row = await findObject(ctx, projectId, member.digest);
    invariant(
      !row || (row.size === member.size && !row.removed),
      'INVALID_WORK_BACKUP',
      'Content differs from its original binding.',
    );
    if (row && (isStored(row) || row.location !== 'r2')) return null;
    if (!row) {
      checkObjectSize(member.size);
      reserved.push(member.size);
      fresh.add(member.digest);
    }
  }
  const found = await findObject(ctx, projectId, proposal.digest);
  if (found && (found._id === undefined || found.removed || isStored(found) || found.location !== 'r2'))
    return null;
  invariant(!found || found.size === proposal.size, 'INVALID_WORK_BACKUP', 'Pack size differs.');
  const packMembers = layout.map(({ digest, size }) => ({ digest, size }));
  // A retry of the same pack was charged when it was first prepared.
  if (found && JSON.stringify(found.packMembers) === JSON.stringify(packMembers)) reserved.length = 0;
  let id: Id<'projectObjects'>;
  if (!found)
    id = await ctx.db.insert('projectObjects', {
      projectId,
      digest: proposal.digest,
      size: proposal.size,
      nonce: crypto.randomUUID(),
      removed: false,
      location: 'r2' as const,
      r2Key: r2Key(projectId, proposal.digest),
      r2PreparedAt: Date.now(),
      packMembers,
    });
  else {
    id = found._id;
    await ctx.db.patch(id, {
      packMembers,
      r2PreparedAt: Date.now(),
      // A key under storage maintenance is never reused: a replayed DELETE could remove the new copy.
      ...(found.r2SweepKey === found.r2Key || !found.r2Key?.startsWith(r2Key(projectId, proposal.digest))
        ? { r2Key: `${r2Key(projectId, proposal.digest)}/u/${crypto.randomUUID()}` }
        : {}),
    });
  }
  const pack = (await ctx.db.get(id))!,
    target = await presignPut(r2, pack.r2Key!, { digest: proposal.digest, size: proposal.size }),
    byDigest = new Map<string, PackedObject>();
  for (const member of layout)
    byDigest.set(member.digest, {
      id,
      stored: false,
      created: fresh.has(member.digest),
      contentType: `application/x-forge-object-${pack.nonce}`,
      pack: { digest: proposal.digest, size: proposal.size, offset: member.offset },
    });
  return { byDigest, target, reserved };
}

/** Write the member rows of a pack the commit read and checked (each digest matched its bytes),
 * in the same transaction that marks the pack committed. A member stored meanwhile keeps its row
 * (these pack bytes for it are then unused); a pending member upload is bound to the pack. */
export async function bindPackMembers(
  ctx: MutationCtx,
  pack: { projectId: Id<'hostedProjects'>; digest: string; size: number; r2Key: string },
  members: readonly { digest: string; size: number }[],
) {
  let offset = 0;
  for (const member of members) {
    const binding = {
      location: 'r2' as const,
      r2Key: pack.r2Key,
      r2Committed: true,
      pack: { digest: pack.digest, size: pack.size, offset },
    };
    offset += member.size;
    const row = await findObject(ctx, pack.projectId, member.digest);
    if (!row)
      await ctx.db.insert('projectObjects', {
        projectId: pack.projectId,
        digest: member.digest,
        size: member.size,
        nonce: crypto.randomUUID(),
        removed: false,
        ...binding,
      });
    else if (
      row._id !== undefined &&
      !row.removed &&
      !isStored(row) &&
      row.size === member.size &&
      row.location === 'r2'
    )
      await ctx.db.patch(row._id, binding);
  }
}
