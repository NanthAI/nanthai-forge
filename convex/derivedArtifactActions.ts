// SPDX-License-Identifier: Apache-2.0
'use node';
import { randomUUID } from 'node:crypto';
import { blobStore } from './blobStore';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
type Derived = Doc<'derivedArtifacts'>;
export const hexDigest = (value: string) =>
  /^[0-9a-f]{64}$/.test(value) ? value : Buffer.from(value, 'base64').toString('hex');
async function reconciled(ctx: ActionCtx, row: Derived): Promise<Derived | null> {
  let cursor: string | null = null;
  while (true) {
    const page: { storageId: string | null; isDone: boolean; cursor: string } = await ctx.runQuery(
      internal.derivedArtifacts.uploadPage,
      { id: row._id, cursor },
    );
    if (page.storageId)
      return ctx.runMutation(internal.derivedArtifacts.attach, { id: row._id, storageId: page.storageId });
    if (page.isDone) return null;
    cursor = page.cursor;
  }
}
// Cache keys bind original storage metadata and derivative format/pin. Permissions
// remain current owning-action checks, never stored cache eligibility or authority.
export async function derivedArtifact(
  ctx: ActionCtx,
  original: string,
  kind: string,
  pin: string,
  build: () => Promise<Blob | string>,
  checkAccess: () => Promise<unknown>,
): Promise<Derived | null> {
  const file = await blobStore(ctx).getMetadata(original);
  invariant(file, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
  const key = { original, kind, pin },
    originalDigest = hexDigest(file.sha256);
  const found: Derived | null = await ctx.runQuery(internal.derivedArtifacts.get, key);
  if (found && found.originalDigest === originalDigest && found.originalSize === file.size) {
    const valid = found.storageId ? await blobStore(ctx).getMetadata(found.storageId) : null;
    if (
      (found.inline !== undefined &&
        digest(found.inline) === found.digest &&
        Buffer.byteLength(found.inline) === found.size) ||
      (valid && valid.size === found.size && hexDigest(valid.sha256) === found.digest)
    )
      return found;
    if (
      !found.storageId &&
      found.uploadType &&
      !found.uploadType.startsWith('application/x-forge-derived-r2-')
    ) {
      const stored = await reconciled(ctx, found);
      if (stored) return stored;
    }
  }
  await checkAccess();
  const value = await build();
  await checkAccess();
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(await value.arrayBuffer());
  const input = {
    ...key,
    originalDigest,
    originalSize: file.size,
    digest: digest(bytes),
    size: bytes.length,
    removed: false,
    contentType: typeof value === 'string' ? 'application/json' : value.type,
    ...(typeof value === 'string'
      ? { inline: value }
      : {
          uploadType: `application/x-forge-derived-r2-${randomUUID()}`,
        }),
  };
  // Reconcile a lost reservation reply before beginning any storage side effect.
  let row: Derived | null;
  try {
    row = await ctx.runMutation(internal.derivedArtifacts.reserve, {
      ...input,
      ...(found ? { replace: found._id } : {}),
    });
  } catch (error) {
    row = await ctx.runQuery(internal.derivedArtifacts.get, key);
    if (!row || row.digest !== input.digest) throw error;
  }
  if (!row || row.inline !== undefined || row.storageId) return row;
  let storageId: string;
  try {
    storageId = await blobStore(ctx).store(new Blob([bytes], { type: row.uploadType! }), {
      r2Namespace: `v1/d/${row._id}`,
    });
  } catch (error) {
    if (!row.uploadType!.startsWith('application/x-forge-derived-r2-')) {
      const stored = await reconciled(ctx, row);
      if (stored) return stored;
    }
    // A deterministic reservation reconciles by the same R2 key on retry.
    throw error;
  }
  try {
    return await ctx.runMutation(internal.derivedArtifacts.attach, { id: row._id, storageId });
  } catch (error) {
    const observed: Derived | null = await ctx.runQuery(internal.derivedArtifacts.get, key);
    if (observed?.storageId === storageId) return observed;
    await ctx.runMutation(internal.derivedArtifacts.discard, { id: row._id, storageId });
    throw error;
  }
}
export async function derivedBytes(ctx: ActionCtx, record: Derived): Promise<Uint8Array> {
  const blob = record.storageId ? await blobStore(ctx).get(record.storageId) : null;
  invariant(record.inline !== undefined || blob, 'INVALID_ARTIFACT', 'Derived source bytes are unavailable.');
  const bytes =
    record.inline !== undefined ? Buffer.from(record.inline) : new Uint8Array(await blob!.arrayBuffer());
  invariant(
    bytes.byteLength === record.size && digest(bytes) === record.digest,
    'INVALID_ARTIFACT',
    'Derived source bytes are unavailable.',
  );
  return bytes;
}
