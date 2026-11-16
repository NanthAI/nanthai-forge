// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';
import { directSourceBatch, sourceWindowOrder } from '../src/hosted-actions-direct';
import { mapSourceOrdered } from '../src/hosted-source-parallel';
import type { PhysicalPin } from '../src/physical-manifest-codec';
import { catalogSourceRow, stateCatalogReader } from './projectStateSourceCatalog';
import { stateRecipePinsBatch } from './projectStateSourceRecipe';
import { readSignedPhysical } from './projectStateSourceReader';

/** Ephemeral, verified legacy-recipe projection in the existing State grant. Nothing is persisted.
 * Large/unusual representations keep their ordinary recipe reader; these are optimization bounds. */
export async function prepareStateRecipes(
  rows: unknown[],
  catalog: (ids: string[]) => Promise<unknown[]>,
  read: (pin: PhysicalPin) => Promise<Uint8Array>,
) {
  const members = rows.map(catalogSourceRow),
    selected = members.filter(value => value.recipe && !value.row.closure);
  if (!selected.length) return rows;
  const held = new Map(members.map(value => [value.pin.sha256, value]));
  const load = async (ids: string[]) => {
    const missing = sourceWindowOrder(ids.filter(id => !held.has(id)));
    for (let at = 0; at < missing.length;) {
      const page = missing.slice(at, at + directSourceBatch),
        values = (await catalog(page)).map(catalogSourceRow);
      invariant(
        values.length > 0 && values.length <= page.length,
        'SOURCE_UNAVAILABLE',
        'Recipe window is incomplete.',
      );
      values.forEach((value, index) => {
        invariant(value.pin.sha256 === page[index], 'SOURCE_HASH_MISMATCH', 'Recipe descriptor changed.');
        held.set(value.pin.sha256, value);
      });
      at += values.length;
    }
    return ids.map(id => held.get(id)!.row);
  };
  const raw = async (pin: PhysicalPin) => {
    const value = held.get(pin.sha256);
    if (!value?.row.url) return read(pin);
    invariant(value.pin.size === pin.size, 'SOURCE_HASH_MISMATCH', 'Recipe physical size changed.');
    return readSignedPhysical(
      {
        ...pin,
        ...(value.row.range
          ? { pack: { digest: pin.sha256, offset: value.row.range.offset, size: value.row.range.total } }
          : {}),
      },
      value.row.url,
    );
  };
  const legacy = stateCatalogReader(raw, load);
  const skipProjection = Symbol('ordinary recipe reader'),
    metadata = new Map<string, number>();
  let proofs: Awaited<ReturnType<typeof stateRecipePinsBatch>>;
  try {
    proofs = await stateRecipePinsBatch(
      selected.map(value => ({ ...value.pin, recipe: value.recipe! })),
      async pins => {
        for (const pin of pins) metadata.set(pin.sha256, pin.size);
        if ([...metadata.values()].reduce((sum, size) => sum + size, 0) > 8 * 1024 * 1024)
          throw skipProjection;
        await load(pins.map(pin => pin.sha256));
        return mapSourceOrdered(pins, pin => legacy(pin), 16);
      },
    );
  } catch (error) {
    if (error !== skipProjection) throw error;
    return rows;
  }
  const eligible = proofs.flatMap((proof, index) =>
    proof.leaves.length <= 100 && proof.leaves.every(pin => pin.size <= 1024 * 1024)
      ? [{ value: selected[index]!, proof }]
      : [],
  );
  await load(proofs.flatMap(proof => proof.leaves.map(pin => pin.sha256)));
  const closures = new Map<string, NonNullable<(typeof members)[number]['row']['closure']>>();
  for (const { value, proof } of eligible) {
    const closure = proof.leaves.map(pin => {
      const leaf = held.get(pin.sha256)!;
      invariant(leaf.pin.size === pin.size, 'SOURCE_HASH_MISMATCH', 'Recipe leaf size changed.');
      return leaf.row.url && !leaf.recipe
        ? {
            digest: pin.sha256,
            size: pin.size,
            url: leaf.row.url,
            ...(leaf.row.range ? { range: leaf.row.range } : {}),
          }
        : null;
    });
    if (closure.every(leaf => leaf !== null)) closures.set(value.pin.sha256, closure);
  }
  const prepared = new Map(
    selected.map((value, index) => [
      value.pin.sha256,
      [...proofs[index]!.pins.values()].map(pin => {
        const descriptor = held.get(pin.sha256)!;
        invariant(descriptor.pin.size === pin.size, 'SOURCE_HASH_MISMATCH', 'Recipe physical size changed.');
        return descriptor.row;
      }),
    ]),
  );
  // The same bounded reply can carry verified descriptors when an inline closure
  // cannot represent the recipe. Larger inventories retain ordinary windowing.
  let bytes = new TextEncoder().encode(JSON.stringify(rows)).length;
  return members.map(value => {
    const closure = closures.get(value.pin.sha256);
    if (closure) {
      const size = new TextEncoder().encode(JSON.stringify(closure)).length + 16;
      if (bytes + size <= 4 * 1024 * 1024) {
        bytes += size;
        return { ...value.row, closure };
      }
    }
    const descriptors = [];
    for (const row of prepared.get(value.pin.sha256) ?? []) {
      const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
      if (bytes + size + 16 > 4 * 1024 * 1024) break;
      descriptors.push(row);
      bytes += size;
    }
    if (!descriptors.length) return value.row;
    bytes += 16;
    return { ...value.row, prepared: descriptors };
  });
}
