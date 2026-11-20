// SPDX-License-Identifier: Apache-2.0
import { JournalNeeded, journalReadReply, journalDependency } from './projectJournalStore';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { query, type QueryCtx } from './cliServer';
import { readHostedRecord } from './projectHostedRecords';
import { accessibleProject } from './projectAuthority';
import { canonicalPayload } from '../src/hosted-source-operation';
import { isPlanningPrefix, planningIdMaxCandidates } from '../src/planning-id';
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

/** Full ids of this project's Lanes whose id starts with `prefix` (8 to 35 lowercase hex), for a short
 * Lane id the CLI could not resolve from the Lanes this machine opened (ad80e037). One range read on the
 * existing record-heads index, at most one row past the candidate limit; no bodies, no writes. */
export const resolveLaneId = query({
  args: { projectId: v.id('hostedProjects'), prefix: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, prefix }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted work.');
      await accessibleProject(ctx, projectId, user.subject);
      invariant(
        isPlanningPrefix(prefix) && prefix === prefix.toLowerCase(),
        'BAD_ARGUMENT',
        'prefix must be 8 to 35 lowercase hex characters.',
      );
      const rows = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_key', q =>
          q.eq('projectId', projectId).eq('kind', 'lane').gte('key', prefix).lt('key', `${prefix}\uffff`),
        )
        .take(planningIdMaxCandidates + 1);
      return canonicalPayload({
        ids: rows.slice(0, planningIdMaxCandidates).map(row => row.key),
        more: rows.length > planningIdMaxCandidates,
      });
    } catch (error) {
      return report(error);
    }
  },
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
      holder: lane.holder ?? null,
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
            // Main-red holds it waited under before this landing (held, released; Item 687d1eda).
            ...(landed.mainRedHolds ? { mainRedHolds: landed.mainRedHolds } : {}),
          }
        : null,
    });
  } catch (error) {
    if (error instanceof JournalNeeded) return journalReadReply(ctx, error, input.projectId);
    return report(error);
  }
}
