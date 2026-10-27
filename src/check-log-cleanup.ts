// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, readdirSync, realpathSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { DAY_MS, LOCAL_LOG_DAYS, providerLogUrl } from './check-log-policy.js';
import { retainCompactCheckReports } from './check-compact-output.js';
import { coverageCacheFiles } from './check-coverage-cache.js';
import type { WorkStore } from './work-store.js';

/** Explicit provider-log migration, or age-based local retention during lifecycle work.
 * Never follows links or removes result/recipe/build-output files. Apply re-observes exact bytes. */
export function localCheckLogPlan(store: WorkStore, now = Date.now(), providers = false) {
  const files: { path: string; size: number; sha256: string; runId: string }[] = [];
  for (const run of store.load().runs) {
    if (!run.endedAt || ['queued', 'preparing', 'running'].includes(run.status) || run.backend?.retryable)
      continue;
    if (providerLogUrl(run) ? !providers : !(now - Date.parse(run.endedAt) >= LOCAL_LOG_DAYS * DAY_MS))
      continue;
    const directory = join(store.directory, `check-${run.id}`);
    if (!existsSync(directory) || realpathSync(directory) !== directory) continue;
    const names = readdirSync(directory).filter(
      name => name.endsWith('.log') || name === 'test-reports.json',
    );
    const shards = join(directory, 'shards');
    if (existsSync(shards) && realpathSync(shards) === shards)
      names.push(
        ...readdirSync(shards)
          .filter(name => /\.(?:log|evidence)$/.test(name))
          .map(name => `shards/${name}`),
      );
    for (const name of names) {
      const path = join(directory, name),
        info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) continue;
      if (!providerLogUrl(run) && now - info.mtimeMs < LOCAL_LOG_DAYS * DAY_MS) continue;
      files.push({
        path: path.slice(store.directory.length + 1),
        size: info.size,
        sha256: digest(readFileSync(path)),
        runId: run.id,
      });
    }
  }
  for (const file of coverageCacheFiles(store)) {
    if (!providers && now - file.at < LOCAL_LOG_DAYS * DAY_MS) continue;
    files.push({
      path: file.path.slice(store.directory.length + 1),
      size: file.size,
      sha256: digest(readFileSync(file.path)),
      runId: file.runId,
    });
  }
  return { files, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}
export function cleanLocalCheckLogs(
  store: WorkStore,
  input: {
    apply?: boolean;
    providers?: boolean;
    now?: number;
    files?: ReturnType<typeof localCheckLogPlan>['files'];
  } = {},
) {
  // Hydrate before taking the writer lock; only exact metadata/file publication is locked.
  const revision = store.revision(),
    current = localCheckLogPlan(store, input.now, input.providers);
  const expected = input.files && new Map(input.files.map(file => [file.path, file]));
  const files = expected ? current.files.filter(file => expected.has(file.path)) : current.files;
  for (const file of files)
    invariant(
      !expected || expected.get(file.path)?.sha256 === file.sha256,
      'EVIDENCE_CHANGED',
      'Selected log bytes changed; retain the original cleanup plan.',
    );
  const plan = { files, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  const result = (deleted: number) => ({
    ...plan,
    dryRun: !input.apply,
    deleted,
    retained: 'Results, failure summaries, compact test evidence, recipes, execution IDs and provider links.',
  });
  if (!input.apply) return result(0);
  return store.locked(() => {
    if (store.revision() !== revision)
      return { ...result(0), skipped: 'Work changed before cleanup; no files were removed.' };
    for (const runId of new Set(files.map(file => file.runId))) {
      const directory = join(store.directory, `check-${runId}`);
      retainCompactCheckReports(directory);
    }
    for (const file of files) {
      const path = join(store.directory, file.path),
        info = lstatSync(path);
      invariant(
        info.isFile() &&
          !info.isSymbolicLink() &&
          info.nlink === 1 &&
          realpathSync(path) === path &&
          info.size === file.size &&
          digest(readFileSync(path)) === file.sha256,
        'EVIDENCE_CHANGED',
        'Log bytes changed since cleanup planning; retry with current files.',
      );
    }
    for (const file of files) {
      unlinkSync(join(store.directory, file.path));
    }
    return result(files.length);
  });
}
