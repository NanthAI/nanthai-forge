// SPDX-License-Identifier: Apache-2.0
import { convexFetch } from './networkFetch';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction, type MutationCtx } from './server';
import {
  writableHostedCheck,
  writeHostedCheck,
  completeHostedCheck,
  type CheckIdentity,
} from './projectHostedCheckStore';
import { hostedCheckTerminal, checkPin, type HostedCheckRun } from '../src/hosted-check';
import { installationToken, githubAppRequest, actionsPermissions } from './githubAppToken';
import { invariant } from '../src/errors';
import {
  runnerVisibilityRequired,
  requirePrivateRunner,
  runnerPublicCode,
  runnerPublicReason,
} from '../src/runner-visibility';
import {
  cachedRepositoryVisibility,
  readRepositoryVisibility,
  recordRepositoryVisibility,
} from './githubRepositoryVisibility';
export const directActionsWatchdogMs = 12 * 60 * 60_000;
/** Incident a7de3a93: a dispatch whose reply was lost has no executionId until the
 * workflow_run webhook binds it. GitHub lists a dispatched run within about a
 * minute, so after this bound one lookup by run-name decides: adopt or re-check. */
export const directActionsAckMs = 5 * 60_000;
const rateLimitMs = { min: 60_000, max: 15 * 60_000 };
const repositoryOf = (run: HostedCheckRun) =>
  run.configuration.provider === 'github-actions' ? run.configuration.repository : 'the repository';
const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
/** Shared-transport deadlines (convexFetch) and native aborts both count as timeouts. */
const timedOut = (error: unknown) => {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  return name === 'TimeoutError' || name === 'AbortError' || code === 'EXCHANGE_REQUEST_TIMEOUT';
};
type DispatchFailure = { outcome: 'unknown' | 'rejected'; failure: string; retryAfterMs?: number };
/** A 4xx reply proves GitHub created no run; 5xx, timeout and network loss do not.
 * Records only the status or error class. Rate limits keep Retry-After. */
