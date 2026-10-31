// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { hostedWriteProject, readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Owner pin: a pinned Lane is never completed or abandoned by cleanup (complete-merged,
 * completeOnAccept, Intent cascades) and never removed by client prune or cache GC. It is one
 * optional field on the Lane record (mirrored on its head row), so no table, scheduler or extra read
 * is added anywhere. One Lane read and at most one write per call; a repeat is a no-op, and a stale
 * retry fails WORK_STALE instead of writing twice. Any Lane state can be pinned, including a
 * completed one, so a closed lead Lane keeps its history and its root. */
export const setPin = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    authorityEpoch: v.number(),
    laneId: v.string(),
    pinned: v.boolean(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change hosted work.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      await hostedWriteProject(ctx, input.projectId, user.subject, input.authorityEpoch);
      const current = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor: project.owner,
        kind: 'lane',
        key: input.laneId,
      });
      invariant(current, 'NOT_FOUND', 'Hosted Lane not found on this project.');
      const lane = hostedLaneSchema.parse(JSON.parse(current.value));
      const result = (changed: boolean, version: number) =>
        canonicalPayload({ laneId: lane.id, pinned: input.pinned, state: lane.state, changed, version });
      if (Boolean(lane.pinned) === input.pinned) return result(false, lane.version);
      const { pinned, ...rest } = lane;
      void pinned;
      await writeHostedRecord(ctx, {
        projectId: input.projectId,
        actor: project.owner,
        authorityEpoch: input.authorityEpoch,
        expectedVersion: lane.version,
        record: { ...rest, ...(input.pinned ? { pinned: true } : {}), version: lane.version + 1 },
      });
      return result(true, lane.version + 1);
    } catch (error) {
      return report(error);
    }
  },
});
