// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Loose ends details (Item fc1831eb): "passed its check, never landed" is a Lane-level stamp. An unrequested check that
// passed (the Lanes recordCheckFeed already names) stamps each Lane that is still open on the exact head that was
// checked: `passedAt` on its overlap and presence rows, and one marker row (projectFinishReadRows, kind
// projectLooseChecked, ordered by the pass time) that Loose ends lists from. A newer save writes a new head and drops
// the stamp and its marker (projectHostedOverlapStore), a landing or a close clears them (projectHostedOverlapLanded,
// materializeHostedOverlapLifecycle), so the stamp never outlives the work it vouches for. Only a Lane an unrequested
// check passed on pays these writes; saves and landings of every other Lane write nothing more.
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

export const checkedKind = 'projectLooseChecked';

export async function stampLanePass(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  /** `since`: when the check's compose picked this head. A Lane written after that (a save, and an undo back to the
   * same head) is newer work than the check saw, so it is not stamped. */
  lanes: readonly { laneId: string; head?: string; since?: number }[],
  at: number,
) {
  if (!Number.isFinite(at)) return;
  for (const lane of lanes) {
    if (!lane.head) continue;
    const row = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.laneId))
      .unique();
    // A save that moved the head meanwhile, a closed Lane and a Lane that already landed this head are left alone;
    // a newer pass of the same head replaces an older stamp, an older one never replaces a newer stamp.
    if (
      !row?.open ||
      !row.presenceRow ||
      row.head !== lane.head ||
      (lane.since !== undefined && row.lastActivityAt > lane.since) ||
      (row.landed?.laneHead === row.head && !row.landed.revertedBy)
    )
      continue;
    if (row.passedAt !== undefined && row.passedAt >= at) continue;
    if (row.passedMark) await ctx.db.delete(row.passedMark);
    const passedMark = await ctx.db.insert('projectFinishReadRows', {
      kind: checkedKind,
      sourceId: lane.laneId,
      sourceCreatedAt: at,
      projectId,
      value: '{}',
    });
    await ctx.db.patch(row._id, { passedAt: at, passedMark });
    if (row.presenceRow) await ctx.db.patch(row.presenceRow.id, { passedAt: at });
  }
}
