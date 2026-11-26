// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getPage } from 'convex-helpers/server/pagination';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import schema from './schema';

export type ItemIntentPosition = 'indexed' | [number, string];

/** Page an Item's bound Intents by their immutable position, including ties. Child streams may
 * retain this position on retry. */
export async function itemIntentPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  after: ItemIntentPosition | null,
  limit: number,
  order: 'asc' | 'desc' = 'asc',
) {
  after ??= 'indexed';
  const prefix = [projectId, 'intent', itemId];
  const result = await getPage(ctx, {
    schema,
    table: 'projectHostedRecordHeads',
    index: 'by_project_and_kind_and_item',
    order,
    startIndexKey: after === 'indexed' ? prefix : [...prefix, ...after],
    startInclusive: after === 'indexed',
    endIndexKey: prefix,
    endInclusive: true,
    targetMaxRows: limit,
    absoluteMaxRows: limit,
  });
  const last = result.indexKeys.at(-1);
  const next = result.hasMore && last ? (last.slice(3) as [number, string]) : null;
  return { heads: result.page, next };
}
