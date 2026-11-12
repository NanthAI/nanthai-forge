// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { NativeFile } from '../src/state/format';
import type { WorkerPin } from '../src/hosted-source-worker-format';
import type { PhysicalEntry } from '../src/physical-manifest-codec';
import type { PhysicalManifestReader } from '../src/physical-manifest';
import type { SourceOutput } from './projectConvexSourceOutput';
import type { ObjectLocation } from './projectConvexSourceTransport';
import { ForgeError } from '../src/errors';
import { r2Key } from './r2';
import { writePhysicalManifest, repairPhysicalRoot } from '../src/physical-manifest-write';
type PhysicalOutput = NonNullable<SourceOutput['physical']>[number];
/** Preserve exact canonical and maintenance nonce keys; never infer an arbitrary URL. */
export function physicalSourceBinding(
  projectId: Id<'hostedProjects'>,
  row: ObjectLocation,
  storedKey?: string,
): PhysicalEntry | null {
  const object = row.descriptor.object;
  if (row.descriptor.recipe) return { ...object, recipe: row.descriptor.recipe };
  const prefix = r2Key(projectId, ''),
    path = storedKey ?? (row.url ? new URL(row.url).pathname : ''),
    at = path.lastIndexOf(prefix),
    key = at < 0 ? '' : path.slice(at + prefix.length),
    match = /^([a-f0-9]{64})(?:\/u\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}))?$/.exec(
      key,
    );
  if (
    !match ||
    (storedKey !== undefined && storedKey !== prefix + key) ||
    (!row.range && match[1] !== object.sha256)
  )
    return null;
  if (row.url && !new URL(row.url).pathname.endsWith('/' + r2Key(projectId, key))) return null;
  const nonce = match[2] === undefined ? {} : { nonce: match[2] };
  return {
    ...object,
    ...(row.range
      ? { pack: { digest: match[1]!, size: row.range.total, offset: row.range.offset, ...nonce } }
      : nonce),
  };
}
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
  members: (state: string) => readonly string[] | undefined;
  describe: (ids: string[], seed: boolean) => Promise<(PhysicalEntry | null)[]>;
  put: (bytes: Uint8Array) => Promise<PhysicalOutput>;
  log: (message: string) => void;
}) {
  const pending = new Map<string, Promise<{ statePhysical: WorkerPin; physical: PhysicalOutput[] } | null>>();
  const entry = (row: ObjectLocation) =>
    physicalSourceBinding(options.projectId, row, options.key(row.descriptor.object.sha256));
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
        } catch (error) {
          if (
            options.sourceKind === 'compose' &&
            (!(error instanceof ForgeError) || error.code !== 'SOURCE_HASH_MISMATCH')
          )
            throw error;
          options.log('source bindings: catalog (physical parent invalid or unavailable; writer skipped)');
        }
      }
      if (!parent && !seed) return null;
      const physical: PhysicalOutput[] = [];
      const result = await writePhysicalManifest({
        state: pin.sha256,
        members: files.map(file => file.blob),
        parent,
        ...(parent ? { parentMembers: options.members(parent.root.state) } : {}),
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
  const compose = async (pin: WorkerPin, files: readonly NativeFile[], mainId: string) => {
    if (pin.sha256 === mainId) return;
    const row = options.locations.get(pin.sha256),
      mainRow = options.locations.get(mainId);
    if (!row) return;
    // Only invalid derived bytes count as absent. Network and storage failures
    // fail the step and retain the ordinary retry contract.
    const open = async (location: ObjectLocation | undefined) => {
      if (!location?.statePhysical) return null;
      try {
        return await options.reader(location);
      } catch (error) {
        if (!(error instanceof ForgeError) || error.code !== 'SOURCE_HASH_MISMATCH') throw error;
        options.log('source bindings: catalog (compose physical root invalid)');
        return null;
      }
    };
    const [head, main] = await Promise.all([open(row), open(mainRow)]);
    if (!head && !row.statePhysical) return existing(pin, files, [mainId], false);
    if (!head) {
      // Regenerate the invalid derived root from verified main membership.
      const original = row.statePhysical;
      delete row.statePhysical;
      try {
        await existing(pin, files, [mainId], false);
        const output = options.outputs.at(-1);
        if (output?.sha256 === pin.sha256 && output.statePhysical) output.statePhysicalRebind = true;
        else
          throw new ForgeError(
            'SOURCE_HASH_MISMATCH',
            'Compose could not replace its invalid physical root.',
          );
      } catch (error) {
        if (original) row.statePhysical = original;
        throw error;
      }
      return;
    }
    if (!main) return;
    const physical: PhysicalOutput[] = [];
    const result = await repairPhysicalRoot({
      state: pin.sha256,
      head,
      main: main.root,
      put: async bytes => {
        const stored = await options.put(bytes);
        physical.push(stored);
        return stored;
      },
    });
    if (!result) {
      options.log('source bindings: compose kept physical manifest');
      return;
    }
    const binding = entry(row);
    if (!binding)
      throw new ForgeError('SOURCE_HASH_MISMATCH', 'Compose physical State binding is unavailable.');
    options.outputs.push({
      ...pin,
      statePhysical: result.pin,
      statePhysicalRebind: true,
      physical,
      ...(binding.recipe
        ? { recipe: binding.recipe }
        : {
            r2Key: r2Key(options.projectId, binding.pack?.digest ?? pin.sha256),
            ...(binding.pack ? { pack: binding.pack } : {}),
          }),
    });
    row.statePhysical = result.pin;
    options.log(
      `source bindings: compose repaired physical manifest (${physical.reduce((sum, pin) => sum + pin.size, 0)} planned metadata bytes)`,
    );
  };
  return {
    output: (pin: WorkerPin, files: readonly NativeFile[], bases: readonly string[]) =>
      create(pin, files, bases, false),
    ...(options.enabled && options.sourceKind === 'compose' ? { composePhysicalState: compose } : {}),
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
