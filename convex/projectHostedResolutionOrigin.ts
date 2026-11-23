// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { z } from 'zod';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  hostedRecordBody,
  readHostedRecord,
  recordHead,
  recordVersion,
  writeHostedRecord,
} from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import type { composeLaneSchema } from '../src/hosted-compose';
import { supersedeLaneFinishes } from './projectHostedLaneFinish';
import { supersedeLane } from './projectHostedSuperseded';
import type { MainRedHold } from '../src/hosted-acceptance';

/** A conflict inside a resolution makes a short chain; the walk stays bounded. */
const DEPTH = 4;
type Lane = z.infer<typeof hostedLaneSchema>;

/** Read the accepted resolution's origin even after a sync replaced the Lane's current version.
 * Returns the accepted resolution Lane (its pinned version) when it names an origin. */
export async function noteResolutionOrigins(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  accepted: z.infer<typeof composeLaneSchema>,
  reached: (intentId: string, laneId: string, viaLaneId?: string) => void,
) {
  const pinned = await recordVersion(ctx, projectId, 'lane', accepted.laneId, accepted.version);
  if (!pinned) return undefined;
  const lane = hostedLaneSchema.parse(JSON.parse(await hostedRecordBody(ctx, pinned)));
  if (
    lane.head !== accepted.head ||
    lane.sourceVersion !== accepted.sourceVersion ||
    lane.lifecycleVersion !== accepted.lifecycleVersion
  )
    return undefined;
  let origin = lane.resolution?.origin;
  for (let depth = 0; origin && depth < DEPTH; depth++) {
    const laneId: string = origin.laneId;
    const head = await recordHead(ctx, projectId, 'lane', laneId);
    if (!head) break;
    reached(head.parent, laneId, head.parent === lane.intentId ? undefined : lane.id);
    const row = await ctx.db.get(head.recordId);
    if (!row) break;
    const current = hostedLaneSchema.parse(JSON.parse(await hostedRecordBody(ctx, row)));
    if (current.head !== origin.head || current.sourceVersion !== origin.sourceVersion) break;
    origin = current.resolution?.origin;
  }
  return lane.resolution?.origin ? lane : undefined;
}

/** A landed resolution Lane completes the conflicted Lane it was made for, so the original never
 * stays open as unfinished work. Only when that Lane is still active, unpinned and at the recorded
 * head: a Lane saved with new bytes afterwards holds new work and stays open. Runs in the
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
    /** The receipt's main-red holds, stamped for the origin Lane's lane-history (Item 687d1eda). */
    mainRedHolds?: MainRedHold[];
  },
  lane: Lane,
  /** Each origin Lane whose source reached main through this resolution, from the record already read
   * (Issue 3a733ee8: its Item gets the landing note too). */
  reached?: (origin: Lane) => void,
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
    reached?.(current);
    await supersedeLaneFinishes(ctx, {
      projectId: input.projectId,
      laneId: current.id,
      head: lane.head,
      scope: 'live',
      fromHead: origin.head,
    });
    if (current.state !== 'active' || current.pinned) break;
    if (current.head !== origin.head) {
      // Saved again after the conflict: it keeps its work and stays open, but its original source
      // reached main through this resolution, so it stops producing advisory notices. A re-save of
      // the same bytes (sourceVersion moved, head unchanged) holds no new work, so the Lane
      // completes like an untouched one (593fc2d7).
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
    if (overlap?.passedMark) await ctx.db.delete(overlap.passedMark);
    if (overlap && overlap.head === current.head && overlap.landed?.receiptId !== input.receiptId)
      await ctx.db.patch(overlap._id, {
        open: false,
        passedAt: undefined,
        passedMark: undefined,
        ...(input.commit
          ? {
              landed: {
                receiptId: input.receiptId,
                commit: input.commit,
                laneHead: current.head,
                at: input.at,
                ...(input.mainRedHolds ? { mainRedHolds: input.mainRedHolds } : {}),
              },
            }
          : {}),
      });
    intents.add(current.intentId);
    origin = current.resolution?.origin;
  }
  return intents;
}
