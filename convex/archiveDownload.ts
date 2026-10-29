// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { ActionCtx } from './_generated/server';
import { archiveSource } from './r2ArchiveSource';
import { presignGet, r2Config } from './r2';
import { storageDigest } from './storageDigest';
import { invariant } from '../src/errors';
export const directDownloadFields = { direct: v.optional(v.boolean()), url: v.optional(v.string()) };
export type DirectDownload = { data: ArrayBuffer; direct?: boolean; url?: string };
type Archive = {
  storageId?: string;
  location?: string;
  r2Committed?: boolean;
  r2Key?: string;
  size: number;
  digest: string;
};
/** Owning authorization and pin checks precede this call. Only committed R2
 * bindings issue URLs; legacy Convex bytes retain their old action-only path. */
export async function archiveDownload(ctx: ActionCtx, row: Archive): Promise<DirectDownload | null> {
  if (row.location === 'r2' && row.r2Committed && row.r2Key)
    return { data: new ArrayBuffer(0), direct: true, url: await presignGet(r2Config(), row.r2Key) };
  if (!row.storageId) return null;
  const source = await archiveSource(ctx, row.storageId);
  if (!source.direct) return null;
  invariant(
    source.metadata &&
      source.metadata.size === row.size &&
      storageDigest(source.metadata.sha256) === row.digest,
    'INVALID_ARTIFACT',
    'Stored archive differs from its exact content pins.',
  );
  const url = await source.getUrl();
  invariant(url, 'INVALID_ARTIFACT', 'Stored archive is unavailable.');
  return { data: new ArrayBuffer(0), direct: true, url };
}
