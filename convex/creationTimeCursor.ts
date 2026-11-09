// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';

/** Paging rule for time-window reads over `_creationTime` (Issue 9c0ba6e1): rows can share one
 * instant (a batch written by one mutation), so a bare time cursor either repeats the tied rows
 * or never advances. The cursor is `TIME` or `TIME:SKIP`: resume at TIME and skip the SKIP rows
 * of that exact instant the earlier page already returned. Rows at one instant keep a stable
 * order, so the skip is exact. A page returns every row or a cursor; it is never silently short. */
export function readCreationCursor(cursor: string | null | undefined, start: number, end: number) {
  const [time = '', skip = '0'] = (cursor ?? '').split(':');
  const resume = cursor ? Number(time) : start;
  const skipped = Number(skip);
  invariant(
    Number.isFinite(resume) &&
      resume >= start &&
      resume < end &&
      Number.isInteger(skipped) &&
      skipped >= 0 &&
      skipped <= 1000,
    'BAD_ARGUMENT',
    'The cursor does not belong to this window.',
  );
  return { resume, skip: skipped };
}
/** The cursor for `rows[index]`, the first row a page did not return. `rows` is the whole fetched
 * list from `resume`, skipped rows included: the cursor names its time and how many earlier rows of
 * that same instant the list holds, so the next page skips exactly those. */
export function nextCreationCursor(rows: { _creationTime: number }[], index: number) {
  const time = rows[index]!._creationTime;
  let used = 0;
  while (used < index && rows[index - 1 - used]!._creationTime === time) used++;
  return used ? `${time}:${used}` : String(time);
}
