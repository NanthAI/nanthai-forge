// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';
import { sha256Hex } from '../src/verified-blob';
import type { PhysicalPin, PhysicalEntry } from '../src/physical-manifest-codec';
import { readSignedPhysical } from './projectStateSourceReader';
import { stateRecipePins } from './projectStateSourceRecipe';
/** Normalize the two existing catalog reply shapes; no field supplies membership authority. */
export function catalogSourceRow(value: unknown) {
  invariant(value && typeof value === 'object', 'SOURCE_UNAVAILABLE', 'Catalog source is unavailable.');
  const row = value as {
    descriptor?: {
      object: { sha256: string; size: number };
      recipe: { sha256: string; size: number } | null;
    };
    digest?: string;
    size?: number;
    recipe?: { digest: string; size: number; url?: string };
    url?: string | null;
    range?: { offset: number; total: number };
    closure?: { digest: string; size: number; url: string; range?: { offset: number; total: number } }[];
  };
  const pin = row.descriptor?.object ?? { sha256: row.digest!, size: row.size! },
    recipe =
      row.descriptor?.recipe ??
      (row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : undefined);
  return { pin, recipe, row };
}
/** Read only pins reached from an authenticated State/recipe. Legacy keys and nested
 * encodings keep their existing catalog path and exact whole-object verifier. */
export function stateCatalogReader(
  read: (pin: PhysicalPin) => Promise<Uint8Array>,
  catalog: (ids: string[]) => Promise<unknown[]>,
) {
  const held = new Map<string, Promise<Uint8Array>>();
  const get = (pin: PhysicalPin, ancestors: ReadonlySet<string> = new Set()): Promise<Uint8Array> => {
    invariant(!ancestors.has(pin.sha256), 'SOURCE_UNAVAILABLE', 'A required raw recipe leaf is unavailable.');
    let promise = held.get(pin.sha256);
    if (!promise) {
      promise = (async () => {
        try {
          return await read(pin);
        } catch {
          /* Same exact pin through its legacy binding. */
        }
        const value = catalogSourceRow((await catalog([pin.sha256]))[0]);
        invariant(
          value.pin.sha256 === pin.sha256 && value.pin.size === pin.size,
          'SOURCE_HASH_MISMATCH',
          'Catalog source pin changed.',
        );
        if (value.row.url)
          return readSignedPhysical(
            {
              ...pin,
              ...(value.row.range
                ? {
                    pack: {
                      digest: pin.sha256,
                      offset: value.row.range.offset,
                      size: value.row.range.total,
                    },
                  }
                : {}),
            },
            value.row.url,
          );
        const bytes = new Uint8Array(pin.size);
        let offset = 0;
        if (value.row.closure) {
          for (const leaf of value.row.closure) {
            const part = await readSignedPhysical(
              {
                sha256: leaf.digest,
                size: leaf.size,
                ...(leaf.range
                  ? {
                      pack: {
                        digest: leaf.digest,
                        offset: leaf.range.offset,
                        size: leaf.range.total,
                      },
                    }
                  : {}),
              },
              leaf.url,
            );
            invariant(
              offset + part.length <= bytes.length,
              'SOURCE_HASH_MISMATCH',
              'Catalog closure exceeds its pin.',
            );
            bytes.set(part, offset);
            offset += part.length;
          }
        } else {
          invariant(value.recipe, 'SOURCE_UNAVAILABLE', 'Catalog physical binding is unavailable.');
          const next = new Set([...ancestors, pin.sha256]);
          const proof = await stateRecipePins({ ...pin, recipe: value.recipe } as PhysicalEntry, child =>
            get(child, next),
          );
          for (const leaf of proof.leaves) {
            const part = await get(leaf, next);
            invariant(
              offset + part.length <= bytes.length,
              'SOURCE_HASH_MISMATCH',
              'Catalog recipe exceeds its pin.',
            );
            bytes.set(part, offset);
            offset += part.length;
          }
        }
        invariant(
          offset === pin.size && (await sha256Hex(bytes)) === pin.sha256,
          'SOURCE_HASH_MISMATCH',
          'Catalog bytes changed.',
        );
        return bytes;
      })();
      held.set(pin.sha256, promise);
    }
    return promise;
  };
  return get;
}
