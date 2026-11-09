// SPDX-License-Identifier: Apache-2.0
// Two-way sync queue: the push webhook, the publish yield and the settle path. Light enough for
// convex/http.ts, every acceptance (enqueueGithubMirror) and the mirror status to load, with no
// compose or landing machinery behind it (that lives in projectGithubInbound.ts).
import { v } from 'convex/values';
import { z } from 'zod';
import { internalMutation, type MutationCtx, type QueryCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { mirrorRow, scheduleMirror } from './projectGithubMirrorRows';
import { effectivePolicy } from '../src/autonomy-policy';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { githubSyncCommitSchema, type GithubSyncCommit } from '../src/github-sync-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { inboundJobSchema, type InboundJob } from '../src/github-inbound-job';

type Queue = Doc<'projectGithubMirrors'>;
export const parseInbound = (job: Doc<'projectGithubMirrorJobs'>) =>
  inboundJobSchema.parse(JSON.parse(job.inbound!));
export const queuedJobs = (ctx: MutationCtx | QueryCtx, projectId: Id<'hostedProjects'>, limit: number) =>
  ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_status_and_sequence', q => q.eq('projectId', projectId).eq('status', 'queued'))
    .order('asc')
    .take(limit);
export async function finish(
  ctx: MutationCtx,
  job: Doc<'projectGithubMirrorJobs'>,
  queue: Queue,
  mapping: GithubSyncCommit | null,
  status: 'done' | 'failed',
  outcome?: { error: string; detail: string },
) {
  await ctx.db.patch(job._id, {
    status,
    step: job.step + 1,
    ...(outcome ?? {}),
    ...(mapping ? { mapping: canonicalPayload(mapping) } : {}),
  });
  const [next] = await queuedJobs(ctx, job.projectId, 1);
  await ctx.db.patch(queue._id, {
    ...(mapping ? { mapping: canonicalPayload(mapping), mirroredAt: Date.now() } : {}),
    activeId: next?._id ?? null,
  });
  if (next) await scheduleMirror(ctx, next);
}
/** The inbound landing's settled phase, or null while it is still pending. */
export async function inboundLanding(
  ctx: MutationCtx | QueryCtx,
  projectId: Id<'hostedProjects'>,
  submissionId: string,
): Promise<{ phase: 'landed' | 'terminal-failed'; error: string | null } | null> {
  const row =
    (await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_submission', q =>
        q.eq('projectId', projectId).eq('submissionId', submissionId),
      )
      .unique()) ??
    (await ctx.db
      .query('projectHostedLandingDesired')
      .withIndex('by_project_and_submission', q =>
        q.eq('projectId', projectId).eq('submissionId', submissionId),
      )
      .unique());
  if (!row) return null;
  // The landing row's phase column, or a desired goal that failed before it was admitted.
  const value = JSON.parse(row.value) as {
    phase?: string;
    error?: { code: string; message?: string } | null;
  };
  const phase = 'phase' in row && typeof row.phase === 'string' ? row.phase : value.phase;
  if (phase !== 'landed' && phase !== 'terminal-failed') return null;
  return {
    phase,
    error: value.error ? `${value.error.code}${value.error.message ? `: ${value.error.message}` : ''}` : null,
  };
}
/** Called with every acceptance (enqueueGithubMirror) while an inbound job holds the queue.
 * Landed: GitHub's commit now stands for its tree (`equivalent`); queued publishes of older
 * States are replaced by this receipt's publish, which contains them. Failed: the job keeps the
 * failure visible and releases the queue; the next publish puts Forge main over GitHub's commit
 * and says so. Pending: nothing changes. */
