// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { NativeSource } from './native-source.js';
import { nativeReachable } from './native-reachable.js';
import { invariant } from './errors.js';
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
  return store.locked(() => {
    const data = store.load(),
      source = new NativeSource(store.root);
    // Validate the entire retained closure before changing metadata or deleting anything.
    const retained = new Set(nativeReachable(store, data));
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
      // Older schema1/2 writers must reject before registering references using
      // their former insert-before-lock protocol. Inspection never upgrades.
      if (data.schema < 3) {
        data.schema = 3;
        data.revision++;
        store.save(data);
      }
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
          'Retained native State ancestry, source, Git provenance/projections, observations and historical Work archives. Workspaces, check evidence, backup files, temporary files and unknown entries are not collected.',
        compatibility:
          command.action === 'collect-native-objects'
            ? `This native owner requires Work format ${data.schema} readers. Each retry recomputes reachability; completed deletions are not rolled back.`
            : `Inspection leaves Work format ${data.schema} unchanged. Explicit collection upgrades older owners to at least format 3.`,
      },
    };
  });
}
