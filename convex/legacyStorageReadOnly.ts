// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { activeStoragePause, storageMutationAvailable } from './legacyStoragePause';
import { invariant } from '../src/errors';
/** Some freshly signed reads are registered as mutations. Preserve those reads
 * while refusing every writer/scheduler method in their transactional context. */
function reader<T extends object>(value: T, reads: string[]): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver);
      if (typeof member !== 'function') return member;
      if (reads.includes(String(key))) return member.bind(target);
      return () =>
        invariant(
          false,
          'LEGACY_STORAGE_WRITES_PAUSED',
          'Dev writes are temporarily paused for approved storage maintenance.',
        );
    },
  });
}
export async function storageMutationContext(ctx: MutationCtx): Promise<MutationCtx> {
  if (!activeStoragePause()) {
    await storageMutationAvailable(ctx);
    return ctx;
  }
  const ports = new Map<PropertyKey, unknown>();
  return new Proxy(ctx, {
    get(target, key, receiver) {
      const reads =
        key === 'db'
          ? ['get', 'query', 'normalizeId']
          : key === 'storage'
            ? ['get', 'getUrl', 'getMetadata']
            : key === 'scheduler'
              ? []
              : null;
      if (!reads) return Reflect.get(target, key, receiver);
      if (!ports.has(key)) ports.set(key, reader(Reflect.get(target, key, receiver), reads));
      return ports.get(key);
    },
  });
}
