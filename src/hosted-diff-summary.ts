// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { NativeFile } from './native-source.js';
import type { ReviewPath } from './source-review-format.js';
import { reviewCounts, reviewEntry, type ReviewGroup } from './review-order.js';

export type DiffSummaryMain = 'equal' | 'absent' | 'different';
/** Most paths one summary page may list; the byte budget can end a page earlier. */
export const DIFF_SUMMARY_PAGE = 500;

/** Where one changed path stands against current main, from manifest entries only (no blob is read).
 * equal: main already holds the Lane's saved bytes and mode (a path the Lane deleted that main lacks counts as equal).
 * absent: the Lane saves the path and main has no such path.
 * different: both sides have the path and they differ, or the Lane deleted a path main still has. */
export function mainStanding(after: NativeFile | null, onMain: NativeFile | undefined): DiffSummaryMain {
  if (!after) return onMain ? 'different' : 'equal';
  if (!onMain) return 'absent';
  return onMain.blob === after.blob && onMain.mode === after.mode ? 'equal' : 'different';
}

/** One bounded page of per-path standings against main. `changes` are all pinned changed paths in
 * sorted order; counts cover every one of them, the page covers `offset` onward within `byteBudget`.
 * Each item also carries the review group and reason the web review screen shows (review-order.ts), from the
 * same manifest facts; protected paths and conflicts come from `policy` and `peers`, so no call is added. */
export function summarizeAgainstMain(
  changes: ReviewPath[],
  mainFiles: NativeFile[],
  offset: number,
  byteBudget: number,
  /** The one docs rule (prose-paths.ts), passed in by the caller that already loads it, so this lazy chunk adds no
   * module or chunk to any agent command. */
  isDoc: (path: string) => boolean,
) {
  const onMain = new Map(mainFiles.map(file => [file.path, file]));
  const standing = changes.map(item => mainStanding(item.after, onMain.get(item.path)));
  const counts = { equal: 0, absent: 0, different: 0 };
  for (const state of standing) counts[state]++;
  const review = changes.map(item =>
    reviewEntry({
      path: item.path,
      doc: isDoc(item.path),
      status: item.status === 'unchanged' ? 'modified' : item.status,
      before: item.before?.mode ?? null,
      after: item.after?.mode ?? null,
    }),
  );
  const items: {
    path: string;
    status: ReviewPath['status'];
    main: DiffSummaryMain;
    group: ReviewGroup;
    reason: string;
  }[] = [];
  let outputBytes = 0,
    end = offset;
  for (; end < changes.length && end < offset + DIFF_SUMMARY_PAGE; end++) {
    const item = {
      path: changes[end]!.path,
      status: changes[end]!.status,
      main: standing[end]!,
      group: review[end]!.group,
      reason: review[end]!.reason,
    };
    const bytes = JSON.stringify(item).length + 1;
    if (items.length && outputBytes + bytes > byteBudget) break;
    outputBytes += bytes;
    items.push(item);
  }
  return { items, counts, groups: reviewCounts(review), outputBytes, end };
}
