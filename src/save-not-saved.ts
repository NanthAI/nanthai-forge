// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import type { NativeExcludedPath } from './source-paths.js';

/** A save receipt names at most this many paths that capture left out by name. */
export const notSavedLimit = 20;
/** New paths that built-in rules kept out of a save although no ignore rule names them:
 * credential stores, local credential files, credential-looking names whose bytes could not be
 * checked (`sensitive-name`) and files whose bytes hold a credential (`secret-content`). VCS
 * metadata and dependency installs are never source and are not listed. `paths` is the first
 * `notSavedLimit` in walk order; `count` is the total; `include` says how to save one on purpose. */
export type NotSaved = { count: number; paths: { path: string; reason: string }[]; include: string };
/** One line: the deliberate include. The landing secret scan still checks what it saves. */
export const notSavedInclude =
  'To save a listed fixture on purpose, add "!PATH" to .forgeignore (never for .env, .env.local or .netrc); the landing secret scan still checks it.';
const listed = new Set(['sensitive-name', 'protected-directory', 'secret-content']);

export function notSavedCollector() {
  const paths: NotSaved['paths'] = [];
  let count = 0;
  return {
    onExcluded(item: NativeExcludedPath) {
      if (item.ignore || item.ignoredToo) return;
      if (!listed.has(item.reason)) return;
      if (item.path.split('/').some(part => /^(\.git|node_modules)$/i.test(part))) return;
      count++;
      if (paths.length < notSavedLimit) paths.push({ path: item.path, reason: item.reason });
    },
    value(): NotSaved | undefined {
      return count ? { count, paths, include: notSavedInclude } : undefined;
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
    // A notice written before `include` existed gets the same line.
    return value.count ? { ...value, include: notSavedInclude } : undefined;
  } catch {
    return undefined;
  }
}
