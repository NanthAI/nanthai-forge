// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markDirectoryChange } from './publicDirectorySource';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery } from './server';
import { cancelPendingTask } from './schedulerCancel';
import { accountFor } from './urlIdentity';
import { retirePublishedDependencies, startProfileRevocation } from './publicProfileDependencies';

type Job = Doc<'publicSnapshotJobs'>;
const minute = 60_000;
const directory = 'directory';
const windowFor = (key: string) => (key === directory ? 10 * minute : minute);
const maxAttempts = 7;
const lease = 11 * minute; // After the maximum lifetime of a Convex action, never while it can still write.
const identity = { id: v.id('publicSnapshotJobs'), serial: v.number() };
const extents = v.object({ active: v.number(), stars: v.number(), newest: v.number(), search: v.number() });

export const publicSnapshotJobsEnabled = () => process.env.FORGE_PUBLIC_SNAPSHOTS === '1';

const byKey = (ctx: QueryCtx | MutationCtx, key: string) =>
  ctx.db
    .query('publicSnapshotJobs')
    .withIndex('by_key', q => q.eq('key', key))
    .unique();

async function schedule(ctx: MutationCtx, row: Job, at: number, patch: Partial<Job> = {}) {
  await cancelPendingTask(ctx, row.task);
  const serial = row.serial + 1;
  const task = await ctx.scheduler.runAt(at, internal.publicSnapshotWorker.run, { id: row._id, serial });
  await ctx.db.patch(row._id, { ...patch, serial, task, phase: 'queued' });
}

/** Call in the mutation that changed the authoritative read. Dormant until explicitly enabled;
 * a queued job absorbs ordinary changes, and a running job keeps at most one follow-up deadline. */
async function queuePublicSnapshots(
  ctx: MutationCtx,
  keys: readonly string[],
  privacy: boolean,
  changed: readonly Id<'hostedProjects'>[] = [],
) {
  const requested: NonNullable<Doc<'hostedProjects'>['snapshotHide']> = [];
  const now = Date.now();
  for (const key of new Set(keys)) {
    let row = await byKey(ctx, key);
    if (!row) {
      const id = await ctx.db.insert('publicSnapshotJobs', {
        key,
        generation: 1,
        serial: 0,
        phase: 'idle',
        urgent: false,
        step: 'publish',
        attempt: 0,
      });
      row = (await ctx.db.get(id))!;
    }
    if (key === directory) {
      const serial = row.serial + Number(privacy || row.phase !== 'queued' || row.step !== 'publish');
      for (const id of changed) await markDirectoryChange(ctx, id, serial);
    }
    if (privacy) {
      requested.push({ id: row._id, generation: await urgentJob(ctx, row, now) });
    } else if (row.phase === 'idle' || (row.phase === 'failed' && !row.urgent)) {
      await schedule(ctx, row, now + windowFor(key), { step: 'publish', attempt: 0 });
    } else if ((row.phase === 'running' || row.step === 'purgeAgain') && row.dirtyAt === undefined) {
      await ctx.db.patch(row._id, { dirtyAt: now });
    }
  }
  return requested;
}

async function urgentJob(ctx: MutationCtx, row: Job, now: number) {
  if (row.step === 'blankProfile' && row.phase === 'queued') return row.generation;
  const generation = row.generation + 1;
  await schedule(ctx, row, now, {
    generation,
    urgent: true,
    step: row.key.startsWith('profile/') ? 'blankProfile' : 'publish',
    purgeAfter: undefined,
    dirtyAt: undefined,
    attempt: 0,
  });
  return generation;
}

export async function queueDependentProfile(ctx: MutationCtx, id: Job['_id']) {
  const row = await ctx.db.get(id);
  if (!row?.key.startsWith('profile/')) return null;
  return urgentJob(ctx, row, Date.now());
}

