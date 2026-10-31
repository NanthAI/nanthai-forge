// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import {
  acceptanceRow,
  acceptancePlan,
  acceptancePage,
  type ReceiptIdentity,
} from './projectHostedAcceptanceStore';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { sameSaveLane } from './projectHostedSaveStore';
import { retireLandedOverlapLanes } from './projectHostedOverlapLanded';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { validateComposePage, composeLaneSchema } from '../src/hosted-compose';
import { hostedLaneSchema } from '../src/hosted-lane';
import { invariant } from '../src/errors';
/** Only an accepted marker activates the staged landed-head ledger. Canonical
 * Lane status is a bounded projection of that ledger. No source/Intent changes. */
export const scheduleAcceptanceCompletion = (ctx: MutationCtx, input: ReceiptIdentity) =>
  ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedAcceptance:complete'), input);
export async function completeAcceptedHeads(ctx: MutationCtx, input: ReceiptIdentity) {
  const row = await acceptanceRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Completion requires an actual accepted receipt.');
  const receipt = hostedAcceptanceSchema.parse(JSON.parse(row.value));
  const plan = await acceptancePlan(ctx, input);
  invariant(
    plan && plan.root === receipt.completion.root,
    'SOURCE_UNAVAILABLE',
    'The accepted completion ledger differs.',
  );
  // Landed work leaves the open-overlap index on the first tick, even when completion is off (keepOpen)
  // or skips a Lane whose pins moved after finish. Idempotent and bounded to one input page.
  if (!receipt.completion.enabled && plan.inputPages) await retireLandedOverlapLanes(ctx, input);
  if (!receipt.completion.enabled || plan.appliedPage === plan.inputPages) return { complete: true };
  if (plan.appliedPage === 0 && plan.appliedEntry === 0) await retireLandedOverlapLanes(ctx, input);
  const project = await ctx.db.get(input.projectId);
  invariant(
    project &&
      project.sourceAuthority?.mode === 'server' &&
      project.sourceAuthority.epoch === receipt.authorityEpoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Retain pending completion across authority changes for reconciliation.',
  );
  const page = await acceptancePage(ctx, { ...input, kind: 'inputs', index: plan.appliedPage });
  invariant(page, 'SOURCE_UNAVAILABLE', 'The accepted input page is unavailable.');
  const entries = validateComposePage(JSON.parse(page.value)).entries;
  // A byte-sized source page can contain 100 inputs. Materialize at most 20
  // canonical records per tick; counters are transaction windows, not Lane caps.
  const end = Math.min(entries.length, plan.appliedEntry + 20);
  for (const value of entries.slice(plan.appliedEntry, end)) {
    const entry = composeLaneSchema.parse(value);
    const current = await readHostedRecord(ctx, {
      projectId: input.projectId,
      actor: project.owner,
      kind: 'lane',
      key: entry.laneId,
    });
    invariant(current, 'SOURCE_UNAVAILABLE', 'An accepted Lane is unavailable.');
    const lane = hostedLaneSchema.parse(JSON.parse(current.value));
    if (lane.state !== 'active' || lane.pinned || !sameSaveLane(lane, entry)) continue;
    await writeHostedRecord(ctx, {
      projectId: input.projectId,
      actor: project.owner,
      authorityEpoch: receipt.authorityEpoch,
      expectedVersion: lane.version,
      record: {
        ...lane,
        version: lane.version + 1,
        lifecycleVersion: lane.lifecycleVersion + 1,
        state: 'completed',
        at: receipt.at,
      },
    });
  }
  const appliedPage = end === entries.length ? plan.appliedPage + 1 : plan.appliedPage;
  await ctx.db.patch(plan._id, { appliedPage, appliedEntry: end === entries.length ? 0 : end });
  const complete = appliedPage === plan.inputPages;
  if (!complete) await scheduleAcceptanceCompletion(ctx, input);
  return { complete };
}
