// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { blobStore } from './blobStore';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { exchangeFetch } from '../src/exchange-request';
import { invariant } from '../src/errors';
import { digest } from '../src/hash';
import { storageDigest } from './projectStorage';
import { isR2Object } from './projectObjectFields';
import { r2Config, presignGet } from './r2';
import {
  objectRecipeSchema,
  objectChunkPageSchema,
  readObjectRecipe,
  objectChunkBytes,
  objectChunkPageBytes,
  type ChunkPin,
} from '../src/object-chunks';

/** Raw bytes live in Convex storage or a committed R2 object (not a recipe). */
export const isRaw = (row: Doc<'projectObjects'>) => !!row.storageId || isR2Object(row);
/** Where raw bytes are cached by identity. */
export const rawKey = (row: Doc<'projectObjects'>) => row.storageId ?? row.r2Key;

/** Server-side read of an R2 object by signed GET. Used only where Convex itself needs the bytes
 * (publication, derived views); clients read R2 directly. Verifies size and sha256. */
async function r2Content(row: Doc<'projectObjects'>, pin: ChunkPin) {
  const url = await presignGet(r2Config(), row.r2Key!);
  const response = await exchangeFetch(
    'server R2 object download',
    url,
    { headers: { 'accept-encoding': 'identity' } },
    { retries: 1 },
  );
  invariant(
    response.ok,
    'R2_OBJECT_UNAVAILABLE',
    `Stored content is unavailable in object storage (HTTP ${response.status}).`,
  );
  const data = Buffer.from(await response.arrayBuffer());
  invariant(
    data.length === pin.size && digest(data) === pin.sha256,
    'BLOB_DIGEST_MISMATCH',
    'Stored content differs from its digest.',
  );
  return data;
}

export async function rawMetadata(ctx: ActionCtx, row: Doc<'projectObjects'>, pin: ChunkPin) {
  if (isR2Object(row)) {
    // Existence and bytes are proven by the verified read itself; there is no separate metadata read.
    invariant(
      row.size === pin.size && row.digest === pin.sha256,
      'INVALID_WORK_BACKUP',
      'Stored content size differs from its checkpoint.',
    );
    return;
  }
  invariant(
    row.size === pin.size && row.storageId && row.digest === pin.sha256,
    'INVALID_WORK_BACKUP',
    'Stored content size differs from its checkpoint.',
  );
  const value = await blobStore(ctx).getMetadata(row.storageId);
  invariant(
    value && value.size === row.size && storageDigest(value.sha256) === row.digest,
    'INVALID_WORK_BACKUP',
    'Stored content differs from its digest.',
  );
}
export async function rawContent(ctx: ActionCtx, row: Doc<'projectObjects'>, pin: ChunkPin) {
  if (isR2Object(row)) return r2Content(row, pin);
  const blob = await blobStore(ctx).get(row.storageId!);
  invariant(blob, 'INVALID_WORK_BACKUP', 'Stored content is unavailable.');
  const bytes = Buffer.from(await blob.arrayBuffer());
  invariant(
    bytes.length === pin.size && digest(bytes) === pin.sha256,
    'INVALID_WORK_BACKUP',
    'Stored content differs from its original bytes.',
  );
  return bytes;
}
type RawReader = typeof rawContent;

