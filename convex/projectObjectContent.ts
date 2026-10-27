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
import { readRecipeTrees } from './projectObjectTreeRead';
import { objectRecipeSchema, objectChunkPageBytes, type ChunkPin } from '../src/object-chunks';

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

type Selected = { pin: ChunkPin; ancestors: ReadonlySet<string> };

/** Only descriptors survive a window. A transition checks the prior window after IO
 * and the next one before IO in the same bounded resolve when they fit. */
function resolver(ctx: ActionCtx, projectId: Id<'hostedProjects'>, actor: string, raw: RawReader) {
  let previous: ChunkPin[] = [];
  const resolve = async (pins: ChunkPin[]) => {
    const unique = [...new Map(pins.map(pin => [pin.sha256, pin])).values()];
    const rows = new Map<string, Doc<'projectObjects'>>();
    for (let start = 0; start < unique.length;) {
      let end = start,
        size = 0;
      while (end < unique.length && end - start < 100) {
        const next = unique[end]!.size;
        if (end > start && size + next > objectChunkPageBytes) break;
        size += next;
        end++;
      }
      const window = unique.slice(start, end);
      const found: Doc<'projectObjects'>[] = await ctx.runQuery(internal.projectObjects.resolve, {
        projectId,
        actor,
        digests: window.map(pin => pin.sha256),
      });
      invariant(
        found.length === window.length,
        'INVALID_WORK_BACKUP',
        'Stored content lookup omitted selected bytes.',
      );
      found.forEach(row => rows.set(row.digest, row));
      start = end;
    }
    return rows;
  };
  return {
    async read(selected: Selected[], consume: (bytes: Buffer, index: number) => void) {
      for (let start = 0; start < selected.length;) {
        let end = start,
          size = 0;
        while (end < selected.length && end - start < 100) {
          const next = selected[end]!.pin.size;
          if (end > start && size + next > objectChunkPageBytes) break;
          size += next;
          end++;
        }
        const window = selected.slice(start, end),
          pins = window.map(item => item.pin);
        const rows = await resolve([...previous, ...pins]);
        const bytes = await objectContents(
          ctx,
          pins.map(pin => rows.get(pin.sha256)!),
          pins,
          actor,
          window.map(item => item.ancestors),
          raw,
        );
        bytes.forEach((value, i) => consume(value, start + i));
        previous = pins;
        start = end;
      }
    },
    async finish(after: ChunkPin[] = []) {
      await resolve([...previous, ...after]);
      previous = [];
    },
  };
}

/** The page shares recipe-body and tree-level resolve windows, never access decisions. */
export async function objectContents(
  ctx: ActionCtx,
  rows: Doc<'projectObjects'>[],
  pins: ChunkPin[],
  actor: string,
  ancestors: ReadonlySet<string> | ReadonlySet<string>[] = new Set(),
  raw: RawReader = rawContent,
  range?: { offset: number; length: number },
  after: ChunkPin[] = [],
): Promise<Buffer[]> {
  const result: Buffer[] = [],
    selected: Selected[] = [],
    indexes: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!,
      pin = pins[i]!;
    invariant(
      row && row.size === pin.size && row.digest === pin.sha256,
      'INVALID_WORK_BACKUP',
      'Stored content size differs from its checkpoint.',
    );
    if (isRaw(row)) {
      await rawMetadata(ctx, row, pin);
      result[i] = await raw(ctx, row, pin);
      continue;
    }
    const ancestry = Array.isArray(ancestors) ? ancestors[i]! : ancestors;
    invariant(
      row.recipe && row.recipe.size <= objectChunkPageBytes && !ancestry.has(row.digest),
      'INVALID_WORK_BACKUP',
      'Stored recipe ancestry is invalid.',
    );
    const next = new Set(ancestry);
    next.add(row.digest);
    selected.push({ pin: { sha256: row.recipe.digest, size: row.recipe.size }, ancestors: next });
    indexes.push(i);
  }
  const recipes: ReturnType<typeof objectRecipeSchema.parse>[] = [];
  if (selected.length) {
    const projectId = rows[indexes[0]!]!.projectId;
    const reader = resolver(ctx, projectId, actor, raw);
    await reader.read(selected, (bytes, i) => {
      const recipe = objectRecipeSchema.parse(JSON.parse(bytes.toString('utf8')));
      const row = rows[indexes[i]!]!;
      invariant(
        recipe.object.sha256 === row.digest && recipe.object.size === row.size,
        'INVALID_WORK_BACKUP',
        'Stored recipe differs from its logical content binding.',
      );
      recipes.push(recipe);
    });
    const values = await readRecipeTrees(
      recipes,
      async (requests, consume) => {
        await reader.read(
          requests.map(item => ({
            pin: item.pin,
            ancestors: selected[item.recipe]!.ancestors,
          })),
          consume,
        );
      },
      range,
    );
    await reader.finish(after);
    for (let i = 0; i < values.length; i++) result[indexes[i]!] = values[i]!;
  }
  return result;
}
export async function objectContent(
  ctx: ActionCtx,
  row: Doc<'projectObjects'>,
  pin: ChunkPin,
  actor: string,
  ancestors: ReadonlySet<string> = new Set(),
  raw: RawReader = rawContent,
): Promise<Buffer> {
  return (await objectContents(ctx, [row], [pin], actor, ancestors, raw))[0]!;
}
/** A bound recipe already proved the full hash; ranges verify every fetched node. */
export async function objectRange(
  ctx: ActionCtx,
  row: Doc<'projectObjects'>,
  actor: string,
  offset: number,
  length = 2 * 1024 * 1024,
): Promise<ArrayBuffer> {
  const [bytes] = await objectContents(
    ctx,
    [row],
    [{ sha256: row.digest, size: row.size }],
    actor,
    new Set(),
    rawContent,
    { offset, length },
  );
  return Uint8Array.from(bytes!).buffer;
}
