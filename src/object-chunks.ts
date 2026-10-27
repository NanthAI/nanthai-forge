// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { treeRefSchema, type TreeRef } from './native-exchange-tree.js';
const pinSchema = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().safe().nonnegative() })
  .strict();
export type ChunkPin = z.infer<typeof pinSchema>;
export const objectChunkPageSchema = z
  .object({
    kind: z.literal('forge-byte-tree'),
    schema: z.literal(1),
    children: z.array(treeRefSchema).min(2),
  })
  .strict();
export const objectRecipeSchema = z
  .object({
    kind: z.literal('forge-object-recipe'),
    schema: z.literal(1),
    object: pinSchema,
    tree: treeRefSchema,
  })
  .strict();
export type ObjectRecipe = z.infer<typeof objectRecipeSchema>;
// Internal content boundaries, not accepted-file limits. Rolling anchors recover
// after an insertion/deletion; raw logical IDs never depend on these parameters.
export const objectChunkBytes = 1024 * 1024,
  objectChunkPageBytes = 2 * 1024 * 1024;
const minimum = 64 * 1024,
  maximum = objectChunkBytes,
  mask = 256 * 1024 - 1;
const gear = Array.from({ length: 256 }, (_, index) =>
  Buffer.from(digest(`forge-content-byte-${index}`), 'hex').readUInt32LE(0),
);
const pin = (bytes: Buffer): ChunkPin => ({ sha256: digest(bytes), size: bytes.length });
/** Chunk boundaries are independent of input read size. The sink must consume
 * each temporary chunk before returning; only compact references are retained. */
export class ObjectRecipeBuilder {
  private readonly leaves: TreeRef[] = [];
  private readonly buffer = Buffer.allocUnsafe(maximum);
  private length = 0;
  private offset = 0;
  private rolling = 0;
  constructor(private readonly put: (bytes: Buffer, offset: number | null) => ChunkPin) {}
  update(bytes: Buffer) {
    for (const byte of bytes) {
      this.buffer[this.length++] = byte;
      this.rolling = ((this.rolling << 1) + gear[byte]!) >>> 0;
      if (this.length >= minimum && ((this.rolling & mask) === 0 || this.length >= maximum)) this.leaf();
    }
  }
  private leaf() {
    const bytes = this.buffer.subarray(0, this.length);
    this.leaves.push({ ...this.put(bytes, this.offset), height: 0, length: this.length });
    this.offset += this.length;
    this.length = 0;
    this.rolling = 0;
  }
  finish(object: ChunkPin) {
    if (this.length || !this.leaves.length) this.leaf();
    invariant(
      this.offset === object.size,
      'EXCHANGE_SOURCE_CHANGED',
      'Chunked source length differs from its original pin.',
    );
    const leaves = this.leaves,
      put = (bytes: Buffer) => this.put(bytes, null);
    let refs = leaves;
    while (refs.length > 1) {
      const pages: TreeRef[][] = [];
      let page: TreeRef[] = [];
      for (const ref of refs) {
        page.push(ref);
        if (page.length >= 16 && ((parseInt(ref.sha256.slice(0, 8), 16) & 31) === 0 || page.length >= 64)) {
          pages.push(page);
          page = [];
        }
      }
      if (page.length) pages.push(page);
      refs = pages.map(children =>
        children.length === 1
          ? children[0]!
          : {
              ...put(Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children }))),
              height: Math.max(...children.map(child => child.height)) + 1,
              length: children.reduce((sum, child) => sum + child.length, 0),
            },
      );
    }
    const recipe: ObjectRecipe = { kind: 'forge-object-recipe', schema: 1, object, tree: refs[0]! };
    return { recipe, bytes: Buffer.from(JSON.stringify(recipe)) };
  }
}
export function buildObjectRecipe(bytes: Buffer) {
  const objects = new Map<string, Buffer>();
  const builder = new ObjectRecipeBuilder((content, offset) => {
    const value = pin(content);
    objects.set(
      value.sha256,
      offset === null ? Buffer.from(content) : bytes.subarray(offset, offset + content.length),
    );
    return value;
  });
  builder.update(bytes);
  return { ...builder.finish(pin(bytes)), objects };
}

/** Ordered bounded reader; successful exhaustion verifies the original whole-file identity. */
export async function* readObjectRecipe(
  input: ObjectRecipe,
  read: (pin: ChunkPin) => Promise<Buffer>,
  prepare?: (pins: ChunkPin[]) => Promise<void>,
): AsyncGenerator<Buffer> {
  const recipe = objectRecipeSchema.parse(input),
    pending = [recipe.tree],
    refs = new Map<string, number>(),
    hash = createHash('sha256');
  invariant(
    recipe.tree.length === recipe.object.size,
    'INVALID_WORK_BACKUP',
    'Chunk recipe length differs from its original content.',
  );
  let length = 0;
  while (pending.length) {
    const ref = pending.pop()!,
      prior = refs.get(ref.sha256);
    // A raw leaf may contain exactly the JSON bytes of an index page. Content
    // identity binds physical size; height/length belong to each occurrence.
    invariant(
      prior === undefined || prior === ref.size,
      'INVALID_WORK_BACKUP',
      'Chunk content has inconsistent physical sizes.',
    );
    refs.set(ref.sha256, ref.size);
    invariant(
      ref.size <= (ref.height === 0 ? objectChunkBytes : objectChunkPageBytes),
      'INVALID_WORK_BACKUP',
      'Chunk recipe entry exceeds its bounded encoding; logical content has no size cap.',
    );
    await prepare?.([ref, ...pending.slice(-99).reverse()]);
    const bytes = await read({ sha256: ref.sha256, size: ref.size });
    invariant(
      bytes.length === ref.size && digest(bytes) === ref.sha256,
      'INVALID_WORK_BACKUP',
      'Chunk content differs from its original digest.',
    );
    if (ref.height === 0) {
      invariant(
        ref.length === ref.size,
        'INVALID_WORK_BACKUP',
        'Chunk size differs from its logical length.',
      );
      length += bytes.length;
      hash.update(bytes);
      yield bytes;
    } else {
      const page = objectChunkPageSchema.parse(JSON.parse(bytes.toString('utf8')));
      invariant(
        page.children.every(child => child.height < ref.height) &&
          page.children.reduce((sum, child) => sum + child.length, 0) === ref.length,
        'INVALID_WORK_BACKUP',
        'Chunk recipe ancestry or logical length is invalid.',
      );
      pending.push(...page.children.slice().reverse());
    }
  }
  invariant(
    length === recipe.object.size && hash.digest('hex') === recipe.object.sha256,
    'INVALID_WORK_BACKUP',
    'Reconstructed content differs from its original whole-file digest.',
  );
}
