// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Exact conflicts at save (flip 4, Issue 853fcde3): what the overlap read returns when a trial merge of
 * this Lane's saved files against main or another open Lane really conflicts. */
export const exactConflictsSchema = z.array(
  z.object({
    with: z.string(),
    goal: z.string(),
    flaggedAt: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        mine: z.array(z.array(z.number())),
        theirs: z.array(z.array(z.number())),
        reason: z.string(),
      }),
    ),
  }),
);
export type ExactConflicts = z.infer<typeof exactConflictsSchema>;

const lines = (ranges: number[][]) =>
  ranges.length
    ? ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(', ')
    : 'whole file';
// Peer goals are member-written: one line, no control characters, bounded.
const quoted = (text: string) =>
  // eslint-disable-next-line no-control-regex
  JSON.stringify(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 160));

/** The receipt's notice and its next step. Nothing to acknowledge: it clears when a later save of
 * either Lane no longer conflicts, or when one side lands or is abandoned. */
export function exactConflictNotice(laneId: string, conflicts: ExactConflicts) {
  if (!conflicts.length) return undefined;
  const items = conflicts.flatMap(conflict =>
    conflict.files.map(file => ({
      file: file.path,
      with: conflict.with,
      ...(conflict.with === 'main' ? {} : { goal: conflict.goal }),
      lines: lines(file.mine),
      theirLines: lines(file.theirs),
      reason: file.reason,
      flaggedAt: conflict.flaggedAt,
    })),
  );
  const main = conflicts.some(conflict => conflict.with === 'main');
  const peers = conflicts.filter(conflict => conflict.with !== 'main').map(conflict => conflict.with);
  const next = [
    main ? `Sync now; your saved files conflict with main: nforge agent . sync '{"laneId":"${laneId}"}'` : '',
    peers.length
      ? `Your saved files conflict with Lane ${peers.join(', ')}. Agree an order or split with that Lane (board note), or change your edit, then save.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    summary: `${items.length} exact conflict(s): a trial merge of saved files really conflicts. No answer needed; it clears when a save no longer conflicts.`,
    items: items.slice(0, 10),
    next,
  };
}
export type ExactConflictNotice = NonNullable<ReturnType<typeof exactConflictNotice>>;

/** Human banner for stderr. */
export function exactConflictBanner(notice: ExactConflictNotice) {
  return [
    '',
    'EXACT CONFLICT (trial merge of saved files)',
    ...notice.items.map(
      item =>
        `  - ${item.file} lines ${item.lines} with ${item.with === 'main' ? 'main' : `Lane ${item.with} ${quoted(item.goal ?? '')}`} (their lines ${item.theirLines}): ${item.reason}`,
    ),
    `Next: ${notice.next}`,
    '',
  ].join('\n');
}
const shown = new Set<string>();
/** The banner once per process for each file, Lane and line set. */
export function exactConflictBannerOnce(notice: ExactConflictNotice) {
  const fresh = notice.items.filter(item => {
    const key = `${item.file}\0${item.with}\0${item.lines}`;
    if (shown.has(key)) return false;
    shown.add(key);
    return true;
  });
  return fresh.length ? exactConflictBanner({ ...notice, items: fresh }) : '';
}
