// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { abandonClass, dormantCutoff } from './projectHostedDormancy';
import { hostedWriteProject, readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

/** One call touches at most this many Lanes: one record read, one overlap row read and at most one
 * record write each. */
export const DORMANT_BATCH = 25;

/** Owner sweep for dormant Lanes that hold no unlanded work. Each id is checked again here, so a stale
 * list is safe: a Lane that was saved, pinned, closed or revived since the list is skipped.
 * - `abandon`: the Lane is dormant and its saved head is fully on main (`landed`) or was never saved
 *   (`empty`). It is abandoned like any Lane; `reopen` or `start --reopen` brings it back, and its
 *   saved head is kept.
 * - `stamp`: a dormant Lane with other saved work stays open; only its overlap row gets the activity
 *   time it lacked, so later reads skip it through the activity index instead of reading its row.
 * Retry-safe: a repeat finds nothing left to change. No scan, scheduler or idle work. */
export const abandon = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    authorityEpoch: v.number(),
    abandon: v.array(v.string()),
    stamp: v.optional(v.array(v.string())),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change hosted work.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      await hostedWriteProject(ctx, input.projectId, user.subject, input.authorityEpoch);
      const stamp = input.stamp ?? [];
      invariant(
        input.abandon.length + stamp.length <= DORMANT_BATCH,
        'BAD_ARGUMENT',
        `Send at most ${DORMANT_BATCH} Lanes per call.`,
      );
      const cutoff = dormantCutoff(project);
      const results: { laneId: string; result: string }[] = [];
      const targets = [
        ...[...new Set(input.abandon)].map(id => [id, 'abandon'] as const),
        ...[...new Set(stamp)].map(id => [id, 'stamp'] as const),
      ];
      for (const [laneId, intent] of targets) {
        const skip = (result: string) => results.push({ laneId, result });
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
        if (lane.state !== 'active') skip('not-open');
        else if (lane.pinned) skip('pinned');
        else if (cutoff === null || Date.parse(lane.at) > cutoff) skip('not-dormant');
        else {
          const row = await ctx.db
            .query('projectHostedOverlapLanes')
            .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', laneId))
            .unique();
          if (intent === 'stamp') {
            if (row && row.lastActivityAt === undefined)
              await ctx.db.patch(row._id, { lastActivityAt: Date.parse(lane.at) });
            skip(row ? 'stamped' : 'no-overlap-row');
          } else if (!abandonClass(lane, row)) skip('has-saved-work');
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
            skip('abandoned');
          }
        }
      }
      return canonicalPayload({ results });
    } catch (error) {
      return report(error);
    }
  },
});
