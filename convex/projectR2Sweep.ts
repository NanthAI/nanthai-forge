// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, internalMutation } from './_generated/server';
import { abandonedWindow, maintenanceEnabled, maintenancePageSize } from './r2Maintenance';
import { projectPrefix } from './r2Operations';
import { r2Key } from './r2';
import { invariant } from '../src/errors';
const job = v.object({ id: v.id('projectObjects'), key: v.string() });
export const page = internalQuery({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    ids: v.array(v.id('projectObjects')),
    scanned: v.number(),
    cursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { projectId, cursor }) => {
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an active project.');
    const result = await ctx.db
      .query('projectObjects')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .paginate({ cursor, numItems: maintenancePageSize });
    return {
      ids: result.page.map(row => row._id),
      scanned: result.page.length,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
const abandoned = (row: {
  location?: string;
  r2Committed?: boolean;
  storageId?: unknown;
  recipe?: unknown;
  r2PreparedAt?: number;
  _creationTime: number;
}) =>
  row.location === 'r2' &&
  !row.r2Committed &&
  !row.storageId &&
  !row.recipe &&
  Date.now() - (row.r2PreparedAt ?? row._creationTime) > abandonedWindow;
export const claim = internalMutation({
  args: { projectId: v.id('hostedProjects'), ids: v.array(v.id('projectObjects')), dryRun: v.boolean() },
  returns: v.array(job),
  handler: async (ctx, { projectId, ids, dryRun }) => {
    if (!dryRun) maintenanceEnabled();
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an active project.');
    invariant(ids.length <= maintenancePageSize, 'BAD_ARGUMENT', 'Use one maintenance page.');
    const jobs = [];
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (!row || row.projectId !== projectId || row.removed) continue;
      const key = row.r2SweepKey ?? (abandoned(row) ? row.r2Key : undefined);
      if (!key || !key.startsWith(projectPrefix(projectId)) || (row.r2Committed && row.r2Key === key))
        continue;
      if (!dryRun && !row.r2SweepKey) await ctx.db.patch(id, { r2SweepKey: key });
      jobs.push({ id, key });
    }
    return jobs;
  },
});
export const complete = internalMutation({
  args: { projectId: v.id('hostedProjects'), jobs: v.array(job) },
  returns: v.null(),
  handler: async (ctx, { projectId, jobs }) => {
    invariant(jobs.length <= maintenancePageSize, 'BAD_ARGUMENT', 'Use one maintenance page.');
    for (const job of jobs) {
      const row = await ctx.db.get(job.id);
      if (row?.projectId !== projectId || row.r2SweepKey !== job.key) continue;
      // Rotate the upload destination. Replayed in-flight DELETEs can never delete a newly
      // prepared/committed copy. A concurrent prepare may already have rotated it.
      await ctx.db.patch(job.id, {
        r2SweepKey: undefined,
        ...(row.r2Key === job.key
          ? {
              r2Key: `${r2Key(projectId, row.digest)}/u/${crypto.randomUUID()}`,
              r2PreparedAt: Date.now(),
            }
          : {}),
      });
    }
    return null;
  },
});
