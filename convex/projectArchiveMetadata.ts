// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { archiveSource } from './r2ArchiveSource';
import { derivedArtifact, derivedBytes } from './derivedArtifactActions';
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
  // Streamed on purpose: a Node action's storage.get buffers the whole archive.
  const response = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
  try {
    const length = response.headers.get('content-length');
    invariant(
      response.ok && response.body && (length === null || (/^\d+$/.test(length) && Number(length) === size)),
      'INVALID_WORK_BACKUP',
      'Stored source and Work are unavailable or incomplete.',
    );
    noteStorageRead(ctx, size);
    return await workArchiveMetadata(response.body);
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
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
  r2 = false,
) {
  if (!cache) return readOriginalMetadata(ctx, storageId, size, digest, checkAccess);
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
    'work-metadata-v2',
    '',
    async () => {
      original = await readOriginalMetadata(ctx, storageId, size, digest, checkAccess);
      return encodeWorkMetadataSidecar(original);
    },
    checkAccess,
    r2,
  );
  await checkAccess();
  if (original) return original;
  invariant(cached, 'INVALID_WORK_BACKUP', 'Stored source and Work are unavailable.');
  return decodeWorkMetadataSidecar(await derivedBytes(ctx, cached));
}