async function resolved(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  pin: ChunkPin,
  ancestors: ReadonlySet<string>,
  raw: RawReader,
): Promise<Buffer> {
  const args = { projectId, actor, digests: [pin.sha256] };
  const rows: Doc<'projectObjects'>[] = await ctx.runQuery(internal.projectObjects.resolve, args);
  const bytes = await objectContent(ctx, rows[0]!, pin, actor, ancestors, raw);
  await ctx.runQuery(internal.projectObjects.resolve, args);
  return bytes;
}
export async function recipeContent(
  ctx: ActionCtx,
  row: Doc<'projectObjects'>,
  actor: string,
  ancestors: ReadonlySet<string> = new Set(),
  raw: RawReader = rawContent,
) {
  invariant(
    row.recipe && row.recipe.size <= objectChunkPageBytes && !ancestors.has(row.digest),
    'INVALID_WORK_BACKUP',
    'Stored recipe ancestry is invalid.',
  );
  const next = new Set(ancestors);
  next.add(row.digest);
  const read = (pin: ChunkPin) => resolved(ctx, row.projectId, actor, pin, next, raw);
  const bytes = await read({ sha256: row.recipe.digest, size: row.recipe.size });
  const recipe = objectRecipeSchema.parse(JSON.parse(bytes.toString('utf8')));
  invariant(
    recipe.object.sha256 === row.digest && recipe.object.size === row.size,
    'INVALID_WORK_BACKUP',
    'Stored recipe differs from its logical content binding.',
  );
  return { recipe, read };
}
export async function objectContent(
  ctx: ActionCtx,
  row: Doc<'projectObjects'>,
  pin: ChunkPin,
  actor: string,
  ancestors: ReadonlySet<string> = new Set(),
  raw: RawReader = rawContent,
): Promise<Buffer> {
  invariant(
    row && row.size === pin.size && row.digest === pin.sha256,
    'INVALID_WORK_BACKUP',
    'Stored content size differs from its checkpoint.',
  );
  if (isRaw(row)) {
    await rawMetadata(ctx, row, pin);
    return raw(ctx, row, pin);
  }
  const { recipe, read } = await recipeContent(ctx, row, actor, ancestors, raw),
    parts: Buffer[] = [];
  for await (const part of readObjectRecipe(recipe, read)) parts.push(part);
  return Buffer.concat(parts);
}
/** A bound recipe has already proved the full hash. A ranged read verifies all
 * fetched nodes and leaves, and retains at most the existing 2 MiB response. */
export async function objectRange(
  ctx: ActionCtx,
  row: Doc<'projectObjects'>,
  actor: string,
  offset: number,
  length = 2 * 1024 * 1024,
): Promise<ArrayBuffer> {
  const { recipe, read } = await recipeContent(ctx, row, actor),
    end = Math.min(row.size, offset + length),
    result = new Uint8Array(end - offset);
  invariant(
    recipe.tree.length === row.size,
    'INVALID_WORK_BACKUP',
    'Chunk recipe length differs from its original content.',
  );
  let copied = 0;
  const visit = async (ref: typeof recipe.tree, start: number): Promise<void> => {
    if (start >= end || start + ref.length <= offset) return;
    invariant(
      ref.size <= (ref.height === 0 ? objectChunkBytes : objectChunkPageBytes),
      'INVALID_WORK_BACKUP',
      'Chunk recipe entry exceeds its bounded encoding.',
    );
    const bytes = await read(ref);
    invariant(
      bytes.length === ref.size && digest(bytes) === ref.sha256,
      'INVALID_WORK_BACKUP',
      'Tree content differs from its selected digest.',
    );
    if (ref.height === 0) {
      invariant(ref.length === ref.size, 'INVALID_WORK_BACKUP', 'Leaf size differs from logical bytes.');
      const from = Math.max(offset, start),
        to = Math.min(end, start + ref.length);
      result.set(bytes.subarray(from - start, to - start), from - offset);
      copied += to - from;
      return;
    }
    const page = objectChunkPageSchema.parse(JSON.parse(bytes.toString('utf8')));
    invariant(
      page.children.every(child => child.height < ref.height) &&
        page.children.reduce((sum, child) => sum + child.length, 0) === ref.length,
      'INVALID_WORK_BACKUP',
      'Tree ancestry or logical length is invalid.',
    );
    let position = start;
    for (const child of page.children) {
      await visit(child, position);
      position += child.length;
    }
  };
  await visit(recipe.tree, 0);
  invariant(copied === result.length, 'INVALID_WORK_BACKUP', 'Stored recipe range is incomplete.');
  return result.buffer;
}
