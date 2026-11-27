// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Done and dropped Items for the Plan screen's Closed and All scopes (Item e0a23825), Archived and Deleted ones for its
// Archive and Deleted lists (Item 4c9e961e), and an Initiative page (Item
// 4df3ee17): one bounded page per call from the planning search roots on the existing by_planning_kind_and_status
// index, or by_planning_initiativeId_and_kind_and_status for one Initiative; no body and no new row. The Open scope
// never subscribes to this; a page re-runs only on planning writes inside the range it read.
import { v } from 'convex/values';
import { paginationOptsValidator, type PaginationOptions } from 'convex/server';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { query } from './cliServer';
import { accessibleProject, readProjectRole } from './projectAuthority';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { planningRecordTable } from './projectWorkRecordTables';
import { planViewRow } from './projectPlanView';
import { report } from './errors';
import { invariant } from '../src/errors';
import { itemDeadlines } from './projectItemRetentionStore';
import { planningRootsWithPrefix } from './projectHostedPlanning';
import { isPlanningPrefix, isPlanningUuid } from '../src/planning-id';
import { agentActor } from '../src/agent-slug';
import { commandPayloadRows, commandValues } from './projectWorkCommandRows';

/** Rows per page: about 55 KB of root values on the dogfood board. */
export const PLAN_SETTLED_PAGE = 50;

export async function settledPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  status: 'closed' | 'abandoned' | 'archived' | 'deleted',
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
  const deadlines =
    status === 'deleted' && result.page.length
      ? await itemDeadlines(
          ctx,
          projectId,
          result.page.at(-1)!.position,
          result.page[0]!.position,
          result.page.length,
          initiativeId,
        )
      : undefined;
  const shelf = status === 'archived' || status === 'deleted';
  const rows: string[] = [];
  for (const root of result.page) {
    try {
      const value = JSON.parse(root.value);
      if (value.purged) continue;
      const row = planViewRow(value, root.position, shelf);
      if (row) {
        let agent = typeof value.agent === 'string' ? value.agent : undefined;
        // Pre-cutover shelved search roots omitted `at` and `agent`; recover them from the canonical header once per row.
        if (shelf && !row.at) {
          const canonical = await record(ctx, generationId, 'planningItems', row.id);
          if (canonical) {
            try {
              const header = JSON.parse(canonical.value) as { at?: unknown; agent?: unknown };
              if (typeof header.at === 'string' && header.at) row.at = header.at;
              if (!agent && typeof header.agent === 'string' && header.agent) agent = header.agent;
            } catch {
              /* Keep the search row as read when the canonical header is unreadable. */
            }
          }
        }
        if (shelf && !row.by) row.by = agentActor(project.owner, agent);
        const deadline = deadlines?.get(row.id);
        if (deadline !== undefined) row.purgeAt = deadline;
        rows.push(JSON.stringify(row));
      }
    } catch {
      /* A root that does not parse is skipped, as in the open read. */
    }
  }
  return { page: rows, isDone: result.isDone, continueCursor: result.continueCursor };
}

export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    status: v.union(v.literal('closed'), v.literal('abandoned'), v.literal('archived'), v.literal('deleted')),
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

/** A linked Item outside the open plan. Shelves stay owner-only; ambiguous prefixes resolve to nothing. */
export const item = query({
  args: { projectId: v.id('hostedProjects'), id: v.string() },
  returns: v.union(v.object({ id: v.string(), row: v.union(v.string(), v.null()) }), v.null()),
  handler: async (ctx, { projectId, id }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const owner = project.owner === user.subject;
      if (!owner && (!isPlanningUuid(id) || !(await readProjectRole(ctx, project, user.subject))))
        return null;
      const generation = await selectedGeneration(ctx, project);
      if (!generation) return null;
      const partition = recordPartition(generation);
      const roots = isPlanningUuid(id)
        ? [await record(ctx, partition, 'planningItems', id)]
        : isPlanningPrefix(id)
          ? await planningRootsWithPrefix(ctx, partition, id, 2)
          : [];
      const root = roots.length === 1 ? roots[0] : null;
      if (!root) return null;
      const header = JSON.parse(root.value);
      if (header.purged) return owner ? { id: root.key, row: null } : null;
      if (header.status !== 'archived' && header.status !== 'deleted') {
        const search = await record(ctx, partition, 'planningSearch', root.key);
        const row = search && planViewRow(JSON.parse(search.value), search.position);
        return { id: root.key, row: row ? JSON.stringify(row) : null };
      }
      if (!owner) return null;
      const rows = [root];
      await commandPayloadRows(rows, keys =>
        Promise.all(keys.map(({ collection, key }) => record(ctx, partition, collection, key))),
      );
      const item = commandValues(rows, 'planningItems')[0];
      const row = item ? planViewRow(item, root.position, true) : null;
      if (row && !row.by)
        row.by = agentActor(project.owner, typeof item?.agent === 'string' ? item.agent : undefined);
      return { id: root.key, row: row ? JSON.stringify(row) : null };
    } catch (error) {
      return report(error);
    }
  },
});
