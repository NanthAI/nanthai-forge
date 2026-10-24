// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { reviewPaths } from './native-source-review.js';
import { pathsOverlap } from './work-interaction.js';
import { workProgress } from './work-progress.js';
import type { WorkStore } from './work-store.js';
import type { FinishAttempt } from './agent-finish-journal.js';

export function finishRetryProgress(store: WorkStore, old: FinishAttempt, next: FinishAttempt) {
  let overlap: string[] | null = null;
  const view = old.view && store.select('views', old.view.viewId as string);
  const base = view?.composedMain;
  if (store.native && base && view?.head && next.previous) {
    try {
      const source = new NativeSource(store.root);
      const changed = (head: string) =>
        reviewPaths(source.state(base).files, source.state(head).files)
          .filter(file => file.status !== 'unchanged')
          .map(file => file.path);
      const left = changed(view.head),
        right = changed(next.previous);
      overlap = [
        ...new Set(
          [...left, ...right].filter(path =>
            left.some(a => right.some(b => pathsOverlap(a, b) && (path === a || path === b))),
          ),
        ),
      ].sort();
    } catch {
      /* Unavailable paths remain explicitly unknown. */
    }
  }
  workProgress(
    'finish retry',
    JSON.stringify({
      oldMain: base?.slice(0, 8) ?? old.previous?.slice(0, 8) ?? null,
      newMain: next.previous?.slice(0, 8) ?? null,
      overlappingPaths: overlap?.slice(0, 10) ?? null,
      overlapCount: overlap?.length ?? null,
      fastPathRejection: old.error?.message ?? 'Dependency moved; new candidate required',
      replacementRunId: next.operations.run,
    }),
    `finish retry ${next.number}`,
  );
}
