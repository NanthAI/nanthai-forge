// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Configured GitHub Actions targets dispatch straight after a main landing. One queued marker
// coalesces rapid changes and an optional target-specific interval defers the next dispatch.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { effectivePolicy } from '../src/autonomy-policy';
import { internalAction } from './server';
import { githubAppRequest, installationToken } from './githubAppToken';
import { convexFetch } from './networkFetch';
import { checkSetting } from './projectHostedCheckStore';
import { deployTarget } from './projectDeployFields';

import type { DeployTarget } from '../src/deploy-targets';
import { newestSuccesses, pathsAffectTarget } from './projectDeployRows';

/** Coalesce window for rapid landings before posting workflow_dispatch. */
export const DEPLOY_COALESCE_MS = 10_000;
/** Backoff for explicitly unaccepted transient statuses or token mint. */
export const deployRetryMs = [60_000, 5 * 60_000, 15 * 60_000] as const;

export const selectDeployTargets = (targets: readonly DeployTarget[], paths?: readonly string[] | null) =>
  targets.filter(target => !paths || pathsAffectTarget(target, paths));

/** Resolve the repository hosting CI workflows: configured CI adapter first (`github-actions` or
 * `ci-status` with `github-actions` adapter), falling back to `githubMirror.repo` when absent. */
export async function resolveDeployRepository(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
): Promise<string | null> {
  const runnerRow = await checkSetting(ctx, project._id, 'runner', 'runner');
  if (runnerRow) {
    try {
      const runner = JSON.parse(runnerRow.value) as {
        provider?: string;
        repository?: string;
        ci?: { adapter?: string; repository?: string };
      };
      if (runner.provider === 'github-actions' && runner.repository) return runner.repository;
      if (runner.provider === 'ci-status' && runner.ci?.adapter === 'github-actions' && runner.ci.repository)
        return runner.ci.repository;
    } catch {
      // ignore malformed runner record and fall back
    }
  }
  return effectivePolicy(project).githubMirror?.repo ?? null;
}

type DispatchInput = { repository: string; workflow: string; state: string; sequence: number };

/** The workflow_dispatch request. Its inputs must match both workflows' declared inputs (a contract
 * test checks them against .github/workflows/*.yml), or GitHub refuses with 422. */
export const deployDispatchRequest = (input: DispatchInput) => ({
  path: `repos/${input.repository}/actions/workflows/${input.workflow}/dispatches`,
  body: { ref: 'main', inputs: { state: input.state, sequence: String(input.sequence) } },
});

/** Only retry explicit non-accepted statuses (429/503) after a POST; gateway errors (502/504) and
 * network timeouts are ambiguous after POST and never blindly retried (the 3-hour catch-up schedule
 * covers dropped dispatches) so non-idempotent workflow_dispatch calls never create duplicate runs. */
export const deployDispatchRetryable = (status: number | undefined, phase: 'token' | 'post') => {
  if (phase === 'token') return status === undefined || status === 429 || status >= 500;
  return status === 429 || status === 503;
};

/** Schedule a single coalesced dispatch for `(projectId, target)` after `delayMs` if none is queued,
 * or patch an existing queued marker in place to the newer `(head, sequence)`. */
export async function queueDeployDispatch(
  ctx: MutationCtx,
  input: {
    projectId: Doc<'hostedProjects'>['_id'];
    repository: string;
    target: string;
    workflow: string;
    head: string;
    sequence: number;
    delayMs: number;
    now: number;
  },
) {
  const existing = await ctx.db
    .query('projectDeploys')
    .withIndex('by_project_and_target_and_run', q =>
      q.eq('projectId', input.projectId).eq('target', input.target).eq('runId', 'queued'),
    )
    .unique();
  if (existing) {
    if (input.sequence >= existing.sequence) {
      await ctx.db.patch(existing._id, {
        head: input.head,
        sequence: input.sequence,
        at: new Date(input.now).toISOString(),
      });
    }
    return false;
  }
  await ctx.db.insert('projectDeploys', {
    projectId: input.projectId,
    target: input.target,
    workflow: input.workflow,
    sequence: input.sequence,
    head: input.head,
    status: 'queued',
    runId: 'queued',
    at: new Date(input.now).toISOString(),
  });
  await ctx.scheduler.runAfter(
    input.delayMs,
    makeFunctionReference<'action'>('projectDeployDispatch:dispatch'),
    {
      projectId: input.projectId,
      repository: input.repository,
      target: input.target,
      state: input.head,
      sequence: input.sequence,
      attempt: 0,
    },
  );
  return true;
}

