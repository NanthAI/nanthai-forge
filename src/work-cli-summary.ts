// SPDX-License-Identifier: Apache-2.0
import { WorkStore } from './work-store.js';
import { recordManifest } from './work-records.js';
import { workGit } from './work-git.js';
import { invariant } from './errors.js';
import { workSchema } from './work-types.js';
import { unifiedWorkSchema } from './work-unified-types.js';

/** Revision and collection sizes need no reviews, source diffs or history hydration. */
export function workCliSummary(root: string) {
  const store = new WorkStore(root);
  return store.observing(() => {
    const bytes = store.pointer(),
      manifest = bytes ? recordManifest(JSON.parse(bytes.toString('utf8'))) : undefined,
      data = manifest?.fields ?? store.load();
    const names = new Set([...Object.keys(workSchema.shape), ...Object.keys(unifiedWorkSchema.shape)]);
    const nativeHead = data.nativeHead;
    invariant(
      nativeHead === undefined || (typeof nativeHead === 'string' && /^[a-f0-9]{64}$/.test(nativeHead)),
      'INVALID_WORK_STORE',
      'The Work source head is invalid.',
    );
    const counts = manifest
      ? Object.fromEntries(
          Object.entries(manifest.collections)
            .filter(([name]) => names.has(name))
            .map(([name, collection]) => [name, collection.count]),
        )
      : Object.fromEntries(
          Object.entries(data)
            .filter(([name, value]) => names.has(name) && Array.isArray(value))
            .map(([name, value]) => [name, (value as unknown[]).length]),
        );
    return {
      revision: store.revision(),
      head: store.native
        ? (nativeHead ?? null)
        : workGit(store.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, true).trim() || null,
      counts,
    };
  });
}
