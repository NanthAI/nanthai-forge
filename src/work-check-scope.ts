// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource } from './native-source.js';
import { workGit } from './work-git.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

/** Runner-owned comparison of immutable inputs, never the mutable Lane or current main. */
export function writeCheckScope(store: WorkStore, run: CheckRun, directory: string) {
  const base = run.comparisonBase ?? run.base;
  let paths: string[];
  if (store.native) {
    const source = new NativeSource(store.root);
    const before = new Map(source.state(base).files.map(file => [file.path, file]));
    const after = new Map(source.state(run.head).files.map(file => [file.path, file]));
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
      run.head,
      '--',
    ]);
    if (names && !names.endsWith('\0')) throw new Error('Incomplete check comparison');
    paths = names ? names.slice(0, -1).split('\0') : [];
  }
  if (store.native) {
    const data = store.load();
    const prefix = data.landingBatches
      ?.flatMap(batch => batch.prefixes)
      .find(prefix => prefix.viewId === run.viewId);
    if (prefix) {
      const source = new NativeSource(store.root);
      for (const id of prefix.entryIds) {
        const entry = data.landingEntries!.find(entry => entry.id === id)!;
        const view = data.views.find(view => view.id === entry.viewId)!;
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
