// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Where a project's permanent purge ends or stops, record that outcome on the bulk-delete request that started it
// (Item 7456856f), so the owner's page and `--wait` see per-project progress from one row. Kept apart from
// projectDeleteRequests so the purge path does not import the request module.
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

/** The purge operation id a bulk request gives each project: this prefix and the request row id. */
export const DELETE_REQUEST_OPERATION = 'delete-request:';

/** One get and one patch, only for purges a bulk request started; every other purge returns at once. */
export async function noteDeleteOutcome(
  ctx: MutationCtx,
  project: Pick<Doc<'hostedProjects'>, '_id' | 'lifecycle'>,
  outcome: 'deleted' | 'failed',
) {
  const operation = project.lifecycle?.operationId;
  if (!operation?.startsWith(DELETE_REQUEST_OPERATION)) return;
  const id = ctx.db.normalizeId('projectDeleteRequests', operation.slice(DELETE_REQUEST_OPERATION.length));
  const row = id ? await ctx.db.get(id) : null;
  if (!row?.results) return;
  await ctx.db.patch(row._id, {
    results: row.results.map(entry => (entry.projectId === project._id ? { ...entry, outcome } : entry)),
  });
}