export async function scheduleDeploys(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  receipt: HostedAcceptance,
  paths?: readonly string[] | null,
) {
  if (project.sourceAuthority?.mode !== 'server') return;
  const targets = selectDeployTargets(project.autonomyPolicy?.deploys?.targets ?? [], paths);
  if (!targets.some(target => target.githubActions)) return;
  const repository = await resolveDeployRepository(ctx, project);
  if (!repository) return;

  const now = Date.now();
  for (const { name, githubActions } of targets) {
    if (!githubActions) continue;
    let delayMs = DEPLOY_COALESCE_MS;
    const interval = githubActions.minimumIntervalMs ?? 0;
    if (interval) {
      const { lastUploaded } = await newestSuccesses(ctx, project._id, name);
      if (lastUploaded) {
        delayMs = Math.max(delayMs, Date.parse(lastUploaded.at) + interval - now + 1_000);
      }
    }
    await queueDeployDispatch(ctx, {
      projectId: project._id,
      repository,
      target: name,
      workflow: githubActions.workflow,
      head: receipt.candidate.head,
      sequence: receipt.snapshot.revision,
      delayMs,
      now,
    });
  }
}

/** One workflow_dispatch for one target on the configured CI repository's main. Claims the newest
 * coalesced head before calling GitHub so rapid bursts produce one dispatch at the tip.
 * When an upload closes the configured interval, the claim can defer until it opens. */
export const dispatch = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    repository: v.string(),
    target: deployTarget,
    state: v.string(),
    sequence: v.number(),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const attempt = input.attempt ?? 0;
    let state = input.state;
    let sequence = input.sequence;
    let workflow: string;
    if (attempt === 0) {
      const claimed = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectDeployStore:claimQueued'), {
          projectId: input.projectId,
          target: input.target,
          repository: input.repository,
        }),
      ) as
        | { action: 'none' }
        | { action: 'defer'; delayMs: number; state: string; sequence: number }
        | { action: 'dispatch'; state: string; sequence: number; workflow: string };
      if (claimed.action === 'none') return null;
      if (claimed.action === 'defer') {
        await ctx.scheduler.runAfter(
          claimed.delayMs,
          makeFunctionReference<'action'>('projectDeployDispatch:dispatch'),
          { ...input, state: claimed.state, sequence: claimed.sequence, attempt: 0 },
        );
        return null;
      }
      state = claimed.state;
      sequence = claimed.sequence;
      workflow = claimed.workflow;
    } else {
      const current = (await ctx.runQuery(
        makeFunctionReference<'query'>('projectDeployStore:dispatchWorkflow'),
        { projectId: input.projectId, target: input.target, repository: input.repository },
      )) as string | null;
      if (!current) return null;
      workflow = current;
    }

    let token: string;
    try {
      token = await installationToken(ctx, input.projectId, input.repository, { actions: 'write' });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      const retry = deployDispatchRetryable(status, 'token') && attempt < deployRetryMs.length;
      console.warn(
        'FORGE_DEPLOY_DISPATCH_FAILED',
        JSON.stringify({
          projectId: input.projectId,
          sequence,
          target: input.target,
          attempt,
          retry,
          code: (error as { code?: string })?.code ?? 'unknown',
          status: status ?? null,
        }),
      );
      if (retry)
        await ctx.scheduler.runAfter(
          deployRetryMs[attempt]!,
          makeFunctionReference<'action'>('projectDeployDispatch:dispatch'),
          { ...input, state, sequence, attempt: attempt + 1 },
        );
      return null;
    }

    let seen: Response | undefined;
    try {
      const request = deployDispatchRequest({
        repository: input.repository,
        workflow,
        state,
        sequence,
      });
      await githubAppRequest(
        request.path,
        token,
        async (url, init) => (seen = await convexFetch(url, init)),
        request.body,
      );
    } catch (error) {
      const status = seen?.status ?? (error as { status?: number })?.status;
      const retry = deployDispatchRetryable(status, 'post') && attempt < deployRetryMs.length;
      // Code and status only: never provider bodies, credentials or messages.
      console.warn(
        'FORGE_DEPLOY_DISPATCH_FAILED',
        JSON.stringify({
          projectId: input.projectId,
          sequence,
          target: input.target,
          attempt,
          retry,
          code: (error as { code?: string })?.code ?? 'unknown',
          status: status ?? null,
        }),
      );
      if (retry)
        await ctx.scheduler.runAfter(
          deployRetryMs[attempt]!,
          makeFunctionReference<'action'>('projectDeployDispatch:dispatch'),
          { ...input, state, sequence, attempt: attempt + 1 },
        );
    }
    return null;
  },
});
