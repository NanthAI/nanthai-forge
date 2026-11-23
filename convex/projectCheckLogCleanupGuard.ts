// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
export async function projectGuard(ctx: QueryCtx | MutationCtx, project: Doc<'hostedProjects'>) {
  const [pin] = await ctx.db
    .query('projectCheckLogSourcePins')
    .withIndex('by_project', q => q.eq('projectId', project._id))
    .order('desc')
    .take(1);
  return JSON.stringify([
    pin?._id ?? null,
    project.revision,
    project.currentBackup,
    project.work,
    project.sourceAuthority,
    project.autonomyPolicy,
  ]);
}
