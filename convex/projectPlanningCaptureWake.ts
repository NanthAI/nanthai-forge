// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';
import { makeFunctionReference } from 'convex/server';
import { digest } from '../src/state/hash';

const rollupWake = makeFunctionReference<'mutation'>('projectPlanRollup:advance');
const operationId = 'planning-capture-wake';
export const capturePageSize = 10;

export function pendingCaptures(ctx: QueryCtx, projectId: Id<'hostedProjects'>, through?: number) {
  return ctx.db.query('projectHostedRecordHeads').withIndex('by_project_and_kind_and_pending_capture', q => {
    const pending = q
      .eq('projectId', projectId)
      .eq('kind', 'issue')
      .eq('pendingPlanningCapture.state', 'pending');
    return through === undefined ? pending : pending.lte('_creationTime', through);
  });
}

export const captureWake = (ctx: QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectJournalReceipts')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();

async function schedule(ctx: MutationCtx, projectId: Id<'hostedProjects'>, key: string) {
  await ctx.scheduler.runAfter(0, rollupWake, {
    projectId,
    itemId: key,
    cause: key,
    source: 'capture',
  });
}

/** One fenced wake per project burst. The common start only reads the marker. */
export async function wakePlanningCaptures(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  if (await captureWake(ctx, projectId)) return;
  const envelope = crypto.randomUUID();
  await schedule(ctx, projectId, envelope);
  await ctx.db.insert('projectJournalReceipts', { projectId, operationId, hash: digest(envelope), envelope });
}

export async function settleCaptureWake(
  ctx: MutationCtx,
  wake: Doc<'projectJournalReceipts'>,
  more: boolean,
) {
  if (!more) {
    await ctx.db.delete(wake._id);
    return;
  }
  const envelope = crypto.randomUUID();
  await schedule(ctx, wake.projectId, envelope);
  await ctx.db.patch(wake._id, { hash: digest(envelope), envelope });
}
