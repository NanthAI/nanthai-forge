// SPDX-License-Identifier: Apache-2.0
import type { NativeFile } from './native-source.js';
import type { ReviewPath } from './source-review-format.js';

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
 * sorted order; counts cover every one of them, the page covers `offset` onward within `byteBudget`. */
export function summarizeAgainstMain(
  changes: ReviewPath[],
  mainFiles: NativeFile[],
  offset: number,
  byteBudget: number,
) {
  const onMain = new Map(mainFiles.map(file => [file.path, file]));
  const standing = changes.map(item => mainStanding(item.after, onMain.get(item.path)));
  const counts = { equal: 0, absent: 0, different: 0 };
  for (const state of standing) counts[state]++;
  const items: { path: string; status: ReviewPath['status']; main: DiffSummaryMain }[] = [];
  let outputBytes = 0,
    end = offset;
  for (; end < changes.length && end < offset + DIFF_SUMMARY_PAGE; end++) {
    const item = { path: changes[end]!.path, status: changes[end]!.status, main: standing[end]! };
    const bytes = JSON.stringify(item).length + 1;
    if (items.length && outputBytes + bytes > byteBudget) break;
    outputBytes += bytes;
    items.push(item);
  }
  return { items, counts, outputBytes, end };
}
