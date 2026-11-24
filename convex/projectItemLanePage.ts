// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getPage } from 'convex-helpers/server/pagination';
import { z } from 'zod';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { invariant } from '../src/errors';
import schema from './schema';

export const itemLanePosition = z.object({
  projectId: z.string(),
  itemId: z.string(),
  key: z.tuple([z.number().nonnegative(), z.string()]),
  seen: z.number().int().nonnegative(),
});
export type ItemLanePosition = z.infer<typeof itemLanePosition>;

/** A fixed-size newest-first keyset cursor. A new Lane above the frontier cannot move older rows. */
export async function itemLanePage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  position: ItemLanePosition | null,
  limit: number,
) {
  invariant(
    !position || (position.projectId === projectId && position.itemId === itemId),
    'BAD_ARGUMENT',
    'Cursor belongs to another Item. Restart without a cursor.',
  );
  const prefix = [projectId, 'lane', itemId];
  const page = await getPage(ctx, {
    schema,
    table: 'projectHostedRecordHeads',
    index: 'by_project_and_kind_and_item',
    order: 'desc',
    startIndexKey: position ? [...prefix, ...position.key] : prefix,
    startInclusive: position === null,
    endIndexKey: prefix,
    endInclusive: true,
    targetMaxRows: limit,
    absoluteMaxRows: limit,
  });
  const heads = page.page;
  const seen = (position?.seen ?? 0) + heads.length;
  const atLeast = page.hasMore;
  const next = atLeast
    ? { projectId, itemId, seen, key: page.indexKeys[limit - 1]!.slice(3) as [number, string] }
    : null;
  return { heads, next, total: seen + (atLeast ? 1 : 0), atLeast };
}
