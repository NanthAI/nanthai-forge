// SPDX-License-Identifier: Apache-2.0
import type { StorageActionWriter, StorageReader } from 'convex/server';
import { v } from 'convex/values';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { exchangeRequest } from '../src/exchange-request';
import { invariant } from '../src/errors';
import type { SourceStepClock } from '../src/source-step-clock';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalQuery, type ActionCtx, type QueryCtx } from './_generated/server';
import { presignGet, r2Config } from './r2';

type Reader = { storage: StorageReader };
type ByteReader = { storage: StorageActionWriter };
type TombstoneReader = Partial<Pick<ActionCtx, 'runQuery'>> & Partial<Pick<QueryCtx, 'db'>>;

const copyFields = {
  digest: v.string(),
  size: v.number(),
  copyKey: v.string(),
  operationId: v.string(),
  contentType: v.optional(v.string()),
};
const copyValidator = v.object(copyFields);
type Copy = typeof copyValidator.type;

export async function lookupLegacyCopy(
  { db }: Pick<QueryCtx, 'db'>,
  storageId: string,
): Promise<Copy | null> {
  const row = await db
    .query('legacyStorageTombstones')
    .withIndex('by_storage', q => q.eq('storageId', storageId as Id<'_storage'>))
    .unique();
  if (!row) return null;
  invariant(
    /^[a-f0-9]{64}$/.test(row.digest) &&
      Number.isSafeInteger(row.size) &&
      row.size >= 0 &&
      /^v1\/p\/[a-z0-9]+\/o\/[a-f0-9]{64}$/.test(row.copyKey) &&
      row.copyKey.endsWith('/' + row.digest),
    'BLOB_DIGEST_MISMATCH',
    'Retired file has an invalid copy pin.',
  );
  const { digest, size, copyKey, operationId, contentType } = row;
  return { digest, size, copyKey, operationId, ...(contentType === undefined ? {} : { contentType }) };
}

export const tombstone = internalQuery({
  args: { storageId: v.string() },
  returns: v.union(v.null(), copyValidator),
  handler: (ctx, { storageId }) => lookupLegacyCopy(ctx, storageId),
});

function findCopy(ctx: TombstoneReader, storageId: string) {
  if (ctx.db) return lookupLegacyCopy({ db: ctx.db }, storageId);
  return ctx.runQuery?.(internal.legacyStorageRead.tombstone, { storageId }) ?? null;
}

// Transport wrappers use the raw primitives so byte meters count only Convex egress,
// retries surround the original I/O, and a caller performs the fallback at most once.
export const nativeLegacyBlob = (ctx: ByteReader, id: string) => ctx.storage.get(id);
export const nativeLegacyMetadata = (ctx: Reader, id: string) => ctx.storage.getMetadata(id);
export const nativeLegacyUrl = (ctx: Reader, id: string) => ctx.storage.getUrl(id);

function observed(storageId: string, copy: Copy) {
  console.info('legacy_storage_read_through', { storageId, operationId: copy.operationId });
}

export async function verifyLegacyCopy(
  copy: Pick<Copy, 'digest' | 'size' | 'copyKey'>,
  retain?: (part: Uint8Array<ArrayBuffer>) => void,
  clock?: SourceStepClock,
) {
  return exchangeRequest(
    'Retired file download',
    await presignGet(r2Config(), copy.copyKey),
    { headers: { 'accept-encoding': 'identity' }, redirect: 'error' },
    async (response, progressed) => {
      invariant(response.ok, 'R2_OBJECT_UNAVAILABLE', 'Retired file copy is unavailable.');
      const hash = sha256.create();
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            invariant(
              size <= copy.size,
              'BLOB_DIGEST_MISMATCH',
              'Retired file copy exceeds its pinned size.',
            );
            hash.update(part.value);
            retain?.(part.value);
            progressed();
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      invariant(
        size === copy.size && bytesToHex(hash.digest()) === copy.digest,
        'BLOB_DIGEST_MISMATCH',
        'Retired file copy differs from its pin.',
      );
    },
    { retries: 0, onAttempt: clock && (() => clock.request('gets')) },
  );
}

async function copyBlob(storageId: string, copy: Copy, clock?: SourceStepClock): Promise<Blob> {
  observed(storageId, copy);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  await verifyLegacyCopy(copy, part => parts.push(part), clock);
  return new Blob(parts, { type: copy.contentType });
}

/** Callers must authorize the legacy id before reading, as for native storage. */
export async function legacyBlob(
  ctx: ByteReader & TombstoneReader,
  storageId: string,
  clock?: SourceStepClock,
) {
  const file = await nativeLegacyBlob(ctx, storageId);
  if (file) return file;
  const lookup = async () => findCopy(ctx, storageId);
  const copy = await (clock ? clock.call(lookup) : lookup());
  return copy ? copyBlob(storageId, copy, clock) : null;
}

/** Callers authorize the legacy id and receivers verify bytes against their pin. */
export async function legacyUrl(ctx: Reader & TombstoneReader, storageId: string) {
  const url = await nativeLegacyUrl(ctx, storageId);
  if (url !== null) return url;
  const copy = await findCopy(ctx, storageId);
  if (!copy) return null;
  const signed = await presignGet(r2Config(), copy.copyKey);
  observed(storageId, copy);
  return signed;
}

/** Transactional callers can use the immutable pin; byte reads verify the copy again. */
export async function legacyMetadata(ctx: Reader & TombstoneReader, storageId: string) {
  const file = await nativeLegacyMetadata(ctx, storageId);
  if (file) return file;
  const copy = await findCopy(ctx, storageId);
  if (!copy) return null;
  observed(storageId, copy);
  return { storageId, sha256: copy.digest, size: copy.size, contentType: copy.contentType ?? null };
}

/** Internal derivation and cleanup use Convex's system metadata shape. */
export async function legacySystemMetadata(ctx: Pick<QueryCtx, 'db'>, storageId: Id<'_storage'>) {
  const file = await ctx.db.system.get(storageId);
  if (file) return file;
  const copy = await lookupLegacyCopy(ctx, storageId);
  if (!copy) return null;
  observed(storageId, copy);
  return { _id: storageId, sha256: copy.digest, size: copy.size, contentType: copy.contentType };
}
