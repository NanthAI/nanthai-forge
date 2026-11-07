// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { supersedeLane } from './projectHostedSuperseded';

/** A conflict inside a resolution makes a short chain; the walk stays bounded. */
const DEPTH = 4;
type Lane = z.infer<typeof hostedLaneSchema>;

/** A landed resolution Lane completes the conflicted Lane it was made for, so the original never
 * stays open as unfinished work. Only when that Lane is still active, unpinned and at the exact
 * recorded source: a Lane saved again afterwards holds new work and stays open. Runs in the
 * acceptance completion tick that completed the resolution Lane, on resolution Lanes only: at most
 * DEPTH record reads/writes and overlap rows, no added call. Reopen undoes it. Returns the Intents
 * of the Lanes it completed. */
export async function completeResolutionOrigins(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    owner: string;
    authorityEpoch: number;
    receiptId: string;
    commit: string | null;
    at: string;
  },
  lane: Lane,
) {
  const intents = new Set<string>();
  let origin = lane.resolution?.origin;
  for (let depth = 0; origin && depth < DEPTH; depth++) {
    const row = await readHostedRecord(ctx, {
      projectId: input.projectId,
      actor: input.owner,
      kind: 'lane',
      key: origin.laneId,
    });
    if (!row) break;
    const current = hostedLaneSchema.parse(JSON.parse(row.value));
    if (current.state !== 'active' || current.pinned) break;
    if (current.head !== origin.head || current.sourceVersion !== origin.sourceVersion) {
      // Saved again after the conflict: it keeps its work and stays open, but its original source
      // reached main through this resolution, so it stops producing advisory notices.
      await supersedeLane(ctx, {
        projectId: input.projectId,
        laneId: current.id,
        by: lane.id,
        receiptId: input.receiptId,
        at: input.at,
      });
      break;
    }
    await writeHostedRecord(ctx, {
      projectId: input.projectId,
      actor: input.owner,
      authorityEpoch: input.authorityEpoch,
      expectedVersion: current.version,
      record: {
        ...current,
        version: current.version + 1,
        lifecycleVersion: current.lifecycleVersion + 1,
        state: 'completed',
        at: input.at,
      },
    });
    // Its work landed through the resolution: leave open overlap evidence, stamped with this receipt.
    const overlap = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', current.id))
      .unique();
    if (overlap && overlap.head === current.head && overlap.landed?.receiptId !== input.receiptId)
      await ctx.db.patch(overlap._id, {
        open: false,
        ...(input.commit
          ? {
              landed: {
                receiptId: input.receiptId,
                commit: input.commit,
                laneHead: current.head,
                at: input.at,
              },
            }
          : {}),
      });
    intents.add(current.intentId);
    origin = current.resolution?.origin;
  }
  return intents;
}
