// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';
import { sha256Hex } from '../src/verified-blob';
import { parseNativeState } from '../src/state/format';
import { packRange } from '../src/object-pack-range';
import type { PhysicalEntry } from '../src/physical-manifest-codec';
import { physicalRuns } from '../src/physical-manifest-runs';
import { stateCatalogReader, catalogSourceRow } from './projectStateSourceCatalog';
import { stateRecipePins } from './projectStateSourceRecipe';
import { directSourceBatch, sourceWindowOrder } from '../src/hosted-actions-direct';
import { stateSourceReader, readSignedPhysical } from './projectStateSourceReader';
import type { ObjectLocation } from './projectConvexSourceTransport';
import type { Id } from './_generated/dataModel';
const refreshManifest = Symbol('refresh selected physical manifest');
/** Selector and catalog callbacks are current-access operations, never supplied by repository input. */
async function buildStateSourceGrants(
  options: {
    projectId: Id<'hostedProjects'>;
    state: string;
    digests: string[];
    all?: boolean | undefined;
    object?: string | undefined;
    runs?: boolean | undefined;
    fallback?: boolean | undefined;
    select: () => Promise<ObjectLocation>;
    catalog: (ids: string[]) => Promise<unknown[]>;
    log: (message: string) => void;
  },
  retryInvalid = false,
) {
  const location = await options.select(),
    source = stateSourceReader(options.projectId),
    readRecipePin = stateCatalogReader(source.read, options.catalog);
  invariant(
    location.descriptor.object.sha256 === options.state,
    'SOURCE_HASH_MISMATCH',
    'Selected State changed.',
  );
  if (options.object === options.state) {
    invariant(location.descriptor.recipe, 'SOURCE_UNAVAILABLE', 'Selected State has no recipe.');
    const proof = await stateRecipePins(
      { ...location.descriptor.object, recipe: location.descriptor.recipe },
      readRecipePin,
    );
    invariant(
      options.digests.every(id => proof.pins.has(id)),
      'SOURCE_UNAVAILABLE',
      'Digest is outside the selected State recipe.',
    );
    return { mode: 'catalog' as const, rows: await options.catalog(options.digests) };
  }
  let entries: (PhysicalEntry | null)[] | null = null;
  let reader: Awaited<ReturnType<typeof source.open>> | null = null;
  if (options.fallback)
    options.log('source bindings: catalog (physical manifest transfer invalid or unavailable)');
  else if (location.statePhysical) {
    try {
      reader = await source.open(options.state, location.statePhysical);
      if (!options.all) entries = await reader.lookup(options.object ? [options.object] : options.digests);
    } catch {
      if (retryInvalid) throw refreshManifest;
      options.log('source bindings: catalog (physical manifest invalid or unavailable)');
      reader = null;
    }
  } else options.log('source bindings: catalog (physical manifest missing)');
  if (reader && options.all) {
    let runs;
    try {
      runs = await physicalRuns(reader.all(false));
    } catch {
      if (retryInvalid) throw refreshManifest;
      options.log('source bindings: catalog (physical manifest invalid or unavailable)');
    }
    const plan =
      runs && runs.length <= 130 && location.statePhysical
        ? await source.plan(options.state, location.statePhysical)
        : null;
    if (runs && plan) {
      options.log('source bindings: physical manifest');
      return { mode: 'runs' as const, runs: await source.sign(runs), plan };
    }
    options.log(
      'source bindings: one-time windowed fallback (raw or fragmented State; check publishes source pack)',
    );
  }
  if (entries && options.object) {
    invariant(entries[0], 'SOURCE_UNAVAILABLE', 'Recipe is outside the selected State.');
    const proof = await stateRecipePins(entries[0], readRecipePin);
    invariant(
      options.digests.every(id => proof.pins.has(id)),
      'SOURCE_UNAVAILABLE',
      'Digest is outside the selected recipe.',
    );
    return { mode: 'catalog' as const, rows: await options.catalog(options.digests) };
  }
  if (entries) {
    invariant(entries.every(Boolean), 'SOURCE_UNAVAILABLE', 'Digest is outside the selected State.');
    if (entries.every(entry => !entry!.recipe)) {
      const values = entries as PhysicalEntry[],
        runs = (await physicalRuns([...new Map(values.map(entry => [entry.sha256, entry])).values()]))!;
      const result = values.map(entry => ({
        descriptor: { object: { sha256: entry.sha256, size: entry.size }, recipe: null },
        url: null as string | null,
        ...(entry.pack ? { range: packRange(entry) } : {}),
        run: undefined as
          | undefined
          | { id: number; offset: number; length: number; total: number; url?: string },
      }));
      if (!options.runs) {
        for (const [index, entry] of values.entries()) {
          const [run] = (await physicalRuns([entry]))!;
          result[index]!.url = (await source.sign([run!]))[0]!.url;
        }
        return { mode: 'rows' as const, rows: result };
      }
      const signed = await source.sign(runs),
        first = new Set<number>();
      values.forEach((entry, index) => {
        const at = signed.findIndex(
          run =>
            run.digest === (entry.pack?.digest ?? entry.sha256) &&
            run.nonce === (entry.pack?.nonce ?? entry.nonce) &&
            (entry.pack
              ? !run.raw &&
                run.offset <= entry.pack.offset &&
                run.offset + run.length >= entry.pack.offset + entry.size
              : run.raw),
        );
        invariant(at >= 0, 'SOURCE_HASH_MISMATCH', 'Source run omits a member.');
        const run = signed[at]!;
        if (run.raw || run.length === entry.size) result[index]!.url = run.url;
        else {
          result[index]!.run = {
            id: at,
            offset: run.offset,
            length: run.length,
            total: run.total,
            ...(first.has(at) ? {} : { url: run.url }),
          };
          first.add(at);
        }
      });
      options.log('source bindings: physical manifest');
      return { mode: 'rows' as const, rows: result };
    }
  }
  // Missing/corrupt/legacy bindings retain exact membership checks. The catalog
  // may hold history and unrelated source; none of it becomes a grant here.
  const pin = location.descriptor.object;
  let bytes: Uint8Array;
  if (location.closure) {
    bytes = new Uint8Array(pin.size);
    let offset = 0;
    for (const leaf of location.closure) {
      const part = await readSignedPhysical(
        {
          sha256: leaf.digest,
          size: leaf.size,
          ...(leaf.range
            ? { pack: { digest: leaf.digest, offset: leaf.range.offset, size: leaf.range.total } }
            : {}),
        },
        leaf.url,
      );
      invariant(
        offset + part.length <= bytes.length,
        'SOURCE_HASH_MISMATCH',
        'State closure exceeds its pin.',
      );
      bytes.set(part, offset);
      offset += part.length;
    }
    invariant(offset === pin.size, 'SOURCE_HASH_MISMATCH', 'State closure is incomplete.');
  } else if (location.descriptor.recipe) {
    const proof = await stateRecipePins({ ...pin, recipe: location.descriptor.recipe }, readRecipePin);
    bytes = new Uint8Array(pin.size);
    let offset = 0;
    for (const leaf of proof.leaves) {
      const part = await readRecipePin(leaf);
      invariant(
        offset + part.length <= bytes.length,
        'SOURCE_HASH_MISMATCH',
        'State recipe exceeds its pin.',
      );
      bytes.set(part, offset);
      offset += part.length;
    }
    invariant(offset === pin.size, 'SOURCE_HASH_MISMATCH', 'State recipe is incomplete.');
  } else {
    invariant(location.url, 'SOURCE_UNAVAILABLE', 'Selected State storage is unavailable.');
    bytes = await readSignedPhysical(
      {
        ...pin,
        ...(location.range
          ? {
              pack: {
                digest: pin.sha256,
                offset: location.range.offset,
                size: location.range.total,
              },
            }
          : {}),
      },
      location.url,
    );
  }
  invariant(
    bytes.length === pin.size && (await sha256Hex(bytes)) === pin.sha256,
    'SOURCE_HASH_MISMATCH',
    'Selected State bytes changed.',
  );
  const members = new Set(parseNativeState(bytes).files.map(file => file.blob)),
    ids = options.all ? sourceWindowOrder([...members]).slice(0, directSourceBatch) : options.digests;
  invariant(
    (options.object ? [options.object] : ids).every(id => members.has(id)),
    'SOURCE_UNAVAILABLE',
    'Digest is outside the selected State.',
  );
  if (options.object) {
    invariant(members.has(options.object), 'SOURCE_UNAVAILABLE', 'Recipe is outside the selected State.');
    const selected = catalogSourceRow((await options.catalog([options.object]))[0]);
    invariant(
      selected.pin.sha256 === options.object && selected.recipe,
      'SOURCE_UNAVAILABLE',
      'Selected member has no recipe.',
    );
    const proof = await stateRecipePins({ ...selected.pin, recipe: selected.recipe }, readRecipePin);
    invariant(
      options.digests.every(id => proof.pins.has(id)),
      'SOURCE_UNAVAILABLE',
      'Digest is outside the selected recipe.',
    );
    return { mode: 'catalog' as const, rows: await options.catalog(options.digests) };
  }
  return {
    mode: 'catalog' as const,
    rows: await options.catalog(ids),
    ...(options.all ? { digests: ids } : {}),
  };
}