export async function queueProjectSnapshots(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  privacy: boolean,
  previousSlug?: string,
) {
  if (!publicSnapshotJobsEnabled() || (!privacy && project.visibility !== 'public')) return;
  const account = await accountFor(ctx, project.owner);
  if (!account?.handle || !project.slug) return;
  if (privacy) await startProfileRevocation(ctx, project._id);
  const requested = await queuePublicSnapshots(
    ctx,
    [
      `profile/${account.handle}`,
      `project/${account.handle}/${project.slug}`,
      directory,
      ...(previousSlug ? [`project/${account.handle}/${previousSlug}`] : []),
    ],
    privacy,
    [project._id],
  );
  if (privacy && requested.length) {
    if (project.visibility === 'private' || project.removal)
      await ctx.db.patch(project._id, { snapshotHide: requested });
    else if (project.snapshotHide) await ctx.db.patch(project._id, { snapshotHide: undefined });
  }
}

export async function queueProjectRead(ctx: MutationCtx, project: Doc<'hostedProjects'>, privacy: boolean) {
  if (!publicSnapshotJobsEnabled() || project.visibility !== 'public' || project.removal || !project.slug)
    return;
  const account = await accountFor(ctx, project.owner);
  if (account?.handle) {
    if (privacy) await startProfileRevocation(ctx, project._id);
    await queuePublicSnapshots(ctx, [`project/${account.handle}/${project.slug}`], privacy);
  }
}

export async function queuePublicAccountRead(
  ctx: MutationCtx,
  handle: string | undefined,
  options: {
    profile?: true;
    directory?: true;
    slugs?: readonly string[];
    previousHandle?: string | undefined;
    coalesce?: true;
    projects?: readonly Id<'hostedProjects'>[];
  },
) {
  if (!publicSnapshotJobsEnabled() || !handle) return;
  const { previousHandle, slugs = [] } = options;
  const handles = previousHandle ? [handle, previousHandle] : [handle];
  await queuePublicSnapshots(
    ctx,
    [
      ...(options.directory ? [directory] : []),
      ...(options.profile ? handles.map(h => `profile/${h}`) : []),
      ...slugs.flatMap(slug => handles.map(h => `project/${h}/${slug}`)),
    ],
    !options.coalesce,
    options.projects,
  );
}

export async function queueOwnerSnapshots(
  ctx: MutationCtx,
  owner: string,
  handle: string,
  previousHandle?: string,
  cursor: string | null = null,
) {
  if (!publicSnapshotJobsEnabled()) return;
  // Also covers legacy accounts over the project creation limit. Do not scan archived projects.
  const projects = await ctx.db
    .query('hostedProjects')
    .withIndex('by_owner_and_removal', q => q.eq('owner', owner).eq('removal', undefined))
    .paginate({ cursor, numItems: 100 });
  await queuePublicAccountRead(ctx, handle, {
    previousHandle,
    ...(cursor === null ? ({ profile: true } as const) : {}),
    directory: true,
    projects: projects.page.filter(project => project.visibility === 'public').map(project => project._id),
    slugs: projects.page.flatMap(project =>
      project.visibility === 'public' && project.slug ? [project.slug] : [],
    ),
  });
  for (const project of projects.page)
    if (project.visibility === 'public') await startProfileRevocation(ctx, project._id);
  if (!projects.isDone)
    await ctx.scheduler.runAfter(0, internal.publicSnapshotJobs.ownerPage, {
      owner,
      handle,
      ...(previousHandle ? { previousHandle } : {}),
      cursor: projects.continueCursor,
    });
}

export const ownerPage = internalMutation({
  args: {
    owner: v.string(),
    handle: v.string(),
    previousHandle: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { owner, handle, previousHandle, cursor }) => {
    await queueOwnerSnapshots(ctx, owner, handle, previousHandle, cursor);
    return null;
  },
});

/** All serving surfaces must reach the requested generation and finish the second purge. */
export async function snapshotHidePending(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  page = new Map<Job['_id'], Promise<Job | null>>(),
) {
  if (!publicSnapshotJobsEnabled()) return false;
  if (project.snapshotProfileRevocation?.scanning || project.snapshotProfileRevocation?.pending) return true;
  for (const target of project.snapshotHide ?? []) {
    let read = page.get(target.id);
    if (!read) {
      read = ctx.db.get(target.id);
      page.set(target.id, read);
    }
    if (((await read)?.confirmedGeneration ?? 0) < target.generation) return true;
  }
  return false;
}

