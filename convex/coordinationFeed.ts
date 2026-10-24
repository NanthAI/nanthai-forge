// SPDX-License-Identifier: Apache-2.0
import { withActorName } from './projectActorNames';
import { getPage } from 'convex-helpers/server/pagination';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';
import { invariant } from '../src/errors';
import { COORDINATION_LIMITS } from '../src/coordination-types';

const prefix = 'forge-coordination-v1:';
export type FeedScope = { field: 'intentId' | 'laneId' | 'recipientActor'; value: string };
const indexes = {
  intentId: 'by_project_and_intentId',
  laneId: 'by_project_and_laneId',
  recipientActor: 'by_project_and_recipientActor',
} as const;

export function feedPageSize(numItems: number) {
  invariant(
    Number.isSafeInteger(numItems) && numItems > 0 && numItems <= COORDINATION_LIMITS.pageSize,
    'BAD_ARGUMENT',
    `Use a feed page size from 1 to ${COORDINATION_LIMITS.pageSize}.`,
  );
  return numItems;
}
/** Position after `[projectId]` (start) or `[projectId, creationTime, id]`; the same cursor works for every scope. */
export function feedPosition(ctx: QueryCtx, projectId: Id<'hostedProjects'>, cursor: string | null) {
  if (!cursor?.startsWith(prefix)) return { position: [] as (string | number)[], cursorReset: !!cursor }; // Opaque EOF cursors replay, never lose events.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor.slice(prefix.length));
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'The coordination cursor is invalid.');
  }
  const value = parsed as { projectId?: unknown; key?: unknown };
  invariant(
    value &&
      value.projectId === projectId &&
      Array.isArray(value.key) &&
      value.key[0] === projectId &&
      (value.key.length === 1 ||
        (value.key.length === 3 &&
          typeof value.key[1] === 'number' &&
          Number.isFinite(value.key[1]) &&
          value.key[1] >= 0 &&
          typeof value.key[2] === 'string' &&
          ctx.db.normalizeId('projectCoordinationEvents', value.key[2]) !== null)),
    'BAD_ARGUMENT',
    'Use a coordination cursor from this project.',
  );
  return { position: (value.key as (string | number)[]).slice(1), cursorReset: false };
}
export const feedCursor = (projectId: string, position: (string | number)[]) =>
  prefix + JSON.stringify({ projectId, key: [projectId, ...position] });

/** Scan rows after a position, in creation order, optionally through a denormalized index. */
export async function feedRows(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  position: (string | number)[],
  maxRows: number,
  scope?: FeedScope,
) {
  const prefixKey: (string | number)[] = scope ? [projectId, scope.value] : [projectId];
  const start = [...prefixKey, ...position];
  const result = await getPage(ctx, {
    table: 'projectCoordinationEvents',
    index: scope ? indexes[scope.field] : 'by_project',
    schema,
    startIndexKey: start,
    startInclusive: position.length === 0,
    endIndexKey: prefixKey,
    endInclusive: true,
    targetMaxRows: maxRows,
    absoluteMaxRows: maxRows,
  });
  return {
    rows: await Promise.all(
      (result.page as Doc<'projectCoordinationEvents'>[]).map(row => withActorName(ctx, projectId, row)),
    ),
    positions: result.indexKeys.map(key => (key as (string | number)[]).slice(prefixKey.length)),
    hasMore: result.hasMore,
  };
}
/** Durable document boundary, not Convex's exhausted-page sentinel. Both bounds retain project authority. */
export async function coordinationFeed(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  cursor: string | null,
  numItems: number,
  scope?: FeedScope,
) {
  feedPageSize(numItems);
  const { position, cursorReset } = feedPosition(ctx, projectId, cursor);
  const result = await feedRows(ctx, projectId, position, numItems, scope);
  return {
    page: result.rows,
    isDone: !result.hasMore,
    continueCursor: feedCursor(projectId, result.positions.at(-1) ?? position),
    cursorReset,
  };
}
