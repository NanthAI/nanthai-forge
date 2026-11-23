// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Starts the dev Convex and web deploy workflows straight after a main landing (Item 8b6efb50),
// through the configured CI adapter repository (falling back to the mirror repo only when no CI
// adapter repository is set). Coalesces rapid bursts per target via one queued marker row and
// schedules a single trailing web flush when a landing arrives inside the 5-minute deploy window.
// Zero polling; zero idle cost.
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

export type DeployTarget = 'convex' | 'web';
export const deployWorkflows: Record<DeployTarget, string> = {
  convex: 'convex-deploy.yml',
  web: 'web-deploy.yml',
};
/** Coalesce window for rapid landings before posting workflow_dispatch. */
export const DEPLOY_COALESCE_MS = 10_000;
/** Minimum spacing between dev web deploys (matches scripts/site-deploy-plan.mjs). */
export const WEB_DEPLOY_WINDOW_MS = 5 * 60_000;
/** Backoff delays for explicitly unaccepted transient statuses (429/502/503/504 or token mint). */
export const deployRetryMs = [60_000, 5 * 60_000, 15 * 60_000] as const;

export const CONVEX_DEPLOY_PATHS = [
  /^convex\//,
  /^src\//,
  /^package(?:-lock)?\.json$/,
  /^\.github\/workflows\/convex-deploy\.yml$/,
  /^scripts\/forge-deploy-ci\.mjs$/,
] as const;

export const WEB_DEPLOY_PATHS = [
  /^web\//,
  /^site\//,
  /^src\//,
  /^convex\//,
  /^scripts\//,
  /^docs\//,
  /^skills\//,
  /^README\.md$/,
  /^package(?:-lock)?\.json$/,
  /^\.github\/workflows\/web-deploy\.yml$/,
] as const;

const matches = (paths: readonly string[], patterns: readonly RegExp[]) =>
  paths.some(path => patterns.some(re => re.test(path)));

/** True when any path in `paths` affects `target`. */
export const pathsAffectTarget = (target: DeployTarget, paths: readonly string[]) =>
  matches(paths, target === 'convex' ? CONVEX_DEPLOY_PATHS : WEB_DEPLOY_PATHS);

/** Which dev deploy targets a landing's changed paths affect. Unknown/absent paths dispatch both
 * so a deploy-relevant change is never missed; test-only landings dispatch nothing. */
export function selectDeployTargets(paths?: readonly string[] | null): DeployTarget[] {
  if (!paths) return ['convex', 'web'];
  const selected: DeployTarget[] = [];
  if (matches(paths, CONVEX_DEPLOY_PATHS)) selected.push('convex');
  if (matches(paths, WEB_DEPLOY_PATHS)) selected.push('web');
  return selected;
}

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

type DispatchInput = { repository: string; target: DeployTarget; state: string; sequence: number };

/** The workflow_dispatch request. Its inputs must match both workflows' declared inputs (a contract
 * test checks them against .github/workflows/*.yml), or GitHub refuses with 422. */
export const deployDispatchRequest = (input: DispatchInput) => ({
  path: `repos/${input.repository}/actions/workflows/${deployWorkflows[input.target]}/dispatches`,
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
    target: DeployTarget;
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
    workflow: deployWorkflows[input.target],
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

/** Called from enqueueGithubMirror when scheduleReleaseSign already confirmed this project is a
 * server-authority project enrolled with release signatures. Coalesces rapid bursts per target
 * into one queued marker row and schedules at most one action per target per burst/window. */
export async function scheduleDevDeploys(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  receipt: HostedAcceptance,
  paths?: readonly string[] | null,
) {
  if (project.sourceAuthority?.mode !== 'server') return false;
  const targets = selectDeployTargets(paths);
  if (!targets.length) return false;
  const repository = await resolveDeployRepository(ctx, project);
  if (!repository) return false;

  const now = Date.now();
  let scheduledAny = false;
  for (const target of targets) {
    let delayMs = DEPLOY_COALESCE_MS;
    if (target === 'web') {
      // Measure the 5-minute window from the newest actual upload, never an unchanged-skip record.
      const recentWeb = await ctx.db
        .query('projectDeploys')
        .withIndex('by_project_and_target_and_status_and_sequence', q =>
          q.eq('projectId', project._id).eq('target', 'web').eq('status', 'succeeded'),
        )
        .order('desc')
        .take(12);
      const lastWeb = recentWeb.find(row => !row.unchanged);
      const lastMs = lastWeb ? Date.parse(lastWeb.at) : NaN;
      if (Number.isFinite(lastMs) && now - lastMs < WEB_DEPLOY_WINDOW_MS) {
        // Schedule one trailing flush right when the 5-minute window opens (zero polling, zero idle cost).
        delayMs = Math.max(DEPLOY_COALESCE_MS, lastMs + WEB_DEPLOY_WINDOW_MS - now + 1_000);
      }
    }
    await queueDeployDispatch(ctx, {
      projectId: project._id,
      repository,
      target,
      head: receipt.candidate.head,
      sequence: receipt.snapshot.revision,
      delayMs,
      now,
    });
    scheduledAny = true;
  }
  return scheduledAny;
}

/** One workflow_dispatch for one target on the configured CI repository's main. Claims the newest
 * coalesced head before calling GitHub so rapid bursts produce one dispatch at the tip. If a web
 * upload finished while this dispatch was waiting in its coalesce window, defers once until the
 * 5-minute window opens instead of dispatching into a closed window. */
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
    if (attempt === 0) {
      const claimed = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectDeployStore:claimQueued'), {
          projectId: input.projectId,
          target: input.target,
        }),
      ) as
        | { action: 'none' }
        | { action: 'defer'; delayMs: number; state: string; sequence: number }
        | { action: 'dispatch'; state: string; sequence: number };
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
        target: input.target,
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
