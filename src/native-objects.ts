import { recordRoots } from './work-record-reachability.js';
// SPDX-License-Identifier: Apache-2.0
import { recordCollectionFence } from './work-record-staging.js';
import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { NativeSource } from './native-source.js';
import { nativeReachable } from './native-reachable.js';
import { invariant } from './errors.js';
import { withAutoSnapshotLock } from './lane-auto-snapshot.js';
import { autoSnapshotObjects } from './lane-auto-snapshot-retention.js';
import type { WorkStore } from './work-store.js';

export const nativeObjectCommandSchema = z.object({
  action: z.enum(['inspect-native-objects', 'collect-native-objects']),
});
export type NativeObjectCommand = z.infer<typeof nativeObjectCommandSchema>;

// Collection shares the existing Work lock with every referencing CAS registration.
// No ages, cached scans, temporary-file cleanup or background deletion are involved.
export function nativeObjects(store: WorkStore, input: unknown) {
  const command = nativeObjectCommandSchema.parse(input);
  invariant(
    store.native,
    'UNSUPPORTED_NATIVE_WORK',
    'Native object inspection and collection use a native Work owner.',
  );
  // The auto-snapshot lock excludes publication of a Lane's latest snapshot, so
  // objects written for it are either retained here or rewritten after collection.
  return store.locked(() =>
    withAutoSnapshotLock(
      store,
      () =>
        recordCollectionFence(store.directory, () => {
          const data = store.load(),
            source = new NativeSource(store.root);
          // Validate the entire retained closure before changing metadata or deleting anything.
          const retained = new Set([...nativeReachable(store, data), ...autoSnapshotObjects(store, source)]);
          const recordDirectory = join(store.directory, 'records');
          const pinnedDetails = recordRoots(
            store,
            new Set(
              existsSync(recordDirectory)
                ? readdirSync(recordDirectory).filter(id => /^[0-9a-f]{64}$/.test(id))
                : [],
            ),
          ).details;
          for (const pin of pinnedDetails.values()) {
            // Opaque historical pins conservatively retain existing objects;
            // current Work closure was verified by nativeReachable above.
            if (existsSync(join(source.directory, pin.sha256))) retained.add(pin.sha256);
          }
          const candidates: { id: string; bytes: number }[] = [],
            preserved: { name: string; reason: string }[] = [];
          let retainedBytes = 0;
          for (const name of readdirSync(source.directory).sort()) {
            const path = join(source.directory, name),
              stat = lstatSync(path);
            if (retained.has(name)) {
              retainedBytes += stat.size;
              continue;
            }
            if (!/^[0-9a-f]{64}$/.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
              preserved.push({ name, reason: 'Not an unreferenced ordinary digest object.' });
              continue;
            }
            // Preserve malformed objects for diagnosis; only collect exact immutable identities.
            try {
              source.object(name);
            } catch {
              preserved.push({ name, reason: 'Object bytes or path could not be verified.' });
              continue;
            }
            candidates.push({ id: name, bytes: stat.size });
          }
          const removed: { id: string; bytes: number }[] = [];
          if (command.action === 'collect-native-objects') {
            for (const item of candidates) {
              const path = join(source.directory, item.id),
                stat = lstatSync(path);
              if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== item.bytes) {
                preserved.push({ name: item.id, reason: 'Object metadata changed after inspection.' });
                continue;
              }
              source.object(item.id);
              unlinkSync(path);
              removed.push(item);
            }
          }
          return {
            revision: data.revision,
            result: {
              action: command.action,
              private: true,
              format: data.schema,
              retained: { objects: retained.size, bytes: retainedBytes },
              candidates,
              removed,
              preserved,
              coverage:
                'Retained native State ancestry, source, Git provenance/projections, observations, historical Work archives and unexpired closed-Lane or latest open-Lane auto-snapshots. Workspaces, check evidence, backup files, temporary files and unknown entries are not collected.',
              compatibility:
                command.action === 'collect-native-objects'
                  ? `This native owner requires Work format ${data.schema} readers. Each retry recomputes reachability; completed deletions are not rolled back.`
                  : `Inspection leaves Work format ${data.schema} unchanged. Explicit collection upgrades older owners to at least format 3.`,
            },
          };
        }),
      60_000,
    ),
  );
}
