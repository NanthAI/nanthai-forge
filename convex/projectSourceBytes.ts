// SPDX-License-Identifier: Apache-2.0
import { convexFetch, networkTimeout } from './networkFetch';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { r2Config, r2Key, presignPut, headObject, checksumOf } from './r2';
import { invariant } from '../src/errors';
import { SourceIoError, transientSourceStatus } from '../src/hosted-source-io-error';
import { retryR2Lag } from '../src/hosted-r2-retry';

/** One byte-write seam for trusted source producers in either Convex runtime. Bytes go
 * to R2 only; the `storageId` result shape remains for callers that still read legacy rows.
 * The caller supplies hash-pinned bytes. R2 enforces the signed checksum on the create-only PUT.
 * A 200 that echoes that exact SHA-256 checksum is R2's own confirmation that this key now holds
 * exactly these bytes (the checksum fixes the size too), so no HEAD follows. A 412 (the key already
 * existed), or a reply without the echo, is confirmed by HEAD before the owning transaction
 * publishes it. */
export async function storeSourceBytes(
  _ctx: Pick<ActionCtx, 'storage'>,
  projectId: Id<'hostedProjects'> | null,
  bytes: Uint8Array,
  pin: { sha256: string; size: number },
  reuse = false,
  created?: (wrote: boolean) => void,
  observe?: (event: 'put' | 'refused' | 'reused', pin: { sha256: string; size: number }) => void,
): Promise<{ storageId: Id<'_storage'> } | { r2Key: string }> {
  invariant(bytes.length === pin.size, 'SOURCE_HASH_MISMATCH', 'Source output size changed.');
  invariant(projectId, 'SOURCE_JOB_INVALID', 'R2 source needs its exact project binding.');
  const config = r2Config(),
    key = r2Key(projectId, pin.sha256);
  const matches = (head: Awaited<ReturnType<typeof headObject>>) =>
    head.status === 'ok' && head.size === pin.size && head.checksum === checksumOf(pin.sha256);
  if (reuse) {
    const existing = await headObject(config, key, true);
    if (matches(existing)) {
      observe?.('reused', pin);
      return { r2Key: key };
    }
    invariant(existing.status === 'missing', 'R2_VERIFY_FAILED', 'Existing source binding differs.');
  }
  const target = await presignPut(config, key, { digest: pin.sha256, size: pin.size });
  let response: Response;
  observe?.('put', pin);
  try {
    response = await convexFetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: new Uint8Array(bytes),
      redirect: 'error',
      signal: networkTimeout(20_000),
    });
  } catch (error) {
    throw new SourceIoError(error, 'source-put', pin.sha256);
  }
  if (response.status === 412) observe?.('refused', pin);
  if (transientSourceStatus(response.status))
    throw new SourceIoError(null, 'source-put', pin.sha256, response.status);
  invariant(response.ok || response.status === 412, 'R2_UPLOAD_FAILED', 'Source upload failed.');
  await response.body?.cancel().catch(() => {});
  if (response.status === 200 && response.headers.get('x-amz-checksum-sha256') === checksumOf(pin.sha256))
    return { r2Key: key };
  // Our own PUT was acknowledged, so a 404 here is read-after-write lag: retry it
  // within the shared bound. Mismatch or any other answer fails at once.
  invariant(
    matches(
      await retryR2Lag(
        () => headObject(config, key, true),
        head => head.status === 'missing',
      ),
    ),
    'R2_VERIFY_FAILED',
    'Exact source size and checksum were not confirmed.',
  );
  // true: this PUT wrote the object; false (412): it already existed and may belong to another writer.
  created?.(response.status !== 412);
  return { r2Key: key };
}

/** Action-local attempted bodies, not a billed-meter estimate. A refused body
 * is already included in its category and counted separately as overlap. */
export function sourcePutMetrics() {
  type Kind = 'state' | 'progress' | 'other';
  const entries: { kind: Kind; sha256: string; size: number }[] = [];
  let refused = 0,
    avoided = 0;
  return {
    observer:
      (kind: Kind) => (event: 'put' | 'refused' | 'reused', pin: { sha256: string; size: number }) => {
        if (event === 'put') entries.push({ kind, ...pin });
        else if (event === 'refused') refused += pin.size;
        else avoided += pin.size;
      },
    avoid: (size: number) => {
      avoided += size;
    },
    snapshot: (result?: { sha256: string } | null) => {
      const totals = { state: 0, progress: 0, result: 0, other: 0, refused, avoided };
      for (const entry of entries)
        totals[entry.kind === 'other' && entry.sha256 === result?.sha256 ? 'result' : entry.kind] +=
          entry.size;
      return totals;
    },
  };
}
