// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { settleLaneApproval } from './projectHostedApprovalStore';
import { abandonClass, dormantCutoff, landedByReceipt } from './projectHostedDormancy';
import { hostedWriteProject, readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';

/** One call touches at most this many Lanes: one record read, one live-line mark read, one overlap row read
 * and at most one record write each. */
export const DORMANT_BATCH = 25;

/** A Lane queued, checking or ready to land is held by the queue, as the Loose ends read says (Still active). Its
 * Lane record need not change when it enters the queue, so the sweep checks the mark itself. */
async function inLandingQueue(ctx: MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) {
  const mark = await ctx.db
    .query('projectLiveLineLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  return mark?.stage === 'queued' || mark?.stage === 'checking' || mark?.stage === 'ready';
}

/** Owner sweep for dormant Lanes that hold no unlanded work. Each id is checked again here, so a stale
 * list is safe: a Lane that was saved, pinned, closed or revived since the list is skipped.
 * - `abandon`: the Lane is dormant and its saved head is fully on main (`landed`) or was never saved
 *   (`empty`). It is abandoned like any Lane; `reopen` or `start --reopen` brings it back, and its
 *   saved head is kept.
 * - `onMain`: the owner's CLI compared the paths this Lane changed with main's bytes and found them all
 *   there. The Lane is abandoned only while its saved head is still the one compared and its overlap row
 *   still holds the complete change list for that head. Same undo as `abandon`.
 * - `stamp`: a dormant Lane with other saved work stays open; only its overlap row gets the activity
 *   time it lacked, so later reads skip it through the activity index instead of reading its row.
 * - `reopen` (Undo, Item fc1831eb): a Lane this sweep set aside comes back as active, only while it is still
 *   abandoned at exactly the version the sweep returned; a Lane changed since is skipped as `changed`.
 * With `versions: true` each Lane set aside or reopened returns its new `version`, the pin its Undo sends (older
 * CLIs parse the reply strictly, so they never ask for it).
 * Retry-safe: a repeat finds nothing left to change. No scan, scheduler or idle work. */
export const abandon = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    authorityEpoch: v.number(),
    abandon: v.array(v.string()),
    stamp: v.optional(v.array(v.string())),
    onMain: v.optional(v.array(v.object({ laneId: v.string(), head: v.string() }))),
    reopen: v.optional(v.array(v.object({ laneId: v.string(), version: v.number() }))),
    versions: v.optional(v.literal(true)),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change hosted work.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      await hostedWriteProject(ctx, input.projectId, user.subject, input.authorityEpoch);
      const stamp = input.stamp ?? [];
      const onMain = new Map((input.onMain ?? []).map(entry => [entry.laneId, entry.head]));
      const reopen = new Map((input.reopen ?? []).map(entry => [entry.laneId, entry.version]));
      invariant(
        input.abandon.length + stamp.length + onMain.size + reopen.size <= DORMANT_BATCH,
        'BAD_ARGUMENT',
        `Send at most ${DORMANT_BATCH} Lanes per call.`,
      );
      const cutoff = dormantCutoff(project);
      const results: { laneId: string; result: string; version?: number }[] = [];
      const targets = [
        ...[...new Set(input.abandon)].map(id => [id, 'abandon'] as const),
        ...[...onMain.keys()].map(id => [id, 'on-main'] as const),
        ...[...new Set(stamp)].map(id => [id, 'stamp'] as const),
        ...[...reopen.keys()].map(id => [id, 'reopen'] as const),
      ];
      for (const [laneId, intent] of targets) {
        const skip = (result: string, version?: number) =>
          results.push({ laneId, result, ...(version === undefined || !input.versions ? {} : { version }) });
        const current = await readHostedRecord(ctx, {
          projectId: input.projectId,
          actor: project.owner,
          kind: 'lane',
          key: laneId,
        });
        if (!current) {
          skip('not-found');
          continue;
        }
        const lane = hostedLaneSchema.parse(JSON.parse(current.value));
        if (intent === 'reopen') {
          // Undo touches only the version this sweep wrote: a Lane reopened, saved or closed since is left alone.
          if (lane.state !== 'abandoned' || lane.version !== reopen.get(laneId)) skip('changed');
          else {
            await writeHostedRecord(ctx, {
              projectId: input.projectId,
              actor: project.owner,
              authorityEpoch: input.authorityEpoch,
              expectedVersion: lane.version,
              record: {
                ...lane,
                version: lane.version + 1,
                lifecycleVersion: lane.lifecycleVersion + 1,
                state: 'active',
                at: new Date().toISOString(),
              },
            });
            skip('reopened', lane.version + 1);
          }
        } else if (lane.state !== 'active') skip('not-open');
        else if (lane.pinned) skip('pinned');
        else if (cutoff === null || Date.parse(lane.at) > cutoff) skip('not-dormant');
        else if (intent !== 'stamp' && (await inLandingQueue(ctx, input.projectId, laneId))) skip('in-queue');
        else {
          const row = await ctx.db
            .query('projectHostedOverlapLanes')
            .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', laneId))
            .unique();
          if (intent === 'stamp') {
            if (row && row.lastActivityAt === undefined)
              await ctx.db.patch(row._id, { lastActivityAt: Date.parse(lane.at) });
            skip(row ? 'stamped' : 'no-overlap-row');
          } else if (
            intent === 'on-main'
              ? !(row && row.head === lane.head && row.complete && onMain.get(laneId) === lane.head)
              : !(abandonClass(lane, row) || (await landedByReceipt(ctx, input.projectId, lane)))
          )
            skip('has-saved-work');
          else {
            await writeHostedRecord(ctx, {
              projectId: input.projectId,
              actor: project.owner,
              authorityEpoch: input.authorityEpoch,
              expectedVersion: lane.version,
              record: {
                ...lane,
                version: lane.version + 1,
                lifecycleVersion: lane.lifecycleVersion + 1,
                state: 'abandoned',
                at: new Date().toISOString(),
              },
            });
            await settleLaneApproval(ctx, input.projectId, laneId, Date.now());
            skip('abandoned', lane.version + 1);
          }
        }
      }
      return canonicalPayload({ results });
    } catch (error) {
      return report(error);
    }
  },
});
