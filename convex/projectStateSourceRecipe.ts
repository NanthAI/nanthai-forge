// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';
import { objectRecipeSchema, objectChunkPageSchema } from '../src/byte-tree-format';
import { treeRefSchema } from '../src/byte-tree-format';
import { readPhysicalPin } from '../src/physical-manifest';
import type { PhysicalPin, PhysicalEntry } from '../src/physical-manifest-codec';
/** A recipe proves authority for metadata and leaves of one selected logical member. */
export async function stateRecipePins(entry: PhysicalEntry, read: (pin: PhysicalPin) => Promise<Uint8Array>) {
  return (await stateRecipePinsBatch([entry], pins => Promise.all(pins.map(pin => read(pin)))))[0]!;
}
/** One verified frontier across selected recipes, rather than a descriptor round per owner. */
export async function stateRecipePinsBatch(
  entries: PhysicalEntry[],
  read: (pins: PhysicalPin[]) => Promise<Uint8Array[]>,
) {
  const metadata = async (pins: PhysicalPin[]) => {
    const bytes = await read(pins);
    return Promise.all(
      pins.map(async (pin, index) =>
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await readPhysicalPin(pin, async () => bytes[index]!),
          ),
        ),
      ),
    );
  };
  for (const entry of entries)
    invariant(entry.recipe, 'SOURCE_UNAVAILABLE', 'Selected member has no recipe.');
  const recipes = await metadata(entries.map(entry => entry.recipe!));
  const proofs = entries.map((entry, index) => {
    const recipe = objectRecipeSchema.parse(recipes[index]);
    invariant(
      recipe.kind === 'forge-object-recipe' &&
        recipe.schema === 1 &&
        recipe.object?.sha256 === entry.sha256 &&
        recipe.object?.size === entry.size,
      'SOURCE_HASH_MISMATCH',
      'Recipe selects different logical bytes.',
    );
    const tree = treeRefSchema.parse(recipe.tree),
      pins = new Map<string, PhysicalPin>([[entry.recipe!.sha256, entry.recipe!]]),
      leaves: PhysicalPin[] = [],
      stack = [tree];
    invariant(tree.length === entry.size, 'SOURCE_HASH_MISMATCH', 'Recipe length changed.');
    return { pins, leaves, stack };
  });
  while (proofs.some(proof => proof.stack.length)) {
    const frontier = proofs.flatMap(proof => proof.stack.filter(node => node.height > 0));
    const pages = await metadata(frontier);
    let index = 0;
    for (const proof of proofs) {
      const next = [] as typeof proof.stack;
      for (const node of proof.stack) {
        const { pins, leaves } = proof;
        pins.set(node.sha256, { sha256: node.sha256, size: node.size });
        if (!node.height) {
          invariant(node.size === node.length, 'SOURCE_HASH_MISMATCH', 'Recipe leaf length changed.');
          leaves.push(node);
          continue;
        }
        const page = objectChunkPageSchema.parse(pages[index++]);
        invariant(
          page.kind === 'forge-byte-tree' && page.schema === 1 && Array.isArray(page.children),
          'SOURCE_HASH_MISMATCH',
          'Recipe page changed.',
        );
        const children = page.children.map((child: unknown) => treeRefSchema.parse(child));
        invariant(
          children.length > 0 &&
            children.every((child: { height: number }) => child.height === node.height - 1) &&
            children.reduce((sum: number, child: { length: number }) => sum + child.length, 0) ===
              node.length,
          'SOURCE_HASH_MISMATCH',
          'Recipe descendants changed.',
        );
        next.push(...children);
      }
      proof.stack = next;
    }
  }
  return proofs.map(({ pins, leaves }) => ({ pins, leaves }));
}
