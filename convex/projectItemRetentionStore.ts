// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { digest } from '../src/state/hash';

const dayMs = 24 * 60 * 60 * 1000;
const retentionMs = 30 * dayMs;

export function itemRetentionRetryAt(now: number, attempts: number) {
  // A failed slot yields the next daily sweep to Items that have never run.
  return now + Math.min(2 ** Math.min(attempts, 5), 30) * dayMs;
}

// Scoped UUIDs let the purge append reject stale requests even after the expiry row was removed on Restore.
// Other internal callers of the executor keep their existing operation IDs.
export const itemRetentionOperation = (projectId: Id<'hostedProjects'>, itemId: string, version: number) => {
  const hex = digest(JSON.stringify(['planning-retention', projectId, itemId, version]));
  return `f04e4d1e-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
export const isItemRetentionOperation = (id: string) => /^f04e4d1e-[0-9a-f]{4}-8/.test(id);

export const itemRetentionRow = (
  ctx: Pick<QueryCtx, 'db'>,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  kind: 'attempt' | 'deadline' = 'attempt',
) =>
  ctx.db
    .query('projectItemRetention')
    .withIndex('by_project_and_item_and_kind', q =>
      q.eq('projectId', projectId).eq('itemId', itemId).eq('kind', kind),
    )
    .unique();

type Root = {
  id: string;
  kind: 'issue' | 'initiative';
  initiativeId?: string;
  status: string;
  version: number;
  at: string;
  purged?: { operationId: string };
};

/** Live append updates the deadline and task atomically with the Item, using its stable creation position.
 * The list reads deadline rows only. Scheduler claims, retries and receipts touch only attempt rows. */
export async function changeItemRetention(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  before: Root | null,
  next: Root,
  position: number,
) {
  if (next.status !== 'deleted' && before?.status !== 'deleted') return;
  const deadline = await itemRetentionRow(ctx, projectId, next.id, 'deadline');
  if (next.purged) {
    if (deadline) await ctx.db.delete(deadline._id);
    if (next.purged.operationId !== itemRetentionOperation(projectId, next.id, next.version - 1)) {
      const queued = await itemRetentionRow(ctx, projectId, next.id);
      if (queued) await ctx.db.delete(queued._id);
    }
    return;
  }

  const queued = await itemRetentionRow(ctx, projectId, next.id);
  if (next.status !== 'deleted') {
    if (deadline) await ctx.db.delete(deadline._id);
    if (queued) await ctx.db.delete(queued._id);
    return;
  }

  const placement = { position, initiativeId: next.initiativeId ?? '', itemKind: next.kind };
  if (queued) {
    if (deadline?.purgeAt === undefined) await ctx.db.delete(queued._id);
    else {
      // An early-removal confirmation only covers the version shown to the owner.
      await ctx.db.patch(queued._id, {
        version: next.version,
        attempts: undefined,
        attemptAt: deadline.purgeAt,
      });
      if (deadline.position !== position || deadline.initiativeId !== placement.initiativeId)
        await ctx.db.patch(deadline._id, placement);
    }
  } else if (before?.status !== 'deleted') {
    const purgeAt = Date.parse(next.at) + retentionMs;
    await ctx.db.insert('projectItemRetention', {
      projectId,
      itemId: next.id,
      kind: 'deadline',
      purgeAt,
      ...placement,
    });
    await ctx.db.insert('projectItemRetention', {
      projectId,
      itemId: next.id,
      kind: 'attempt',
      version: next.version,
      attemptAt: purgeAt,
    });
  }
}

/** The Deleted roots and deadlines share the creation-position order. One bounded range per shown page. */
export async function itemDeadlines(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  first: number,
  last: number,
  pageSize: number,
  initiativeId?: string,
) {
  const rows = ctx.db.query('projectItemRetention');
  const index =
    initiativeId === undefined
      ? rows.withIndex('by_project_and_kind_and_position', q =>
          q
            .eq('projectId', projectId)
            .eq('kind', 'deadline')
            .eq('itemKind', 'issue')
            .gte('position', first)
            .lte('position', last),
        )
      : rows.withIndex('by_project_and_kind_and_initiative_and_position', q =>
          q
            .eq('projectId', projectId)
            .eq('kind', 'deadline')
            .eq('itemKind', 'issue')
            .eq('initiativeId', initiativeId)
            .gte('position', first)
            .lte('position', last),
        );
  const page = await index.take(pageSize);
  return new Map(page.map(row => [row.itemId, row.purgeAt]));
}
