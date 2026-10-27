// SPDX-License-Identifier: Apache-2.0
'use node';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import {
  objectChunkBytes,
  objectChunkPageBytes,
  objectChunkPageSchema,
  type ChunkPin,
  type ObjectRecipe,
} from '../src/object-chunks';

type Request = { pin: ChunkPin; recipe: number };
/** Breadth-first descriptors, sequential byte consumption. No additional retained byte cache. */
export async function readRecipeTrees(
  recipes: ObjectRecipe[],
  read: (requests: Request[], consume: (bytes: Buffer, index: number) => void) => Promise<void>,
  range?: { offset: number; length: number },
) {
  const results = recipes.map(recipe => {
    invariant(
      recipe.tree.length === recipe.object.size,
      'INVALID_WORK_BACKUP',
      'Chunk recipe length differs from its original content.',
    );
    return Buffer.alloc(
      range ? Math.min(recipe.object.size, range.offset + range.length) - range.offset : recipe.object.size,
    );
  });
  const copied = recipes.map(() => 0);
  let pending = recipes.map((recipe, index) => ({ ref: recipe.tree, recipe: index, start: 0 }));
  while (pending.length) {
    const current = pending.filter(
      item =>
        !range ||
        (item.start < range.offset + results[item.recipe]!.length &&
          item.start + item.ref.length > range.offset),
    );
    pending = [];
    for (const { ref } of current)
      invariant(
        ref.size <= (ref.height === 0 ? objectChunkBytes : objectChunkPageBytes),
        'INVALID_WORK_BACKUP',
        'Chunk recipe entry exceeds its bounded encoding.',
      );
    await read(
      current.map(item => ({ pin: item.ref, recipe: item.recipe })),
      (bytes, index) => {
        const { ref, recipe, start } = current[index]!;
        invariant(
          bytes.length === ref.size && digest(bytes) === ref.sha256,
          'INVALID_WORK_BACKUP',
          'Tree content differs from its selected digest.',
        );
        if (ref.height === 0) {
          invariant(ref.length === ref.size, 'INVALID_WORK_BACKUP', 'Leaf size differs from logical bytes.');
          const offset = range?.offset ?? 0;
          const from = Math.max(offset, start),
            to = Math.min(offset + results[recipe]!.length, start + ref.length);
          bytes.copy(results[recipe]!, from - offset, from - start, to - start);
          copied[recipe]! += to - from;
        } else {
          const page = objectChunkPageSchema.parse(JSON.parse(bytes.toString('utf8')));
          invariant(
            page.children.every(child => child.height < ref.height) &&
              page.children.reduce((sum, child) => sum + child.length, 0) === ref.length,
            'INVALID_WORK_BACKUP',
            'Tree ancestry or logical length is invalid.',
          );
          let position = start;
          for (const child of page.children) {
            pending.push({ ref: child, recipe, start: position });
            position += child.length;
          }
        }
      },
    );
  }
  results.forEach((bytes, i) =>
    invariant(
      copied[i] === bytes.length && (range || digest(bytes) === recipes[i]!.object.sha256),
      'INVALID_WORK_BACKUP',
      'Reconstructed content differs from its original whole-file digest.',
    ),
  );
  return results;
}
