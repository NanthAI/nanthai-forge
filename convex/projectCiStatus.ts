// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './server';
import { completeHostedCheck, writableHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { mirroredBase } from './gitServeLaneStore';
import { checkPin, hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';
import { recordHead } from './projectHostedRecords';
import {
  CANDIDATE_BRANCH_PREFIX,
  candidateBranch,
  candidatePublishable,
  ciStatusEntryPaths,
  ciStatusVerdict,
  type CiStatusProvider,
} from '../src/ci-status';
import type { Id } from './_generated/dataModel';
import { requireStoredRepositoryBinding } from './githubBindingAccess';
import { invariant } from '../src/errors';

/**
 * The ci-status check provider (flip 3, src/ci-status.ts): a run publishes its Candidate as the branch
 * `forge/candidates/<runId>` of the project's GitHub mirror repository (projectCiStatusPublish), the
 * project's own workflow runs on that push, and GitHub's signed `workflow_run` event settles the run.
 * Per landing: one publish action (one prepare and one record mutation, source reads per 100 objects)
 * and one webhook mutation per workflow event (requested, in progress, completed). Nothing polls.
 */
const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
const ciRun = (run: HostedCheckRun) =>
  run.configuration.provider === 'ci-status' ? run.configuration : null;

/** The saved ci-status runner setting. Candidate branches start from main's mirrored commit, so the CI
 * repository is the project's GitHub mirror, with the Forge App installed. `runtime` and the
 * environment fingerprint are derived from the setting, never typed. */
export async function ciStatusRunner(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  ci: CiStatusProvider,
) {
  invariant(
    ci.adapter === 'github-actions',
    'BAD_ARGUMENT',
    'GitLab CI statuses are verified, but Forge cannot publish Candidates to GitLab yet; choose adapter "github-actions".',
  );
  await requireStoredRepositoryBinding(ctx, projectId, ci.repository, { runner: true });
  const mirror = await ctx.db
    .query('projectGithubMirrors')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  invariant(
    mirror?.repository.toLowerCase() === ci.repository.toLowerCase(),
    'BAD_ARGUMENT',
    `Turn on the GitHub mirror to ${ci.repository} first: Candidate branches start from main's mirrored commit.`,
  );
  const runtime = checkPin({ provider: 'ci-status', ci });
  return { provider: 'ci-status' as const, ci, runtime, environmentFingerprint: runtime };
}

export async function scheduleCiStatus(ctx: MutationCtx, run: HostedCheckRun) {
  if (ciRun(run))
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectCiStatusPublish:publish'), {
      projectId: run.projectId,
      runId: run.id,
    });
}

/** The project role of one account: anyone who is neither the owner nor a contributor is outside. */
async function roleOf(ctx: MutationCtx, projectId: Id<'hostedProjects'>, owner: string, actor: string) {
  if (actor && actor === owner) return 'owner' as const;
  const contributor = actor
    ? await ctx.db
        .query('projectContributors')
        .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', actor))
        .unique()
    : null;
  return contributor ? ('contributor' as const) : ('outside' as const);
}

/** Settles a ci-status run once: the provider's verdict, or why Forge could not run it. */
async function settle(
  ctx: MutationCtx,
  selected: Awaited<ReturnType<typeof writableHostedCheck>>,
  status: 'passed' | 'failed' | 'cancelled' | 'runner-unavailable',
  reason: string,
  now = Date.now(),
) {
  const { row, run } = selected;
  if (hostedCheckTerminal(run)) return;
  run.status = status;
  // One fixed shard: the provider run is the whole check (acceptance evidence counts shards).
  run.counts =
    status === 'passed' ? { completed: 1, passed: 1, failed: 0 } : { completed: 0, passed: 0, failed: 0 };
  run.exitCode = status === 'passed' ? 0 : status === 'failed' ? 1 : null;
  if (status !== 'passed') run.failureReason = reason.slice(0, 500);
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
}

/** Before any GitHub IO: the mirror seed that publishes this Candidate on top of main's mirrored
 * commit for its base, or null when there is nothing to do. */
