// SPDX-License-Identifier: Apache-2.0
// Done and dropped Items for the Plan screen's Closed and All scopes (Item e0a23825) and an Initiative page (Item
// 4df3ee17): one bounded page per call from the planning search roots on the existing by_planning_kind_and_status
// index, or by_planning_initiativeId_and_kind_and_status for one Initiative; no body and no new row. The Open scope
// never subscribes to this; a page re-runs only on planning writes inside the range it read.
import { v } from 'convex/values';
import { paginationOptsValidator, type PaginationOptions } from 'convex/server';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { planningRecordTable } from './projectWorkRecordTables';
import { planViewRow } from './projectPlanView';
import { report } from './errors';
import { invariant } from '../src/errors';

/** Rows per page: about 55 KB of root values on the dogfood board. */
export const PLAN_SETTLED_PAGE = 50;

export async function settledPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  status: 'closed' | 'abandoned',
  paginationOpts: PaginationOptions,
  initiativeId?: string,
) {
  invariant(
    initiativeId === undefined || (initiativeId.length > 0 && initiativeId.length <= 64),
    'BAD_ARGUMENT',
    'An Initiative id is at most 64 characters.',
  );
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
  const project = await accessibleProject(ctx, projectId, user.subject);
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return { page: [], isDone: true, continueCursor: '' };
  const generationId = recordPartition(generation);
  const table = await planningRecordTable(ctx, generationId);
  const indexed =
    initiativeId === undefined
      ? ctx.db
          .query(table)
          .withIndex('by_planning_kind_and_status', q =>
            q
              .eq('generationId', generationId)
              .eq('collection', 'planningSearch')
              .eq('planning.kind', 'issue')
              .eq('planning.status', status),
          )
      : ctx.db
          .query(table)
          .withIndex('by_planning_initiativeId_and_kind_and_status', q =>
            q
              .eq('generationId', generationId)
              .eq('collection', 'planningSearch')
              .eq('planning.initiativeId', initiativeId)
              .eq('planning.kind', 'issue')
              .eq('planning.status', status),
          );
  const result = await indexed.order('desc').paginate({
    ...paginationOpts,
    numItems: Math.max(1, Math.min(paginationOpts.numItems, PLAN_SETTLED_PAGE)),
  });
  const rows: string[] = [];
  for (const root of result.page) {
    try {
      const row = planViewRow(JSON.parse(root.value), root.position);
      if (row) rows.push(JSON.stringify(row));
    } catch {
      /* A root that does not parse is skipped, as in the open read. */
    }
  }
  return { page: rows, isDone: result.isDone, continueCursor: result.continueCursor };
}

export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    status: v.union(v.literal('closed'), v.literal('abandoned')),
    initiativeId: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({ page: v.array(v.string()), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, { projectId, status, initiativeId, paginationOpts }) => {
    try {
      return await settledPage(ctx, projectId, status, paginationOpts, initiativeId);
    } catch (error) {
      return report(error);
    }
  },
});
