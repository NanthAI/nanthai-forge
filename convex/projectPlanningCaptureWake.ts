// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';
import { makeFunctionReference } from 'convex/server';

const rollupWake = makeFunctionReference<'mutation'>('projectPlanRollup:advance');
export const capturePageSize = 10;

/** Undefined commit stamps precede stamped heads. A legacy target can still fence within that prefix. */
export function pendingCaptures(ctx: QueryCtx, projectId: Id<'hostedProjects'>, through?: bigint | number) {
  return ctx.db.query('projectHostedRecordHeads').withIndex('by_project_and_kind_and_pending_capture', q => {
    const pending = q
      .eq('projectId', projectId)
      .eq('kind', 'issue')
      .eq('pendingPlanningCapture.state', 'pending');
    return through === undefined
      ? pending
      : typeof through === 'bigint'
        ? pending.lte('commitTs', through)
        : pending.eq('commitTs', undefined).lte('_creationTime', through);
  });
}

export async function oldestPendingCapture(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const [head] = await pendingCaptures(ctx, projectId).take(1);
  return head ?? null;
}

/** Old deployments queued a random fence in a project journal receipt. Drain that wake on upgrade. */
export const legacyCaptureWake = (ctx: QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectJournalReceipts')
    .withIndex('by_project_and_operation', q =>
      q.eq('projectId', projectId).eq('operationId', 'planning-capture-wake'),
    )
    .unique();

export function scheduleCaptureWake(ctx: MutationCtx, projectId: Id<'hostedProjects'>, itemId: string) {
  return ctx.scheduler.runAfter(0, rollupWake, {
    projectId,
    itemId,
    cause: itemId,
    source: 'capture',
    captureTicket: true,
  });
}

/** Reconcile arrivals beyond a short page's snapshot outside the publishing transaction. */
export async function followCapturePage(ctx: MutationCtx, projectId: Id<'hostedProjects'>, cause: string) {
  await ctx.scheduler.runAfter(0, rollupWake, {
    projectId,
    itemId: cause,
    cause,
    source: 'capture',
    captureTail: true,
  });
}

export async function handCapturePage(ctx: MutationCtx, head: Doc<'projectHostedRecordHeads'>) {
  const capture = head.pendingPlanningCapture;
  if (!capture) return;
  const wake = await scheduleCaptureWake(ctx, head.projectId, head.key);
  await ctx.db.patch(head._id, { pendingPlanningCapture: { ...capture, wake } });
}

/** An out-of-order ticket may already have returned. Hand the drain to the oldest remaining Item. */
export async function ensureCaptureWake(ctx: MutationCtx, head: Doc<'projectHostedRecordHeads'> | null) {
  const capture = head?.pendingPlanningCapture;
  if (!head || capture?.state !== 'pending') return;
  const scheduled = capture.wake && (await ctx.db.system.get(capture.wake));
  if (scheduled?.state.kind === 'pending') return;
  await handCapturePage(ctx, head);
}