export async function settleInbound(
  ctx: MutationCtx,
  queue: Queue,
  receipt: HostedAcceptance,
): Promise<'landed' | 'failed' | null> {
  if (!queue.activeId) return null;
  const job = await ctx.db.get(queue.activeId);
  if (!job?.inbound) return null;
  const inbound = parseInbound(job);
  if (inbound.phase !== 'landing' || !inbound.submissionId) return null;
  const settled = await inboundLanding(ctx, job.projectId, inbound.submissionId);
  if (!settled) return null;
  const previous = githubSyncCommitSchema.parse(JSON.parse(queue.mapping!));
  const landed = settled.phase === 'landed';
  const mapping: GithubSyncCommit = {
    ...previous,
    operationId: inbound.landingOperationId!,
    // The next inbound job starts its Lane from this accepted State.
    acceptanceId: landed ? receipt.id : inbound.base!.receiptId,
    viewId: landed ? receipt.candidate.id : previous.viewId,
    state: inbound.equivalent!,
    parent: previous.commit,
    commit: inbound.commit!,
    tree: inbound.tree!,
    message: inbound.message ?? '',
    seconds: Math.floor(Date.now() / 1000),
  };
  if (landed) {
    for (const old of await queuedJobs(ctx, job.projectId, 100))
      if (!old.inbound && old.sequence < receipt.snapshot.revision)
        await ctx.db.patch(old._id, {
          status: 'done',
          step: old.step + 1,
          detail: `Published within State ${receipt.candidate.head.slice(0, 8)} after GitHub ${inbound.commit!.slice(0, 12)} landed.`,
        });
  }
  const lane = inbound.laneId!.slice(0, 8);
  await finish(
    ctx,
    job,
    queue,
    mapping,
    landed ? 'done' : 'failed',
    landed
      ? undefined
      : {
          error: 'GITHUB_INBOUND_FAILED',
          detail: `GitHub ${inbound.commit!.slice(0, 12)} did not land on Forge (Lane ${lane}; ${settled.error ?? 'failed'}). The next Forge landing publishes Forge main over it on GitHub; fix and land Lane ${lane} to keep the change.`,
        },
  );
  await ctx.db.patch(queue._id, {
    inbound: canonicalPayload({
      commit: inbound.commit,
      laneId: inbound.laneId,
      outcome: settled.phase,
      ...(landed ? {} : { note: true, error: settled.error }),
    }),
  });
  return landed ? 'landed' : 'failed';
}
export const inboundOutcomeSchema = z
  .object({
    commit: z.string(),
    laneId: z.string(),
    outcome: z.enum(['landed', 'terminal-failed']),
    note: z.boolean().optional(),
    error: z.string().nullable().optional(),
  })
  .strict();
export const twoWay = (project: Doc<'hostedProjects'> | null) => {
  const policy = project ? effectivePolicy(project).githubMirror : undefined;
  return project?.sourceAuthority?.mode === 'server' && !project.removal && policy?.autoPush && policy.inbound
    ? policy
    : null;
};

/** Queue one inbound job unless one already waits: it reads GitHub main when it runs, so later
 * pushes coalesce. Sequence 0 sorts it before every queued publish. Runs at once when idle. */
export async function ensureInbound(ctx: MutationCtx, project: Doc<'hostedProjects'>, queue: Queue) {
  const [first] = await queuedJobs(ctx, project._id, 1);
  // A queued push job sorts first (sequence 0); a pull request job (0.5) is not one.
  if (first?.inbound && !first.pullKey) return first._id;
  const id = await ctx.db.insert('projectGithubMirrorJobs', {
    projectId: project._id,
    receiptId: `inbound:${crypto.randomUUID()}`,
    sequence: 0,
    repository: queue.repository,
    authorityEpoch: project.sourceAuthority!.epoch,
    status: 'queued',
    step: 0,
    cursor: null,
    state: '0'.repeat(64),
    inbound: canonicalPayload({ phase: 'pending' } satisfies InboundJob),
  });
  if (!queue.activeId) {
    await ctx.db.patch(queue._id, { activeId: id });
    await scheduleMirror(ctx, { _id: id, step: 0 });
  }
  return id;
}
/** HMAC-verified push webhook (convex/http.ts): one indexed read; Forge's own push or a mirror
 * without two-way sync writes nothing and schedules nothing. */
export const receive = internalMutation({
  args: { repository: v.string(), ref: v.string(), after: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    if (input.ref !== 'refs/heads/main' || !/^[0-9a-f]{40}$/.test(input.after)) return null;
    const key = input.repository.toLowerCase();
    // A repository has one stored binding; operator overrides may name it for a few projects.
    for (const queue of await ctx.db
      .query('projectGithubMirrors')
      .withIndex('by_repository_key', q => q.eq('repositoryKey', key))
      .take(8)) {
      const mapping = queue.mapping ? githubSyncCommitSchema.parse(JSON.parse(queue.mapping)) : null;
      if (mapping?.commit === input.after) continue;
      const project = await ctx.db.get(queue.projectId);
      const policy = twoWay(project);
      if (!policy || policy.repo.toLowerCase() !== key) continue;
      await ensureInbound(ctx, project!, queue);
    }
    return null;
  },
});
/** A publish that found GitHub main moved (GITHUB_SYNC_CHANGED) under two-way sync waits behind
 * an inbound job for GitHub's new head instead of failing; it re-seeds when it runs again. */
export async function yieldToInbound(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  queue: Queue,
  job: Doc<'projectGithubMirrorJobs'>,
) {
  await ctx.db.patch(job._id, {
    status: 'queued',
    step: job.step + 1,
    cursor: null,
    seed: undefined,
    failures: 0,
    error: undefined,
    detail: undefined,
    nextAttemptAt: undefined,
    httpStatus: undefined,
    apiOperation: undefined,
    requestBytes: undefined,
  });
  await ctx.db.patch(queue._id, { activeId: null });
  const inbound = await ensureInbound(ctx, project, { ...queue, activeId: null });
  const step = (await ctx.db.get(inbound))!.step;
  if ((await mirrorRow(ctx, project._id))?.activeId !== inbound) {
    await ctx.db.patch(queue._id, { activeId: inbound });
    await scheduleMirror(ctx, { _id: inbound, step });
  }
}
