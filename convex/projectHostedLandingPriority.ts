// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
import { ownedProject } from './projectAuthority';
import { hostedWriteProject } from './projectHostedRecords';
import { loadLanding } from './projectHostedLandingStore';
import { landingPriorityState } from './projectHostedLandingOrder';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

/** One submission patch, no wake/poller or progress fan-out. The retained CAS
 * prevents an old retry from undoing a later owner's priority change. */
export const prioritize = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    operationId: v.string(),
    priority: v.union(v.literal('urgent'), v.literal('normal')),
    expectedVersion: v.number(),
    authorityEpoch: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await acceptanceActor(ctx, true);
      await ownedProject(ctx, input.projectId, actor.id);
      await hostedWriteProject(ctx, input.projectId, actor.id, input.authorityEpoch);
      const { row, state } = await loadLanding(ctx, input);
      const change = {
        operationId: input.operationId,
        actor: actor.id,
        priority: input.priority,
        expectedVersion: input.expectedVersion,
      };
      if (row.priorityChange?.operationId === input.operationId) {
        invariant(
          canonicalPayload(row.priorityChange) === canonicalPayload(change),
          'WORK_OPERATION_CHANGED',
          'Replay the original priority change.',
        );
        return canonicalPayload(landingPriorityState(row, state));
      }
      invariant(
        Number.isSafeInteger(input.expectedVersion) &&
          input.expectedVersion >= 0 &&
          (row.priorityVersion ?? 0) === input.expectedVersion,
        'WORK_STALE',
        'Queue priority changed; read the current Candidate submission before changing it again.',
      );
      invariant(
        state.phase === 'queued',
        'WORK_STALE',
        'Reprioritise a queued Candidate; a running check is never cancelled for priority.',
      );
      const patch = {
        priority: input.priority,
        priorityReason: `Priority changed to ${input.priority} by the project owner; use prioritize with the previous priority to undo.`,
        priorityVersion: input.expectedVersion + 1,
        priorityChange: change,
      };
      await ctx.db.patch(row._id, patch);
      return canonicalPayload(landingPriorityState({ ...row, ...patch }, state));
    } catch (error) {
      return report(error);
    }
  },
});
