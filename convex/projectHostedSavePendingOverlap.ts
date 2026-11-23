// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { hostedLaneSchema } from '../src/hosted-lane';
import type { OverlapChange } from '../src/hosted-overlap';
import { hostedRecordBody, recordHead } from './projectHostedRecords';
import { trackHostedOverlapLane } from './projectHostedOverlapStore';
import { saveStateSchema, type loadSave } from './projectHostedSaveStore';

type SaveState = Awaited<ReturnType<typeof loadSave>>['state'];
/** Newer saves of one Lane read to find the ones still settling at the same head. */
const SETTLING_WINDOW = 8;

/** A background save writes its paths into the Lane's overlap evidence when it is submitted, before
 * its head is published (fea47345 C), so peers, presence and the first-write hook see them at once.
 * When that save fails, the evidence is rebuilt from the saved head's (the row's `settled` copy) plus
 * the deltas of the Lane's other saves still settling at that head (Item 3f70760d, from the receipt
 * 4401958d review), and the trial merge runs again, so no surface names work that was never saved
 * and no conflict the pending save ended stays hidden. A Lane whose head already moved needs nothing:
 * that head's write started from the saved evidence. Failure path only: one bounded save range, one
 * head read and the overlap row write. */
export async function revertPendingSaveOverlap(
  ctx: MutationCtx,
  row: Doc<'projectHostedSaves'>,
  state: SaveState,
) {
  const { laneId } = row;
  if (!row.background || !laneId || state.overlapChanges === undefined) return;
  const head = await recordHead(ctx, row.projectId, 'lane', laneId);
  const record = head ? await ctx.db.get(head.recordId) : null;
  if (!record) return;
  const lane = hostedLaneSchema.parse(JSON.parse(await hostedRecordBody(ctx, record)));
  if (lane.state !== 'active' || lane.head !== state.request.expected.head) return;
  const newer = await ctx.db
    .query('projectHostedSaves')
    .withIndex('by_project_and_lane_and_commit', q => q.eq('projectId', row.projectId).eq('laneId', laneId))
    .order('desc')
    .take(SETTLING_WINDOW);
  const settling = newer
    .filter(other => other._id !== row._id && other.background)
    .flatMap(other => {
      const parsed = saveStateSchema.safeParse(JSON.parse(other.value));
      return parsed.success &&
        parsed.data.status === 'submitted' &&
        parsed.data.overlapChanges !== undefined &&
        parsed.data.request.expected.head === lane.head
        ? [{ at: other._creationTime, state: parsed.data }]
        : [];
    })
    .sort((a, b) => a.at - b.at);
  await trackHostedOverlapLane(ctx, row.projectId, lane, {
    restorePending: settling.map(({ state: other }) => ({
      changes: JSON.parse(other.overlapChanges!) as OverlapChange[],
      complete: other.overlapComplete !== false,
    })),
  });
}
