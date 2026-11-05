// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readHostedRecord, recordHead, writeHostedRecord } from './projectHostedRecords';
import { hostedIntentSchema } from '../src/hosted-lane';

/** One page of sibling Lane heads; an Intent with more Lanes than this stays open. */
const SIBLINGS = 100;
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
  if (siblings.length > SIBLINGS || siblings.some(row => row.status === 'active')) return false;
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
