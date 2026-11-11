// SPDX-License-Identifier: Apache-2.0
import { JournalNeeded, journalReadReply, journalDependency } from './projectJournalStore';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { query, type QueryCtx } from './cliServer';
import { readHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { invariant } from '../src/errors';
import { report } from './errors';

/** One Lane's history from rows already stored: when it opened, the main it started from, the main it
 * was last synced to, and its landing. Six indexed reads (head, record body, first record, its body, overlap
 * row), a few hundred bytes of reply, no writes, no idle work. Works for open, landed and abandoned Lanes. */
export const read = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: journalLaneHistoryRead,
});

export async function journalLaneHistoryRead(
  ctx: QueryCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string },
) {
  try {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted work.');
    const key = {
      projectId: input.projectId,
      actor: user.subject,
      kind: 'lane' as const,
      key: input.laneId,
    };
    const current = await readHostedRecord(ctx, key);
    invariant(current, 'NOT_FOUND', 'Hosted Lane not found on this project.');
    const lane = hostedLaneSchema.parse(JSON.parse(current.value));
    const landed = (
      await ctx.db
        .query('projectHostedOverlapLanes')
        .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', input.laneId))
        .unique()
    )?.landed;
    journalDependency(ctx, 'landing-stamp', landed ?? null);
    // Version 0 is the record written at start: its time is the open time, its base the first main.
    const first = lane.version === 0 ? current : await readHostedRecord(ctx, { ...key, version: 0 });
    const opened = first ? hostedLaneSchema.parse(JSON.parse(first.value)) : null;
    return JSON.stringify({
      schema: 1,
      laneId: lane.id,
      intentId: lane.intentId,
      state: lane.state,
      openedAt: opened?.at ?? null,
      // The main the Lane started from, and the main its pinned base is now (they differ after a sync).
      startBase: opened?.base ?? null,
      lastSyncedBase: lane.base,
      synced: opened ? opened.base.receiptId !== lane.base.receiptId : null,
      head: lane.head,
      version: lane.version,
      lastActivityAt: lane.at,
      // Present once an accepted receipt carried one of this Lane's saved heads; null otherwise
      // (never landed, or landed before the landing stamp existed).
      landing: landed
        ? {
            receiptId: landed.receiptId,
            commit: landed.commit,
            head: landed.laneHead,
            at: landed.at,
            // A reverted landing is off main: not current even while the Lane still holds that head.
            current: landed.laneHead === lane.head && !landed.revertedBy,
            ...(landed.revertedBy ? { revertedBy: landed.revertedBy } : {}),
          }
        : null,
    });
  } catch (error) {
    if (error instanceof JournalNeeded) return journalReadReply(ctx, error, input.projectId);
    return report(error);
  }
}
