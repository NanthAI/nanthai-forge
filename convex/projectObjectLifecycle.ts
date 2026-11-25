// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';

// Called only by the existing explicit project deletion owner. Source history has
// no automatic expiry. Nonce receipts remain to reconcile attributable late uploads.
export async function purgeExchangeObjects(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectObjects')
    .withIndex('by_project_and_removed', q => q.eq('projectId', project._id).eq('removed', false))
    .take(50);
  for (const row of rows) {
    await ctx.db.patch(row._id, { removed: true, recipe: undefined });
  }
  return rows.length === 0;
}
