// SPDX-License-Identifier: Apache-2.0
import { wakeCiMirrorWaiters } from './projectCiStatusMirror';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import {
  markMirrorStop,
  mirrorJob,
  mirrorRow,
  scheduleMirror,
  resumeMirrorJob,
} from './projectGithubMirrorRows';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { readHostedRecord } from './projectHostedRecords';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { githubSyncCommitSchema, githubSyncSchema } from '../src/github-sync-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { noteMessage } from '../src/landing-message';
import { mirrorPublishMessage } from './projectGithubMirrorMessage';
import { missingObjectDelays, transientMirrorCodes } from '../src/hosted-github-retry';
import { inboundBegin } from './projectGithubInbound';
import { finish, inboundOutcomeSchema, yieldToInbound } from './projectGithubInboundQueue';
import { openLane, projectLink, settlePull } from './projectGithubPullQueue';
import { pusherNotice } from '../src/github-inbound-job';
import { effectivePolicy } from '../src/autonomy-policy';
import { beginMirrorBurst, mirrorAudit, startMirrorPublish } from './projectGithubMirrorCadence';
import type { MirrorSeed } from '../src/hosted-github-mirror';
import { mirrorVerifyAfterPush, retryMirrorVerification } from './projectGithubMirrorVerify';
const identity = { jobId: v.id('projectGithubMirrorJobs'), step: v.number() };
async function seed(
  ctx: MutationCtx,
  active: NonNullable<Awaited<ReturnType<typeof mirrorJob>>>,
  through: number | undefined,
) {
  const { job, queue, project } = active;
  // A link pinned before a project went private (or before Item d357d772) is never posted for a private one.
  const verifyLink = project.visibility === 'public' ? (job.verifyLink ?? null) : null;
  if (job.cursor) return { cursor: job.cursor, repository: job.repository, verifyLink };
  if (job.seed) return { cursor: null, repository: job.repository, seed: JSON.parse(job.seed), verifyLink };
  const row = await acceptanceRow(ctx, { projectId: job.projectId, receiptId: job.receiptId });
  invariant(row, 'SOURCE_UNAVAILABLE', 'Mirror acceptance receipt is unavailable.');
  const receipt = hostedAcceptanceSchema.parse(JSON.parse(row.value));
  const mapped = queue.staged ?? queue.mapping;
  let binding = mapped ? githubSyncCommitSchema.parse(JSON.parse(mapped)) : null;
  const publishedRef =
    queue.staged && queue.mapping
      ? githubSyncCommitSchema.parse(JSON.parse(queue.mapping)).commit
      : queue.stagedRef;
  const publish = through === undefined || job.sequence >= through;
  const mergeParent =
    publish && queue.staged && publishedRef && publishedRef !== queue.stagedRef ? publishedRef : undefined;
  if (!binding) {
    const generation = await selectedGeneration(ctx, project);
    const old = generation ? await record(ctx, recordPartition(generation), 'githubSync', 'github') : null;
    if (old) {
      const value = githubSyncSchema.parse(JSON.parse(old.value));
      invariant(
        value.repository.toLowerCase() === job.repository.toLowerCase() && value.branch === 'main',
        'GITHUB_SYNC_BINDING',
        'The native mirror mapping selects another repository or branch.',
      );
      invariant(
        value.pushed === value.commits.length,
        'GITHUB_SYNC_PENDING',
        'Reconcile the retained native mirror operation before bootstrap.',
      );
      binding = value.commits[value.pushed - 1] ?? null;
    }
  }
  const fallback = async () => {
    const candidate = await readHostedRecord(ctx, {
      projectId: job.projectId,
      actor: project.owner,
      kind: 'candidate',
      key: receipt.candidate.id,
    });
    const intentId = candidate && JSON.parse(candidate.value).intentId;
    const intent = intentId
      ? await readHostedRecord(ctx, {
          projectId: job.projectId,
          actor: project.owner,
          kind: 'intent',
          key: intentId,
        })
      : null;
    invariant(
      intent,
      'SOURCE_UNAVAILABLE',
      'The accepted Intent is unavailable for the mirror commit message.',
    );
    return JSON.parse(intent.value).outcome;
  };
  const name = process.env.FORGE_GITHUB_SYNC_NAME?.trim() || binding?.committer.name;
  const email = process.env.FORGE_GITHUB_SYNC_EMAIL?.trim() || binding?.committer.email;
  invariant(
    name && email && !/[<>\r\n\0]/.test(name + email) && /no-?reply/i.test(email),
    'GITHUB_SYNC_IDENTITY',
    'Configure the existing noreply sync identity with FORGE_GITHUB_SYNC_NAME and FORGE_GITHUB_SYNC_EMAIL, or retain it in githubSync.',
  );
  const published = await mirrorPublishMessage(ctx, job.projectId, receipt, row.sequence, binding, fallback);
  // The first publish after a failed inbound landing says it takes that GitHub change out here.
  const outcome = queue.inbound ? inboundOutcomeSchema.parse(JSON.parse(queue.inbound)) : null;
  const note =
    outcome?.note &&
    `This publish takes GitHub commit ${outcome.commit.slice(0, 12)} out of main: it did not land on Forge (Lane ${outcome.laneId.slice(0, 8)}). Fix and land that Lane to bring it back.`;
  const message = note ? noteMessage(published, note) : published;
  // Item c63c2171: the same repair tells the commit's author on GitHub first (pinned below), in
  // public words only: the refusal code, the Lane and its Forge link, never the refusal detail.
  const notice = note
    ? {
        commit: outcome.commit,
        text: pusherNotice(
          outcome.commit,
          outcome.laneId,
          outcome.error ?? null,
          await projectLink(ctx, project, outcome.laneId),
        ),
      }
    : undefined;
  // No mapping yet: the import row (one indexed read, first job only) says which GitHub commit
  // and Forge State the project began from, so a mirror turned on after landings can catch up.
  const imported = binding
    ? null
    : await ctx.db
        .query('projectGithubImports')
        .withIndex('by_project', q => q.eq('projectId', job.projectId))
        .first();
  const value = {
    cursor: null,
    repository: job.repository,
    seed: {
      repository: job.repository,
      state: receipt.candidate.head,
      previous: receipt.previous.head,
      acceptanceId: receipt.id,
      operationId: receipt.operationId,
      viewId: receipt.candidate.id,
      message,
      at: receipt.at,
      binding,
      verified: !!mapped,
      main: {
        publish,
        ...(publishedRef ? { expectedRef: publishedRef } : {}),
        ...(mergeParent ? { mergeParent } : {}),
      },
      identity: { name, email },
      ...(imported?.publication
        ? { import: { commit: imported.commit, state: imported.publication.head } }
        : {}),
      ...(notice ? { notice } : {}),
    },
  };
  // Pin mutable Intent prose and configured identity before any GitHub IO.
  // A lost commit/ref reply must replay these exact commit bytes.
  const projectUrl = value.seed.main.publish ? await projectLink(ctx, project) : null;
  const receiptLink = projectUrl ? new URL(`code/${job.receiptId}`, `${projectUrl}/`).href : null;
  await ctx.db.patch(job._id, {
    seed: canonicalPayload(value.seed),
    ...(receiptLink ? { verifyLink: receiptLink } : {}),
  });
  return { ...value, verifyLink: receiptLink };
}
export const begin = internalMutation({
  args: identity,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    if (!job) return null;
    if (job.inbound) {
      const inbound = await inboundBegin(ctx, input);
      return inbound && canonicalPayload(inbound);
    }
    const active = await mirrorJob(ctx, input, job);
    if (!active) return null;
    const { project, queue } = active;
    const saved = job.seed ? (JSON.parse(job.seed) as MirrorSeed) : null;
    // A window with over 100 outstanding blobs cannot move a ref. A pinned staged job never moves it.
    const cannotPush = job.blobOnly || saved?.main?.publish === false;
    const audit = cannotPush ? null : await mirrorAudit(ctx, project._id);
    const burst = cannotPush
      ? { ready: true, through: queue.batchThrough }
      : await beginMirrorBurst(ctx, queue, job, !!audit?.red);
    if (!burst.ready) return null;
    const { verifyLink, ...value } = await seed(ctx, active, burst.through);
    const pinned = saved ?? (value.seed as MirrorSeed);
    const verify = pinned?.main?.publish !== false;
    const headRed =
      !!audit?.red && ((queue.revertThrough ?? -1) < job.sequence || audit.red.head === job.state);
    const state = headRed
      ? 'failure'
      : job.exactCheck || (audit?.lastGreen?.sequence ?? -1) >= job.sequence
        ? 'success'
        : 'pending';
    return canonicalPayload({
      ...value,
      projectId: job.projectId,
      ...(verify ? { verification: { state, link: verifyLink } } : {}),
    });
  },
});
export const commit = internalMutation({
  args: {
    ...identity,
    cursor: v.union(v.string(), v.null()),
    mapping: v.union(v.string(), v.null()),
    verify: v.optional(v.union(v.literal('pending'), v.literal('success'), v.literal('failure'))),
    verifyError: v.optional(v.string()),
    verifyRetry: v.optional(v.literal(true)),
    blobOnly: v.optional(v.literal(true)),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const active = await mirrorJob(ctx, input);
    if (!active) return null;
    const { job, queue, project } = active;
    if (input.mapping) {
      const mapping = githubSyncCommitSchema.parse(JSON.parse(input.mapping));
      invariant(
        mapping.acceptanceId === job.receiptId && mapping.state === job.state,
        'GITHUB_SYNC_HISTORY',
        'Retain the mirror acceptance mapping.',
      );
      const staged = job.seed && (JSON.parse(job.seed) as MirrorSeed).main?.publish === false;
      const burstJobId = queue.burstJobId ?? job._id;
      await ctx.db.patch(job._id, {
        status: 'done',
        mapping: canonicalPayload(mapping),
        step: job.step + 1,
        cursor: null,
        blobOnly: undefined,
        failures: 0,
        nextAttemptAt: undefined,
        error: undefined,
        detail: undefined,
        ...(input.verify ? { verify: input.verify } : {}),
        ...(input.verify && !input.verifyError ? { verifySent: input.verify } : {}),
        ...(input.verifyError ? { verifyError: input.verifyError } : {}),
        ...(staged ? { burstJobId } : {}),
      });
      const next = await ctx.db
        .query('projectGithubMirrorJobs')
        .withIndex('by_project_and_status_and_sequence', q =>
          staged
            ? q.eq('projectId', job.projectId).eq('status', 'queued').gt('sequence', job.sequence)
            : q.eq('projectId', job.projectId).eq('status', 'queued'),
        )
        .order('asc')
        .take(1);
      const outcome = queue.inbound ? inboundOutcomeSchema.parse(JSON.parse(queue.inbound)) : null;
      const now = Date.now();
      const patch = {
        activeId: next[0]?._id ?? null,
        ...(staged
          ? {
              staged: canonicalPayload(mapping),
              stagedRef: queue.stagedRef ?? mapping.parent,
              stagedCount: (queue.stagedCount ?? 0) + 1,
              burstJobId,
            }
          : {
              queuedPublishes: Math.max(0, (queue.queuedPublishes ?? 1) - 1 - (queue.stagedCount ?? 0)),
              mapping: canonicalPayload(mapping),
              mirroredAt: now,
              pushedAt: now,
              staged: undefined,
              stagedCount: undefined,
              stagedRef: undefined,
              burstJobId: undefined,
              hold: undefined,
              batchThrough: undefined,
              burstFirstAt: undefined,
              ...(input.verifyError ? { verifyError: input.verifyError } : {}),
              ...(input.verify === 'pending' ? { pendingVerify: (queue.pendingVerify ?? 0) + 1 } : {}),
              ...((queue.flushThrough ?? -1) <= job.sequence ? { flushThrough: undefined } : {}),
              ...((queue.revertThrough ?? -1) <= job.sequence ? { revertThrough: undefined } : {}),
              ...(outcome?.note ? { inbound: canonicalPayload({ ...outcome, note: false }) } : {}),
            }),
      };
      invariant(
        !staged || next[0],
        'GITHUB_SYNC_HISTORY',
        'The retained mirror burst is missing its final State.',
      );
      await ctx.db.patch(queue._id, patch);
      if (!staged && queue.burstJobId) await ctx.db.patch(queue.burstJobId, { burstPublished: true });
      if (next[0]) await startMirrorPublish(ctx, project, { ...queue, ...patch }, next[0]);
      const transitioned =
        input.verify === 'pending' &&
        (await mirrorVerifyAfterPush(
          ctx,
          { ...queue, ...patch },
          { ...job, mapping: canonicalPayload(mapping) },
        ));
      if (input.verifyRetry && !transitioned) await retryMirrorVerification(ctx, queue, [job._id], 1);
      if (job.ciWaiters) await wakeCiMirrorWaiters(ctx, job._id);
    } else {
      invariant(input.cursor, 'SOURCE_UNAVAILABLE', 'Mirror continuation is unavailable.');
      await ctx.db.patch(job._id, {
        status: 'running',
        step: job.step + 1,
        cursor: input.cursor,
        blobOnly: input.blobOnly,
        failures: 0,
        nextAttemptAt: undefined,
        error: undefined,
        detail: undefined,
      });
      await scheduleMirror(ctx, { _id: job._id, step: job.step + 1 });
    }
    return null;
  },
});
export const failed = internalMutation({
  args: {
    ...identity,
    code: v.string(),
    detail: v.string(),
    httpStatus: v.optional(v.number()),
    apiOperation: v.optional(v.string()),
    requestBytes: v.optional(v.number()),
    cursor: v.optional(v.string()),
    missingObject: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.jobId);
    if (!job || job.step !== input.step || ['done', 'failed'].includes(job.status)) return null;
    const queue = await mirrorRow(ctx, job.projectId);
    if (queue?.activeId !== job._id) return null;
    if (input.code === 'GITHUB_SYNC_CHANGED' && !job.inbound) {
      const project = await ctx.db.get(job.projectId);
      const mirror = project ? effectivePolicy(project).githubMirror : null;
      if (project && mirror?.autoPush && mirror.inbound) {
        await yieldToInbound(ctx, project, queue, job);
        return null;
      }
    }
    // A checkpointed advance selects a different immutable request. Bound
    // consecutive failures of that request, not failures accumulated while
    // successfully publishing other blobs in the same window.
    let failures = (input.cursor ? 0 : (job.failures ?? 0)) + 1;
    // GitHub read-after-write lag on this job's own objects (adff6f58): its own
    // short budget, counted only across consecutive such 422s of this request.
    const lag = input.missingObject === true && input.httpStatus === 422;
    if (lag)
      failures =
        (!input.cursor && job.status === 'retrying' && job.httpStatus === 422 ? (job.failures ?? 0) : 0) + 1;
    const transient =
      transientMirrorCodes.includes(input.code) ||
      (input.code === 'GITHUB_SYNC_API' &&
        (input.httpStatus === 429 ||
          (input.httpStatus !== undefined && input.httpStatus >= 500 && input.httpStatus <= 599)));
    const delay = lag
      ? (missingObjectDelays[failures - 1] ?? null)
      : transient && failures < 5
        ? 60_000 * 2 ** (failures - 1)
        : null;
    // A pull request job never holds the queue on a terminal failure: forge/verify says why.
    if (delay === null && job.pullKey) {
      await finish(ctx, job, queue, null, 'failed', { error: input.code, detail: input.detail });
      await settlePull(
        ctx,
        (await ctx.db.get(job._id))!,
        'error',
        `${input.code}: ${input.detail}`,
        `${input.code}: ${openLane}`,
      );
      return null;
    }
    // Advance the worker fence, retaining the exact cursor/seed. Duplicate or
    // late callbacks cannot spend another attempt or overwrite newer progress.
    const step = job.step + 1;
    await ctx.db.patch(job._id, {
      status: delay === null ? 'failed' : 'retrying',
      step,
      failures,
      error: input.code,
      // A terminal job holds the queue: name the one recovery command.
      detail:
        delay === null
          ? `${input.detail} Next: fix the cause, then the project owner runs nforge github resume PROJECT (or Resume in the mirror panel); the cursor and State are kept.`
          : input.detail,
      httpStatus: input.httpStatus,
      apiOperation: input.apiOperation,
      requestBytes: input.requestBytes,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      nextAttemptAt: delay === null ? undefined : Date.now() + delay,
    });
    if (delay !== null) await scheduleMirror(ctx, { _id: job._id, step }, delay);
    else {
      // The job now holds the queue: landed replies name the stop (friction 28e84c06).
      await markMirrorStop(ctx, job);
      if (job.ciWaiters) await wakeCiMirrorWaiters(ctx, job._id);
    }
    return null;
  },
});
export const resume = internalMutation({
  args: { jobId: v.id('projectGithubMirrorJobs') },
  returns: v.object({
    status: v.union(
      v.literal('missing'),
      v.literal('done'),
      v.literal('already-running'),
      v.literal('scheduled'),
    ),
    step: v.union(v.number(), v.null()),
  }),
  handler: (ctx, input) => resumeMirrorJob(ctx, input.jobId),
});
