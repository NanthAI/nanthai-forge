// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readHostedRecord, recordHead, writeHostedRecord } from './projectHostedRecords';
import { hostedIntentSchema } from '../src/hosted-lane';
import { supersedeQuietSiblings } from './projectHostedSuperseded';
import { wakePlanLifecycle } from './projectPlanRollupWake';
import { runningLaneHead } from './projectHostedOpenLaneEvidence';

/** One page of sibling Lane heads; an Intent with more Lanes than this stays open. */
const SIBLINGS = 100;
/** Completes an active Intent once none of its Lanes is still open. Runs in the transaction that just
 * completed a Lane (acceptance completion tick, explicit complete, operator sweep), so it adds no call:
 * one head read, one indexed page of sibling heads and one record write. Outside acceptance, the
 * lifecycle cause requests an Item check; acceptance already wakes the batched fold.
 * Idempotent: a completed, abandoned or missing Intent, or any open sibling, changes nothing. */
export async function completeIntentWhenLanesDone(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    authorityEpoch: number;
    intentId: string;
    at: string;
    planningCause?: string;
    /** Losing the final Lane cancels this execution, not its planning Item or pending recovery. */
    abandon?: true;
    /** Lanes of a landing that stay active (keepOpen, completeOnAccept off): they declared this Intent and do
     * not keep it open. A pinned Lane always does. */
    landed?: ReadonlySet<string>;
    /** A Lane of this Intent that just landed: its quiet open siblings are superseded from the same
     * sibling page (friction b7f93deb). */
    supersededBy?: { laneId: string; receiptId: string };
  },
  knownHead?: Awaited<ReturnType<typeof recordHead>>,
) {
  // Head rows carry the status, so a settled or missing Intent and any open sibling cost no record body read.
  const head =
    knownHead === undefined ? await recordHead(ctx, input.projectId, 'intent', input.intentId) : knownHead;
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
    if (await runningLaneHead(ctx, row)) return false;
  }
  const current = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.actor,
    kind: 'intent',
    key: input.intentId,
  });
  if (!current) return false;
  const intent = hostedIntentSchema.parse(JSON.parse(current.value));
  if (intent.status !== 'active' || (input.abandon && intent.needsFix)) return false;
  await writeHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.actor,
    authorityEpoch: input.authorityEpoch,
    expectedVersion: intent.version,
    record: {
      ...intent,
      version: intent.version + 1,
      status: input.abandon ? 'abandoned' : 'completed',
      at: input.at,
    },
  });
  if (input.planningCause)
    await wakePlanLifecycle(ctx, {
      projectId: input.projectId,
      cause: input.planningCause,
      itemId: head.planningItemId,
    });
  return true;
}
