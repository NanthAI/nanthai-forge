// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { v } from 'convex/values';
import { effectivePolicy } from '../src/autonomy-policy';
import { mirrorCadence, mirrorDeadline, mirrorRedHoldMs } from '../src/hosted-github-mirror-status';
import { mirrorRow, scheduleMirror } from './projectGithubMirrorRows';
import { cancelPendingTask } from './schedulerCancel';

type Queue = Doc<'projectGithubMirrors'>;
type Job = Doc<'projectGithubMirrorJobs'>;
type Project = Doc<'hostedProjects'>;
export const mirrorCadenceView = v.object({
  value: v.union(v.literal('automatic'), v.literal('every-landing'), v.literal('batch-quick-landings')),
  medianFullCheckMs: v.union(v.number(), v.null()),
  samples: v.number(),
  windowMs: v.number(),
  boundsMs: v.array(v.number()),
  maxHoldMs: v.number(),
  pushNowPaths: v.array(v.string()),
  reason: v.string(),
});

export async function mirrorCadenceRead(ctx: QueryCtx | MutationCtx, project: Project, row?: Queue | null) {
  const policy = effectivePolicy(project).githubMirror;
  if (!policy) return null;
  const queue = row === undefined ? await mirrorRow(ctx, project._id) : row;
  return mirrorCadence(policy, queue?.checkWalls?.map(check => check.milliseconds) ?? []);
}

export const mirrorAudit = (ctx: MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedMainAudits')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();

/** Reuses the selected next job and its existing wake. No timer remains when the queue drains. */
export async function startMirrorPublish(
  ctx: MutationCtx,
  project: Project,
  queue: Queue,
  job: Pick<Job, '_id' | 'step' | 'sequence' | 'acceptedAt' | 'inbound' | 'seed' | 'cursor'>,
) {
  if (
    job.inbound ||
    job.seed ||
    job.cursor ||
    queue.batchThrough !== undefined ||
    job.acceptedAt === undefined
  )
    return scheduleMirror(ctx, job);
  const policy = effectivePolicy(project).githubMirror;
  if (!policy?.autoPush) return;
  const reverted = (queue.revertThrough ?? -1) >= job.sequence;
  const flushed = (queue.flushThrough ?? -1) >= job.sequence;
  if (queue.hold) {
    const more = (queue.newestPublish ?? -1) > job.sequence;
    const held = !more && !reverted && !(flushed && !queue.hold.red);
    return scheduleMirror(ctx, job, held ? Math.max(0, queue.hold.until - Date.now()) : 0);
  }
  const lastPushAt = queue.pushedAt ?? queue.mirroredAt;
  const red = !reverted && Boolean((await mirrorAudit(ctx, project._id))?.red);
  const until = mirrorDeadline({
    firstAt: job.acceptedAt,
    ...(lastPushAt === undefined ? {} : { lastPushAt }),
    windowMs: mirrorCadence(policy, queue.checkWalls?.map(check => check.milliseconds) ?? []).windowMs,
    red,
    revert: reverted,
    flushPaths: flushed,
  });
  const delay = Math.max(0, until - Date.now());
  const holding =
    until > job.acceptedAt || ((reverted || (flushed && !red)) && policy.push !== 'every-landing');
  if (holding) await ctx.db.patch(queue._id, { hold: { firstAt: job.acceptedAt, until, red } });
  await scheduleMirror(ctx, job, delay);
}

/** Fast-path an already held burst for a revert, a matching path, or a green release. The
 * worker still observes the audit before it chooses a ref update. */
export async function wakeHeldMirror(
  ctx: MutationCtx,
  queue: Queue,
  now: number,
  mode: 'flush' | 'every' | 'stage' = 'flush',
) {
  if (!queue.hold || !queue.activeId || queue.hold.until <= now) return;
  const job = await ctx.db.get(queue.activeId);
  if (!job || job.inbound || job.status !== 'queued') return;
  const task = job.scheduledId ? await ctx.db.system.get(job.scheduledId) : null;
  if (mode === 'stage' && task && task.scheduledTime <= now) return;
  if (!(await cancelPendingTask(ctx, job.scheduledId, task))) return;
  if (mode !== 'stage')
    await ctx.db.patch(queue._id, { hold: mode === 'every' ? undefined : { ...queue.hold, until: now } });
  // Fence the cancelled wake even in a replay where the harness already read its arguments.
  const step = job.step + 1;
  await ctx.db.patch(job._id, { step });
  await scheduleMirror(ctx, { _id: job._id, step });
}

/** Inbound work can use the queue during a hold. Its handoff keeps the original deadline. */
export async function suspendHeldMirror(ctx: MutationCtx, queue: Queue) {
  if (!queue.hold || !queue.activeId || queue.hold.until <= Date.now()) return false;
  const job = await ctx.db.get(queue.activeId);
  if (!job || job.inbound || job.status !== 'queued') return false;
  if (!(await cancelPendingTask(ctx, job.scheduledId))) return false;
  await ctx.db.patch(job._id, { step: job.step + 1, scheduledId: undefined });
  return true;
}

/** Decide once, when the original wake runs. New arrivals beyond the pinned end form the
 * next burst. A red that appeared during a normal hold extends only to the original cap. */
export async function beginMirrorBurst(ctx: MutationCtx, queue: Queue, job: Job, auditRed: boolean) {
  const now = Date.now();
  const reverted = (queue.revertThrough ?? -1) >= job.sequence;
  if (!job.seed && queue.batchThrough !== undefined && (queue.revertThrough ?? -1) > queue.batchThrough) {
    await ctx.db.patch(queue._id, { batchThrough: queue.revertThrough });
    return { ready: true, through: queue.revertThrough };
  }
  if (!queue.hold && (!auditRed || reverted || job.acceptedAt === undefined))
    return { ready: true, through: queue.batchThrough };
  const { firstAt, until } = queue.hold ?? { firstAt: queue.burstFirstAt ?? job.acceptedAt!, until: now };
  const deadline = reverted ? now : auditRed ? firstAt + mirrorRedHoldMs : until;
  if (deadline > now) {
    // Earlier accepted States can be materialized while the newest still owns the ref deadline.
    if (!job.seed && (queue.newestPublish ?? -1) > job.sequence)
      return { ready: true, through: queue.newestPublish };
    // The original hold wake may have fired on the normal cadence before the audit went red.
    await ctx.db.patch(queue._id, { hold: { firstAt, until: deadline, red: auditRed } });
    const step = job.step + 1;
    await ctx.db.patch(job._id, { step, status: 'queued' });
    await scheduleMirror(ctx, { _id: job._id, step }, deadline - now);
    return { ready: false };
  }
  const through =
    queue.batchThrough ??
    (reverted
      ? queue.revertThrough
      : (queue.flushThrough ?? -1) >= job.sequence && !auditRed
        ? queue.flushThrough
        : queue.newestPublish);
  if (queue.hold || queue.batchThrough !== through)
    await ctx.db.patch(queue._id, { hold: undefined, batchThrough: through, burstFirstAt: firstAt });
  return { ready: true, through };
}
