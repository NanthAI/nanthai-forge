// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { coverageSourcePath, DAY_MS } from './check-log-policy.js';
import type { CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';

export const COVERAGE_CACHE_FILES = 3;
export const COVERAGE_CACHE_BYTES = 16 * 1024 * 1024;
export const COVERAGE_CACHE_DAYS = 7;
/** Generated cache discovery uses provenance, not artifact numbering. Never follows links. */
export function coverageCacheFiles(store: WorkStore, runs: CheckRun[] = store.load().runs) {
  return runs.flatMap(run =>
    (run.artifacts ?? []).flatMap(item => {
      if (item.status !== 'retained' || item.sourcePath !== coverageSourcePath) return [];
      const path = join(store.directory, `check-${run.id}/artifacts/${item.filename}`);
      try {
        const stat = lstatSync(path);
        return stat.isFile() && stat.nlink === 1 && realpathSync(path) === path
          ? [{ path, size: stat.size, at: stat.mtimeMs, runId: run.id }]
          : [];
      } catch {
        return [];
      }
    }),
  );
}
/** Activity-driven LRU-like bound. Missing caches simply retain the static/full selection. */
export function pruneCoverageCache(store: WorkStore, pending?: CheckRun, now = Date.now()) {
  const runs = store.load().runs.filter(run => run.id !== pending?.id);
  if (pending) runs.push(pending);
  const files = coverageCacheFiles(store, runs).sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
  let count = 0,
    bytes = 0;
  for (const file of files) {
    if (
      now - file.at >= COVERAGE_CACHE_DAYS * DAY_MS ||
      count >= COVERAGE_CACHE_FILES ||
      bytes + file.size > COVERAGE_CACHE_BYTES
    )
      unlinkSync(file.path);
    else {
      count++;
      bytes += file.size;
    }
  }
  return { files: count, bytes };
}
