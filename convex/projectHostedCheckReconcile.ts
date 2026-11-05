// SPDX-License-Identifier: Apache-2.0
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
 * Runner contract step (incident a7de3a93): reconcile a dispatch that no runner
 * acknowledged within the bound. Adapters with a provider lookup use it (GitHub
 * Actions: by run-name); machine runners keep their lease watchdog; any other
 * adapter whose controller lease has lapsed settles `interrupted`, so the
 * landing's bounded platform retry re-dispatches. Called by the checking stall
 * alarm only: one read when nothing is wrong, never a timer or a poll.
 */
export async function reconcileUnacknowledgedCheck(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; runId: string },
  now = Date.now(),
): Promise<'none' | 'lookup' | 'interrupted'> {
  const exists = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
  if (!exists) return 'none';
  const observed = hostedCheckRunSchema.parse(JSON.parse(exists.value));
  if (!unacknowledgedDispatch(observed) || isMachineRunner(observed.configuration)) return 'none';
  let selected: Awaited<ReturnType<typeof writableHostedCheck>>;
  try {
    // Authority moved: the new authority's own paths own this run.
    selected = await writableHostedCheck(ctx, input);
  } catch (cause) {
    if (cause instanceof ForgeError) return 'none';
    throw cause;
  }
  const { run } = selected;
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