export const prepare = internalMutation({
  args: identity,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const selected = await writableHostedCheck(ctx, input),
      { row, run } = selected;
    const ci = ciRun(run);
    if (!ci || hostedCheckTerminal(run) || run.cancelRequested || run.ci?.commit) return null;
    invariant(
      ci.ci.adapter === 'github-actions',
      'RUNNER_UNAVAILABLE',
      'Only GitHub Actions publishes today.',
    );
    // The project's workflow runs with the mirror repository's secrets: an outside contributor's
    // Candidate never reaches it (it needs Forge's own runner, where jobs get no token).
    const project = await ctx.db.get(input.projectId);
    const head = await recordHead(ctx, input.projectId, 'candidate', run.request.candidateId);
    const candidate = head ? await ctx.db.get(head.recordId) : null;
    const authors = project
      ? await Promise.all(
          [...new Set([run.actor, candidate?.creatorAccountId ?? ''])].map(actor =>
            roleOf(ctx, input.projectId, project.owner, actor),
          ),
        )
      : [];
    if (!candidatePublishable({ authors, ownerApproved: false })) {
      await settle(
        ctx,
        selected,
        'runner-unavailable',
        `${ci.ci.workflow} runs with ${ci.ci.repository}'s secrets, so Forge publishes only Candidates from the owner and contributors. An outside contributor's Candidate needs a check on Forge's own runner.`,
      );
      return null;
    }
    const mirror = await ctx.db
      .query('projectGithubMirrors')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .unique();
    const base =
      mirror && mirror.repository.toLowerCase() === ci.ci.repository.toLowerCase()
        ? await mirroredBase(ctx, input.projectId, run.candidate.base, mirror.mapping)
        : null;
    if (!base) {
      await settle(
        ctx,
        selected,
        'runner-unavailable',
        `Main's Git commit for this Candidate's base is not on ${ci.ci.repository} yet (the GitHub mirror publishes it after each landing). Check again once the mirror is synced.`,
      );
      return null;
    }
    const name = process.env.FORGE_GITHUB_SYNC_NAME?.trim() || base.committer.name;
    const email = process.env.FORGE_GITHUB_SYNC_EMAIL?.trim() || base.committer.email;
    const state = await ctx.db
      .query('projectHostedStates')
      .withIndex('by_project_and_head', q =>
        q.eq('projectId', input.projectId).eq('head', run.request.expectedHead),
      )
      .unique();
    invariant(state, 'SOURCE_UNAVAILABLE', 'The Candidate needs trusted source registration.');
    const whole = { sha256: run.request.expectedHead, size: state.size };
    run.dispatchStarted = true;
    run.status = 'dispatching';
    run.ci = { branch: candidateBranch(run.id), commit: null, link: null };
    // The provider runs the whole Candidate: one shard, the State itself as selection and manifest.
    run.plan ??= {
      head: run.request.expectedHead,
      definition: run.check.definition,
      runtime: ci.runtime,
      environmentFingerprint: ci.environmentFingerprint,
      lockfile: ci.runtime,
      selection: whole,
      manifest: whole,
      shardCount: 1,
    };
    run.planDigest ??= checkPin(run.plan);
    await writeHostedCheck(ctx, row._id, run);
    return JSON.stringify({
      repository: ci.ci.repository,
      state: run.request.expectedHead,
      previous: run.candidate.base.head,
      acceptanceId: run.id,
      operationId: run.request.operationId,
      viewId: run.request.candidateId,
      message: `Forge Candidate ${run.request.candidateId}\n\nForge-Candidate: ${run.request.candidateId}\nForge-State: ${run.request.expectedHead}`,
      at: run.at,
      binding: base,
      verified: true,
      identity: { name, email },
      branch: run.ci.branch,
    });
  },
});

/** The Candidate branch exists on GitHub: the project's workflow runs on it. */
export const published = internalMutation({
  args: { ...identity, commit: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const { row, run } = await writableHostedCheck(ctx, input);
    if (!ciRun(run) || hostedCheckTerminal(run) || !run.ci) return null;
    invariant(/^[a-f0-9]{40}$/.test(input.commit), 'EVIDENCE_CHANGED', 'Invalid published commit.');
    invariant(
      !run.ci.commit || run.ci.commit === input.commit,
      'EVIDENCE_CHANGED',
      'Another commit was published.',
    );
    run.ci.commit = input.commit;
    run.status = 'running';
    await writeHostedCheck(ctx, row._id, run);
    return null;
  },
});

export const failed = internalMutation({
  args: { ...identity, reason: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const selected = await writableHostedCheck(ctx, input);
    if (ciRun(selected.run))
      await settle(
        ctx,
        selected,
        'runner-unavailable',
        `Forge could not publish the Candidate branch: ${input.reason}`,
      );
    return null;
  },
});

/** A signed `workflow_run` event (convex/http.ts checked the HMAC) on a Candidate branch. Only the
 * configured workflow's push run of the published commit counts (src/ci-status.ts); anything else is
 * ignored and the run waits for its own event. */
export async function receiveCiStatus(
  ctx: MutationCtx,
  payload: { workflow_run?: { head_branch?: unknown } },
) {
  const branch = payload.workflow_run?.head_branch;
  const match =
    typeof branch === 'string' && branch.startsWith(CANDIDATE_BRANCH_PREFIX)
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(
          branch.slice(CANDIDATE_BRANCH_PREFIX.length),
        )
      : null;
  if (!match) return false;
  const row = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_run', q => q.eq('runId', match[0]))
    .unique();
  if (!row) return true;
  const selected = await writableHostedCheck(ctx, { projectId: row.projectId, runId: row.runId }),
    { run } = selected;
  const ci = ciRun(run);
  if (!ci || !run.ci?.commit || hostedCheckTerminal(run)) return true;
  const verdict = ciStatusVerdict(
    ci.ci,
    { runId: run.id, commit: run.ci.commit, executionId: run.executionId },
    { source: 'provider-event', signed: true, payload },
  );
  if (verdict.outcome === 'refused') {
    console.log(`FORGE_CI_STATUS_REFUSED ${JSON.stringify({ runId: run.id, reason: verdict.reason })}`);
    return true;
  }
  if (verdict.outcome !== 'pending' && verdict.outcome !== 'terminal') return true;
  run.executionId = verdict.executionId;
  if (verdict.outcome === 'pending') {
    await writeHostedCheck(ctx, selected.row._id, run);
    return true;
  }
  run.ci = { ...run.ci, link: verdict.link };
  await settle(
    ctx,
    selected,
    verdict.status,
    `${ciStatusEntryPaths(ci.ci)[0]} concluded ${verdict.conclusion}${verdict.link ? ` (${verdict.link})` : ''}.`,
  );
  return true;
}