/** R2 I/O must not let an earlier access decision outlive current policy or the run fence.
 * A rebind keeps the logical State unchanged. Reuse the fresh authorized descriptor
 * once, then check access and its exact pin again after the replacement transfer. */
export async function stateSourceGrants(options: Parameters<typeof buildStateSourceGrants>[0]) {
  let selected = await options.select();
  let value: Awaited<ReturnType<typeof buildStateSourceGrants>> | undefined;
  const build = (retryInvalid = false) =>
    buildStateSourceGrants(
      {
        ...options,
        select: async () => selected,
      },
      retryInvalid,
    );
  const sameState = (current: ObjectLocation) =>
    current.descriptor.object.sha256 === selected.descriptor.object.sha256 &&
    current.descriptor.object.size === selected.descriptor.object.size;
  const sameRoot = (current: ObjectLocation) =>
    current.statePhysical?.sha256 === selected.statePhysical?.sha256 &&
    current.statePhysical?.size === selected.statePhysical?.size;
  try {
    value = await build(true);
  } catch (error) {
    if (error !== refreshManifest) throw error;
  }
  let current = await options.select();
  invariant(sameState(current), 'SOURCE_UNAVAILABLE', 'Selected State changed during source resolution.');
  if (!value || !sameRoot(current)) {
    selected = current;
    value = await build();
    current = await options.select();
    invariant(
      sameState(current) && sameRoot(current),
      'SOURCE_UNAVAILABLE',
      'Selected State changed during source resolution.',
    );
  }
  return value;
}
