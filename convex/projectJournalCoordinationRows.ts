// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import { loadedJournalRows, requireJournal, JournalNeeded, journalDependency } from './projectJournalStore';
import type { JournalIndex } from '../src/journal-segment';
import type { FeedScope } from './coordinationFeed';
/** Creation-time/id positions retain ties exactly, as the existing feed cursor does. */
export const coordinationJournalKey = (projectId: string, position: (string | number)[]) =>
  position.length
    ? `${projectId}:${Number(position[0]).toFixed(6).padStart(23, '0')}:${position[1]}`
    : `${projectId}:`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (row: Doc<'projectCoordinationEvents'>) =>
  coordinationJournalKey(row.projectId, [row._creationTime, row._id]);
/** Groups are cut from contiguous bounded capture pages and indexed by their last source key.
 * Each group has one Lane/Intent/recipient combination, retaining indexed scoped feeds. */
export async function journalCoordinationRows(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  position: (string | number)[],
  limit: number,
  live: Doc<'projectCoordinationEvents'>[],
  scope?: FeedScope,
  newestFirst = false,
) {
  const after =
    newestFirst && !position.length ? `${projectId}:9~` : coordinationJournalKey(projectId, position);
  const direction = newestFirst ? -1 : 1;
  const query = ctx.db.query('projectJournalSegments');
  const source = newestFirst
    ? query.withIndex('by_project_and_category_and_first', q =>
        q.eq('projectId', projectId).eq('category', 'coordination').lt('firstPosition', after),
      )
    : scope?.field === 'laneId'
      ? query.withIndex('by_project_and_lane_and_last', q =>
          q.eq('projectId', projectId).eq('laneId', scope.value).gt('lastPosition', after),
        )
      : scope?.field === 'intentId'
        ? query.withIndex('by_project_and_intent_and_last', q =>
            q.eq('projectId', projectId).eq('intentId', scope.value).gt('lastPosition', after),
          )
        : scope?.field === 'recipientActor'
          ? query.withIndex('by_project_and_recipient_and_last', q =>
              q.eq('projectId', projectId).eq('recipientActor', scope.value).gt('lastPosition', after),
            )
          : query.withIndex('by_project_and_category_and_last', q =>
              q.eq('projectId', projectId).eq('category', 'coordination').gt('lastPosition', after),
            );
  const indexes = (await source.order(newestFirst ? 'desc' : 'asc').take(limit + 100)).map(
    row => JSON.parse(row.value) as JournalIndex,
  );
  journalDependency(ctx, 'coordination-selection', [
    position,
    scope ?? null,
    newestFirst,
    live.map(row => row._id),
    indexes.map(index => index.pointer.sha256),
  ]);
  const loaded = loadedJournalRows(ctx, 'projectCoordinationEvents').filter(
    row =>
      row.projectId === projectId &&
      (newestFirst ? keyOf(row) < after : keyOf(row) > after) &&
      (!scope || row[scope.field] === scope.value),
  );
  const combined = [...new Map([...loaded, ...live].map(row => [row._id, row])).values()].sort(
    (a, b) => direction * compare(keyOf(a), keyOf(b)),
  );
  const bound = combined[limit - 1]
    ? keyOf(combined[limit - 1]!)
    : newestFirst
      ? `${projectId}:`
      : `${projectId}:~`;
  const needed = indexes
    .map(index => ({
      index,
      next:
        (newestFirst
          ? [...(index.keys ?? [])].reverse().find(key => key < after)
          : index.keys?.find(key => key > after)) ?? (newestFirst ? index.endKey! : index.startKey!),
    }))
    .filter(item => (newestFirst ? item.next >= bound : item.next <= bound))
    .sort((a, b) => direction * compare(a.next, b.next));
  let blockedAt: string | undefined;
  for (const { index, next } of needed) {
    try {
      requireJournal(ctx, index);
    } catch (error) {
      if (!(error instanceof JournalNeeded)) throw error;
      const loadedBytes = JSON.stringify(
        (ctx as QueryCtx & { journalLoaded?: unknown[] }).journalLoaded ?? [],
      ).length;
      // A transport continuation, never a history limit. At least the earliest selected key is
      // loaded first, so every bounded reply advances before an unloaded later segment.
      if (
        loadedBytes >= 2 * 1024 * 1024 &&
        combined.some(row => (newestFirst ? keyOf(row) > next : keyOf(row) < next))
      ) {
        blockedAt = next;
        break;
      }
      throw error;
    }
  }
  const rows: Doc<'projectCoordinationEvents'>[] = [];
  let bytes = 0;
  for (const row of combined) {
    if (
      (blockedAt && (newestFirst ? keyOf(row) <= blockedAt : keyOf(row) >= blockedAt)) ||
      rows.length >= limit
    )
      break;
    const size = new TextEncoder().encode(JSON.stringify(row)).length;
    if (rows.length && bytes + size > 500 * 1024) break;
    rows.push(row);
    bytes += size;
  }
  return {
    rows,
    hasMore:
      !!blockedAt ||
      combined.length > rows.length ||
      indexes.some(index =>
        newestFirst
          ? (index.keys?.[0] ?? index.startKey!) < (rows.length ? keyOf(rows.at(-1)!) : after)
          : (index.keys?.at(-1) ?? index.endKey!) > (rows.length ? keyOf(rows.at(-1)!) : after),
      ),
    positions: rows.map(row => [row._creationTime, row._id]),
  };
}
