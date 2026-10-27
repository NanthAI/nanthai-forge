// SPDX-License-Identifier: Apache-2.0
import { digest } from '../dist/hash.js';

/** Stress assumption: 25% of source objects >=128 KiB use recipes, with four leaves.
 * The local owner's read-only size census found 2,197/19,304 objects above 128 KiB
 * (2,093/2,714 States), but sizes do not prove hosted representation. The current
 * exchange-client.ts uploads only >2 MiB objects as recipes; smaller records stay
 * raw and metadata/ paths are excluded. This deliberately includes smaller
 * historical/delta-style source recipes. The deep-tree stress variant uses 16 KiB
 * legacy leaves and 16-way pages, making shared frontiers exceed 100 occurrences
 * before deduplication; current CDC writers use larger leaves. */
export function recipeObjects(objects, sizes, sources, deepTrees = false) {
  const get = objects.get.bind(objects),
    has = objects.has.bind(objects);
  const physical = new Map(),
    bindings = new Map();
  const bytes = key => physical.get(key)?.() ?? get(key);
  objects.get = bytes;
  objects.has = key => physical.has(key) || has(key);
  const row = key => {
    let recipe = bindings.get(key);
    if (sources.has(key) && !physical.has(key) && !recipe && (deepTrees || parseInt(key[0], 16) < 4)) {
      const value = get(key);
      if (value.length >= 128 * 1024) {
        const children = [],
          width = deepTrees ? 16 * 1024 : Math.min(1024 * 1024, Math.ceil(value.length / 4));
        for (let start = 0; start < value.length; start += width) {
          const end = Math.min(start + width, value.length),
            part = value.subarray(start, end);
          const sha256 = digest(part);
          physical.set(sha256, () => get(key).subarray(start, end));
          sizes.set(sha256, part.length);
          children.push({ sha256, size: part.length, height: 0, length: part.length });
        }
        let refs = children;
        while (refs.length > 1) {
          const next = [];
          const width = deepTrees ? 16 : refs.length;
          for (let i = 0; i < refs.length; i += width) {
            const children = refs.slice(i, i + width);
            if (children.length === 1) {
              next.push(children[0]);
              continue;
            }
            const page = Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children }));
            const tree = {
              sha256: digest(page),
              size: page.length,
              height: Math.max(...children.map(c => c.height)) + 1,
              length: children.reduce((n, c) => n + c.length, 0),
            };
            physical.set(tree.sha256, () => page);
            sizes.set(tree.sha256, page.length);
            next.push(tree);
          }
          refs = next;
        }
        const tree = refs[0];
        const body = Buffer.from(
          JSON.stringify({
            kind: 'forge-object-recipe',
            schema: 1,
            object: { sha256: key, size: value.length },
            tree,
          }),
        );
        recipe = { digest: digest(body), size: body.length };
        physical.set(recipe.digest, () => body);
        sizes.set(recipe.digest, body.length);
        bindings.set(key, recipe);
      }
    }
    return {
      projectId: 'project',
      digest: key,
      size: sizes.get(key) ?? bytes(key).length,
      ...(recipe ? { recipe } : { storageId: key }),
    };
  };
  return { row, bindings };
}
