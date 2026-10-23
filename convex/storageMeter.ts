// SPDX-License-Identifier: Apache-2.0
import type { StorageActionWriter } from 'convex/server';
import type { Id } from './_generated/dataModel';

/** Storage bytes one action read: Blob sizes from ctx.storage.get plus bytes a
 * caller notes for its own transfers. Diagnostics only; never an access decision. */
export type StorageMeter = { reads: number; bytes: number };
const meters = new WeakMap<object, StorageMeter>();

export function meteredStorage<Ctx extends { storage: StorageActionWriter }>(ctx: Ctx): Ctx {
  if (meters.has(ctx)) return ctx;
  const meter = { reads: 0, bytes: 0 };
  const metered = {
    ...ctx,
    storage: {
      ...ctx.storage,
      get: async (id: Id<'_storage'>) => {
        const blob = await ctx.storage.get(id);
        if (blob) {
          meter.reads++;
          meter.bytes += blob.size;
        }
        return blob;
      },
    },
  };
  meters.set(metered, meter);
  return metered;
}
export function storageMeter(ctx: object): StorageMeter {
  return meters.get(ctx) ?? { reads: 0, bytes: 0 };
}
export function noteStorageRead(ctx: object, bytes: number, reads = 1) {
  const meter = meters.get(ctx);
  if (!meter) return;
  meter.reads += reads;
  meter.bytes += bytes;
}
