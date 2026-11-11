// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';
import { objectRecipeSchema, objectChunkPageSchema } from '../src/byte-tree-format';
import { treeRefSchema } from '../src/byte-tree-format';
import { readPhysicalPin } from '../src/physical-manifest';
import type { PhysicalPin, PhysicalEntry } from '../src/physical-manifest-codec';
/** A recipe proves authority for metadata and leaves of one selected logical member. */
export async function stateRecipePins(entry: PhysicalEntry, read: (pin: PhysicalPin) => Promise<Uint8Array>) {
  invariant(entry.recipe, 'SOURCE_UNAVAILABLE', 'Selected member has no recipe.');
  const metadata = async (pin: PhysicalPin) =>
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readPhysicalPin(pin, read)));
  const recipe = objectRecipeSchema.parse(await metadata(entry.recipe));
  invariant(
    recipe.kind === 'forge-object-recipe' &&
      recipe.schema === 1 &&
      recipe.object?.sha256 === entry.sha256 &&
      recipe.object?.size === entry.size,
    'SOURCE_HASH_MISMATCH',
    'Recipe selects different logical bytes.',
  );
  const tree = treeRefSchema.parse(recipe.tree),
    pins = new Map<string, PhysicalPin>([[entry.recipe.sha256, entry.recipe]]),
    leaves: PhysicalPin[] = [],
    stack = [tree];
  invariant(tree.length === entry.size, 'SOURCE_HASH_MISMATCH', 'Recipe length changed.');
  while (stack.length) {
    const node = stack.pop()!;
    pins.set(node.sha256, { sha256: node.sha256, size: node.size });
    if (!node.height) {
      invariant(node.size === node.length, 'SOURCE_HASH_MISMATCH', 'Recipe leaf length changed.');
      leaves.push(node);
      continue;
    }
    const page = objectChunkPageSchema.parse(await metadata(node));
    invariant(
      page.kind === 'forge-byte-tree' && page.schema === 1 && Array.isArray(page.children),
      'SOURCE_HASH_MISMATCH',
      'Recipe page changed.',
    );
    const children = page.children.map((child: unknown) => treeRefSchema.parse(child));
    invariant(
      children.length > 0 &&
        children.every((child: { height: number }) => child.height === node.height - 1) &&
        children.reduce((sum: number, child: { length: number }) => sum + child.length, 0) === node.length,
      'SOURCE_HASH_MISMATCH',
      'Recipe descendants changed.',
    );
    stack.push(...children.reverse());
  }
  return { pins, leaves };
}
