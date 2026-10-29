// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, type MutationCtx } from './_generated/server';
import {
  writableHostedCheck,
  writeHostedCheck,
  completeHostedCheck,
  type CheckIdentity,
} from './projectHostedCheckStore';
import { hostedCheckTerminal, checkPin, type HostedCheckRun } from '../src/hosted-check';
import { installationToken, githubAppRequest, actionsPermissions } from './githubAppToken';
import { invariant } from '../src/errors';
export const directActionsWatchdogMs = 12 * 60 * 60_000;
const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
export const directActions = (run: HostedCheckRun) =>
  run.configuration.provider === 'github-actions' && !run.configuration.credential;
export async function scheduleDirectActions(ctx: MutationCtx, run: HostedCheckRun) {
  if (directActions(run))
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedActionsDirect:dispatch'), {
      projectId: run.projectId,
      runId: run.id,
    });
}
export async function requestDirectCancel(ctx: MutationCtx, run: HostedCheckRun) {
  if (
    !run.actions ||
    !run.cancelRequested ||
    !run.executionId ||
    hostedCheckTerminal(run) ||
    run.actions.cancelScheduled
  )
    return;
  run.actions.cancelScheduled = true;
  const selected = await writableHostedCheck(ctx, {
    projectId: run.projectId as CheckIdentity['projectId'],
    runId: run.id,
  });
  await writeHostedCheck(ctx, selected.row._id, run);
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedActionsWebhook:cancel'), {
    projectId: run.projectId,
    runId: run.id,
  });
}
export async function settleDirectActions(
  ctx: MutationCtx,
  selected: Awaited<ReturnType<typeof writableHostedCheck>>,
  status: 'failed' | 'cancelled' | 'interrupted' | 'runner-unavailable',
  reason: string,
  now = Date.now(),
) {
  const { row, run } = selected;
  if (hostedCheckTerminal(run)) return run;
  run.status = status;
  run.exitCode = status === 'failed' ? 1 : null;
  run.failureReason = reason;
  run.endedAt = new Date(now).toISOString();
  run.terminalDigest = checkPin({
    runId: run.id,
    fence: run.fence,
    executionId: run.executionId,
    status,
    reason,
  });
  await completeHostedCheck(ctx, run);
  await writeHostedCheck(ctx, row._id, run);
  return run;
}
/** Atomic reservation, including a single recovery deadline, precedes GitHub IO.
 * An unknown dispatch is never resubmitted: GitHub has no idempotency key. */
export async function reserveDirectActions(ctx: MutationCtx, input: CheckIdentity, now = Date.now()) {
  const selected = await writableHostedCheck(ctx, input),
    { row, run } = selected;
  invariant(directActions(run), 'RUNNER_UNAVAILABLE', 'Select the Convex GitHub App runner.');
  if (hostedCheckTerminal(run) || run.cancelRequested || run.dispatchStarted) return null;
  run.fence++;
  run.dispatchStarted = true;
  run.status = 'dispatching';
  run.actions = {
    reservedAt: now,
    fence: run.fence,
    outcome: 'unknown',
    watchdog: await ctx.scheduler.runAfter(
      directActionsWatchdogMs,
      makeFunctionReference<'mutation'>('projectHostedActionsDirect:expire'),
      { ...input, fence: run.fence },
    ),
  };
  await writeHostedCheck(ctx, row._id, run);
  return run;
}
export const reserve = internalMutation({ args: identity, returns: v.any(), handler: reserveDirectActions });
export const observe = internalMutation({
  args: {
    ...identity,
    fence: v.number(),
    outcome: v.union(v.literal('accepted'), v.literal('unknown'), v.literal('rejected')),
    executionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const selected = await writableHostedCheck(ctx, input),
      { row, run } = selected;
    invariant(
      run.actions?.fence === input.fence && run.fence === input.fence,
      'WORK_STALE',
      'Actions dispatch fence changed.',
    );
    if (hostedCheckTerminal(run)) return null;
    run.actions.outcome = input.outcome;
    if (input.executionId) {
      invariant(
        !run.executionId || run.executionId === input.executionId,
        'EVIDENCE_CHANGED',
        'Actions execution changed.',
      );
      run.executionId = input.executionId;
    }
    if (input.outcome === 'rejected' && !run.executionId)
      await settleDirectActions(ctx, selected, 'runner-unavailable', 'GitHub App dispatch was refused.');
    else {
      if (!run.plan) run.status = run.executionId ? 'preparing' : 'unknown';
      await writeHostedCheck(ctx, row._id, run);
      await requestDirectCancel(ctx, run);
    }
    return null;
  },
});
export const expire = internalMutation({
  args: { ...identity, fence: v.number() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const selected = await writableHostedCheck(ctx, input);
    if (
      !hostedCheckTerminal(selected.run) &&
      selected.run.actions?.fence === input.fence &&
      selected.run.fence === input.fence
    ) {
      // The executing scheduler entry cannot cancel itself.
      selected.run.actions.watchdog = null;
      await settleDirectActions(
        ctx,
        selected,
        'interrupted',
        'No terminal Actions callback or webhook arrived before the execution deadline.',
      );
    }
    return null;
  },
});
export const dispatch = internalAction({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const run: HostedCheckRun | null = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedActionsDirect:reserve'),
      input,
    );
    if (!run) return null;
    invariant(run.configuration.provider === 'github-actions', 'RUNNER_UNAVAILABLE', 'Select Actions.');
    let outcome: 'accepted' | 'unknown' | 'rejected' = 'rejected',
      executionId: string | undefined;
    try {
      const site = process.env.CONVEX_SITE_URL;
      invariant(
        site && new URL(site).protocol === 'https:',
        'RUNNER_UNAVAILABLE',
        'Convex site URL is unavailable.',
      );
      const token = await installationToken(ctx, run.configuration.repository, actionsPermissions);
      // Mark unknown before the non-idempotent call. Never retry a lost response.
      outcome = 'unknown';
      const response = await githubAppRequest(
        `repos/${run.configuration.repository}/actions/workflows/forge-check.yml/dispatches`,
        token,
        fetch,
        {
          ref: 'main',
          return_run_details: true,
          inputs: { runId: run.id, deployment: site, projectId: run.projectId },
        },
      );
      if (response.status === 200) {
        const result = (await response.json()) as { workflow_run_id?: number };
        if (Number.isSafeInteger(result.workflow_run_id) && result.workflow_run_id! > 0)
          executionId = String(result.workflow_run_id);
      }
      outcome = 'accepted';
    } catch {
      // Do not include provider bodies, credentials or network errors in records.
    }
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsDirect:observe'), {
      ...input,
      fence: run.fence,
      outcome,
      ...(executionId ? { executionId } : {}),
    });
    return null;
  },
});
