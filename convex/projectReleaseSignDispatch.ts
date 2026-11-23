// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Starts the automated CLI release signer straight after a main landing (docs/operations/cli-update.md,
// "Automated signer"), so signing never waits on the GitHub mirror push. The signer starts from the
// Forge State it is handed and signs whatever is Forge main's newest State when it runs, so a late or
// out-of-order dispatch can never leave the newest State unsigned.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { effectivePolicy } from '../src/autonomy-policy';
import { internalAction } from './server';
import { githubAppRequest, installationToken } from './githubAppToken';
import { convexFetch } from './networkFetch';

export const releaseSignWorkflow = 'release-sign.yml';
/** Waits before each retry of a dispatch GitHub did not answer with a 4xx (5xx, rate limit, network,
 * token mint). A retry that creates a second run costs one skipped read; the signer is idempotent. */
export const releaseSignRetryMs = [60_000, 5 * 60_000, 15 * 60_000] as const;

type DispatchInput = { repository: string; state: string; release: number };

/** The dispatch request. Its inputs must match the workflow's declared `workflow_dispatch` inputs
 * (a contract test reads the workflow), or GitHub refuses it with 422. */
export const releaseSignDispatchRequest = (input: DispatchInput) => ({
  path: `repos/${input.repository}/actions/workflows/${releaseSignWorkflow}/dispatches`,
  body: { ref: 'main', inputs: { state: input.state, release: String(input.release) } },
});

/** Called when main publishes a landing (a landing batch publishes once), from the mirror enqueue but
 * ahead of its auto-push check and queue, so whatever the mirror is doing: paused, held, failing or
 * refused. It needs only the mirror's
 * repository name. One indexed read: only a project that already has a stored release signature
 * releases signed CLI builds. Then one scheduled action; nothing runs when main does not move. */
export async function scheduleReleaseSign(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  receipt: HostedAcceptance,
) {
  const repository = effectivePolicy(project).githubMirror?.repo;
  if (!repository || project.sourceAuthority?.mode !== 'server') return false;
  const releases = await ctx.db
    .query('projectReleaseSignatures')
    .withIndex('by_project_and_head', q => q.eq('projectId', project._id))
    .first();
  if (!releases) return false;
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectReleaseSignDispatch:dispatch'), {
    projectId: project._id,
    repository,
    state: receipt.candidate.head,
    release: receipt.snapshot.revision,
    attempt: 0,
  });
  return true;
}

/** A 4xx proves GitHub refused (no App grant, workflow missing or older); rate limits are not refusals. */
export const releaseSignRefused = (status: number | undefined) =>
  status !== undefined && status >= 400 && status < 500 && status !== 403 && status !== 429;

/** One workflow_dispatch on the mirror repository's main. GitHub's concurrency group keeps one signer
 * running and one queued, a newer dispatch replacing the queued one; whichever run goes last signs
 * main's newest State. A 4xx refusal (no App grant, workflow missing or older) is logged, not retried. */
export const dispatch = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    repository: v.string(),
    state: v.string(),
    release: v.number(),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const attempt = input.attempt ?? 0;
    let seen: Response | undefined;
    try {
      const token = await installationToken(ctx, input.projectId, input.repository, { actions: 'write' });
      const request = releaseSignDispatchRequest(input);
      await githubAppRequest(
        request.path,
        token,
        async (url, init) => (seen = await convexFetch(url, init)),
        request.body,
      );
    } catch (error) {
      // The dispatch reply, or the token mint's GitHub status; none for a network loss.
      const status = seen?.status ?? (error as { status?: number })?.status;
      const retry = !releaseSignRefused(status) && attempt < releaseSignRetryMs.length;
      // Code and status only: never provider bodies, credentials or messages.
      console.warn(
        'FORGE_RELEASE_SIGN_DISPATCH_FAILED',
        JSON.stringify({
          projectId: input.projectId,
          release: input.release,
          attempt,
          retry,
          code: (error as { code?: string })?.code ?? 'unknown',
          status: status ?? null,
        }),
      );
      if (retry)
        await ctx.scheduler.runAfter(
          releaseSignRetryMs[attempt]!,
          makeFunctionReference<'action'>('projectReleaseSignDispatch:dispatch'),
          { ...input, attempt: attempt + 1 },
        );
    }
    return null;
  },
});
