// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type QueryCtx } from './server';
import type { Id } from './_generated/dataModel';
import { historyChunk } from './projectHistoryFields';

/** Daily caps on the Worker byte path (Issue 09367fb2): the Worker runs on Workers Free
 * (100,000 requests/day, R2 egress free); these keep R2 reads and backend calls bounded
 * so the path cannot grow past the owner's $5/month approval. Packs counts served packs
 * (one per clone or fetch that moves bytes). */
export const workerCaps = {
  project: { packs: 1_000, bytes: 20 * 1024 ** 3 },
  all: { packs: 10_000, bytes: 100 * 1024 ** 3 },
};
export const usageDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
/** Rows older than this many days are deleted when their scope is next written. */
const keepDays = 7;

type Usage = { packs: number; bytes: number };
async function usageRow(ctx: QueryCtx, scope: string, day: string) {
  return ctx.db
    .query('gitWorkerUsage')
    .withIndex('by_scope_and_day', q => q.eq('scope', scope).eq('day', day))
    .unique();
}
/** Today's use for one project and for every project: two indexed reads. */
export async function workerUsage(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const day = usageDay();
  const [project, all] = await Promise.all([usageRow(ctx, projectId, day), usageRow(ctx, '*', day)]);
  return {
    project: { packs: project?.packs ?? 0, bytes: project?.bytes ?? 0 },
    all: { packs: all?.packs ?? 0, bytes: all?.bytes ?? 0 },
  };
}
/** The cap a request of `bytes` would pass, or null when it fits. */
export function overCap(usage: { project: Usage; all: Usage }, bytes: number) {
  for (const scope of ['project', 'all'] as const) {
    const cap = workerCaps[scope],
      used = usage[scope];
    if (used.packs + 1 > cap.packs || used.bytes + bytes > cap.bytes)
      return {
        code: 'GIT_BYTE_LIMIT',
        message: `Forge's daily large-pack limit (${scope === 'project' ? 'this project' : 'all projects'}: ${cap.packs} packs, ${cap.bytes / 1024 ** 3} GiB) is used up; retry after 00:00 UTC.`,
      };
  }
  return null;
}

/** Counts one served pack before its bytes flow; refuses past a cap. A retried unknown
 * outcome can count a pack twice, which errs toward the cap. */
export const reserve = internalMutation({
  args: { projectId: v.id('hostedProjects'), bytes: v.number() },
  returns: v.union(v.null(), v.object({ code: v.string(), message: v.string() })),
  handler: async (ctx, { projectId, bytes }) => {
    const day = usageDay();
    const refused = overCap(await workerUsage(ctx, projectId), bytes);
    if (refused) return refused;
    for (const scope of [projectId as string, '*']) {
      const row = await usageRow(ctx, scope, day);
      if (row) await ctx.db.patch(row._id, { packs: row.packs + 1, bytes: row.bytes + bytes });
      else {
        await ctx.db.insert('gitWorkerUsage', { scope, day, packs: 1, bytes });
        const cutoff = usageDay(Date.now() - keepDays * 86_400_000);
        const old = await ctx.db
          .query('gitWorkerUsage')
          .withIndex('by_scope_and_day', q => q.eq('scope', scope).lt('day', cutoff))
          .take(2);
        for (const stale of old) await ctx.db.delete(stale._id);
      }
    }
    return null;
  },
});

/** Caches the joined trailer of one pack set (keyed by its packs' SHA-1s) on the history row. */
export const setJoined = internalMutation({
  args: { projectId: v.id('hostedProjects'), key: v.string(), sha1: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, ...joined }) => {
    const row = await ctx.db
      .query('projectHistory')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .unique();
    if (row) await ctx.db.patch(row._id, { joined });
    return null;
  },
});

/** Records the framed copies of packs (by tip) for the v2 Worker path. Returns the tips
 * whose pack row is gone, so the caller deletes those objects. */
export const setFramed = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    packs: v.array(v.object({ tip: v.string(), framed: v.array(historyChunk) })),
  },
  returns: v.array(v.string()),
  handler: async (ctx, { projectId, packs }) => {
    const missing: string[] = [];
    for (const { tip, framed } of packs) {
      const row = await ctx.db
        .query('projectHistoryPacks')
        .withIndex('by_project_and_tip', q => q.eq('projectId', projectId).eq('tip', tip))
        .take(1)
        .then(rows => rows[0] ?? null);
      if (row) await ctx.db.patch(row._id, { framed });
      else missing.push(tip);
    }
    return missing;
  },
});
