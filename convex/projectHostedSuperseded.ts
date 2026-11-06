// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { patchOverlapRow } from './projectHostedOverlapPeers';

type Row = Doc<'projectHostedOverlapLanes'>;
const overlapRow = (ctx: MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();

/** Marks one open Lane superseded on its overlap row: it leaves presence (its slim row is deleted) and
 * advisory notices, keeps its saved work, stays open and keeps blocking notices. Stamped with the head
 * it was set on, so a later save or `start --reopen` makes it live again. Idempotent. */
async function supersede(ctx: MutationCtx, row: Row, by: { laneId: string; receiptId: string; at: string }) {
  if (!row.open || row.superseded?.laneHead === row.head) return false;
  if (row.presenceRow) await ctx.db.delete(row.presenceRow.id);
  await patchOverlapRow(ctx, row, {
    presenceRow: undefined,
    superseded: { by: by.laneId, receiptId: by.receiptId, laneHead: row.head, at: by.at },
  });
  return true;
}

/** A Lane of an Intent just landed (Issue 55024d40, friction b7f93deb). Its still-open, unpinned
 * siblings of the same Intent that were last written before it started are earlier attempts it
 * succeeds: they are superseded, not completed or abandoned. Takes the Intent's sibling Lane heads the
 * Intent completion already read, so it adds no head read: with no other open sibling it reads nothing;
 * otherwise the landed Lane's overlap row plus one overlap row per candidate. No added call. */
export async function supersedeQuietSiblings(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    siblings: readonly { key: string; status: string; pinned?: boolean }[];
    laneId: string;
    receiptId: string;
    at: string;
    /** Lanes of the same landing that stay active (keepOpen): landed work, not earlier attempts. */
    landed?: ReadonlySet<string>;
  },
) {
  const candidates = input.siblings.filter(
    sibling =>
      sibling.key !== input.laneId &&
      sibling.status === 'active' &&
      !sibling.pinned &&
      !input.landed?.has(sibling.key),
  );
  if (!candidates.length) return 0;
  const landed = await overlapRow(ctx, input.projectId, input.laneId);
  if (!landed) return 0;
  let marked = 0;
  for (const sibling of candidates) {
    const row = await overlapRow(ctx, input.projectId, sibling.key);
    // Unknown activity counts as live: missing evidence never hides a Lane.
    const activity = row?.lastActivityAt ?? row?.presenceRow?.at ?? Infinity;
    if (row && activity <= landed._creationTime && (await supersede(ctx, row, input))) marked++;
  }
  return marked;
}

/** The conflicted original of a landed resolution Lane that was saved again after the conflict and so
 * stays open: its work reached main through the resolution, so it is superseded the same way. */
export async function supersedeLane(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; by: string; receiptId: string; at: string },
) {
  const row = await overlapRow(ctx, input.projectId, input.laneId);
  return row ? supersede(ctx, row, { laneId: input.by, receiptId: input.receiptId, at: input.at }) : false;
}
