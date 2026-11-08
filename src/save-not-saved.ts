// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import type { NativeExcludedPath } from './source-paths.js';

/** A save receipt names at most this many paths that capture left out by name. */
export const notSavedLimit = 20;
/** New paths that built-in name rules kept out of a save although no ignore rule names them:
 * credential names and stores. VCS metadata and dependency installs are never source and are
 * not listed. `paths` is the first `notSavedLimit` in walk order; `count` is the total. */
export type NotSaved = { count: number; paths: { path: string; reason: string }[] };

export function notSavedCollector() {
  const paths: NotSaved['paths'] = [];
  let count = 0;
  return {
    onExcluded(item: NativeExcludedPath) {
      if (item.ignore || item.ignoredToo) return;
      if (item.reason !== 'sensitive-name' && item.reason !== 'protected-directory') return;
      if (item.path.split('/').some(part => /^(\.git|node_modules)$/i.test(part))) return;
      count++;
      if (paths.length < notSavedLimit) paths.push({ path: item.path, reason: item.reason });
    },
    value(): NotSaved | undefined {
      return count ? { count, paths } : undefined;
    },
  };
}

/** Written next to a save's capture only when something was left out. */
export const notSavedFile = 'not-saved.json';

/** The not-saved notice a save's capture recorded, for its receipt. One local read, no call. */
export function capturedNotSaved(root: string, operationId: string): NotSaved | undefined {
  try {
    const value = JSON.parse(
      readFileSync(join(clientCacheRoot(realpathSync(root)), 'saves', operationId, notSavedFile), 'utf8'),
    ) as NotSaved;
    return value.count ? value : undefined;
  } catch {
    return undefined;
  }
}
