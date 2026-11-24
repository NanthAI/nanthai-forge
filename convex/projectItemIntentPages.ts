// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getPage } from 'convex-helpers/server/pagination';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { recordHead } from './projectHostedRecords';
import schema from './schema';

export type ItemIntentPosition = 'indexed' | [number, string];

/** The same-id legacy root is outside the index. Emit it once, then page indexed heads
 * by their immutable position, including ties. Child streams may retain this position on retry. */
export async function itemIntentPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  after: ItemIntentPosition | null,
  limit: number,
  order: 'asc' | 'desc' = 'asc',
) {
  const root = after === null ? await recordHead(ctx, projectId, 'intent', itemId) : null;
  const legacy = root && !root.planningItemId ? [root] : [];
  const remaining = limit - legacy.length;
  if (remaining === 0) return { heads: legacy, next: 'indexed' as const };
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
    targetMaxRows: remaining,
    absoluteMaxRows: remaining,
  });
  const last = result.indexKeys.at(-1);
  const next = result.hasMore && last ? (last.slice(3) as [number, string]) : null;
  return { heads: [...legacy, ...result.page], next };
}
