// SPDX-License-Identifier: Apache-2.0
import { findStoredObject, findSourceObjects } from './projectObjectFind';
import { r2ObjectKey } from './r2';
import type { QueryCtx } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { pointObject } from './projectObjectPointBinding';
import { invariant } from '../src/errors';
import type { CatalogObject } from './projectObjectFind';
/** Exact whole-key liveness without another index on every upload. Raw and
 * metadata carriers resolve by digest; compacted member packs retain one exact
 * whole-key proof in the existing receipt-key index before losing their rows. */
export async function sourceKeyReferenced(ctx: QueryCtx, projectId: Id<'hostedProjects'>, key: string) {
  const physical = r2ObjectKey(projectId, key);
  if (!physical) return false;
  if (await retainedSourceKey(ctx, projectId, key)) return true;
  const object = await findStoredObject(ctx, projectId, physical.digest);
  if (object && !object.removed && object.sourceReferenced && object.r2Committed && object.r2Key === key)
    return true;
  const retained = (await findSourceObjects(ctx, projectId, [physical.digest])).get(physical.digest);
  return retained?.r2Key === key;
}

/** A verified source placement can share its logical hash with an unrelated
 * pending upload pack. Keep its whole key live without committing that pack's
 * unverified members or changing the primary upload identity. */
export async function retainSourceKey(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  pin: { sha256: string; size: number; r2Key: string; pack?: import('../src/object-pack-range').ObjectPack },
) {
  const key = `source-key:${projectId}:${pin.r2Key}`;
  const old = await ctx.db
    .query('projectObjectReceipts')
    .withIndex('by_key', q => q.eq('key', key))
    .unique();
  const sourceBinding = { r2Key: pin.r2Key, ...(pin.pack ? { pack: pin.pack } : {}) };
  const value = { projectId, key, value: pin.sha256, size: pin.size, sourceBinding };
  pointObject(value as Doc<'projectObjectReceipts'>, projectId, pin.sha256);
  if (old) {
    const prior = pointObject(old, projectId, old.value);
    invariant(
      prior.r2Key === pin.r2Key && (prior.pack?.size ?? prior.size) === (pin.pack?.size ?? pin.size),
      'SOURCE_HASH_MISMATCH',
      'Retained whole source key changed.',
    );
  } else await ctx.db.insert('projectObjectReceipts', value);
}

/** A retained member also proves its checksum-verified whole carrier. This is
 * used only when a producer needs an exact older key, never another nonce copy. */
export async function retainedSourceKey(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  key: string,
): Promise<CatalogObject | null> {
  const physical = r2ObjectKey(projectId, key);
  if (!physical) return null;
  const [receipt] = await ctx.db
    .query('projectObjectReceipts')
    .withIndex('by_key', q => q.eq('key', `source-key:${projectId}:${key}`))
    .take(1);
  if (!receipt) return null;
  const stored = pointObject(receipt, projectId, receipt.value);
  invariant(stored.r2Key === key, 'SOURCE_HASH_MISMATCH', 'Retained source key binding changed.');
  return {
    projectId,
    digest: physical.digest,
    size: stored.pack?.size ?? stored.size,
    nonce: '',
    removed: false,
    sourceReferenced: true,
    location: 'r2',
    r2Committed: true,
    r2Key: key,
  };
}
