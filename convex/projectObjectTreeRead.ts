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

type Request = { pin: ChunkPin; recipes: number[] };
/** Share each frontier by digest, including its destination spans. Unchanged
 * subtrees expand once across all States; only descriptors survive a byte window. */
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
    const height = pending.reduce((max, item) => Math.max(max, item.ref.height), 0);
    const current = pending.filter(
      item =>
        item.ref.height === height &&
        (!range ||
          (item.start < range.offset + results[item.recipe]!.length &&
            item.start + item.ref.length > range.offset)),
    );
    pending = pending.filter(item => item.ref.height !== height);
    for (const { ref } of current)
      invariant(
        ref.size <= (ref.height === 0 ? objectChunkBytes : objectChunkPageBytes),
        'INVALID_WORK_BACKUP',
        'Chunk recipe entry exceeds its bounded encoding.',
      );
    const groups = new Map<string, typeof current>();
    for (const item of current) {
      const key = `${item.ref.sha256}:${item.ref.height}:${item.ref.length}`;
      const group = groups.get(key) ?? [];
      invariant(
        !group.length || group[0]!.ref.size === item.ref.size,
        'INVALID_WORK_BACKUP',
        'Shared tree content has inconsistent physical sizes.',
      );
      group.push(item);
      groups.set(key, group);
    }
    const shared = [...groups.values()];
    await read(
      shared.map(items => ({ pin: items[0]!.ref, recipes: [...new Set(items.map(i => i.recipe))] })),
      (bytes, index) => {
        const items = shared[index]!,
          { ref } = items[0]!;
        invariant(
          bytes.length === ref.size && digest(bytes) === ref.sha256,
          'INVALID_WORK_BACKUP',
          'Tree content differs from its selected digest.',
        );
        if (ref.height === 0) {
          invariant(ref.length === ref.size, 'INVALID_WORK_BACKUP', 'Leaf size differs from logical bytes.');
          for (const { recipe, start } of items) {
            const offset = range?.offset ?? 0;
            const from = Math.max(offset, start),
              to = Math.min(offset + results[recipe]!.length, start + ref.length);
            bytes.copy(results[recipe]!, from - offset, from - start, to - start);
            copied[recipe]! += to - from;
          }
        } else {
          const page = objectChunkPageSchema.parse(JSON.parse(bytes.toString('utf8')));
          invariant(
            page.children.every(child => child.height < ref.height) &&
              page.children.reduce((sum, child) => sum + child.length, 0) === ref.length,
            'INVALID_WORK_BACKUP',
            'Tree ancestry or logical length is invalid.',
          );
          for (const { recipe, start } of items) {
            let position = start;
            for (const child of page.children) {
              pending.push({ ref: child, recipe, start: position });
              position += child.length;
            }
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
