import { semanticTests } from './intent-semantic-conflict.js';
import { landingCheckPrefix } from './landing-records.js';
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource } from './native-source.js';
import { workGit } from './work-git.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

/** Compare immutable saved source without materializing or executing it. */
export function checkChangedPaths(store: WorkStore, base: string, head: string) {
  let paths: string[];
  if (store.native) {
    const source = new NativeSource(store.root);
    const before = new Map(source.state(base).files.map(file => [file.path, file]));
    const after = new Map(source.state(head).files.map(file => [file.path, file]));
    paths = [...new Set([...before.keys(), ...after.keys()])].filter(path => {
      const a = before.get(path),
        b = after.get(path);
      return a?.blob !== b?.blob || a?.mode !== b?.mode;
    });
  } else {
    const names = workGit(store.root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-only',
      '-z',
      base,
      head,
      '--',
    ]);
    if (names && !names.endsWith('\0')) throw new Error('Incomplete check comparison');
    paths = names ? names.slice(0, -1).split('\0') : [];
  }
  return paths.sort();
}

/** Runner-owned comparison of immutable inputs, never the mutable Lane or current main. */
export function writeCheckScope(store: WorkStore, run: CheckRun, directory: string) {
  const base = run.comparisonBase ?? run.base;
  let paths = checkChangedPaths(store, base, run.head);
  if (store.native) {
    const indexed = store.readRecords?.();
    const legacy = indexed ? undefined : store.load();
    const prefix = indexed
      ? landingCheckPrefix(store, run.viewId)
      : legacy?.landingBatches?.flatMap(batch => batch.prefixes).find(prefix => prefix.viewId === run.viewId);
    if (prefix) {
      const source = new NativeSource(store.root);
      for (const id of prefix.entryIds) {
        const entry = (
          indexed
            ? store.select('landingEntries', id)
            : legacy?.landingEntries?.find(entry => entry.id === id)
        )!;
        const view = (
          indexed ? store.select('views', entry.viewId) : legacy?.views.find(view => view.id === entry.viewId)
        )!;
        const before = new Map(
          source.state(view.composedMain ?? view.base).files.map(file => [file.path, file]),
        );
        const after = new Map(source.state(view.head!).files.map(file => [file.path, file]));
        for (const path of new Set([...before.keys(), ...after.keys()]))
          if (
            before.get(path)?.blob !== after.get(path)?.blob ||
            before.get(path)?.mode !== after.get(path)?.mode
          )
            paths.push(path);
      }
      paths = [...new Set(paths)];
    }
  }
  const path = join(directory, 'changes.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      base,
      comparison: run.comparisonBase ? 'main' : 'view-base',
      head: run.head,
      paths: paths.sort(),
      ...(store.select?.('views', run.viewId)?.semanticPlan
        ? { semanticTests: semanticTests(store.select?.('views', run.viewId)?.semanticPlan) }
        : {}),
      ...(run.interaction !== undefined ? { interaction: run.interaction } : {}),
      ...(run.recovery ? { recovery: run.recovery } : {}),
      ...(run.optimistic || run.recovery ? { optimistic: true } : {}),
      ...(run.mainCheck ? { mainCheck: run.mainCheck } : {}),
    }),
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
  return path;
}
