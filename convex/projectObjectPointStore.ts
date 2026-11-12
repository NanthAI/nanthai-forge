// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { ObjectView } from './projectObjectFind';
import { clearObjectCatalogCache } from './projectObjectFind';
import { pointBinding, pointObject } from './projectObjectPointBinding';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { retainSourceKey } from './projectSourceKeyProtection';

/** One caller-bounded page. Publish exact bindings before retiring any source
 * descriptor. Pending uploads, ancestry and mutable State metadata stay rows. */
export async function storePointObjects(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  objects: readonly ObjectView[],
) {
  let bytes = 0,
    readBytes = 0,
    written = 0;
  const carriers = new Map<string, number>();
  for (const object of objects) {
    invariant(
      object.projectId === projectId,
      'SOURCE_HASH_MISMATCH',
      'Source point belongs to another project.',
    );
    const key = `source-point:${projectId}:${object.digest}`,
      sourceBinding = pointBinding(object);
    const old = await ctx.db
      .query('projectObjectReceipts')
      .withIndex('by_key', q => q.eq('key', key))
      .unique();
    if (old) {
      readBytes += new TextEncoder().encode(JSON.stringify(old)).length;
      const prior = pointObject(old, projectId, object.digest);
      invariant(
        prior.size === object.size &&
          canonicalPayload(pointBinding(prior)) === canonicalPayload(sourceBinding) &&
          (object.stateGeneration === undefined ||
            prior.stateGeneration === undefined ||
            object.stateGeneration === prior.stateGeneration) &&
          (object.stateSize === undefined ||
            prior.stateSize === undefined ||
            canonicalPayload(object.stateSize) === canonicalPayload(prior.stateSize)),
        'SOURCE_HASH_MISMATCH',
        'Immutable source point binding changed.',
      );
    }
    const value = {
      projectId,
      key,
      value: object.digest,
      size: object.size,
      nonce: old?.nonce ?? object.nonce,
      sourceBinding,
      ...(object.stateGeneration === undefined && old?.stateGeneration === undefined
        ? {}
        : { stateGeneration: object.stateGeneration ?? old?.stateGeneration }),
      ...(object.stateSize === undefined && old?.stateSize === undefined
        ? {}
        : { stateSize: object.stateSize ?? old?.stateSize }),
    };
    // A member point alone cannot be found by the carrier's digest. Retain
    // one whole-key proof before its dense or full descriptor disappears.
    if (object.pack && object.r2Key) {
      invariant(
        !carriers.has(object.r2Key) || carriers.get(object.r2Key) === object.pack.size,
        'SOURCE_HASH_MISMATCH',
        'Shared source carrier size changed.',
      );
      if (!carriers.has(object.r2Key))
        await retainSourceKey(ctx, projectId, {
          sha256: object.digest,
          size: object.size,
          r2Key: object.r2Key,
          pack: object.pack,
        });
      carriers.set(object.r2Key, object.pack.size);
    }
    if (
      old &&
      canonicalPayload({ ...old, _id: undefined, _creationTime: undefined }) === canonicalPayload(value)
    )
      continue;
    if (old) await ctx.db.replace(old._id, value);
    else await ctx.db.insert('projectObjectReceipts', value);
    bytes += new TextEncoder().encode(JSON.stringify(value)).length;
    written++;
  }
  if (written) await ctx.db.insert('projectCheckLogSourcePins', { projectId, digest: objects[0]!.digest });
  clearObjectCatalogCache(ctx);
  return { bytes, readBytes, written };
}
/** A direct bulk catalog producer can retain its bounded page format. It must
 * reopen fallback before writing any dense page after point completion. */
export async function retainCatalogFallback(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const header = await ctx.db
    .query('projectObjectReceipts')
    .withIndex('by_key', q => q.eq('key', `source-points:${projectId}`))
    .unique();
  if (header?.projectId === projectId && header.value === '2') await ctx.db.patch(header._id, { value: '1' });
  clearObjectCatalogCache(ctx);
}
