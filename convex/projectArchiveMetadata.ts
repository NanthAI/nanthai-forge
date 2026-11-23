// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { createHash } from 'node:crypto';
import type { ActionCtx } from './_generated/server';
import { archiveSource } from './r2ArchiveSource';
import { derivedArtifact, derivedBytes } from './derivedArtifactActions';
import { exchangeRequest } from '../src/exchange-request';
import { invariant } from '../src/errors';
import { workArchiveMetadata } from '../src/work-archive-metadata';
import { encodeWorkMetadataSidecar, decodeWorkMetadataSidecar } from './workMetadataSidecar';
import { noteStorageRead } from './storageMeter';

// Call only after the owning backup/proposal has passed its current access check.
// The storage URL stays inside this action; final owner/grant checks remain at callers.
async function readOriginalMetadata(
  ctx: ActionCtx,
  storageId: string,
  size: number,
  digest: string,
  checkAccess: () => Promise<unknown>,
) {
  const source = await archiveSource(ctx, storageId);
  const metadata = source.metadata;
  const actualDigest =
    metadata &&
    (/^[0-9a-f]{64}$/.test(metadata.sha256)
      ? metadata.sha256
      : Buffer.from(metadata.sha256, 'base64').toString('hex'));
  invariant(
    metadata && metadata.size === size && actualDigest === digest,
    'INVALID_WORK_BACKUP',
    'Stored source and Work bytes differ from their original archive pins.',
  );
  const url = await source.getUrl();
  invariant(url, 'INVALID_WORK_BACKUP', 'Stored source and Work are unavailable.');
  await checkAccess();
  // Read the complete response once. Decode only the metadata prefix and hash
  // the entire compressed stream without buffering the source or evidence.
  return exchangeRequest(
    'archive metadata download',
    url,
    { headers: { 'accept-encoding': 'identity' } },
    async (response, progressed) => {
      try {
        const length = response.headers.get('content-length');
        invariant(
          response.ok &&
            response.body &&
            (length === null || (/^\d+$/.test(length) && Number(length) === size)),
          'INVALID_WORK_BACKUP',
          'Stored source and Work are unavailable or incomplete.',
        );
        noteStorageRead(ctx, size);
        const hash = createHash('sha256');
        let received = 0;
        const result = await workArchiveMetadata(response.body, undefined, progressed, chunk => {
          received += chunk.length;
          invariant(received <= size, 'INVALID_WORK_BACKUP', 'Stored archive exceeds its pinned size.');
          hash.update(chunk);
        });
        invariant(
          received === size && hash.digest('hex') === digest,
          'INVALID_WORK_BACKUP',
          'Downloaded archive differs from its original pin.',
        );
        return result;
      } finally {
        if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
      }
    },
    { retries: 1 },
  );
}

// Exact UTF-8 metadata bytes are retained, including unknown Work fields. The
// original full archive remains authoritative for recovery and every other member.
export async function projectArchiveMetadata(
  ctx: ActionCtx,
  storageId: string,
  size: number,
  digest: string,
  checkAccess: () => Promise<unknown>,
  cache = true,
) {
  if (!cache || storageId.startsWith('r2archive:'))
    return readOriginalMetadata(ctx, storageId, size, digest, checkAccess);
  const source = await archiveSource(ctx, storageId);
  if (source.purged) return readOriginalMetadata(ctx, storageId, size, digest, checkAccess);
  const file = source.metadata;
  const actual =
    file &&
    (/^[0-9a-f]{64}$/.test(file.sha256) ? file.sha256 : Buffer.from(file.sha256, 'base64').toString('hex'));
  invariant(
    file && file.size === size && actual === digest,
    'INVALID_WORK_BACKUP',
    'Stored source and Work bytes differ from their original archive pins.',
  );
  let original: Awaited<ReturnType<typeof readOriginalMetadata>> | undefined;
  const cached = await derivedArtifact(
    ctx,
    storageId,
    'work-metadata-v3',
    '',
    async () => {
      original = await readOriginalMetadata(ctx, storageId, size, digest, checkAccess);
      return encodeWorkMetadataSidecar(original);
    },
    checkAccess,
  );
  await checkAccess();
  if (original) return original;
  invariant(cached, 'INVALID_WORK_BACKUP', 'Stored source and Work are unavailable.');
  return decodeWorkMetadataSidecar(await derivedBytes(ctx, cached));
}
