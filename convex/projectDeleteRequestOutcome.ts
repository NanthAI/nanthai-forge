// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Where a project's permanent purge ends or stops, record that outcome on the bulk-delete request that started it
// (Item 7456856f), so the owner's page and `--wait` see per-project progress from one row. Kept apart from
// projectDeleteRequests so the purge path does not import the request module.
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

/** The purge operation id a bulk request gives each project: this prefix and the request row id. */
export const DELETE_REQUEST_OPERATION = 'delete-request:';

type Request = Doc<'projectDeleteRequests'>;
export const deletePurgeOperation = (project: Pick<Doc<'hostedProjects'>, 'purge' | 'lifecycle'>) =>
  project.purge?.operationId ?? project.lifecycle?.operationId;

/** One get and one patch, only for purges a bulk request started; every other purge returns at once. */
export async function noteDeleteOutcome(
  ctx: MutationCtx,
  project: Pick<Doc<'hostedProjects'>, '_id' | 'lifecycle' | 'purge'>,
  outcome: 'deleted' | 'failed',
) {
  const operation = deletePurgeOperation(project);
  if (!operation?.startsWith(DELETE_REQUEST_OPERATION)) return;
  const id = ctx.db.normalizeId('projectDeleteRequests', operation.slice(DELETE_REQUEST_OPERATION.length));
  const row = id ? await ctx.db.get(id) : null;
  if (!row?.results?.some(entry => entry.projectId === project._id && entry.outcome === 'started')) return;
  await ctx.db.patch(row._id, {
    results: row.results.map(entry => (entry.projectId === project._id ? { ...entry, outcome } : entry)),
  });
}

/** Older approvals may still show started after their purge settled. Only observe their pinned
 * projects while they are outstanding. New approvals use the existing request-row subscription. */
export async function reconcileDeleteOutcomes(ctx: QueryCtx, row: Request): Promise<Request> {
  if (row.tracksPurgeReceipt || row.status !== 'approved' || !row.results?.some(e => e.outcome === 'started'))
    return row;
  const operation = `${DELETE_REQUEST_OPERATION}${row._id}`;
  const results = await Promise.all(
    row.results.map(async entry => {
      if (entry.outcome !== 'started') return entry;
      const id = ctx.db.normalizeId('hostedProjects', entry.projectId);
      const project = id ? await ctx.db.get(id) : null;
      if (!project || project.owner !== row.owner) return { ...entry, outcome: 'refused' as const };
      if (deletePurgeOperation(project) !== operation) return { ...entry, outcome: 'changed' as const };
      if (project.purge?.completedAt !== undefined && project.removal === 'deleted')
        return { ...entry, outcome: 'deleted' as const };
      if (project.removal === 'deleted') return { ...entry, outcome: 'changed' as const };
      if (project.purgeBlocked) return { ...entry, outcome: 'failed' as const };
      return entry;
    }),
  );
  return { ...row, results };
}