export function classifyDispatchFailure(
  response: Response | undefined,
  error: unknown,
  stage: 'setup' | 'dispatch',
  now = Date.now(),
): DispatchFailure {
  if (stage === 'setup') return { outcome: 'rejected', failure: 'setup' };
  if (!response) {
    return { outcome: 'unknown', failure: timedOut(error) ? 'timeout' : 'network' };
  }
  const status = response.status;
  if (status >= 500) return { outcome: 'unknown', failure: `http ${status}` };
  const retryAfter = Number(response.headers.get('retry-after'));
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const limited =
    status === 429 ||
    (status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
  if (limited) {
    const wait =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Number.isFinite(reset) && reset > 0
          ? reset * 1000 - now
          : rateLimitMs.min;
    return {
      outcome: 'rejected',
      failure: `rate-limited http ${status}`,
      retryAfterMs: Math.min(rateLimitMs.max, Math.max(rateLimitMs.min, wait)),
    };
  }
  return {
    outcome: 'rejected',
    failure: status === 401 || status === 403 ? `auth http ${status}` : `http ${status}`,
  };
}
/** The followable reason a refused dispatch settles with; it reaches the landing error. */
export function dispatchFailureReason(failure: string | undefined, repository: string) {
  if (failure?.startsWith('public-runner')) return runnerPublicReason(repository, failure.slice(14));
  if (failure?.startsWith('auth'))
    return (
      `GitHub App dispatch was refused (${failure.slice(5)}). Check that the Forge GitHub App is installed on ` +
      `${repository} with Actions write permission, then finish the same Lane again.`
    );
  if (failure?.startsWith('rate-limited'))
    return `GitHub rate-limited the dispatch (${failure.slice(13)}); Forge waited for Retry-After.`;
  return `GitHub App dispatch was refused${failure ? ` (${failure})` : ''}.`;
}
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
    (hostedCheckTerminal(run) && run.status !== 'cancelled') ||
    run.actions.cancelScheduled !== undefined
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
    { row, run, project } = selected;
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
  // A private project dispatches only to a repository proven private (unless its owner
  // accepted public logs on this runner): a fresh
  // cached read, or 'unchecked' so dispatch reads GitHub once and records it.
  const runnerVisibility =
    !runnerVisibilityRequired(project.visibility, run.configuration) ||
    run.configuration.provider !== 'github-actions'
      ? 'not-required'
      : ((await cachedRepositoryVisibility(ctx, run.configuration.repository, now)) ?? 'unchecked');
  return Object.assign(run, { runnerVisibility });
}
// JSON text (Issue 0c457ae4): a run value never crosses a function boundary as an object.
export const reserve = internalMutation({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => JSON.stringify(await reserveDirectActions(ctx, input)),
});
export const observe = internalMutation({
  args: {
    ...identity,
    fence: v.number(),
    outcome: v.union(v.literal('accepted'), v.literal('unknown'), v.literal('rejected')),
    executionId: v.optional(v.string()),
    failure: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
    visibility: v.optional(v.string()),
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
    if (input.visibility && run.configuration.provider === 'github-actions')
      await recordRepositoryVisibility(ctx, run.configuration.repository, input.visibility);
    if (hostedCheckTerminal(run) && run.status !== 'cancelled') return null;
    run.actions.outcome = input.outcome;
    if (input.failure) run.actions.failure = input.failure.slice(0, 80);
    if (
      run.status !== 'cancelled' &&
      !input.executionId &&
      !run.executionId &&
      input.outcome !== 'accepted'
    ) {
      // Unknown: one lookup after the acknowledgement bound. Rate-limited: wait
      // for Retry-After, then settle; the platform retry re-dispatches and counts.
      const unknown = input.outcome === 'unknown';
      if (unknown || input.retryAfterMs !== undefined) {
        run.status = 'unknown';
        await writeHostedCheck(ctx, row._id, run);
        await ctx.scheduler.runAfter(
          unknown ? directActionsAckMs : input.retryAfterMs!,
          makeFunctionReference<'action'>('projectHostedActionsDirect:reconcile'),
          { projectId: input.projectId, runId: input.runId, fence: input.fence },
        );
        return null;
      }
    }
    if (input.executionId) {
      invariant(
        !run.executionId || run.executionId === input.executionId,
        'EVIDENCE_CHANGED',
        'Actions execution changed.',
      );
      run.executionId = input.executionId;
    }
    if (run.status === 'cancelled') {
      await writeHostedCheck(ctx, row._id, run);
      await requestDirectCancel(ctx, run);
    } else if (input.outcome === 'rejected' && !run.executionId)
      await settleDirectActions(
        ctx,
        selected,
        'runner-unavailable',
        dispatchFailureReason(run.actions.failure, repositoryOf(run)),
      );
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
    const run: (HostedCheckRun & { runnerVisibility?: string }) | null = JSON.parse(
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsDirect:reserve'), input),
    );
    if (!run) return null;
    invariant(run.configuration.provider === 'github-actions', 'RUNNER_UNAVAILABLE', 'Select Actions.');
    let outcome: 'accepted' | 'unknown' | 'rejected' = 'rejected',
      executionId: string | undefined,
      visibility: string | undefined,
      failed: DispatchFailure | undefined,
      seen: Response | undefined,
      stage: 'setup' | 'dispatch' = 'setup';
    try {
      const site = process.env.CONVEX_SITE_URL;
      invariant(
        site && new URL(site).protocol === 'https:',
        'RUNNER_UNAVAILABLE',
        'Convex site URL is unavailable.',
      );
      const token = await installationToken(
        ctx,
        input.projectId,
        run.configuration.repository,
        actionsPermissions,
      );
      if (run.runnerVisibility && run.runnerVisibility !== 'not-required') {
        // The Actions token carries metadata read: one GitHub call per expiry.
        if (run.runnerVisibility === 'unchecked')
          visibility = await readRepositoryVisibility(run.configuration.repository, token);
        requirePrivateRunner('private', run.configuration.repository, visibility ?? run.runnerVisibility);
      }
      // Mark unknown before the non-idempotent call. Never retry a lost response.
      outcome = 'unknown';
      stage = 'dispatch';
      const response = await githubAppRequest(
        `repos/${run.configuration.repository}/actions/workflows/forge-check.yml/dispatches`,
        token,
        async (url, init) => (seen = await convexFetch(url, init)),
        {
          ref: 'main',
          return_run_details: true,
          inputs: {
            runId: run.id,
            deployment: site,
            projectId: run.projectId,
            runs_on: JSON.stringify(run.configuration.runsOn),
          },
        },
      );
      if (response.status === 200) {
        const result = (await response.json()) as { workflow_run_id?: number };
        if (Number.isSafeInteger(result.workflow_run_id) && result.workflow_run_id! > 0)
          executionId = String(result.workflow_run_id);
      }
      outcome = 'accepted';
    } catch (error) {
      // Status or error class only: never provider bodies, credentials or messages.
      failed =
        (error as { code?: string })?.code === runnerPublicCode
          ? {
              outcome: 'rejected',
              failure: `public-runner ${visibility ?? run.runnerVisibility}`,
            }
          : classifyDispatchFailure(seen, error, stage);
      outcome = failed.outcome;
      console.warn(
        'FORGE_ACTIONS_DISPATCH_FAILED',
        JSON.stringify({ runId: run.id, failure: failed.failure }),
      );
    }
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsDirect:observe'), {
      ...input,
      fence: run.fence,
      outcome,
      ...(executionId ? { executionId } : {}),
      ...(failed ? { failure: failed.failure } : {}),
      ...(failed?.retryAfterMs !== undefined ? { retryAfterMs: failed.retryAfterMs } : {}),
      ...(visibility ? { visibility } : {}),
    });
    return null;
  },
});
/** Still unacknowledged at this fence: what reconciliation needs, else null. */
function unacknowledged(run: HostedCheckRun, fence: number) {
  return !hostedCheckTerminal(run) &&
    !run.cancelRequested &&
    run.actions?.fence === fence &&
    run.fence === fence &&
    run.dispatchStarted &&
    !run.executionId
    ? run.actions
    : null;
}
export const pendingReconcile = internalMutation({
  args: { ...identity, fence: v.number() },
  returns: v.union(
    v.null(),
    v.object({ lookup: v.boolean(), repository: v.string(), reservedAt: v.number() }),
  ),
  handler: async (ctx, input) => {
    const { run } = await writableHostedCheck(ctx, input);
    const actions = unacknowledged(run, input.fence);
    if (!actions || run.configuration.provider !== 'github-actions') return null;
    // A refused (rate-limited) dispatch created no run: nothing to look up.
    return {
      lookup: actions.outcome === 'unknown',
      repository: run.configuration.repository,
      reservedAt: actions.reservedAt,
    };
  },
});
/** Adopts the run the lookup found, or settles `interrupted` so the landing's
 * platform retry re-dispatches (bounded). Late reports for that settled run are
 * then refused by run id: no session, result or webhook binds it. */
