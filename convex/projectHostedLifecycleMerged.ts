// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { mutation } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { acceptancePlan, acceptancePage } from './projectHostedAcceptanceStore';
import { hostedWriteProject, readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { sameSaveLane } from './projectHostedSaveStore';
import { validateComposePage, composeLaneSchema } from '../src/hosted-compose';
import { hostedLaneSchema } from '../src/hosted-lane';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

const RECEIPTS = 10;
const ENTRIES = 100;
const receiptSchema = z
  .object({ at: z.string(), completion: z.object({ pages: z.number(), enabled: z.boolean() }).loose() })
  .loose();
/** Operator sweep: complete every active Lane whose exact saved head an accepted receipt landed.
 * Receipts whose own acceptance already completes (completeOnAccept) are skipped, and so is any pinned Lane. One call reads at
 * most RECEIPTS receipts and about ENTRIES Lane entries; the caller resumes from `next` until `done`.
 * Re-running is safe: a Lane that is no longer active, or changed after landing, is never written. */
export const completeMerged = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    authorityEpoch: v.number(),
    sequence: v.number(),
    page: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change hosted work.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      await hostedWriteProject(ctx, input.projectId, user.subject, input.authorityEpoch);
      const receipts = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project_and_sequence', q =>
          // Receipt sequences are integers: greater than sequence - 1 is the first receipt not yet finished.
          q.eq('projectId', input.projectId).gt('sequence', input.sequence - 1),
        )
        .take(RECEIPTS);
      const completed: string[] = [];
      let sequence = input.sequence,
        page = input.page,
        inspected = 0;
      for (const row of receipts) {
        const receipt = receiptSchema.parse(JSON.parse(row.value));
        const plan = receipt.completion.enabled
          ? null
          : await acceptancePlan(ctx, { projectId: input.projectId, receiptId: row.receiptId });
        for (; plan && page < plan.inputPages; page++) {
          if (inspected >= ENTRIES)
            return canonicalPayload({ completed, next: { sequence: row.sequence, page }, done: false });
          const stored = await acceptancePage(ctx, {
            projectId: input.projectId,
            receiptId: row.receiptId,
            kind: 'inputs',
            index: page,
          });
          invariant(stored, 'SOURCE_UNAVAILABLE', 'An accepted input page is unavailable.');
          const entries = validateComposePage(JSON.parse(stored.value)).entries;
          inspected += entries.length;
          for (const value of entries) {
            const entry = composeLaneSchema.parse(value);
            const current = await readHostedRecord(ctx, {
              projectId: input.projectId,
              actor: project.owner,
              kind: 'lane',
              key: entry.laneId,
            });
            if (!current) continue;
            const lane = hostedLaneSchema.parse(JSON.parse(current.value));
            if (lane.state !== 'active' || lane.pinned || !sameSaveLane(lane, entry)) continue;
            await writeHostedRecord(ctx, {
              projectId: input.projectId,
              actor: project.owner,
              authorityEpoch: input.authorityEpoch,
              expectedVersion: lane.version,
              record: {
                ...lane,
                version: lane.version + 1,
                lifecycleVersion: lane.lifecycleVersion + 1,
                state: 'completed',
                at: receipt.at,
              },
            });
            completed.push(lane.id);
          }
        }
        sequence = row.sequence + 1;
        page = 0;
      }
      return canonicalPayload({
        completed,
        next: { sequence, page },
        done: receipts.length < RECEIPTS,
      });
    } catch (error) {
      return report(error);
    }
  },
});
