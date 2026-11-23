// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { finishPlanProjectProjection } from './projectFinishReadProjection';

/** Optional read models must never deny a valid source write. */
export const planHeaderFits = (value: string) => new TextEncoder().encode(value).byteLength <= 256000;

/** Empty projects and removal tombstones have no Plan selection to retain. */
export const planProjectHeaderWanted = (row: Record<string, unknown>) =>
  !row.removal && Boolean((row.work as { generationId?: string } | undefined)?.generationId);

/** Explicit preparation installs metadata directly; it never patches the canonical
 * project or invokes the legacy Work/line publisher as a side effect. */
export async function ensurePlanProjectHeader(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  const next = finishPlanProjectProjection(project);
  const old = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q => q.eq('kind', next.kind).eq('sourceId', project._id))
    .unique();
  if (!planProjectHeaderWanted(project) || !planHeaderFits(next.value)) {
    if (old) await ctx.db.delete(old._id);
  } else if (!old) await ctx.db.insert('projectFinishReadRows', next);
  else if (old.value !== next.value) await ctx.db.replace(old._id, next);
}
