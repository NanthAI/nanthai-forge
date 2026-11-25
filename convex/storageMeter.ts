// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Bytes one action read from object storage, as its callers note them with `noteStorageRead`.
 * Diagnostics only; never an access decision. */
export type StorageMeter = { reads: number; bytes: number };
const meters = new WeakMap<object, StorageMeter>();

/** The same context, registered so a caller can note its R2 reads against it. */
export function meteredStorage<Ctx extends object>(ctx: Ctx): Ctx {
  if (meters.has(ctx)) return ctx;
  const metered = { ...ctx };
  meters.set(metered, { reads: 0, bytes: 0 });
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
