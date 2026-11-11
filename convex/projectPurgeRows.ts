// SPDX-License-Identifier: Apache-2.0
import { deleteLandingRequestBodies } from './projectLandingRequestBody';
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import {
  projectPurgeOrder,
  purgeIndex,
  rowReferences,
  valuesAt,
  type ProjectPurgeTable,
} from './projectPurgeInventory';
import { removeExclusive } from './projectStorage';
import { purgePageBudget, documentBytes } from './projectPurgeBudget';

export { purgePageBudget, documentBytes };
type Row = { _id: string } & Record<string, unknown>;
type Indexed = {
  withIndex: (
    index: string,
    range: (q: {
      eq: (field: string, value: unknown) => unknown;
      gte: (field: string, value: unknown) => { lt: (field: string, value: unknown) => unknown };
    }) => unknown,
  ) => { take: (n: number) => Promise<Row[]> };
};
// oxlint-disable-next-line forge/convex-bounded-query -- the Indexed type exposes only withIndex(...).take(n)
const indexed = (ctx: MutationCtx, table: string) => ctx.db.query(table as never) as unknown as Indexed;
/** Up to `n` rows a project owns in one covered table, through its project index. */
export const projectRows = (
  ctx: MutationCtx,
  table: ProjectPurgeTable,
  projectId: Id<'hostedProjects'>,
  n: number,
) =>
  indexed(ctx, table)
    .withIndex(purgeIndex(table).index, q => {
      const scoped = q.eq('projectId', projectId) as { eq: (field: string, value: unknown) => unknown };
      const scope = purgeIndex(table).scope;
      return scope ? scoped.eq('scope', scope) : scoped;
    })
    .take(n);
async function chunk(ctx: MutationCtx, step: number, projectId: Id<'hostedProjects'>) {
  if (step < projectPurgeOrder.length)
    return projectRows(ctx, projectPurgeOrder[step]!, projectId, purgePageBudget.chunk);
  // Archive blob rows: namespace `v1/p/<projectId>/...`; '0' sorts right after '/'.
  return indexed(ctx, 'artifactBlobs')
    .withIndex('by_namespace_and_digest', q =>
      q.gte('namespace', `v1/p/${projectId}/`).lt('namespace', `v1/p/${projectId}0`),
    )
    .take(purgePageBudget.chunk);
}
/** Steps: every `projectPurgeTables` entry in order, then the artifact namespace. */
export const purgeSteps = projectPurgeOrder.length + 1;

/** Delete one bounded page of project-owned rows (plus their exclusive Convex files and
 * pending scheduled functions). Records progress on the project; true when nothing is left. */
export async function purgeProjectRowsPage(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  const progress = project.purge ?? {
    operationId: project.lifecycle?.operationId ?? `purge:${project._id}`,
    reason: 'owner' as const,
    startedAt: Date.now(),
    rows: 0,
    bytes: 0,
    pages: 0,
  };
  let step = progress.table ?? 0,
    rows = 0,
    bytes = 0;
  while (step < purgeSteps && rows < purgePageBudget.rows && bytes < purgePageBudget.bytes) {
    const batch = await chunk(ctx, step, project._id);
    if (!batch.length) {
      step++;
      continue;
    }
    const references =
      step < projectPurgeOrder.length ? rowReferences(projectPurgeOrder[step]!) : { files: [], tasks: [] };
    for (const row of batch) {
      if (rows >= purgePageBudget.rows || bytes >= purgePageBudget.bytes) break;
      rows++;
      bytes += documentBytes(row);
      for (const path of references.tasks)
        for (const id of valuesAt(row, path)) {
          const task = await ctx.db.system.get(id as Id<'_scheduled_functions'>);
          if (task?.state.kind === 'pending') await ctx.scheduler.cancel(id as Id<'_scheduled_functions'>);
        }
      // S3 bodies are exclusively owned by their ticket, including the larger batch selection.
      if (step < projectPurgeOrder.length && projectPurgeOrder[step] === 'projectHostedLandingRequests')
        for (const body of await deleteLandingRequestBodies(ctx.db, row)) {
          rows++;
          bytes += documentBytes(body);
        }
      await ctx.db.delete(row._id as never);
      for (const path of references.files)
        for (const id of valuesAt(row, path)) await removeExclusive(ctx, id as Id<'_storage'>, row._id);
    }
  }
  if (project.purge && !rows && step === (progress.table ?? 0)) return step >= purgeSteps;
  await ctx.db.patch(project._id, {
    purge: {
      ...progress,
      table: step,
      rows: progress.rows + rows,
      bytes: progress.bytes + bytes,
      pages: progress.pages + 1,
    },
  });
  return step >= purgeSteps;
}