export async function reconcileDirectActions(
  ctx: MutationCtx,
  input: CheckIdentity & { fence: number; executionId?: string; lookup: string },
) {
  const selected = await writableHostedCheck(ctx, input),
    { row, run } = selected;
  const actions = unacknowledged(run, input.fence);
  if (!actions) return null;
  if (input.executionId) {
    run.executionId = input.executionId;
    actions.outcome = 'accepted';
    if (!run.plan) run.status = 'preparing';
    await writeHostedCheck(ctx, row._id, run);
    return null;
  }
  const failure = actions.failure;
  if (actions.outcome === 'rejected')
    return settleDirectActions(
      ctx,
      selected,
      'runner-unavailable',
      dispatchFailureReason(failure, repositoryOf(run)),
    );
  return settleDirectActions(
    ctx,
    selected,
    'interrupted',
    `The Actions dispatch was never acknowledged (${failure ?? 'no reply'}; lookup ${input.lookup}); Forge checks again.`,
  );
}
export const reconciled = internalMutation({
  args: { ...identity, fence: v.number(), executionId: v.optional(v.string()), lookup: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    await reconcileDirectActions(ctx, input);
    return null;
  },
});
/** One provider lookup per unacknowledged dispatch, by the run-name the workflow
 * declares (`forge-check/<runId>`). No loop, timer or retry of the dispatch here. */
export const reconcile = internalAction({
  args: { ...identity, fence: v.number() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const pending: { lookup: boolean; repository: string; reservedAt: number } | null = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedActionsDirect:pendingReconcile'),
      input,
    );
    if (!pending) return null;
    let executionId: string | undefined,
      lookup = 'skipped';
    if (pending.lookup)
      try {
        const token = await installationToken(ctx, input.projectId, pending.repository, actionsPermissions);
        const since = new Date(Math.floor(pending.reservedAt / 1000) * 1000 - 60_000).toISOString();
        const response = await githubAppRequest(
          `repos/${pending.repository}/actions/workflows/forge-check.yml/runs?event=workflow_dispatch&per_page=100&created=${encodeURIComponent(`>=${since}`)}`,
          token,
        );
        const body = (await response.json()) as { workflow_runs?: { id?: number; display_title?: string }[] };
        const found = body.workflow_runs?.find(item => item.display_title === `forge-check/${input.runId}`);
        lookup = found ? 'found' : 'absent';
        if (found && Number.isSafeInteger(found.id) && found.id! > 0) executionId = String(found.id);
      } catch (error) {
        lookup = `failed ${timedOut(error) ? 'timeout' : 'error'}`;
      }
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsDirect:reconciled'), {
      ...input,
      lookup,
      ...(executionId ? { executionId } : {}),
    });
    return null;
  },
});
