// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalMutation } from './server';
import { queueDependentProfile } from './publicSnapshotJobs';

const batch = 32;
// Maximum lifetime of a selected action, plus the maximum edge cache lifetime.
const cacheGrace = 12 * 60_000;
const cursorArg = v.union(v.string(), v.null());

/** Recorded in the same transaction as the authoritative profile read, before any PUT.
 * Retire an absent pointer only after older in-flight writes and caches can no longer use it. */
export async function recordProfileDependencies(
  ctx: MutationCtx,
  profile: Id<'publicSnapshotJobs'>,
  sources: ReadonlySet<Id<'hostedProjects'>>,
) {
  const rows = await ctx.db
    .query('publicProfileDependencies')
    .withIndex('by_profile_and_source', q => q.eq('profile', profile))
    .take(256);
  const seen = new Set<Id<'hostedProjects'>>();
  for (const row of rows) {
    if (!sources.has(row.source)) continue;
    seen.add(row.source);
    if (row.absentSince !== undefined) await ctx.db.patch(row._id, { absentSince: undefined });
  }
  for (const source of sources) {
    if (seen.has(source)) continue;
    const row =
      rows.length < 256
        ? null
        : await ctx.db
            .query('publicProfileDependencies')
            .withIndex('by_profile_and_source', q => q.eq('profile', profile).eq('source', source))
            .unique();
    if (!row) await ctx.db.insert('publicProfileDependencies', { profile, source });
    else if (row.absentSince !== undefined) await ctx.db.patch(row._id, { absentSince: undefined });
  }
}

/** Only a successful publication may start retirement; failed selections can leave old content live. */
export async function retirePublishedDependencies(
  ctx: MutationCtx,
  profile: Id<'publicSnapshotJobs'>,
  published: readonly Id<'hostedProjects'>[],
) {
  const sources = new Set(published);
  const now = Date.now();
  const rows = await ctx.db
    .query('publicProfileDependencies')
    .withIndex('by_profile_and_source', q => q.eq('profile', profile))
    .take(256);
  for (const row of rows) {
    if (sources.has(row.source)) continue;
    if (row.absentSince === undefined) await ctx.db.patch(row._id, { absentSince: now });
    else if (!row.pending && now - row.absentSince >= cacheGrace) await ctx.db.delete(row._id);
  }
}

/** Source mutations advance an epoch before any older profile selection can register again. */
export async function startProfileRevocation(ctx: MutationCtx, source: Id<'hostedProjects'>) {
  const [project, [dependency]] = await Promise.all([
    ctx.db.get(source),
    ctx.db
      .query('publicProfileDependencies')
      .withIndex('by_source', q => q.eq('source', source))
      .take(1),
  ]);
  if (!project || !dependency) return;
  const epoch = (project.snapshotProfileRevocation?.epoch ?? 0) + 1;
  await ctx.db.patch(source, { snapshotProfileRevocation: { epoch, pending: 0, scanning: true } });
  await ctx.scheduler.runAfter(0, internal.publicProfileDependencies.revokePage, {
    source,
    epoch,
    cursor: null,
  });
}

export const revokePage = internalMutation({
  args: { source: v.id('hostedProjects'), epoch: v.number(), cursor: cursorArg },
  returns: v.null(),
  handler: async (ctx, { source, epoch, cursor }) => {
    const current = (await ctx.db.get(source))?.snapshotProfileRevocation;
    if (current?.epoch !== epoch || !current.scanning) return null;
    const result = await ctx.db
      .query('publicProfileDependencies')
      .withIndex('by_source', q => q.eq('source', source))
      .paginate({ cursor, numItems: batch });
    let pending = current.pending;
    for (const entry of result.page) {
      if (entry.pending?.epoch === epoch) continue;
      const generation = await queueDependentProfile(ctx, entry.profile);
      if (generation === null) continue;
      await ctx.db.patch(entry._id, { pending: { epoch, generation } });
      pending++;
    }
    await ctx.db.patch(source, { snapshotProfileRevocation: { epoch, pending, scanning: !result.isDone } });
    if (!result.isDone)
      await ctx.scheduler.runAfter(0, internal.publicProfileDependencies.revokePage, {
        source,
        epoch,
        cursor: result.continueCursor,
      });
    return null;
  },
});

/** Group confirmation without polling or putting an unbounded set of addresses on the project row. */
export const confirmPage = internalMutation({
  args: { profile: v.id('publicSnapshotJobs'), cursor: cursorArg },
  returns: v.null(),
  handler: async (ctx, { profile, cursor }) => {
    const confirmed = (await ctx.db.get(profile))?.confirmedGeneration ?? 0;
    const result = await ctx.db
      .query('publicProfileDependencies')
      .withIndex('by_profile_and_source', q => q.eq('profile', profile))
      .paginate({ cursor, numItems: batch });
    for (const entry of result.page) {
      if (!entry.pending || entry.pending.generation > confirmed) continue;
      const project = await ctx.db.get(entry.source);
      const current = project?.snapshotProfileRevocation;
      if (current?.epoch === entry.pending.epoch && current.pending > 0) {
        await ctx.db.patch(entry.source, {
          snapshotProfileRevocation: { ...current, pending: current.pending - 1 },
        });
        if (project?.removal) {
          await ctx.db.delete(entry._id);
          continue;
        }
      }
      await ctx.db.patch(entry._id, { pending: undefined });
    }
    if (!result.isDone)
      await ctx.scheduler.runAfter(0, internal.publicProfileDependencies.confirmPage, {
        profile,
        cursor: result.continueCursor,
      });
    return null;
  },
});
