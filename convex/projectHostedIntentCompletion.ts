// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readHostedRecord, recordHead, writeHostedRecord } from './projectHostedRecords';
import { hostedIntentSchema } from '../src/hosted-lane';
import { supersedeQuietSiblings } from './projectHostedSuperseded';

/** One page of sibling Lane heads; an Intent with more Lanes than this stays open. */
const SIBLINGS = 100;
/** True when the Lane's current saved head is the head an accepted landing carried (its overlap row's landing
 * stamp). A later save moves the row head and the Lane counts as running again. */
async function landedAtHead(ctx: MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) {
  const row = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  return !!row?.landed && row.landed.laneHead === row.head;
}
/** Completes an active Intent once none of its Lanes is still open. Runs in the transaction that just
 * completed a Lane (acceptance completion tick, explicit complete, operator sweep), so it adds no call:
 * one head read, one indexed page of sibling heads and one record write. The planning read then closes
 * the Issue that shares this Intent's id (`reconcile`), unless its Done-when lines are still open.
 * Idempotent: a completed, abandoned or missing Intent, or any open sibling, changes nothing. */
export async function completeIntentWhenLanesDone(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    authorityEpoch: number;
    intentId: string;
    at: string;
    /** Lanes of a landing that stay active (keepOpen, completeOnAccept off): they declared this Intent and do
     * not keep it open. A pinned Lane always does. */
    landed?: ReadonlySet<string>;
    /** A Lane of this Intent that just landed: its quiet open siblings are superseded from the same
     * sibling page (friction b7f93deb). */
    supersededBy?: { laneId: string; receiptId: string };
  },
) {
  // Head rows carry the status, so a settled or missing Intent and any open sibling cost no record body read.
  const head = await recordHead(ctx, input.projectId, 'intent', input.intentId);
  if (!head || head.status !== 'active') return false;
  const siblings = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_parent', q =>
      q.eq('projectId', input.projectId).eq('kind', 'lane').eq('parent', input.intentId),
    )
    .take(SIBLINGS + 1);
  if (siblings.length <= SIBLINGS && input.supersededBy)
    await supersedeQuietSiblings(ctx, {
      projectId: input.projectId,
      siblings,
      ...input.supersededBy,
      at: input.at,
      ...(input.landed ? { landed: input.landed } : {}),
    });
  if (siblings.length > SIBLINGS) return false;
  for (const row of siblings) {
    if (row.status !== 'active' || (!row.pinned && input.landed?.has(row.key))) continue;
    // A sibling that stayed open after its own landing (completeOnAccept off, keepOpen) and has not been saved
    // since is landed work, not running work: it must not keep the Intent open forever (0b12fcfe line 1). Its
    // landing stamp rides on the overlap row, one indexed read, only when a sibling would otherwise block.
    if (!row.pinned && (await landedAtHead(ctx, input.projectId, row.key))) continue;
    return false;
  }
  const current = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.actor,
    kind: 'intent',
    key: input.intentId,
  });
  if (!current) return false;
  const intent = hostedIntentSchema.parse(JSON.parse(current.value));
  if (intent.status !== 'active') return false;
  await writeHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.actor,
    authorityEpoch: input.authorityEpoch,
    expectedVersion: intent.version,
    record: { ...intent, version: intent.version + 1, status: 'completed', at: input.at },
  });
  return true;
}
