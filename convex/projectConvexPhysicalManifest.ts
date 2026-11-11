// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { NativeFile } from '../src/state/format';
import type { WorkerPin } from '../src/hosted-source-worker-format';
import type { PhysicalEntry } from '../src/physical-manifest-codec';
import type { PhysicalManifestReader } from '../src/physical-manifest';
import type { SourceOutput } from './projectConvexSourceOutput';
import type { ObjectLocation } from './projectConvexSourceTransport';
import { r2Key } from './r2';
type PhysicalOutput = NonNullable<SourceOutput['physical']>[number];
/** The same action/commit owns State bytes and their derived physical recipe.
 * Only compose may seed. Ordinary saves/syncs never enumerate the catalog. */
export function sourcePhysicalManifests(options: {
  enabled: boolean;
  sourceKind?: string | undefined;
  projectId: Id<'hostedProjects'>;
  locations: Map<string, ObjectLocation>;
  outputs: SourceOutput[];
  key: (id: string) => string | undefined;
  reader: (row: ObjectLocation) => Promise<PhysicalManifestReader>;
  describe: (ids: string[], seed: boolean) => Promise<(PhysicalEntry | null)[]>;
  put: (bytes: Uint8Array) => Promise<PhysicalOutput>;
  log: (message: string) => void;
}) {
  const pending = new Map<string, Promise<{ statePhysical: WorkerPin; physical: PhysicalOutput[] } | null>>();
  function entry(row: ObjectLocation): PhysicalEntry | null {
    const object = row.descriptor.object;
    if (row.descriptor.recipe) return { ...object, recipe: row.descriptor.recipe };
    const key =
      options.key(object.sha256) ?? (row.url ? new URL(row.url).pathname.split('/').at(-1) : undefined);
    if (!key || !/^[a-f0-9]{64}$/.test(key)) return null;
    if (row.url && !new URL(row.url).pathname.endsWith('/' + r2Key(options.projectId, key))) return null;
    return {
      ...object,
      ...(row.range ? { pack: { digest: key, size: row.range.total, offset: row.range.offset } } : {}),
    };
  }
  const create = async (
    pin: WorkerPin,
    files: readonly NativeFile[],
    bases: readonly string[],
    seed: boolean,
  ) => {
    if (!options.enabled) return null;
    const old = options.locations.get(pin.sha256)?.statePhysical;
    if (old) return { statePhysical: old, physical: [] };
    let running = pending.get(pin.sha256);
    if (running) return running;
    running = (async () => {
      let parent: PhysicalManifestReader | null = null;
      const preferred = options.sourceKind === 'sync' ? [...bases].reverse() : bases;
      for (const id of preferred) {
        const row = options.locations.get(id);
        if (!row?.statePhysical) continue;
        try {
          parent = await options.reader(row);
          break;
        } catch {
          options.log('source bindings: catalog (physical parent invalid or unavailable; writer skipped)');
        }
      }
      if (!parent && !seed) return null;
      const { writePhysicalManifest } = await import('../src/physical-manifest-write');
      const physical: PhysicalOutput[] = [];
      const result = await writePhysicalManifest({
        state: pin.sha256,
        members: files.map(file => file.blob),
        parent,
        describe: async ids => {
          const known = ids.map(id => options.locations.get(id)),
            missing = ids.filter((_id, index) => !known[index]);
          const described = missing.length ? await options.describe(missing, seed) : [];
          const byId = new Map(missing.map((id, index) => [id, described[index] ?? null]));
          return ids.map((id, index) => (known[index] ? entry(known[index]!) : (byId.get(id) ?? null)));
        },
        put: async bytes => {
          const stored = await options.put(bytes);
          physical.push(stored);
          return stored;
        },
      });
      if (!result) {
        options.log('source bindings: catalog (legacy physical bindings; writer skipped)');
        return null;
      }
      options.log(
        seed
          ? 'source bindings: compose physical manifest seed'
          : 'source bindings: incremental physical manifest',
      );
      return { statePhysical: result.pin, physical };
    })();
    pending.set(pin.sha256, running);
    return running;
  };
  const existing = async (
    pin: WorkerPin,
    files: readonly NativeFile[],
    bases: readonly string[],
    seed: boolean,
  ) => {
    if (options.locations.get(pin.sha256)?.statePhysical) return;
    const row = options.locations.get(pin.sha256);
    if (!row) return;
    const binding = entry(row);
    if (!binding) return;
    const result = await create(pin, files, bases, seed);
    if (!result) return;
    const output: SourceOutput = {
      ...pin,
      ...result,
      ...(binding.recipe
        ? { recipe: binding.recipe }
        : {
            r2Key: r2Key(options.projectId, binding.pack?.digest ?? pin.sha256),
            ...(binding.pack ? { pack: binding.pack } : {}),
          }),
    };
    row.statePhysical = result.statePhysical;
    options.outputs.push(output);
  };
  return {
    output: (pin: WorkerPin, files: readonly NativeFile[], bases: readonly string[]) =>
      create(pin, files, bases, false),
    ...(options.enabled
      ? {
          writePhysicalState: (pin: WorkerPin, files: readonly NativeFile[], bases: readonly string[]) =>
            existing(pin, files, bases, false),
          ...(options.sourceKind === 'compose'
            ? {
                seedPhysicalState: (pin: WorkerPin, files: readonly NativeFile[]) =>
                  existing(pin, files, [], true),
              }
            : {}),
        }
      : {}),
  };
}