export const claim = internalMutation({
  args: identity,
  handler: async (ctx, { id, serial }): Promise<Job | null> => {
    const row = await ctx.db.get(id);
    if (row?.serial !== serial || row.phase !== 'queued') return null;
    const task = await ctx.scheduler.runAfter(lease, internal.publicSnapshotJobs.lost, { id, serial });
    await ctx.db.patch(id, { phase: 'running', task });
    return row;
  },
});

export const current = internalQuery({
  args: identity,
  handler: async (ctx, { id, serial }): Promise<boolean> => {
    const row = await ctx.db.get(id);
    return row?.serial === serial && row.phase === 'running';
  },
});

export const reserve = internalMutation({
  args: { ...identity, extents },
  handler: async (ctx, { id, serial, extents }): Promise<boolean> => {
    const row = await ctx.db.get(id);
    if (row?.serial !== serial || row.phase !== 'running') return false;
    await ctx.db.patch(id, { extents });
    return true;
  },
});

async function retry(ctx: MutationCtx, row: Job, permanent = false) {
  const attempt = row.attempt + 1;
  if (permanent || attempt >= maxAttempts) {
    await cancelPendingTask(ctx, row.task);
    await ctx.db.patch(row._id, { phase: 'failed', task: undefined, attempt });
    // Alert once on the fenced transition, without paths, source or provider responses.
    console.error('FORGE_PUBLIC_SNAPSHOT_FAILED', {
      id: row._id,
      generation: row.generation,
      step: row.step,
      attempt,
      permanent,
    });
    return;
  }
  // Retain the pending state, including a purge or tombstone which isn't confirmed yet.
  const delay = Math.min(5 * minute, 1_000 * 2 ** (2 * row.attempt));
  await schedule(ctx, row, Date.now() + delay, { attempt });
}

/** Operator recovery after fixing the cause. An unknown reply is safe to retry with the same serial. */
export const resumeFailed = internalMutation({
  args: identity,
  handler: async (ctx, { id, serial }): Promise<boolean> => {
    const row = await ctx.db.get(id);
    if (!publicSnapshotJobsEnabled() || row?.serial !== serial || row.phase !== 'failed') return false;
    await schedule(ctx, row, Date.now(), { attempt: 0 });
    return true;
  },
});

export const lost = internalMutation({
  args: identity,
  handler: async (ctx, { id, serial }) => {
    const row = await ctx.db.get(id);
    if (row?.serial === serial && row.phase === 'running') await retry(ctx, row);
  },
});

export const settle = internalMutation({
  args: {
    ...identity,
    ok: v.boolean(),
    permanent: v.optional(v.boolean()),
    dependencies: v.optional(v.array(v.id('hostedProjects'))),
  },
  handler: async (ctx, { id, serial, ok, permanent, dependencies }) => {
    const row = await ctx.db.get(id);
    if (row?.serial !== serial || row.phase !== 'running') return;
    const now = Date.now();
    if (!ok) return retry(ctx, row, permanent);
    if (row.step === 'blankProfile')
      return schedule(ctx, row, now, {
        step: 'publish',
        attempt: 0,
        generation: row.generation + 1,
        purgeAfter: now + 30_000,
      });
    if (dependencies) await retirePublishedDependencies(ctx, id, dependencies);
    if (row.urgent && row.step === 'publish')
      return schedule(ctx, row, Math.max(now, row.purgeAfter ?? now + 30_000), {
        step: 'purgeAgain',
        attempt: 0,
      });
    const next = {
      urgent: false,
      dirtyAt: undefined,
      purgeAfter: undefined,
      step: 'publish' as const,
      attempt: 0,
      ...(row.urgent ? { confirmedGeneration: row.generation } : {}),
    };
    if (row.urgent && row.key.startsWith('profile/'))
      await ctx.scheduler.runAfter(0, internal.publicProfileDependencies.confirmPage, {
        profile: id,
        cursor: null,
      });
    if (row.dirtyAt !== undefined)
      return schedule(ctx, row, Math.max(now, row.dirtyAt + windowFor(row.key)), next);
    await cancelPendingTask(ctx, row.task);
    await ctx.db.patch(id, { ...next, task: undefined, phase: 'idle' });
  },
});
