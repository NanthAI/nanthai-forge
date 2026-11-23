// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

/** The last retained server landing receipt, independent of later saves, audits or other project activity. */
export async function latestLanding(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const [receipt] = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .order('desc')
    .take(1);
  return receipt ?? null;
}
