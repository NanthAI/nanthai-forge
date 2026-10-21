// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { blobStore } from './blobStore';
import type { Id } from './_generated/dataModel';
import { exchangeRequest } from '../src/exchange-request';
import { invariant } from '../src/errors';
import { noteStorageRead } from './storageMeter';

// URLs remain action-private. Call after owning authorization, then recheck before
// reading and after returning at the caller. Never materialize the entire Blob.
export async function projectArchivePart(
  ctx: ActionCtx,
  storageId: Id<'_storage'>,
  size: number,
  digest: string,
  offset: number,
  checkAccess: () => Promise<unknown>,
  errorCode: 'INVALID_WORK_BACKUP' | 'INVALID_ARTIFACT' = 'INVALID_WORK_BACKUP',
  contentType?: (value: string) => void,
): Promise<ArrayBuffer> {
  const metadata = await blobStore(ctx).getMetadata(storageId);
  const actualDigest =
    metadata &&
    (/^[0-9a-f]{64}$/.test(metadata.sha256)
      ? metadata.sha256
      : Buffer.from(metadata.sha256, 'base64').toString('hex'));
  invariant(
    metadata && metadata.size === size && actualDigest === digest,
    errorCode,
    'Stored archive bytes differ from their original size/digest.',
  );
  if (size === 0 && offset === 0) {
    await checkAccess();
    if (contentType) contentType((await blobStore(ctx).get(storageId))?.type ?? '');
    return new ArrayBuffer(0);
  }
  // Ranged on purpose: a Node action's storage.get buffers the whole Blob and
  // would transfer all of it again for every part.
  const url = await blobStore(ctx).getUrl(storageId);
  invariant(url, errorCode, 'Stored archive is unavailable.');
  await checkAccess();
  const end = Math.min(size, offset + 2 * 1024 * 1024),
    length = end - offset;
  return exchangeRequest(
    'Convex archive range download',
    url,
    { headers: { Range: `bytes=${offset}-${end - 1}` } },
    async (response, progressed) => {
      contentType?.(response.headers.get('content-type')?.toLowerCase() ?? '');
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        invariant(
          response.body && (response.status === 200 || response.status === 206),
          errorCode,
          'Stored archive transfer is unavailable.',
        );
        const partial = response.status === 206,
          expected = partial ? length : size,
          contentLength = response.headers.get('content-length');
        invariant(
          contentLength === null || (/^\d+$/.test(contentLength) && Number(contentLength) === expected),
          errorCode,
          'Stored archive transfer has a different length.',
        );
        if (partial) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
          invariant(
            range && Number(range[1]) === offset && Number(range[2]) === end - 1 && Number(range[3]) === size,
            errorCode,
            'Stored archive transfer has different source offsets.',
          );
        }
        // Range-less storage responses are consumed incrementally, discarding their
        // prefix. Retain only the requested bytes and cancel the unused suffix.
        const data = new Uint8Array(length),
          start = partial ? 0 : offset,
          stop = start + length;
        reader = response.body.getReader();
        let position = 0,
          copied = 0;
        while (position < stop) {
          const part = await reader.read();
          invariant(!part.done, errorCode, 'Stored archive transfer ended before the requested bytes.');
          if (part.value.byteLength) progressed();
          const next = position + part.value.byteLength;
          invariant(next <= expected, errorCode, 'Stored archive transfer exceeds its original size.');
          const from = Math.max(position, start),
            to = Math.min(next, stop);
          if (to > from) {
            data.set(part.value.subarray(from - position, to - position), copied);
            copied += to - from;
          }
          position = next;
        }
        if (partial || end === size) {
          const tail = await reader.read();
          invariant(tail.done, errorCode, 'Stored archive transfer exceeds its original size.');
        }
        invariant(copied === length, errorCode, 'Stored archive transfer is incomplete.');
        noteStorageRead(ctx, position);
        return data.buffer;
      } finally {
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        } else if (response.body && !response.body.locked)
          await response.body.cancel().catch(() => undefined);
      }
    },
    { retries: 1 },
  );
}
