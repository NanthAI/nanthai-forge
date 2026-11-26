// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { writableHostedCheck } from './projectHostedCheckStore';
import { ForgeError } from '../src/errors';
import { directActions, directActionsAckMs, settleDirectActions } from './projectHostedActionsDirect';
import { hostedCheckRunSchema, hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';
import { isMachineRunner } from '../src/hosted-machine-runner';

/** Dispatched, but no runner ever acknowledged it (no execution bound). */
export const unacknowledgedDispatch = (run: HostedCheckRun) =>
  !hostedCheckTerminal(run) && !run.cancelRequested && run.dispatchStarted && !run.executionId;

/**
 * Checking alarm recovery. Incident a7de3a93: reconcile a dispatch that no runner
 * acknowledged within the bound. Adapters with a provider lookup use it (GitHub
 * Actions: by run-name); machine runners keep their lease watchdog; any other
 * adapter whose controller lease has lapsed settles `interrupted`, so the
 * landing's bounded platform retry re-dispatches. Called by the checking stall
 * alarm only: one read when nothing is wrong. Incident cd63bbe9: one bound
 * result recovery for a prepared but uncollected report inbox.
 */
export async function repairStalledCheck(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; runId: string },
  now = Date.now(),
) {
  const exists = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
  if (!exists) return 'none';
  const observed = hostedCheckRunSchema.parse(JSON.parse(exists.value));
  const activity = exists.shardActivity;
  // A quiet job owns its wait through the timeout of the observed shard.
  const live =
    activity &&
    observed.status === 'running' &&
    !observed.cancelRequested &&
    directActions(observed) &&
    observed.executionId &&
    observed.actions?.watchdog &&
    observed.actions.fence === observed.fence &&
    activity.at >= observed.actions.reservedAt &&
    activity.at <= now &&
    now < activity.until
      ? activity
      : null;
  // A bound execution can finish without delivering its collector or webhook.
  // A provider verdict alone cannot settle it: recover the prepared report inbox.
  const reports =
    directActions(observed) &&
    observed.plan &&
    observed.executionId &&
    observed.actions?.workflowSha &&
    !observed.reportPointer &&
    exists.reportStorage === 'r2' &&
    exists.resultBatch &&
    !exists.reportRecovery;
  if (
    hostedCheckTerminal(observed) ||
    observed.cancelRequested ||
    (!reports && !unacknowledgedDispatch(observed)) ||
    isMachineRunner(observed.configuration)
  )
    return live ?? 'none';
  let selected: Awaited<ReturnType<typeof writableHostedCheck>>;
  try {
    // Authority moved: the new authority's own paths own this run.
    selected = await writableHostedCheck(ctx, input, false, exists);
  } catch (cause) {
    if (cause instanceof ForgeError) return 'none';
    throw cause;
  }
  const { row, run } = selected;
  if (reports) {
    const holder = row.reportCollection;
    // An HTTP collector can still hold the original lease. Let it finish or
    // expire before repairing, so the alarm never takes over a live fold.
    const after = holder?.fence === run.fence && !holder.scheduledFunctionId ? holder.until : now;
    const recovery = await ctx.scheduler.runAfter(
      Math.max(0, after - now),
      makeFunctionReference<'action'>('projectHostedActionsVerdict:confirm'),
      { ...input, fence: run.fence, attempt: 0, stallRepair: true },
    );
    await ctx.db.patch(row._id, { reportRecovery: recovery });
    return live ?? 'reports';
  }
  const since = run.actions?.reservedAt ?? Date.parse(run.at);
  if (now - since < directActionsAckMs) return 'none';
  if (directActions(run)) {
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedActionsDirect:reconcile'), {
      projectId: input.projectId,
      runId: input.runId,
      fence: run.fence,
    });
    return 'lookup';
  }
  // A live controller lease still owns its own lookups and recovery.
  if (run.lease && run.lease.until > now) return 'none';
  await settleDirectActions(
    ctx,
    selected,
    'interrupted',
    'No runner acknowledged the dispatch and no controller holds it; Forge checks again.',
    now,
  );
  return 'interrupted';
}
